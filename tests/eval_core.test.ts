import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FatalJobError, InvalidResultError, JobLoopOptions, runJobs, supersededCharges, unfinishedReservations } from "../eval/core.js";
import { cleanupTempDir, makeTempDir } from "./helpers.js";

type Job = { key: string; cost: number };
type Row = {
  evaluationId: string;
  id: string;
  estimatedCostUsd: number;
  retryCostUsd?: number;
  capChargeUsd?: number;
  status: "ok" | "thrown" | "invalid" | "outage";
  note?: string;
  [extra: string]: unknown;
};

const EVALUATION = "eval-core";
const dirs: string[] = [];
afterEach(async () => Promise.all(dirs.splice(0).map(cleanupTempDir)));

function jobs(...costs: number[]): Job[] {
  return costs.map((cost, index) => ({ key: `job-${index + 1}`, cost }));
}

async function run(overrides: Partial<JobLoopOptions<Job, Row>> & { jobs: Job[] }) {
  const dir = overrides.resultsPath ? path.dirname(overrides.resultsPath) : await makeTempDir("onehand-core-");
  if (!overrides.resultsPath) dirs.push(dir);
  const result = await runJobs<Job, Row>({
    evaluationId: EVALUATION,
    existing: [],
    concurrency: 1,
    costCapUsd: 10,
    reservationUsd: 4,
    resultsPath: path.join(dir, "results.jsonl"),
    invalidPath: path.join(dir, "invalid-results.jsonl"),
    keyOf: (row) => row.id,
    execute: async (job) => ({ evaluationId: EVALUATION, id: job.key, estimatedCostUsd: job.cost, status: "ok" }),
    validate: (rows) => {
      const seen = new Set<string>();
      for (const row of rows) {
        if (seen.has(row.id)) throw new Error(`Duplicate ${row.id}`);
        seen.add(row.id);
        if (!Number.isFinite(row.estimatedCostUsd) || row.estimatedCostUsd < 0) throw new Error(`Invalid cost for ${row.id}`);
        if (row.poisoned) throw new Error(`Poisoned row ${row.id}`);
      }
    },
    substitute: (job, error, charge) => ({
      evaluationId: EVALUATION,
      id: job.key,
      estimatedCostUsd: error instanceof InvalidResultError ? charge : 0,
      capChargeUsd: charge,
      status: error instanceof InvalidResultError ? "invalid" : "thrown",
      note: (error as Error).message
    }),
    ...overrides
  });
  return { ...result, dir, file: async (name: string) => readJsonl(path.join(dir, name)) };
}

