import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseCommand, quoteArg } from "../../src/tools/command.js";

export type SwebenchSplit = "dev" | "holdout";
// "epoch": Epoch AI's drop-in rebuilds on ghcr.io (Docker Hub is too slow here); "official": record.image.
export type ImageSource = "epoch" | "official";

// One SWE-bench Verified instance. It carries the gold patch and the hidden test lists, so only the
// harness reads it; the agent sees agentTaskFor(record) and nothing else.
export type SwebenchRecord = {
  instance_id: string;
  repo: string;
  base_commit: string;
  environment_setup_commit: string;
  version: string;
  created_at: string;
  difficulty: string;
  eval_type: string;
  image: string;
  log_parser: string;
  patch: string;
  test_patch: string;
  eval_script: string;
  problem_statement: string;
  hints_text: string;
  FAIL_TO_PASS: string[];
  PASS_TO_PASS: string[];
};

export type SwebenchSplits = {
  schemaVersion: 1;
  dataset: string;
  datasetRevision: string;
  dev: { name: string; instanceIds: string[] };
  holdout: { name: string; instanceIds: string[] };
};

export type SwebenchExclusion = { instanceId: string; reason: string; evidence: string };

export type TestFamily = "django" | "sphinx" | "sympy" | "pytest";

export type SwebenchTestCommand = {
  // The official test command without its targets; parseCommand(base) round-trips.
  base: string;
  env: Record<string, string>;
  targetHint: string;
  family: TestFamily;
};

export type LoadedSplit = {
  split: SwebenchSplit;
  datasetRevision: string;
  dataFileSha256: string;
  // Split ids minus exclusions, in splits.json order.
  instanceIds: string[];
  // The exclusions that removed ids from this split.
  exclusions: SwebenchExclusion[];
  // Every record in the data file.
  records: Map<string, SwebenchRecord>;
};

export const SPLITS_PATH = fileURLToPath(new URL("./splits.json", import.meta.url));
export const EXCLUSIONS_PATH = fileURLToPath(new URL("./exclusions.json", import.meta.url));
export const AGENT_TASK_INSTRUCTIONS = "Resolve the issue below in the repository at /testbed by editing non-test source files. Hidden tests will verify the fix; you may run and add tests to check your work. Put temporary scripts under /testbed/.scratch/ (excluded from the final patch).";

const STRING_FIELDS = [
  "instance_id", "repo", "base_commit", "environment_setup_commit", "version", "created_at", "difficulty",
  "eval_type", "image", "log_parser", "patch", "test_patch", "eval_script", "problem_statement", "hints_text"
] as const;
const START_TEST_OUTPUT = ": '>>>>> Start Test Output'";
const END_TEST_OUTPUT = ": '>>>>> End Test Output'";
// The agent sees these. Every example is an <angle-bracket> placeholder, never a real module, class, or test
// name: a real one can name the hidden tests' location (auth_tests.test_forms did, for three instances). The
// placeholder names themselves occur in no dev or holdout instance's tests (see the leak check).
const FILE_OR_NODE_HINT = "test file paths or pytest node ids, e.g. <path/to/test_file_name.py> or <path/to/test_file_name.py>::<test_function_name>";
const FAMILIES: Record<TestFamily, { program: string; targetHint: string }> = {
  django: {
    program: "./tests/runtests.py",
    targetHint: "Django test labels relative to tests/, e.g. <app_tests>.<test_module_name> or <app_tests>.<test_module_name>.<TestCaseClass>.<test_method>"
  },
  sphinx: { program: "tox", targetHint: FILE_OR_NODE_HINT },
  sympy: { program: "bin/test", targetHint: "test file paths, e.g. <path/to/test_file_name.py>" },
  pytest: { program: "pytest", targetHint: FILE_OR_NODE_HINT }
};

// Every hint an agent can be shown, for the leak check.
export const TARGET_HINTS: readonly string[] = [...new Set(Object.values(FAMILIES).map((family) => family.targetHint))];
const IMPORT_PACKAGES: Record<string, string> = {
  "django/django": "django",
  "sphinx-doc/sphinx": "sphinx",
  "sympy/sympy": "sympy",
  "scikit-learn/scikit-learn": "sklearn",
  "matplotlib/matplotlib": "matplotlib",
  "astropy/astropy": "astropy",
  "pydata/xarray": "xarray",
  "pytest-dev/pytest": "_pytest",
  "psf/requests": "requests",
  "pylint-dev/pylint": "pylint",
  "mwaskom/seaborn": "seaborn",
  "pallets/flask": "flask"
};

export function swebenchDataPath(): string {
  return process.env.ONEHAND_SWEBENCH_DATA ?? path.join(homedir(), ".onehand", "swebench", "data", "verified.jsonl");
}

