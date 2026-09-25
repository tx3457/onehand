import { execFile } from "node:child_process";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { estimateCost, priceSnapshotFor } from "../src/pricing.js";
import { bootstrapMeanCi } from "../eval/stats.js";
import { loadSplits, normalizeRecord } from "../eval/swebench/dataset.js";
import { gradeExternal, ExternalOptions, readMiniTrajectory } from "../eval/swebench/external.js";
import { cleanupTempDir, makeTempDir } from "./helpers.js";

const exec = promisify(execFile);
const PRICE = priceSnapshotFor("deepseek-flash");
const PINNED = `sha256:${"a".repeat(64)}`;
const IDS = ["owner__repo-1", "owner__repo-2", "owner__repo-3"];
const PATCH = "diff --git a/a.py b/a.py\n--- a/a.py\n+++ b/a.py\n@@ -1 +1 @@\n-a\n+b\n";
const FAKE_HARNESS = `#!/usr/bin/env node
const fs = require('node:fs'), path = require('node:path');
const args = process.argv.slice(2);
if (args[0] === '-c') { console.log(fs.readFileSync(path.join(__dirname, 'version'), 'utf8')); process.exit(0); }
const value = flag => args[args.indexOf(flag) + 1];
const prediction = JSON.parse(fs.readFileSync(value('-p'), 'utf8'));
const dataset = JSON.parse(fs.readFileSync(value('-d'), 'utf8'));
fs.appendFileSync(path.join(__dirname, 'calls.jsonl'), JSON.stringify({args, prediction, dataset}) + '\\n');
const id = value('-i');
const dir = path.join('logs', 'run_evaluation', value('-id'), prediction.model_name_or_path.replaceAll('/', '__'), id);
fs.mkdirSync(dir, {recursive:true});
fs.writeFileSync(path.join(dir, 'run_instance.log'), '2026-09-25 19:45:56,712 - INFO - >>>>> Applied Patch:\\n');
if (prediction.model_patch.includes('TIMEOUT')) {
  fs.writeFileSync(path.join(dir, 'test_output.txt'), 'Timeout error: 1800 seconds exceeded.');
} else if (!prediction.model_patch.includes('INFRA') || fs.existsSync(path.join(__dirname, 'recovered'))) {
  fs.writeFileSync(path.join(dir, 'report.json'), JSON.stringify({[id]: {
    resolved:true, patch_successfully_applied:true,
    tests_status:{FAIL_TO_PASS:{success:['test_a'], failure:[]}, PASS_TO_PASS:{success:['test_b'], failure:[]}}
  }}));
}
`;
const FAKE_DOCKER = `#!/usr/bin/env node
const fs = require('node:fs'), path = require('node:path');
const args = process.argv.slice(2);
fs.appendFileSync(path.join(__dirname, 'docker-calls.jsonl'), JSON.stringify(args) + '\\n');
if (args.slice(0,4).join(' ') !== 'image inspect --format {{.Id}}') process.exit(9);
if (fs.existsSync(path.join(__dirname, 'missing-image'))) { console.error('No such image'); process.exit(1); }
const retag = path.join(__dirname, 'retag');
console.log(args[4].startsWith('sha256:') ? args[4] : fs.existsSync(retag) ? fs.readFileSync(retag, 'utf8') : '${PINNED}');
`;

function trajectory() {
  return {
    info: { exit_status: "Submitted", mini_version: "2.4.6", model_stats: { api_calls: 99 }, config: {
      agent: { step_limit: 75, cost_limit: 3 }, environment: { run_args: ["--rm", "--network", "none"] }
    } },
    messages: [
      { role: "system", content: "do not persist this prompt" },
      { role: "assistant", extra: { response: { model: "deepseek-flash", usage: {
        prompt_tokens: 1000, prompt_cache_hit_tokens: 600, prompt_cache_miss_tokens: 400,
        completion_tokens: 50, completion_tokens_details: { reasoning_tokens: 20 }
      } } } },
      { role: "user", content: "bash output" },
      { role: "assistant", extra: { response: { model: "deepseek-flash-2026", usage: {
        prompt_tokens: 2000, prompt_cache_hit_tokens: 1500, prompt_cache_miss_tokens: 500,
        completion_tokens: 70, completion_tokens_details: { reasoning_tokens: 30 }
      } } } },
      { role: "assistant", extra: { response: { model: "deepseek-flash", usage: null } } }
    ]
  };
}