async function readJsonl(file: string): Promise<Array<Record<string, any>>> {
  const text = await readFile(file, "utf8").catch(() => "");
  return text.split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

async function until(condition: () => boolean): Promise<void> {
  for (let tick = 0; tick < 2_000 && !condition(); tick += 1) await new Promise((resolve) => setTimeout(resolve, 1));
  expect(condition()).toBe(true);
}

describe("evaluation job loop", () => {
  it("charges each row its cost and stops before a job whose reservation would pass the cap", async () => {
    const executed: string[] = [];
    const { rows, capReached, file } = await run({
      jobs: jobs(3, 3, 3, 3, 3),
      execute: async (job) => {
        executed.push(job.key);
        return { evaluationId: EVALUATION, id: job.key, estimatedCostUsd: job.cost, status: "ok" };
      }
    });
    // 0+4, 3+4, and 6+4 fit a cap of 10; 9+4 does not.
    expect(executed).toEqual(["job-1", "job-2", "job-3"]);
    expect(capReached).toBe(true);
    expect(rows.map((row) => row.capChargeUsd)).toEqual([3, 3, 3]);
    expect(await file("results.jsonl")).toEqual(rows);
  });

  it("holds a reservation for every job in flight", async () => {
    let inFlight = 0;
    let peak = 0;
    const { rows } = await run({
      jobs: jobs(0.5, 0.5, 0.5, 0.5, 0.5, 0.5),
      concurrency: 3,
      execute: async (job) => {
        peak = Math.max(peak, ++inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight -= 1;
        return { evaluationId: EVALUATION, id: job.key, estimatedCostUsd: job.cost, status: "ok" };
      }
    });
    // A third concurrent start would hold 3 × 4 = 12 against a cap of 10.
    expect(peak).toBe(2);
    expect(rows).toHaveLength(6);
  });

  it("records a thrown job at zero cost but charges it the full reservation", async () => {
    let calls = 0;
    const { rows, capReached } = await run({
      jobs: jobs(1, 1, 1),
      costCapUsd: 6,
      execute: async () => {
        calls += 1;
        throw new Error("workspace setup failed");
      }
    });
    expect(calls).toBe(1);
    expect(capReached).toBe(true);
    expect(rows).toEqual([{
      evaluationId: EVALUATION, id: "job-1", estimatedCostUsd: 0, capChargeUsd: 4, status: "thrown", note: "workspace setup failed"
    }]);
  });

  it("persists capChargeUsd, so a resume rebuilds what the cap actually charged and skips finished jobs", async () => {
    const first = await run({
      jobs: jobs(1, 1),
      costCapUsd: 6,
      execute: async () => { throw new Error("container start failed"); }
    });
    const stored = (await first.file("results.jsonl")) as Row[];
    expect(stored).toEqual([expect.objectContaining({ id: "job-1", estimatedCostUsd: 0, capChargeUsd: 4 })]);

    const executed: string[] = [];
    const execute = async (job: Job): Promise<Row> => {
      executed.push(job.key);
      return { evaluationId: EVALUATION, id: job.key, estimatedCostUsd: job.cost, status: "ok" };
    };
    const resultsPath = path.join(first.dir, "results.jsonl");
    // Spent is rebuilt as 4 (the charge), not 0 (the row's cost): 4 + 4 > 6 still blocks job-2.
    const blocked = await run({ jobs: jobs(1, 1), costCapUsd: 6, existing: stored, resultsPath, execute });
    expect(executed).toEqual([]);
    expect(blocked.capReached).toBe(true);
    // Rows without capChargeUsd fall back to their estimated cost.
    const legacy = stored.map(({ capChargeUsd: _charge, ...row }) => row);
    const unblocked = await run({ jobs: jobs(1, 1), costCapUsd: 6, existing: legacy, resultsPath, execute });
    expect(executed).toEqual(["job-2"]);
    expect(unblocked.rows.map((row) => row.id)).toEqual(["job-1", "job-2"]);
  });

  it("substitutes an invalid row, charges its original cost, and audits a redacted copy", async () => {
    const secret = "sk-leaked1234567890secret";
    const { rows, file, dir } = await run({
      jobs: jobs(0.25, 0.25),
      execute: async (job) => ({
        evaluationId: EVALUATION,
        id: job.key,
        estimatedCostUsd: job.key === "job-1" ? job.cost : Number.NaN,
        status: "ok",
        poisoned: true,
        finalMessage: `token used: ${secret}`,
        trace: [{ reasoning_content: "private chain of thought", apiKey: secret }]
      })
    });
    expect(rows).toEqual([
      { evaluationId: EVALUATION, id: "job-1", estimatedCostUsd: 0.25, capChargeUsd: 0.25, status: "invalid", note: "Invalid run result: Poisoned row job-1" },
      // An unusable cost is charged the reservation.
      { evaluationId: EVALUATION, id: "job-2", estimatedCostUsd: 4, capChargeUsd: 4, status: "invalid", note: "Invalid run result: Invalid cost for job-2" }
    ]);
    const audit = await file("invalid-results.jsonl");
    expect(audit.map((entry) => entry.error)).toEqual(["Poisoned row job-1", "Invalid cost for job-2"]);
    expect(audit[0]).toMatchObject({ at: expect.any(String), original: { id: "job-1", poisoned: true } });
    expect(audit[0]!.original.trace).toEqual([{ reasoning_content: "[REDACTED]", apiKey: "[REDACTED]" }]);
    const raw = await readFile(path.join(dir, "invalid-results.jsonl"), "utf8");
    expect(raw).not.toContain(secret);
    expect(raw).not.toContain("private chain of thought");
  });

  it("substitutes a row that belongs to another job or evaluation instead of misattributing it", async () => {
    const { rows } = await run({
      jobs: jobs(0.1, 0.1, 0.1),
      execute: async (job) => ({
        evaluationId: job.key === "job-3" ? "another-evaluation" : EVALUATION,
        // Every row claims to be job-1; only job-1's may keep that identity.
        id: job.key === "job-3" ? "job-3" : "job-1",
        estimatedCostUsd: job.cost,
        status: "ok"
      })
    });
    expect(rows.map((row) => [row.id, row.status, row.note])).toEqual([
      ["job-1", "ok", undefined],
      ["job-2", "invalid", "Invalid run result: Result does not match its job: expected job-2, got job-1"],
      ["job-3", "invalid", "Invalid run result: Result does not match its job: expected job-3, got job-3"]
    ]);
  });

  it("starts jobs in queue order, keeps at most N in flight, and appends rows as they finish", async () => {
    const gates = new Map<string, () => void>();
    const started: string[] = [];
    const finished: string[] = [];
    const pending = run({
      jobs: jobs(0.1, 0.1, 0.1, 0.1),
      concurrency: 2,
      costCapUsd: 100,
      execute: async (job) => {
        started.push(job.key);
        await new Promise<void>((resolve) => gates.set(job.key, resolve));
        return { evaluationId: EVALUATION, id: job.key, estimatedCostUsd: job.cost, status: "ok" };
      },
      onRow: (row) => finished.push(row.id)
    });
    await until(() => started.length === 2);
    expect(started).toEqual(["job-1", "job-2"]);
    // A worker takes the next queued job only after its row is written.
    gates.get("job-2")!();
    await until(() => started.length === 3);
    expect([started, finished]).toEqual([["job-1", "job-2", "job-3"], ["job-2"]]);
    gates.get("job-3")!();
    await until(() => started.length === 4);
    gates.get("job-4")!();
    await until(() => finished.length === 3);
    gates.get("job-1")!();
    const { rows, file } = await pending;
    expect(finished).toEqual(["job-2", "job-3", "job-4", "job-1"]);
    expect(rows.map((row) => row.id)).toEqual(finished);
    expect((await file("results.jsonl")).map((row) => row.id)).toEqual(finished);
  });

  it("journals every job start, with its reservation, before the job runs", async () => {
    const dir = await makeTempDir("onehand-core-");
    dirs.push(dir);
    const journalPath = path.join(dir, "eval-journal.jsonl");
    const seenAtStart: string[][] = [];
    await run({
      jobs: jobs(1, 1),
      resultsPath: path.join(dir, "results.jsonl"),
      journalPath,
      execute: async (job) => {
        seenAtStart.push((await readJsonl(journalPath)).map((entry) => entry.key));
        return { evaluationId: EVALUATION, id: job.key, estimatedCostUsd: job.cost, status: "ok" };
      }
    });
    expect(seenAtStart).toEqual([["job-1"], ["job-1", "job-2"]]);
    expect(await readJsonl(journalPath)).toEqual([
      { evaluationId: EVALUATION, key: "job-1", reservedUsd: 4, at: expect.any(String) },
      { evaluationId: EVALUATION, key: "job-2", reservedUsd: 4, at: expect.any(String) }
    ]);
  });

  it("charges the reservation of a job a crash left without a row, warns, and keeps charging it after the rerun", async () => {
    const dir = await makeTempDir("onehand-core-");
    dirs.push(dir);
    const journalPath = path.join(dir, "eval-journal.jsonl");
    // job-1 finished; job-2 started and the invocation died before its row.
    // An older evaluation that used this directory left its own starts, which never count here.
    await writeFile(journalPath, [
      { evaluationId: "an-older-evaluation", key: "job-2", reservedUsd: 4, at: "t" },
      { evaluationId: EVALUATION, key: "job-1", reservedUsd: 4, at: "t" },
      { evaluationId: EVALUATION, key: "job-2", reservedUsd: 4, at: "t" }
    ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
    const existing: Row[] = [{ evaluationId: EVALUATION, id: "job-1", estimatedCostUsd: 1, capChargeUsd: 1, status: "ok" }];
    const executed: string[] = [];
    const execute = async (job: Job): Promise<Row> => {
      executed.push(job.key);
      return { evaluationId: EVALUATION, id: job.key, estimatedCostUsd: job.cost, status: "ok" };
    };
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    let warned: string;
    try {
      // Spent is 1 + 4: another reservation of 4 passes a cap of 8, so job-2 cannot rerun.
      const blocked = await run({ jobs: jobs(1, 1), costCapUsd: 8, existing, resultsPath: path.join(dir, "results.jsonl"), journalPath, execute });
      expect([executed, blocked.capReached]).toEqual([[], true]);
      warned = stderr.mock.calls.map(([text]) => String(text)).join("");
    } finally {
      stderr.mockRestore();
    }
    expect(warned).toContain("1 job(s) were in flight when an earlier invocation stopped (job-2); charging their reservations, $4.0000, against the cost cap");
    // Without the journal, nothing would hold it back.
    await run({ jobs: jobs(1, 1), costCapUsd: 8, existing, resultsPath: path.join(dir, "results.jsonl"), execute });
    expect(executed).toEqual(["job-2"]);

    // Its rerun (the key's last start) produced the row; the crashed start is still charged.
    await writeFile(journalPath, ["job-1", "job-2", "job-2"].map((key) => JSON.stringify({ evaluationId: EVALUATION, key, reservedUsd: 4, at: "t" })).join("\n") + "\n");
    expect(await unfinishedReservations(journalPath, ["job-1", "job-2"], EVALUATION)).toEqual({ keys: ["job-2"], chargeUsd: 4 });
    expect(await unfinishedReservations(journalPath, [], "another-evaluation")).toEqual({ keys: [], chargeUsd: 0 });
    expect(await unfinishedReservations(path.join(dir, "missing.jsonl"), [], EVALUATION)).toEqual({ keys: [], chargeUsd: 0 });
    // A reservation that is not a number would make the cap arithmetic NaN and so disable it.
    await writeFile(journalPath, JSON.stringify({ evaluationId: EVALUATION, key: "job-1", reservedUsd: "4", at: "t" }) + "\n");
    await expect(unfinishedReservations(journalPath, [], EVALUATION)).rejects.toThrow(/eval-journal\.jsonl:1: malformed journal entry/);
  });

  it("holds an extra reservation on request, and charges a thrown job everything it held", async () => {
    const dir = await makeTempDir("onehand-core-");
    dirs.push(dir);
    const journalPath = path.join(dir, "eval-journal.jsonl");
    const granted: boolean[] = [];
    const { rows } = await run({
      jobs: jobs(1),
      costCapUsd: 10,
      resultsPath: path.join(dir, "results.jsonl"),
      journalPath,
      execute: async (_job, context) => {
        // Holding 4, a further 7 would pass the cap of 10; 3 fits exactly.
        granted.push(await context.reserve(7), await context.reserve(3), await context.reserve(-1));
        throw new Error("retry threw");
      }
    });
    expect(granted).toEqual([false, true, false]);
    expect(rows).toEqual([expect.objectContaining({ id: "job-1", status: "thrown", estimatedCostUsd: 0, capChargeUsd: 7 })]);
    expect((await readJsonl(journalPath)).map(({ key, reservedUsd, extension }) => [key, reservedUsd, extension])).toEqual([
      ["job-1", 4, undefined], ["job-1", 3, true]
    ]);
    // Had the invocation died there, the resume would charge the start and its extension together.
    expect(await unfinishedReservations(journalPath, [], EVALUATION)).toEqual({ keys: ["job-1"], chargeUsd: 7 });
  });

  it("stops at a fatal job error: jobs in flight finish, no job starts, and the error is rethrown", async () => {
    const dir = await makeTempDir("onehand-core-");
    dirs.push(dir);
    const journalPath = path.join(dir, "eval-journal.jsonl");
    let releaseFirst: () => void = () => undefined;
    const started: string[] = [];
    let extraAfterFatal: boolean | undefined;
    const pending = run({
      jobs: jobs(0.1, 0.1, 0.1, 0.1),
      concurrency: 2,
      costCapUsd: 10,
      resultsPath: path.join(dir, "results.jsonl"),
      journalPath,
      execute: async (job, context) => {
        started.push(job.key);
        if (job.key === "job-2") throw new FatalJobError("image changed");
        if (job.key === "job-1") {
          await new Promise<void>((resolve) => { releaseFirst = resolve; });
          // job-2's spend is unknown, so its 4 stays charged: 4 + 4 held here + 3 passes the cap of 10.
          extraAfterFatal = await context.reserve(3);
        }
        return { evaluationId: EVALUATION, id: job.key, estimatedCostUsd: job.cost, status: "ok" };
      }
    });
    await until(() => started.length === 2);
    releaseFirst();
    await expect(pending).rejects.toThrow("image changed");
    expect([started, extraAfterFatal]).toEqual([["job-1", "job-2"], false]);
    expect((await readJsonl(path.join(dir, "results.jsonl"))).map((row) => row.id)).toEqual(["job-1"]);
    // job-2 keeps its journal entry, so a resume charges it.
    expect(await unfinishedReservations(journalPath, ["job-1"], EVALUATION)).toEqual({ keys: ["job-2"], chargeUsd: 4 });
  });

  it("charges a row its final attempt plus the attempts it discarded, and so an invalid row too", async () => {
    const executed: string[] = [];
    const { rows, capReached } = await run({
      jobs: jobs(1, 1, 1, 1),
      execute: async (job) => {
        executed.push(job.key);
        return { evaluationId: EVALUATION, id: job.key, estimatedCostUsd: job.cost, retryCostUsd: 2, status: "ok", ...(job.key === "job-2" ? { poisoned: true } : {}) };
      }
    });
    // 0+4, 3+4, and 6+4 fit a cap of 10; 9+4 does not. Counting only the final attempts, job-4 would have run.
    expect([executed, capReached]).toEqual([["job-1", "job-2", "job-3"], true]);
    expect(rows.map((row) => [row.id, row.status, row.estimatedCostUsd, row.retryCostUsd, row.capChargeUsd])).toEqual([
      ["job-1", "ok", 1, 2, 3],
      // The invalid row's substitute is charged both attempts, as the audited amount.
      ["job-2", "invalid", 3, undefined, 3],
      ["job-3", "ok", 1, 2, 3]
    ]);
    // A discarded attempt whose cost is unusable leaves the invalid row charged the reservation.
    const unusable = await run({
      jobs: jobs(1),
      execute: async (job) => ({ evaluationId: EVALUATION, id: job.key, estimatedCostUsd: 1, retryCostUsd: -1, status: "ok", poisoned: true })
    });
    expect(unusable.rows.map((row) => row.capChargeUsd)).toEqual([4]);
  });

  it("runs a superseded row's job again, keeps charging the row, and never reads its start as a crash", async () => {
    const dir = await makeTempDir("onehand-core-");
    dirs.push(dir);
    const resultsPath = path.join(dir, "results.jsonl");
    const journalPath = path.join(dir, "eval-journal.jsonl");
    const supersededPath = path.join(dir, "superseded-results.jsonl");
    const secret = "sk-leaked1234567890secret";
    // An earlier invocation: job-1 finished, and an outage ended job-2 after it had held 2 more for a retry.
    const outage: Row = {
      evaluationId: EVALUATION, id: "job-2", estimatedCostUsd: 1, retryCostUsd: 2, capChargeUsd: 3, status: "outage", note: `provider said ${secret}`
    };
    const finished: Row = { evaluationId: EVALUATION, id: "job-1", estimatedCostUsd: 1, capChargeUsd: 1, status: "ok" };
    await writeFile(resultsPath, [finished, outage].map((row) => JSON.stringify(row) + "\n").join(""));
    await writeFile(journalPath, [
      { evaluationId: EVALUATION, key: "job-1", reservedUsd: 4, at: "t" },
      { evaluationId: EVALUATION, key: "job-2", reservedUsd: 4, at: "t" },
      { evaluationId: EVALUATION, key: "job-2", reservedUsd: 2, at: "t", extension: true }
    ].map((entry) => JSON.stringify(entry) + "\n").join(""));
    const rerun = { path: supersededPath, reason: (row: Row) => row.status === "outage" ? "outage rerun" : undefined };
    const executed: string[] = [];
    const execute = async (job: Job): Promise<Row> => {
      executed.push(job.key);
      return { evaluationId: EVALUATION, id: job.key, estimatedCostUsd: job.cost, status: "ok" };
    };
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    let warned: string;
    let blocked: Awaited<ReturnType<typeof run>>;
    try {
      // Spent is 1 + 3 (the superseded row, still charged): job-2's reservation of 4 passes a cap of 7.5.
      blocked = await run({ jobs: jobs(1, 1), costCapUsd: 7.5, existing: [finished, outage], resultsPath, journalPath, rerun, execute });
      warned = stderr.mock.calls.map(([text]) => String(text)).join("");
    } finally {
      stderr.mockRestore();
    }
    expect([executed, blocked.capReached, blocked.rows]).toEqual([[], true, [finished]]);
    expect(warned).toContain("[eval] 1 job(s) run again (outage rerun): job-2; their rows moved to superseded-results.jsonl, and their charges still count against the cost cap");
    // Its start is marked superseded in the journal, so it is not a crash either.
    expect(warned).not.toContain("in flight");
    expect(await readJsonl(resultsPath)).toEqual([finished]);
    expect(await readJsonl(supersededPath)).toEqual([
      { at: expect.any(String), reason: "outage rerun", row: { ...outage, note: "provider said [REDACTED_KEY]" } }
    ]);
    expect(await readFile(supersededPath, "utf8")).not.toContain(secret);
    expect((await readJsonl(journalPath)).at(-1)).toEqual({ evaluationId: EVALUATION, key: "job-2", reservedUsd: 0, at: expect.any(String), superseded: 1 });
    expect(await unfinishedReservations(journalPath, ["job-1"], EVALUATION)).toEqual({ keys: [], chargeUsd: 0 });
    expect(await supersededCharges(supersededPath, EVALUATION)).toBe(3);
    expect(await supersededCharges(supersededPath, "another-evaluation")).toBe(0);

    // A cap of 8 fits it exactly; the resume reads results.jsonl as it now stands.
    const resumed = await run({ jobs: jobs(1, 1), costCapUsd: 8, existing: await readJsonl(resultsPath) as Row[], resultsPath, journalPath, rerun, execute });
    expect(executed).toEqual(["job-2"]);
    expect(resumed.rows.map((row) => [row.id, row.status])).toEqual([["job-1", "ok"], ["job-2", "ok"]]);
    // Exactly one row per job, and neither start of job-2 is unfinished.
    expect((await readJsonl(resultsPath)).map((row) => row.id)).toEqual(["job-1", "job-2"]);
    expect(await unfinishedReservations(journalPath, ["job-1", "job-2"], EVALUATION)).toEqual({ keys: [], chargeUsd: 0 });
    expect(await readJsonl(supersededPath)).toHaveLength(1);

    // An unusable charge would disable the cap, and so would an ordinal that names no start.
    await writeFile(supersededPath, JSON.stringify({ at: "t", reason: "x", row: { evaluationId: EVALUATION, estimatedCostUsd: "3" } }) + "\n");
    await expect(supersededCharges(supersededPath, EVALUATION)).rejects.toThrow(/superseded-results\.jsonl:1: malformed superseded entry/);
    await writeFile(journalPath, JSON.stringify({ evaluationId: EVALUATION, key: "job-1", reservedUsd: 0, at: "t", superseded: 0 }) + "\n");
    await expect(unfinishedReservations(journalPath, [], EVALUATION)).rejects.toThrow(/eval-journal\.jsonl:1: malformed journal entry/);
  });

  it("supersedes a row once and charges it once, whichever step a crash interrupted", async () => {
    const dir = await makeTempDir("onehand-core-");
    dirs.push(dir);
    const resultsPath = path.join(dir, "results.jsonl");
    const journalPath = path.join(dir, "eval-journal.jsonl");
    const supersededPath = path.join(dir, "superseded-results.jsonl");
    const outage: Row = { evaluationId: EVALUATION, id: "job-1", estimatedCostUsd: 3, retryCostUsd: 0, capChargeUsd: 3, status: "outage" };
    // job-1's first start crashed and its second produced the outage row; a resume then marked that second start and
    // recorded the row, but crashed before it rewrote results.jsonl.
    await writeFile(resultsPath, JSON.stringify(outage) + "\n");
    await writeFile(journalPath, [
      { evaluationId: EVALUATION, key: "job-1", reservedUsd: 4, at: "t" },
      { evaluationId: EVALUATION, key: "job-1", reservedUsd: 4, at: "t" },
      { evaluationId: EVALUATION, key: "job-1", reservedUsd: 0, at: "t", superseded: 2 }
    ].map((entry) => JSON.stringify(entry) + "\n").join(""));
    await writeFile(supersededPath, JSON.stringify({ at: "t", reason: "outage rerun", row: outage }) + "\n");
    const executed: string[] = [];
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      // Spent is 3 (the row, once) + 4 (the crashed start): another 4 fits a cap of 11 only if nothing counts twice.
      await run({
        jobs: jobs(1), costCapUsd: 11, existing: [outage], resultsPath, journalPath,
        rerun: { path: supersededPath, reason: (row) => row.status === "outage" ? "outage rerun" : undefined },
        execute: async (job) => {
          executed.push(job.key);
          return { evaluationId: EVALUATION, id: job.key, estimatedCostUsd: job.cost, status: "ok" };
        }
      });
    } finally {
      stderr.mockRestore();
    }
    expect(executed).toEqual(["job-1"]);
    expect(await readJsonl(supersededPath)).toHaveLength(1);
    expect((await readJsonl(resultsPath)).map((row) => [row.id, row.status])).toEqual([["job-1", "ok"]]);
    // Only the crashed first start is unfinished; the repeated marker names the same start.
    expect(await unfinishedReservations(journalPath, ["job-1"], EVALUATION)).toEqual({ keys: ["job-1"], chargeUsd: 4 });
  });

  it("opens the breaker after N consecutive tripping rows: no job starts, and the jobs in flight finish", async () => {
    const trips = (row: Row) => row.status === "outage";
    const outcome = (key: string, outages: string[]): Row["status"] => outages.includes(key) ? "outage" : "ok";
    // One at a time: a row that does not trip it resets the count.
    const executed: string[] = [];
    const opened: number[] = [];
    const sequential = await run({
      jobs: jobs(0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1),
      costCapUsd: 100,
      execute: async (job) => {
        executed.push(job.key);
        return { evaluationId: EVALUATION, id: job.key, estimatedCostUsd: job.cost, status: outcome(job.key, ["job-1", "job-2", "job-4", "job-5", "job-6"]) };
      },
      breaker: { after: 3, trips, onOpen: () => opened.push(executed.length) }
    });
    expect([executed, opened, sequential.breakerOpen, sequential.capReached]).toEqual([
      ["job-1", "job-2", "job-3", "job-4", "job-5", "job-6"], [6], true, false
    ]);
    expect(sequential.rows).toHaveLength(6);

    // Across workers, in the order jobs finish: job-2 is still running when job-1, job-3, and job-4 fail.
    let releaseSecond: () => void = () => undefined;
    const started: string[] = [];
    const pending = run({
      jobs: jobs(0.1, 0.1, 0.1, 0.1, 0.1, 0.1),
      concurrency: 2,
      costCapUsd: 100,
      execute: async (job) => {
        started.push(job.key);
        if (job.key === "job-2") await new Promise<void>((resolve) => { releaseSecond = resolve; });
        return { evaluationId: EVALUATION, id: job.key, estimatedCostUsd: job.cost, status: outcome(job.key, ["job-1", "job-3", "job-4", "job-5", "job-6"]) };
      },
      breaker: { after: 3, trips }
    });
    await until(() => started.length === 4);
    releaseSecond();
    const concurrent = await pending;
    // job-2 finished and reset the count, but nothing starts once the breaker is open.
    expect([started, concurrent.breakerOpen]).toEqual([["job-1", "job-2", "job-3", "job-4"], true]);
    expect(concurrent.rows.map((row) => row.id)).toEqual(["job-1", "job-3", "job-4", "job-2"]);
    expect((await concurrent.file("results.jsonl")).map((row) => row.id)).toEqual(["job-1", "job-3", "job-4", "job-2"]);

    // Without a breaker, nothing stops.
    const unguarded = await run({
      jobs: jobs(0.1, 0.1, 0.1, 0.1),
      costCapUsd: 100,
      execute: async (job) => ({ evaluationId: EVALUATION, id: job.key, estimatedCostUsd: job.cost, status: "outage" })
    });
    expect([unguarded.rows.length, unguarded.breakerOpen]).toEqual([4, false]);
  });

  it("stops every worker when writing or reporting a row fails, and fails after the jobs in flight finish", async () => {
    let releaseSecond: () => void = () => undefined;
    const started: string[] = [];
    const pending = run({
      jobs: jobs(0.1, 0.1, 0.1),
      concurrency: 2,
      costCapUsd: 100,
      execute: async (job) => {
        started.push(job.key);
        if (job.key === "job-2") await new Promise<void>((resolve) => { releaseSecond = resolve; });
        return { evaluationId: EVALUATION, id: job.key, estimatedCostUsd: job.cost, status: "ok" };
      },
      onRow: (row) => {
        if (row.id === "job-1") throw new Error("disk full");
      }
    });
    await until(() => started.length === 2);
    releaseSecond();
    await expect(pending).rejects.toThrow("disk full");
    // job-2 was in flight and finished; job-3 never started.
    expect(started).toEqual(["job-1", "job-2"]);
  });
});