export async function loadSplits(file = SPLITS_PATH): Promise<SwebenchSplits> {
  const splits = JSON.parse(await readFile(file, "utf8")) as SwebenchSplits;
  if (splits?.schemaVersion !== 1 || typeof splits.datasetRevision !== "string" || !splits.datasetRevision) {
    throw new Error(`${file}: unsupported splits file`);
  }
  for (const name of ["dev", "holdout"] as const) {
    const ids: unknown = splits[name]?.instanceIds;
    if (!Array.isArray(ids) || !ids.length || ids.some((id) => typeof id !== "string" || !id)) {
      throw new Error(`${file}: ${name}.instanceIds must be a non-empty list of instance ids`);
    }
    if (new Set(ids).size !== ids.length) throw new Error(`${file}: ${name} lists an instance id twice`);
  }
  const overlap = splits.dev.instanceIds.filter((id) => splits.holdout.instanceIds.includes(id));
  if (overlap.length) throw new Error(`${file}: dev and holdout share ${overlap.join(", ")}`);
  return splits;
}

export async function loadRecords(file = swebenchDataPath()): Promise<{
  records: Map<string, SwebenchRecord>;
  dataFileSha256: string;
}> {
  const raw = await readFile(file);
  const records = new Map<string, SwebenchRecord>();
  for (const [index, line] of raw.toString("utf8").split("\n").entries()) {
    if (!line.trim()) continue;
    const record = normalizeRecord(JSON.parse(line), `${file}:${index + 1}`);
    if (records.has(record.instance_id)) throw new Error(`${file}: duplicate record ${record.instance_id}`);
    records.set(record.instance_id, record);
  }
  return { records, dataFileSha256: createHash("sha256").update(raw).digest("hex") };
}

