import { appendFile, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { redactDeep } from "../src/agent/persistence.js";

// The job loop shared by the T1 and SWE-bench evaluations: an ordered queue drained by N workers under a
// cost cap, where every row is checked against its job, validated, and appended to results.jsonl, and a
// rerun into the same directory resumes from the rows already there.

// What the loop needs from any row: its evaluation, its measured cost (the attempt the row describes), the cost
// of attempts it discarded, and what the cap charged it.
export type CostedRow = { evaluationId: string; estimatedCostUsd: number; retryCostUsd?: number; capChargeUsd?: number };

// What a running job may ask of the loop.
export type JobContext = {
  // Holds `amountUsd` more against the cap for this job (e.g. to retry it); false, holding nothing, when that
  // would pass the cap.
  reserve(amountUsd: number): Promise<boolean>;
};

export type JobLoopOptions<Job extends { key: string }, Row extends CostedRow> = {
  evaluationId: string;
  // Every planned job in run order; a job whose key an existing row already has is skipped.
  jobs: Job[];
  // Rows from earlier invocations, already validated.
  existing: Row[];
  concurrency: number;
  costCapUsd: number;
  // Held against the cap while a job runs, and charged in full to a job that throws (its cost is unknown).
  // Limits are checked before each model turn, so a run can exceed it by at most one turn's usage.
  reservationUsd: number;
  resultsPath: string;
  invalidPath: string;
  // Every job start (and every extra reservation) is appended here first, so a resume can charge the jobs an
  // interrupted invocation left without a row.
  journalPath?: string;
  keyOf(row: Row): string;
  execute(job: Job, context: JobContext): Promise<Row>;
  // Throws when the last row is invalid next to the rows before it.
  validate(rows: Row[]): void;
  // The harness row that stands in for a job that threw or produced an invalid row; `error` is an
  // InvalidResultError for the latter, and `charge` is what the cap charges the substitute.
  substitute(job: Job, error: unknown, charge: number): Row;
  onRow?(row: Row, job: Job): void;
  // Existing rows whose jobs run again: `reason` names why (undefined keeps the row). Each such row moves, redacted,
  // to `path` (the superseded file), and what the cap charged it keeps counting.
  rerun?: { path: string; reason(row: Row): string | undefined };
  // Opens once `after` consecutive rows, in the order their jobs finish, trip it: no new job starts, and the jobs
  // in flight finish. Any other row resets the count.
  breaker?: { after: number; trips(row: Row): boolean; onOpen?(): void };
};

// An invalid row's substitute carries this error, so `substitute` can tell it from a job that threw.
export class InvalidResultError extends Error {
  constructor(readonly reason: string) {
    super(`Invalid run result: ${reason}`);
    this.name = "InvalidResultError";
  }
}

// A job throws this to stop the whole evaluation rather than record a row: no new job starts, the jobs in
// flight finish, and the loop rethrows it. The job keeps its journal entry, so a resume charges it.
export class FatalJobError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FatalJobError";
  }
}

// Written in the output directory: one entry per job start, one per extra reservation a job takes, and one per
// start whose row a resume superseded (`superseded` is that start's ordinal among its key's starts).
export const JOURNAL_FILE = "eval-journal.jsonl";
type JournalEntry = { evaluationId: string; key: string; reservedUsd: number; at: string; extension?: true; superseded?: number };
// Written in the output directory: one entry per row a resume took out of results.jsonl to run its job again.
export const SUPERSEDED_FILE = "superseded-results.jsonl";
type SupersededEntry = { at: string; reason: string; row: CostedRow };