function recordFor(id: string) {
  return normalizeRecord({
    instance_id: id, repo: "owner/repo", base_commit: "abc", environment_setup_commit: "def", version: "1",
    created_at: "2020-01-01", difficulty: "easy", eval_type: "pass_and_fail", image: "unused-official-image",
    log_parser: "parse_log_pytest", patch: PATCH, test_patch: PATCH, eval_script: "pytest", problem_statement: "fix",
    hints_text: "", FAIL_TO_PASS: ["test_a"], PASS_TO_PASS: ["test_b"]
  });
}

let dir: string;
let options: ExternalOptions;
let preds: Record<string, { instance_id: string; model_name_or_path: string; model_patch?: string | null }>;
beforeEach(async () => {
  dir = await makeTempDir("onehand-external-");
  const bin = path.join(dir, "bin");
  await mkdir(bin);
  for (const [name, script] of [["python", FAKE_HARNESS], ["docker", FAKE_DOCKER]]) {
    await writeFile(path.join(bin, name!), script!);
    await chmod(path.join(bin, name!), 0o755);
  }
  await writeFile(path.join(bin, "version"), "5.0.2");
  vi.stubEnv("ONEHAND_SWEBENCH_PYTHON", path.join(bin, "python"));
  vi.stubEnv("PATH", `${bin}:${process.env.PATH}`);
  options = {
    preds: path.join(dir, "preds.json"), trajectories: path.join(dir, "trajectories"),
    split: "dev", label: "mini-swe-agent-2.4.6", model: "deepseek-flash", imageSource: "epoch",
    concurrency: 2, outputDir: path.join(dir, "output"), files: {
      splits: path.join(dir, "splits.json"), data: path.join(dir, "data.jsonl"), exclusions: path.join(dir, "exclusions.json")
    }
  };
  await writeFile(options.files!.splits!, JSON.stringify({ schemaVersion: 1, datasetRevision: "test-revision",
    dev: { instanceIds: IDS }, holdout: { instanceIds: ["owner__repo-4"] } }));
  await writeFile(options.files!.data!, [...IDS, "owner__repo-4"].map(id => JSON.stringify(recordFor(id))).join("\n"));
  await writeFile(options.files!.exclusions!, "[]");
  preds = Object.fromEntries(IDS.map(id => [id, { instance_id: id, model_name_or_path: "mini/flash", model_patch: PATCH }]));
  for (const id of IDS) {
    await mkdir(path.join(options.trajectories, id), { recursive: true });
    await writeTrajectory(id, trajectory());
  }
  await writePreds();
});
afterEach(async () => { vi.unstubAllEnvs(); await cleanupTempDir(dir); });