// FAIL_TO_PASS and PASS_TO_PASS arrive as arrays or as JSON-encoded strings; both become arrays.
export function normalizeRecord(value: unknown, where = "SWE-bench record"): SwebenchRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${where}: expected an object`);
  const record: Record<string, unknown> = { ...(value as Record<string, unknown>) };
  for (const field of STRING_FIELDS) {
    if (typeof record[field] !== "string") throw new Error(`${where}: ${field} must be a string`);
  }
  for (const field of ["FAIL_TO_PASS", "PASS_TO_PASS"]) {
    const list: unknown = typeof record[field] === "string" ? JSON.parse(record[field] as string) : record[field];
    if (!Array.isArray(list) || list.some((item) => typeof item !== "string")) {
      throw new Error(`${where}: ${field} must be a list of test names`);
    }
    record[field] = list;
  }
  return record as SwebenchRecord;
}

export async function loadExclusions(file = EXCLUSIONS_PATH): Promise<SwebenchExclusion[]> {
  const value: unknown = JSON.parse(await readFile(file, "utf8"));
  if (!Array.isArray(value)) throw new Error(`${file}: expected a list of exclusions`);
  const seen = new Set<string>();
  return value.map((entry: Record<string, unknown>, index) => {
    for (const field of ["instanceId", "reason", "evidence"]) {
      if (typeof entry?.[field] !== "string" || !(entry[field] as string).trim()) {
        throw new Error(`${file}[${index}]: ${field} must be a non-empty string`);
      }
    }
    const exclusion = { instanceId: entry.instanceId as string, reason: entry.reason as string, evidence: entry.evidence as string };
    if (seen.has(exclusion.instanceId)) throw new Error(`${file}: ${exclusion.instanceId} is excluded twice`);
    seen.add(exclusion.instanceId);
    return exclusion;
  });
}

export async function loadSwebenchSplit(split: SwebenchSplit, files: {
  splits?: string;
  data?: string;
  exclusions?: string;
} = {}): Promise<LoadedSplit> {
  const [splits, { records, dataFileSha256 }, exclusions] = await Promise.all([
    loadSplits(files.splits), loadRecords(files.data), loadExclusions(files.exclusions)
  ]);
  const splitIds = [...splits.dev.instanceIds, ...splits.holdout.instanceIds];
  const missing = splitIds.filter((id) => !records.has(id));
  if (missing.length) throw new Error(`SWE-bench data file has no record for split ids: ${missing.join(", ")}`);
  const stray = exclusions.filter((entry) => !splitIds.includes(entry.instanceId));
  if (stray.length) throw new Error(`Exclusions name ids outside dev and holdout: ${stray.map((entry) => entry.instanceId).join(", ")}`);
  const ids = splits[split].instanceIds;
  const applied = exclusions.filter((entry) => ids.includes(entry.instanceId));
  const excluded = new Set(applied.map((entry) => entry.instanceId));
  return {
    split,
    datasetRevision: splits.datasetRevision,
    dataFileSha256,
    instanceIds: ids.filter((id) => !excluded.has(id)),
    exclusions: applied,
    records
  };
}

// The agent sees the issue text and fixed instructions only: never the gold patch, the test patch,
// the hints, the FAIL_TO_PASS/PASS_TO_PASS names, or the eval script.
export function agentTaskFor(record: SwebenchRecord): string {
  return `${AGENT_TASK_INSTRUCTIONS}\n\n<issue>\n${record.problem_statement.trim()}\n</issue>\n`;
}

export function testCommandFor(record: SwebenchRecord): SwebenchTestCommand {
  return parseOfficialTestCommand(record).command;
}

// The targets the official eval script appends, derived from the test patch. Harness-side only.
export function officialTestTargets(record: SwebenchRecord): string[] {
  return parseOfficialTestCommand(record).targets;
}

// The instance image for a source. Epoch names images by the verbatim instance id (no _1776_ rewrite).
export function imageFor(record: Pick<SwebenchRecord, "instance_id" | "image">, source: ImageSource): string {
  return source === "official" ? record.image : `ghcr.io/epoch-research/swe-bench.eval.x86_64.${record.instance_id}:latest`;
}

export function importPackageFor(repo: string): string {
  const name = IMPORT_PACKAGES[repo];
  if (!name) throw new Error(`No import package is known for ${repo}`);
  return name;
}

export function taskHashFor(record: SwebenchRecord): string {
  return createHash("sha256").update(stableJson(record)).digest("hex");
}

// Every file a patch touches, from its `diff --git a/X b/Y` headers.
export function patchFiles(patch: string): string[] {
  const files = new Set<string>();
  for (const match of patch.matchAll(/^diff --git a\/(\S+) b\/(\S+)$/gm)) {
    files.add(match[1]!);
    files.add(match[2]!);
  }
  return [...files];
}

function parseOfficialTestCommand(record: SwebenchRecord): { command: SwebenchTestCommand; targets: string[] } {
  const id = record.instance_id;
  const lines = record.eval_script.split("\n");
  const start = lines.indexOf(START_TEST_OUTPUT);
  const end = lines.indexOf(END_TEST_OUTPUT);
  if (start < 0 || end < start) throw new Error(`${id}: eval_script has no test output markers`);
  const commandLines = lines.slice(start + 1, end).filter((line) => line.trim());
  if (commandLines.length !== 1) throw new Error(`${id}: expected one test command line, found ${commandLines.length}`);

  const env: Record<string, string> = {};
  let heredoc: string | null = null;
  for (const line of lines.slice(0, start)) {
    // Heredoc bodies (the applied test patch) are data, not script lines.
    if (heredoc !== null) {
      if (line === heredoc) heredoc = null;
      continue;
    }
    heredoc = /<<-?\s*'?([A-Za-z0-9_]+)'?\s*$/.exec(line)?.[1] ?? null;
    if (/^export\s/.test(line)) {
      for (const assignment of parseCommand(line).args) addAssignment(env, assignment, id);
    }
  }
  if (heredoc !== null) throw new Error(`${id}: eval_script has an unterminated heredoc (${heredoc})`);
  const parsed = parseCommand(commandLines[0]!);
  const tokens = [parsed.program, ...parsed.args];
  while (tokens.length > 1 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0]!)) addAssignment(env, tokens.shift()!, id);
  for (const token of tokens) {
    if (/[$`]/.test(token)) throw new Error(`${id}: shell expansion is not supported in the test command: ${token}`);
  }

  const family: TestFamily = record.repo === "django/django" ? "django"
    : record.repo === "sphinx-doc/sphinx" ? "sphinx"
      : record.repo === "sympy/sympy" ? "sympy" : "pytest";
  if (tokens[0] !== FAMILIES[family].program) throw new Error(`${id}: unexpected ${family} test program ${tokens[0]}`);
  const files = patchFiles(record.test_patch);
  const candidates = new Set(family === "django" ? [...files, ...files.map(djangoLabel)] : files);
  let cut = tokens.length;
  while (cut > 1 && candidates.has(tokens[cut - 1]!)) cut--;
  const base = tokens.slice(0, cut);
  const targets = tokens.slice(cut);
  if (!targets.length) throw new Error(`${id}: the test command ends with no test_patch target`);
  const leftover = base.slice(1).filter((token) => candidates.has(token) || looksLikeTarget(token));
  if (leftover.length) throw new Error(`${id}: test targets remain in the base command: ${leftover.join(" ")}`);

  const joined = base.map(quoteArg).join(" ");
  const reparsed = parseCommand(joined);
  if ([reparsed.program, ...reparsed.args].join("\0") !== base.join("\0")) {
    throw new Error(`${id}: the base test command does not round-trip: ${joined}`);
  }
  return { command: { base: joined, env, targetHint: FAMILIES[family].targetHint, family }, targets };
}

function addAssignment(env: Record<string, string>, assignment: string, id: string): void {
  const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s.exec(assignment);
  if (!match) throw new Error(`${id}: unsupported environment assignment: ${assignment}`);
  if (/[$`]/.test(match[2]!)) throw new Error(`${id}: shell expansion is not supported in ${match[1]}`);
  env[match[1]!] = match[2]!;
}

// Mirrors the harness: tests/auth_tests/test_forms.py -> auth_tests.test_forms.
function djangoLabel(file: string): string {
  return file.replace(/\.py$/, "").replace(/^tests\//, "").replaceAll("/", ".");
}

function looksLikeTarget(token: string): boolean {
  return !token.startsWith("-") &&
    (token.endsWith(".py") || token.includes("/") || token.includes("::") || /^[A-Za-z_]\w*(\.\w+)+$/.test(token));
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