export async function runJobs<Job extends { key: string }, Row extends CostedRow>(
  options: JobLoopOptions<Job, Row>
): Promise<{ rows: Row[]; capReached: boolean; breakerOpen: boolean }> {
  const { reservationUsd, journalPath, rerun, breaker } = options;
  const existing = rerun ? await supersede(options, rerun) : options.existing;
  const existingKeys = new Set(existing.map((row) => options.keyOf(row)));
  const jobs = options.jobs.filter((job) => !existingKeys.has(job.key));
  let cursor = 0;
  // A thrown job is charged its worst case even though its row is recorded at zero cost, so rebuilding
  // spent on resume must use the charge that was actually counted against the cap.
  let spent = existing.reduce((sum, row) => sum + (row.capChargeUsd ?? row.estimatedCostUsd), 0);
  if (rerun) spent += await supersededCharges(rerun.path, options.evaluationId);
  if (journalPath) {
    const unfinished = await unfinishedReservations(journalPath, existingKeys, options.evaluationId);
    if (unfinished.keys.length) {
      process.stderr.write(`[eval] warning: ${unfinished.keys.length} job(s) were in flight when an earlier invocation stopped (${unfinished.keys.join(", ")}); charging their reservations, $${unfinished.chargeUsd.toFixed(4)}, against the cost cap\n`);
      spent += unfinished.chargeUsd;
    }
  }
  let reservations = 0;
  let capReached = false;
  let tripping = 0;
  let breakerOpen = false;
  let fatal: { error: unknown } | undefined;
  const produced: Row[] = [];
  // Appends one at a time, so jobs still start in queue order.
  let journaled = Promise.resolve();
  const journal = (entry: JournalEntry): Promise<void> => {
    if (!journalPath) return Promise.resolve();
    journaled = journaled.then(() => appendFile(journalPath, JSON.stringify(entry) + "\n", "utf8"));
    return journaled;
  };
  // Also one at a time, so results.jsonl keeps the order the jobs finished in, which the breaker counts in; a
  // failed append does not hold back the next one.
  let recorded = Promise.resolve();
  const record = (row: Row): Promise<void> => {
    const appended = recorded.then(() => appendFile(options.resultsPath, JSON.stringify(row) + "\n", "utf8"));
    recorded = appended.catch(() => undefined);
    return appended;
  };

  const worker = async () => {
    for (;;) {
      if (fatal || breakerOpen || cursor >= jobs.length) return;
      if (spent + reservations + reservationUsd > options.costCapUsd) {
        capReached = true;
        return;
      }
      const job = jobs[cursor++]!;
      let held = reservationUsd;
      reservations += held;
      await journal({ evaluationId: options.evaluationId, key: job.key, reservedUsd: held, at: new Date().toISOString() });
      const context: JobContext = {
        reserve: async (amountUsd) => {
          if (!(Number.isFinite(amountUsd) && amountUsd >= 0) || spent + reservations + amountUsd > options.costCapUsd) return false;
          reservations += amountUsd;
          held += amountUsd;
          await journal({ evaluationId: options.evaluationId, key: job.key, reservedUsd: amountUsd, at: new Date().toISOString(), extension: true });
          return true;
        }
      };
      let row: Row;
      let capCharge: number;
      try {
        row = await options.execute(job, context);
        // The attempt the row describes, and any it discarded (whose cost it reserved while running).
        capCharge = row.estimatedCostUsd + (row.retryCostUsd ?? 0);
      } catch (error) {
        if (error instanceof FatalJobError) {
          fatal ??= { error };
          // Its spend is unknown, so it keeps holding its reservation for the jobs still in flight.
          spent += held;
          reservations -= held;
          return;
        }
        capCharge = held;
        row = options.substitute(job, error, capCharge);
      }
      try {
        // A row for a different job or evaluation must never reach validation as its own: if it happened
        // to collide with an already-produced key it would fail with a confusing "Duplicate" error instead
        // of being substituted like any other invalid row.
        if (options.keyOf(row) !== job.key || row.evaluationId !== options.evaluationId) {
          throw new Error(`Result does not match its job: expected ${job.key}, got ${options.keyOf(row)}`);
        }
        options.validate([...existing, ...produced, row]);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const original = row as Partial<CostedRow> | null | undefined;
        const costs: unknown[] = [original?.estimatedCostUsd, original?.retryCostUsd ?? 0];
        const charged = costs.every((cost) => typeof cost === "number" && Number.isFinite(cost) && cost >= 0)
          ? (costs as number[]).reduce((sum, cost) => sum + cost, 0)
          : held;
        await appendFile(options.invalidPath, JSON.stringify({ at: new Date().toISOString(), error: message, original: redactDeep(row) }) + "\n", "utf8");
        row = options.substitute(job, new InvalidResultError(message), charged);
        capCharge = charged;
        options.validate([...existing, ...produced, row]);
      }
      row.capChargeUsd = capCharge;
      reservations -= held;
      spent += capCharge;
      produced.push(row);
      if (breaker) {
        tripping = breaker.trips(row) ? tripping + 1 : 0;
        if (tripping >= breaker.after && !breakerOpen) {
          breakerOpen = true;
          breaker.onOpen?.();
        }
      }
      await record(row);
      options.onRow?.(row, job);
    }
  };
  // Any other error (writing a row, onRow) also stops every worker from taking another job, and waits for
  // the jobs in flight, so nothing keeps appending after the loop has failed.
  const guarded = async () => {
    try {
      await worker();
    } catch (error) {
      fatal ??= { error };
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, options.concurrency) }, guarded));
  if (fatal) throw fatal.error;
  return { rows: [...existing, ...produced], capReached, breakerOpen };
}