const writePreds = () => writeFile(options.preds, JSON.stringify(preds));
const writeTrajectory = (id: string, value: unknown) => writeFile(path.join(options.trajectories, id, `${id}.traj.json`), JSON.stringify(value));
async function calls(name = "calls.jsonl"): Promise<any[]> {
  return (await readFile(path.join(dir, "bin", name), "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
}

describe("external SWE-bench reference", () => {
  it("counts usage responses, aggregates cache and reasoning tokens, and uses the shared price calculation", () => {
    const metrics = readMiniTrajectory(trajectory(), PRICE);
    expect(metrics).toMatchObject({ modelRounds: 2, apiCalls: 99, inputTokens: 3000, cacheHitInputTokens: 2100,
      cacheMissInputTokens: 900, outputTokens: 120, reasoningTokens: 50, exitStatus: "Submitted", miniVersion: "2.4.6",
      responseModels: ["deepseek-flash", "deepseek-flash-2026"],
      miniConfig: { stepLimit: 75, costLimitUsd: 3, networkDisabled: true }
    });
    expect(metrics.estimatedCostUsd).toBeCloseTo(0.0004266, 12);
    expect(metrics.estimatedCostUsd).toBe(estimateCost(metrics, PRICE));
  });

  it.each(["", " \n", null, undefined])("grades an empty/missing patch (%s) unresolved without launching it", async patch => {
    preds[IDS[0]!]!.model_patch = patch;
    await writePreds();
    const { rows } = await gradeExternal({ ...options, taskIds: [IDS[0]!] });
    expect(rows[0]).toMatchObject({ emptyPatch: true, resolved: false, patchApplied: false, gradingOutcome: "empty_patch" });
    expect(await calls()).toEqual([]);
    expect(await calls("docker-calls.jsonl")).toEqual([]);
  });

  it("keeps a missing prediction in the selected denominator and passes through timeout grading", async () => {
    delete preds[IDS[1]!];
    preds[IDS[2]!]!.model_patch += "# TIMEOUT\n";
    await writePreds();
    const { rows, summary } = await gradeExternal(options);
    expect(rows.find(row => row.taskId === IDS[1])).toMatchObject({ emptyPatch: true, resolved: false });
    expect(rows.find(row => row.taskId === IDS[2])).toMatchObject({ gradingOutcome: "test_timeout", resolved: false, patchApplied: true });
    expect(summary.resolved).toEqual({ count: 1, rate: 1 / 3, ci95: bootstrapMeanCi([1, 0, 0]) });
    expect(summary).toMatchObject({ complete: true, plannedRuns: 3, observedRuns: 3,
      meanModelRounds: 2, meanInputTokens: 3000, meanCacheHitInputTokens: 2100, meanCacheMissInputTokens: 900,
      meanOutputTokens: 120, meanReasoningTokens: 50, exitStatusCounts: { Submitted: 3 },
      gradingOutcomeCounts: { scored: 1, empty_patch: 1, test_timeout: 1 }
    });
    expect(summary.meanCostUsd).toBeCloseTo(0.0004266, 12);
    expect(summary.medianCostUsd).toBeCloseTo(0.0004266, 12);
    expect(summary.costPerResolvedUsd).toBeCloseTo(0.0012798, 12);
    const graded = await calls();
    expect(graded).toHaveLength(2);
    expect(graded.every(call => call.dataset.image === PINNED && call.args.includes("1800"))).toBe(true);
    expect(rows.filter(row => !row.emptyPatch).every(row => row.imageId === PINNED)).toBe(true);
  });

  it("resumes only ungraded instances and rewrites the same summary without duplicating rows", async () => {
    const first = await gradeExternal({ ...options, taskIds: [IDS[0]!] });
    expect(first.rows).toHaveLength(1);
    const second = await gradeExternal(options);
    expect(second.rows).toHaveLength(3);
    expect(await calls()).toHaveLength(3);
    await rm(path.join(dir, "bin", "python"));
    await rm(path.join(dir, "bin", "docker"));
    expect((await gradeExternal(options)).summary).toEqual(second.summary);
    const lines = (await readFile(path.join(options.outputDir, "external-results.jsonl"), "utf8")).trim().split("\n");
    expect(lines).toHaveLength(3);
  });

  it("computes mean and median from unequal per-run costs, including unresolved runs", async () => {
    for (const [index, factor] of [1, 2, 7].entries()) {
      const mini: any = trajectory();
      for (const message of mini.messages) {
        const usage = message.extra?.response?.usage;
        if (!usage) continue;
        for (const key of ["prompt_tokens", "prompt_cache_hit_tokens", "prompt_cache_miss_tokens", "completion_tokens"]) usage[key] *= factor;
        usage.completion_tokens_details.reasoning_tokens *= factor;
      }
      await writeTrajectory(IDS[index]!, mini);
      preds[IDS[index]!]!.model_patch = "";
    }
    await writePreds();
    const { summary } = await gradeExternal(options);
    expect(summary.meanCostUsd).toBeCloseTo(0.004266 / 3, 12);
    expect(summary.medianCostUsd).toBeCloseTo(0.0008532, 12);
    expect(summary.totalCostUsd).toBeCloseTo(0.004266, 12);
    expect(summary.resolved).toMatchObject({ count: 0, rate: 0, ci95: [0, 0] });
    expect(summary.costPerResolvedUsd).toBeNull();
  });

  it("rejects changed inputs on resume instead of mixing old verdicts with new usage", async () => {
    await gradeExternal(options);
    const changed = trajectory();
    changed.info.config.agent.step_limit = 100;
    await writeTrajectory(IDS[0]!, changed);
    await expect(gradeExternal(options)).rejects.toThrow(/resume.*mismatch/i);
    expect(await calls()).toHaveLength(3);
  });

  it("freezes pending image IDs before grading and reuses them after a partial resume with retagged images", async () => {
    preds[IDS[1]!]!.model_patch += "# INFRA\n";
    await writePreds();
    await expect(gradeExternal({ ...options, concurrency: 1 })).rejects.toThrow(/failed 3 times/);
    const partial = JSON.parse(await readFile(path.join(options.outputDir, "external-summary.json"), "utf8"));
    expect(partial).toMatchObject({ complete: false, observedRuns: 1 });
    await writeFile(path.join(dir, "bin", "retag"), `sha256:${"b".repeat(64)}`);
    await writeFile(path.join(dir, "bin", "recovered"), "");
    const result = await gradeExternal(options);
    expect(result.summary.complete).toBe(true);
    expect(result.rows.map(row => row.imageId)).toEqual([PINNED, PINNED, PINNED]);
    expect((await calls()).every(call => call.dataset.image === PINNED)).toBe(true);
    expect((await calls()).filter(call => call.prediction.instance_id === IDS[0])).toHaveLength(1);
  });

  it("writes redacted rows and a descriptive disclaimer with config-derived setup differences", async () => {
    const mini = trajectory();
    mini.info.exit_status = "Error api_key=sk-sensitive123456";
    await writeTrajectory(IDS[0]!, mini);
    await gradeExternal(options);
    for (const file of ["external-results.jsonl", "external-summary.json", "external-report.md"]) {
      const text = await readFile(path.join(options.outputDir, file), "utf8");
      expect(text).not.toContain("sk-sensitive123456");
      expect(text).not.toContain("do not persist this prompt");
    }
    const report = await readFile(path.join(options.outputDir, "external-report.md"), "utf8");
    expect(report).toContain("external descriptive reference");
    expect(report).toContain("bash tool");
    expect(report).toContain("step_limit=75");
    expect(report).toContain("cost_limit=3");
    expect(report).toContain("network was disabled via run args");
    expect(report).toContain("OneHand");
  });

  it("reports unknown network settings honestly and does not double charge reasoning tokens", () => {
    const mini: any = trajectory();
    delete mini.info.config;
    expect(readMiniTrajectory(mini, PRICE)).toMatchObject({ miniConfig: { stepLimit: null, costLimitUsd: null, networkDisabled: null }, estimatedCostUsd: estimateCost({ cacheHitInputTokens: 2100, cacheMissInputTokens: 900, outputTokens: 120 }, PRICE) });
    mini.info.config = { environment: { run_args: ["--network=none", "--network=host"] } };
    expect(readMiniTrajectory(mini, PRICE).miniConfig.networkDisabled).toBe(false);
    mini.info.config.environment.run_args = "--rm --network=none";
    expect(readMiniTrajectory(mini, PRICE).miniConfig.networkDisabled).toBe(true);
  });

  it("rejects malformed usage and missing trajectories before any grading", async () => {
    const mini: any = trajectory();
    mini.messages[1].extra.response.usage.prompt_cache_miss_tokens = -1;
    expect(() => readMiniTrajectory(mini, PRICE)).toThrow(/usage/);
    await rm(path.join(options.trajectories, IDS[1]!, `${IDS[1]}.traj.json`));
    await expect(gradeExternal(options)).rejects.toThrow(/traj.json/);
    expect(await calls()).toEqual([]);
  });

  it("fails closed on a wrong harness version or a missing local image", async () => {
    await writeFile(path.join(dir, "bin", "version"), "5.0.1");
    await expect(gradeExternal(options)).rejects.toThrow(/5\.0\.2/);
    await writeFile(path.join(dir, "bin", "version"), "5.0.2");
    await writeFile(path.join(dir, "bin", "missing-image"), "");
    await expect(gradeExternal(options)).rejects.toThrow(/not available locally/);
    expect(await calls()).toEqual([]);
  });

  it("does not persist infrastructure failures as unresolved verdicts and resumes them", async () => {
    preds[IDS[0]!]!.model_patch += "# INFRA\n";
    await writePreds();
    await expect(gradeExternal({ ...options, concurrency: 1 })).rejects.toThrow(/failed 3 times/);
    const summary = JSON.parse(await readFile(path.join(options.outputDir, "external-summary.json"), "utf8"));
    expect(summary).toMatchObject({ complete: false, observedRuns: 0, costPerResolvedUsd: null });
    await writeFile(path.join(dir, "bin", "recovered"), "");
    expect((await gradeExternal(options)).summary.complete).toBe(true);
  });

  it("rejects excluded/foreign task ids and mismatched prediction ids", async () => {
    await expect(gradeExternal({ ...options, taskIds: ["../escape"] })).rejects.toThrow(/split/);
    await writeFile(options.files!.exclusions!, JSON.stringify([{ instanceId: IDS[0], reason: "bad", evidence: "fixture" }]));
    await expect(gradeExternal({ ...options, taskIds: [IDS[0]!] })).rejects.toThrow(/split/);
    preds[IDS[1]!]!.instance_id = "other";
    await writePreds();
    await expect(gradeExternal(options)).rejects.toThrow(/instance_id/);
    expect(await calls()).toEqual([]);
  });
});

describe("grade-external CLI", () => {
  const cli = path.resolve("eval/swebench/cli.ts");
  function args() { return ["--import", "tsx", cli, "grade-external", "--preds", options.preds, "--trajectories", options.trajectories,
    "--split", "dev", "--label", "mini-swe-agent-2.4.6", "--model", "deepseek-flash", "--image-source", "epoch", "--output", options.outputDir]; }

  it.each([
    ["--split", "mini", /dev or holdout/], ["--concurrency", "0", /positive integer/],
    ["--concurrency", "1.5", /positive integer/], ["--image-source", "official", /epoch/],
    ["--model", "unknown", /price snapshot/], ["--label", " ", /label/], ["--task-ids", ",", /instance ids/]
  ])("rejects invalid %s=%s without invoking Docker", async (flag, value, message) => {
    const result = await exec(process.execPath, [...args(), String(flag), String(value)]).catch(error => error);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(message);
    expect(await calls("docker-calls.jsonl")).toEqual([]);
  });

  it.each(["--preds", "--trajectories", "--split", "--label", "--output"])("requires %s", async flag => {
    const argv = args();
    argv.splice(argv.indexOf(flag), 2);
    const result = await exec(process.execPath, argv).catch(error => error);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(`required option '${flag}`);
  });

  it("runs the registered command with fake harness and Docker", async () => {
    const splits = await loadSplits();
    const id = splits.dev.instanceIds[0]!;
    await writeFile(options.files!.data!, [...splits.dev.instanceIds, ...splits.holdout.instanceIds].map(key => JSON.stringify(recordFor(key))).join("\n"));
    await mkdir(path.join(options.trajectories, id));
    await writeTrajectory(id, trajectory());
    preds = { [id]: { instance_id: id, model_name_or_path: "mini/flash", model_patch: PATCH } };
    await writePreds();
    const result = await exec(process.execPath, [...args(), "--task-ids", id], { env: { ...process.env, ONEHAND_SWEBENCH_DATA: options.files!.data! } });
    expect(result.stdout).toContain("external-report.md");
    const rows = (await readFile(path.join(options.outputDir, "external-results.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ taskId: id, resolved: true, imageId: PINNED, modelRounds: 2 });
  });
});