// Takes the rows `rerun` names out of results.jsonl, so their jobs run again, and returns the rest. The journal first
// marks each row's start as superseded, so it never reads as a crash; the row then goes, redacted, to the superseded
// file, whose charges keep counting against the cap; results.jsonl is rewritten last, atomically. Every step can be
// repeated, so a resume after a crash at any point neither loses a charge nor counts one twice.
async function supersede<Job extends { key: string }, Row extends CostedRow>(
  options: JobLoopOptions<Job, Row>,
  rerun: NonNullable<JobLoopOptions<Job, Row>["rerun"]>
): Promise<Row[]> {
  const kept: Row[] = [];
  const moved: Array<{ row: Row; reason: string }> = [];
  for (const row of options.existing) {
    const reason = rerun.reason(row);
    if (reason) moved.push({ row, reason });
    else kept.push(row);
  }
  if (!moved.length) return options.existing;
  const at = new Date().toISOString();
  if (options.journalPath) {
    // Each row came from its key's last start, since no job of this invocation has started yet.
    const starts = await journalStarts(options.journalPath, options.evaluationId);
    const markers = moved.flatMap(({ row }): JournalEntry[] => {
      const key = options.keyOf(row);
      const ordinal = starts.get(key)?.held.length;
      return ordinal ? [{ evaluationId: options.evaluationId, key, reservedUsd: 0, at, superseded: ordinal }] : [];
    });
    if (markers.length) await appendFile(options.journalPath, markers.map((entry) => JSON.stringify(entry) + "\n").join(""), "utf8");
  }
  const recorded = new Set((await readJsonLines<SupersededEntry>(rerun.path)).map((entry) => JSON.stringify(entry.row)));
  const entries = moved
    .map(({ row, reason }): SupersededEntry => ({ at, reason, row: redactDeep(row) }))
    .filter((entry) => !recorded.has(JSON.stringify(entry.row)));
  if (entries.length) await appendFile(rerun.path, entries.map((entry) => JSON.stringify(entry) + "\n").join(""), "utf8");
  const rewritten = `${options.resultsPath}.tmp`;
  await writeFile(rewritten, kept.map((row) => JSON.stringify(row) + "\n").join(""), "utf8");
  await rename(rewritten, options.resultsPath);
  const reasons = [...new Set(moved.map(({ reason }) => reason))].join(", ");
  process.stderr.write(`[eval] ${moved.length} job(s) run again (${reasons}): ${moved.map(({ row }) => options.keyOf(row)).join(", ")}; their rows moved to ${path.basename(rerun.path)}, and their charges still count against the cost cap\n`);
  return kept;
}

// What the cap charged the rows a resume superseded: that money was spent, so it keeps counting.
export async function supersededCharges(supersededPath: string, evaluationId: string): Promise<number> {
  let chargeUsd = 0;
  for (const [index, entry] of (await readJsonLines<SupersededEntry>(supersededPath)).entries()) {
    const charge: unknown = entry?.row?.capChargeUsd ?? entry?.row?.estimatedCostUsd;
    if (typeof charge !== "number" || !(Number.isFinite(charge) && charge >= 0)) {
      throw new Error(`${supersededPath}:${index + 1}: malformed superseded entry`);
    }
    if (entry.row.evaluationId === evaluationId) chargeUsd += charge;
  }
  return chargeUsd;
}

// The jobs that earlier invocations started but never recorded (a crash or kill with the job in flight), and
// the reservations they held: their real cost is unknown, so each is charged its worst case. A key is re-run
// only while it has no row, so its row always comes from its last start; every other start is unfinished,
// except one whose row a resume superseded, which the superseded file charges instead.
export async function unfinishedReservations(journalPath: string, recordedKeys: Iterable<string>, evaluationId: string): Promise<{
  keys: string[];
  chargeUsd: number;
}> {
  const recorded = new Set(recordedKeys);
  const keys: string[] = [];
  let chargeUsd = 0;
  for (const [key, { held, superseded }] of await journalStarts(journalPath, evaluationId)) {
    const last = recorded.has(key) ? held.length : 0;
    const unfinished = held.filter((_, index) => index + 1 !== last && !superseded.has(index + 1));
    if (!unfinished.length) continue;
    keys.push(key);
    chargeUsd += unfinished.reduce((sum, value) => sum + value, 0);
  }
  return { keys, chargeUsd };
}

// Per key: what each start held (its reservation plus any extensions), and the ordinals of the starts whose rows a
// resume superseded.
async function journalStarts(journalPath: string, evaluationId: string): Promise<Map<string, { held: number[]; superseded: Set<number> }>> {
  const starts = new Map<string, { held: number[]; superseded: Set<number> }>();
  for (const [index, entry] of (await readJsonLines<JournalEntry>(journalPath)).entries()) {
    if (typeof entry?.key !== "string" || !(Number.isFinite(entry.reservedUsd) && entry.reservedUsd >= 0) ||
        (entry.superseded !== undefined && !(Number.isInteger(entry.superseded) && entry.superseded > 0))) {
      throw new Error(`${journalPath}:${index + 1}: malformed journal entry`);
    }
    // A directory reused for a new evaluation keeps its old journal; only this evaluation's starts count.
    if (entry.evaluationId !== evaluationId) continue;
    const job = starts.get(entry.key) ?? { held: [], superseded: new Set<number>() };
    if (entry.superseded !== undefined) job.superseded.add(entry.superseded);
    else if (entry.extension && job.held.length) job.held[job.held.length - 1]! += entry.reservedUsd;
    else job.held.push(entry.reservedUsd);
    starts.set(entry.key, job);
  }
  return starts;
}

// Freezes the manifest on the first invocation. On a later one, the stored manifest must be compatible
// with the proposed one, and the rows already written are returned for the caller to validate.
export async function openResults<Manifest, Row>(
  outputDir: string,
  proposed: Manifest,
  assertCompatible: (existing: Manifest, proposed: Manifest) => void
): Promise<{ manifest: Manifest; existing: Row[]; resultsPath: string; invalidPath: string; journalPath: string; supersededPath: string }> {
  const resultsPath = path.join(outputDir, "results.jsonl");
  const invalidPath = path.join(outputDir, "invalid-results.jsonl");
  const journalPath = path.join(outputDir, JOURNAL_FILE);
  const supersededPath = path.join(outputDir, SUPERSEDED_FILE);
  const manifestPath = path.join(outputDir, "manifest.json");
  const previous = await readJsonFile<Manifest>(manifestPath);
  const existing = await readJsonLines<Row>(resultsPath);
  if (!previous && existing.length > 0) {
    throw new Error("Refusing to resume results.jsonl without its original manifest.json");
  }
  const manifest = previous ?? proposed;
  if (previous) assertCompatible(previous, proposed);
  else await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
  return { manifest, existing, resultsPath, invalidPath, journalPath, supersededPath };
}

// A missing file reads as no lines.
export async function readJsonLines<Row>(file: string): Promise<Row[]> {
  try {
    return (await readFile(file, "utf8")).split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as Row);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function readJsonFile<T>(file: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
