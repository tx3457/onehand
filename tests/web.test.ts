import { request } from "node:http";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startWebUi } from "../src/web/server.js";
import { CheckpointStore } from "../src/runtime/checkpoints.js";
import { ConfinedDirectory } from "../src/web/files.js";
import { listRuns } from "../src/web/runs.js";
import { listEvaluations } from "../src/web/evaluations.js";
import { cleanupTempDir, makeTempDir } from "./helpers.js";

describe("read-only Web UI", () => {
  let root: string;
  let runsDir: string;
  let resultsDir: string;
  let ui: Awaited<ReturnType<typeof startWebUi>>;
  let cookie: string;
  let previousCheckpointDir: string | undefined;
  const usage = { modelRounds: 3, toolCalls: 2, inputTokens: 120, outputTokens: 30, totalTokens: 150, wallTimeMs: 400 };

  beforeEach(async () => {
    root = await makeTempDir("onehand-web-");
    runsDir = path.join(root, "runs");
    resultsDir = path.join(root, "results");
    previousCheckpointDir = process.env.ONEHAND_CHECKPOINT_DIR;
    process.env.ONEHAND_CHECKPOINT_DIR = path.join(root, "shadow");
    await mkdir(runsDir);
    await mkdir(resultsDir);
    await mkdir(path.join(root, "repo"));
    await putRun("older", "2026-01-01T00:00:00Z");
    await putRun("newer", "2026-02-01T00:00:00Z");
    ui = await startWebUi({ port: 0, runsDir, resultsDir });
    const bootstrap = await get(new URL(ui.url).pathname + new URL(ui.url).search, {}, false);
    cookie = String(bootstrap.headers["set-cookie"]?.[0]).split(";")[0];
  });

  afterEach(async () => {
    await ui?.close();
    if (previousCheckpointDir === undefined) delete process.env.ONEHAND_CHECKPOINT_DIR;
    else process.env.ONEHAND_CHECKPOINT_DIR = previousCheckpointDir;
    await cleanupTempDir(root);
  });

  async function putRun(id: string, updatedAt: string, extra = {}) {
    await mkdir(path.join(runsDir, id), { recursive: true });
    await writeFile(path.join(runsDir, id, "state.json"), JSON.stringify({
      runId: id, task: "Review token=private-value", repo: path.join(root, "repo"),
      provider: "openai", model: "scripted", status: "success", stopReason: "explicit_finish", usage, updatedAt,
      history: [{ role: "assistant", content: "RAW_HISTORY_CANARY" }], records: [{ output: "RAW_RECORD_CANARY" }],
      plan: { status: "completed", steps: [{ id: 1, description: "inspect", status: "completed", evidence: "checked" }] },
      finalMessage: "Done password=secret-value", ...extra
    }));
  }

  function get(url: string, headers: Record<string, string> = {}, authenticated = true, method = "GET") {
    return new Promise<{ status: number; headers: import("node:http").IncomingHttpHeaders; body: string }>((resolve, reject) => {
      const req = request(ui.origin + url, {
        method, headers: { ...(authenticated ? { Cookie: cookie } : {}), ...headers }
      }, (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => { body += chunk; });
        res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body }));
      });
      req.on("error", reject);
      req.end();
    });
  }

  it("binds loopback and rejects a non-loopback host before listening", async () => {
    expect(ui.server.address()).toMatchObject({ address: "127.0.0.1" });
    await expect(startWebUi({ host: "0.0.0.0", port: 0, runsDir, resultsDir })).rejects.toThrow(/127.0.0.1/);
  });

  it("requires authentication on the page, assets and API and rejects a bad token", async () => {
    for (const url of ["/", "/app.js", "/app.css", "/api/runs", "/?token=bad"]) {
      expect((await get(url, {}, false)).status).toBe(401);
    }
    expect((await get("/", { Authorization: `Bearer ${new URL(ui.url).searchParams.get("token")}` }, false)).status).toBe(401);
  });

  it("exchanges a 32-byte one-time token for a strict HttpOnly cookie and a clean URL", async () => {
    const other = await startWebUi({ port: 0, runsDir, resultsDir });
    try {
      const token = new URL(other.url).searchParams.get("token")!;
      expect(token).toMatch(/^[0-9a-f]{64}$/);
      const response = await fetch(other.url, { redirect: "manual" });
      expect(response.status).toBe(303);
      expect(response.headers.get("location")).toBe("/");
      expect(response.headers.get("set-cookie")).toMatch(/HttpOnly; SameSite=Strict/);
      expect(response.headers.get("set-cookie")).not.toContain(token);
      expect((await fetch(other.url, { redirect: "manual" })).status).toBe(401);
    } finally { await other.close(); }
  });

  it("keeps simultaneous server sessions usable in the same host cookie jar", async () => {
    const other = await startWebUi({ port: 0, runsDir, resultsDir });
    try {
      const login = await fetch(other.url, { redirect: "manual" });
      const otherCookie = login.headers.get("set-cookie")!.split(";")[0];
      const jar = `${cookie}; ${otherCookie}`;
      expect((await get("/api/runs", { Cookie: jar })).status).toBe(200);
      expect((await fetch(`${other.origin}/api/runs`, { headers: { Cookie: jar } })).status).toBe(200);
    } finally { await other.close(); }
  });

  it("skips directories removed during run and evaluation enumeration", async () => {
    const runs = new ConfinedDirectory(runsDir);
    const readRunFiles = runs.files.bind(runs);
    runs.files = async (id) => {
      if (id === "newer") await rm(path.join(runsDir, id), { recursive: true });
      return readRunFiles(id);
    };
    await expect(listRuns(runs)).resolves.toMatchObject([{ id: "older" }]);
    for (const id of ["removed", "surviving"]) {
      await mkdir(path.join(resultsDir, id));
      await writeFile(path.join(resultsDir, id, "summary.json"), "{}");
      await writeFile(path.join(resultsDir, id, "manifest.json"), "{}");
    }
    const evaluations = new ConfinedDirectory(resultsDir);
    const readEvalFiles = evaluations.files.bind(evaluations);
    evaluations.files = async (id) => {
      if (id === "removed") await rm(path.join(resultsDir, id), { recursive: true });
      return readEvalFiles(id);
    };
    await expect(listEvaluations(evaluations)).resolves.toEqual([{ id: "surviving", invalidated: false }]);
  });

  it("rejects foreign Host and Origin headers while accepting its own origin", async () => {
    expect((await get("/api/runs", { Host: "attacker.invalid" })).status).toBe(403);
    expect((await get("/api/runs", { Origin: "https://attacker.invalid" })).status).toBe(403);
    expect((await get("/api/runs", { Origin: "null" })).status).toBe(403);
    expect((await get("/api/runs", { Origin: ui.origin })).status).toBe(200);
    expect((await get("/api/runs", { Host: `localhost:${new URL(ui.origin).port}` })).status).toBe(200);
  });

  it("rejects mutation methods and sends defensive headers on every response", async () => {
    for (const method of ["POST", "PUT", "DELETE", "OPTIONS"]) {
      const result = await get("/api/runs", {}, true, method);
      expect(result.status).toBe(405);
      expect(result.headers.allow).toBe("GET");
    }
    const result = await get("/");
    expect(result.headers["content-security-policy"]).toBe("default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; frame-ancestors 'none'");
    expect(result.headers["x-content-type-options"]).toBe("nosniff");
    expect(result.headers["referrer-policy"]).toBe("no-referrer");
    expect(result.headers["cache-control"]).toBe("no-store");
    expect(result.body).toContain('src="/app.js"');
    expect((await get("/app.js")).headers["content-type"]).toContain("javascript");
  });

  it("returns 404 for traversal, unknown IDs and symlink escapes", async () => {
    await symlink(path.join(root, "repo"), path.join(runsDir, "escape"));
    await putRun("linked", "2026-03-01");
    await writeFile(path.join(root, "outside.json"), '{"task":"OUTSIDE_CANARY"}');
    await symlink(path.join(root, "outside.json"), path.join(runsDir, "linked", "trace.jsonl"));
    for (const url of ["/api/runs/%2e%2e", "/api/runs/%2e%2e%2foutside", "/api/runs/%252e%252e", "/api/runs/newer%2fstate.json", "/api/runs/missing", "/api/runs/escape", "/api/runs/linked", "/api/evaluations/%2e%2e", "/api/evaluations/missing", "/api/runs/%ZZ"]) {
      expect((await get(url)).status, url).toBe(404);
    }
  });

  it("lists fixture runs newest first and returns only redacted state projections", async () => {
    const result = await get("/api/runs");
    expect(result.status).toBe(200);
    expect(JSON.parse(result.body).runs.map((run: { id: string }) => run.id)).toEqual(["newer", "older"]);
    expect(JSON.parse(result.body).runs[0]).toMatchObject({ repo: "repo", model: "scripted", usage, stopReason: "explicit_finish" });
    const detail = await get("/api/runs/newer");
    expect(JSON.parse(detail.body)).toMatchObject({ plan: { steps: [{ evidence: "checked" }] }, usage });
    for (const response of [result, detail]) {
      expect(response.body).not.toMatch(/RAW_HISTORY_CANARY|RAW_RECORD_CANARY|private-value|secret-value/);
      expect(response.body).toContain("[REDACTED]");
    }
  });

  it("projects model, tool, masking, subagent, permission and checkpoint trace events", async () => {
    const events = [
      { event: "model_turn", data: { round: 1, usage, toolCallNames: ["read_file"], history: "TRACE_HISTORY_CANARY" } },
      { event: "tool_result", data: { name: "read_file", arguments: { path: "file.ts" }, ok: false, durationMs: 42, errorCategory: "other", error: "missing" } },
      ...["context_masked", "subagent_started", "subagent_finished", "permission_decision", "checkpoint_created"].map((event) => ({ event, data: { id: "checkpoint", decision: "deny", status: "success" } }))
    ];
    await writeFile(path.join(runsDir, "newer", "trace.jsonl"), events.map((event) => JSON.stringify({ ts: "now", ...event })).join("\n") + '\n{"event":');
    const result = await get("/api/runs/newer");
    const body = JSON.parse(result.body);
    expect(body.timeline.map((event: { event: string }) => event.event)).toEqual(events.map((event) => event.event));
    expect(body.timeline[1].data).toMatchObject({ arguments: { path: "file.ts" }, ok: false, durationMs: 42, errorCategory: "other" });
    expect(result.body).not.toContain("TRACE_HISTORY_CANARY");
  });

  it("bounds trace output to the newest 2000 events", async () => {
    await writeFile(path.join(runsDir, "newer", "trace.jsonl"), Array.from({ length: 2005 }, (_, round) => JSON.stringify({ ts: "now", event: "model_turn", data: { round } })).join("\n") + "\n");
    const body = JSON.parse((await get("/api/runs/newer")).body);
    expect(body.timeline).toHaveLength(2000);
    expect(body.timeline[0].data.round).toBe(5);
    expect(body.timeline.at(-1).data.round).toBe(2004);
    expect(body.timelineTruncated).toBe(true);
  });

  it("tails oversized traces and reports a partially written final record", async () => {
    const prefix = JSON.stringify({ event: "tool_result", data: { error: "x".repeat(2 * 1024 * 1024) } });
    await writeFile(path.join(runsDir, "newer", "trace.jsonl"), prefix + '\n{"event":"model_turn","data":{"round":9000}}\n{"event":');
    const result = await get("/api/runs/newer");
    expect(result.status).toBe(200);
    expect(JSON.parse(result.body)).toMatchObject({ timeline: [{ event: "model_turn", data: { round: 9000 } }], timelineTruncated: true, timelineIncomplete: true });
  });

  it("confines state, evaluation metadata and Markdown symlinks to their listed directory", async () => {
    const outside = path.join(root, "outside.txt");
    await writeFile(outside, "OUTSIDE_CANARY");
    await unlink(path.join(runsDir, "newer", "state.json"));
    await symlink(outside, path.join(runsDir, "newer", "state.json"));
    expect((await get("/api/runs/newer")).status).toBe(404);
    await mkdir(path.join(resultsDir, "linked"));
    await writeFile(path.join(resultsDir, "linked", "manifest.json"), "{}");
    await symlink(outside, path.join(resultsDir, "linked", "summary.json"));
    expect((await get("/api/evaluations/linked")).status).toBe(404);
    await unlink(path.join(resultsDir, "linked", "summary.json"));
    await writeFile(path.join(resultsDir, "linked", "summary.json"), "{}");
    await symlink(outside, path.join(resultsDir, "linked", "report.md"));
    expect((await get("/api/evaluations/linked")).status).toBe(404);
  });

  it("does not expose extra state fields hidden inside malformed plan IDs", async () => {
    await putRun("nested", "2026-02-01", { plan: { steps: [{ id: { history: "NESTED_HISTORY_CANARY" }, description: "step", status: "pending" }] } });
    const result = await get("/api/runs/nested");
    expect(result.status).toBe(200);
    expect(result.body).not.toContain("NESTED_HISTORY_CANARY");
  });

  it("caps the serialized response even when many small records exceed the total limit", async () => {
    await putRun("wide", "2026-02-01", { plan: { steps: Array.from({ length: 700 }, (_, id) => ({ id, description: "step", evidence: "x".repeat(7000) })) } });
    const result = await get("/api/runs/wide");
    expect(result.status).toBe(413);
    expect(Buffer.byteLength(result.body)).toBeLessThan(1000);
  });

  it("bounds JSON nesting before redaction without hiding other runs", async () => {
    const deeplyNested = "[".repeat(20_000) + "0" + "]".repeat(20_000);
    await writeFile(path.join(runsDir, "newer", "state.json"), '{"history":' + deeplyNested + '}');
    expect((await get("/api/runs/newer")).status).toBe(413);
    expect(JSON.parse((await get("/api/runs")).body).runs.map((run: { id: string }) => run.id)).toEqual(["older"]);
    await mkdir(path.join(resultsDir, "deep"));
    await writeFile(path.join(resultsDir, "deep", "summary.json"), '{"completeness":' + deeplyNested + '}');
    await writeFile(path.join(resultsDir, "deep", "manifest.json"), '{}');
    expect((await get("/api/evaluations/deep")).status).toBe(413);
  });

  it("rejects very wide JSON before allocating a traversal entry for each child", () => {
    const script = [
      'import { parseArtifactJson } from "./src/web/files.ts";',
      'try { parseArtifactJson("[" + "0,".repeat(1999999) + "0]"); process.exit(2); }',
      'catch (error) { if (error.status !== 413) throw error; }'
    ].join("\n");
    expect(() => execFileSync(process.execPath, ["--max-old-space-size=96", "--import", "tsx", "--input-type=module", "-e", script], {
      cwd: process.cwd(), timeout: 5000, stdio: "pipe"
    })).not.toThrow();
  });

  it("discovers directories added after an earlier request", async () => {
    expect(JSON.parse((await get("/api/runs")).body).runs).toHaveLength(2);
    await putRun("latest", "2026-03-01");
    expect(JSON.parse((await get("/api/runs")).body).runs[0].id).toBe("latest");
    expect((await get("/api/runs/latest")).status).toBe(200);
  });

  it("rejects an oversized state and tolerates missing roots without creating them", async () => {
    await writeFile(path.join(runsDir, "newer", "state.json"), " ".repeat(8 * 1024 * 1024 + 1));
    expect((await get("/api/runs/newer")).status).toBe(413);
    const absent = await startWebUi({ port: 0, runsDir: path.join(root, "absent"), resultsDir });
    try {
      const login = await fetch(absent.url, { redirect: "manual" });
      const result = await fetch(`${absent.origin}/api/runs`, { headers: { Cookie: login.headers.get("set-cookie")!.split(";")[0] } });
      expect(await result.json()).toEqual({ runs: [] });
    } finally { await absent.close(); }
  });

  it("lists evaluation fixtures and labels invalidated directories without serving them", async () => {
    for (const id of ["valid", "INVALID-old", "marked"]) {
      await mkdir(path.join(resultsDir, id));
      await writeFile(path.join(resultsDir, id, "manifest.json"), JSON.stringify({ model: "scripted", variants: [{ name: "A" }] }));
      await writeFile(path.join(resultsDir, id, "summary.json"), JSON.stringify({ kind: "swebench_summary", variants: ["A"], complete: true, resolved: { rate: 0.5 }, efficiency: { estimatedCostUsd: { mean: 0.2 }, modelRounds: { mean: 4 }, inputTokens: { mean: 100 }, outputTokens: { mean: 20 } } }));
    }
    await writeFile(path.join(resultsDir, "marked", "INVALID.txt"), "invalid");
    await writeFile(path.join(resultsDir, "valid", "report.md"), "# Report\n<script>alert(1)</script>\n");
    const list = JSON.parse((await get("/api/evaluations")).body).evaluations;
    expect(list).toEqual(expect.arrayContaining([{ id: "valid", invalidated: false }, { id: "INVALID-old", invalidated: true }, { id: "marked", invalidated: true }]));
    expect((await get("/api/evaluations/marked")).status).toBe(404);
    expect((await get("/api/evaluations/INVALID-old")).status).toBe(404);
    const detail = JSON.parse((await get("/api/evaluations/valid")).body);
    expect(detail.variants[0]).toMatchObject({ name: "A", resolvedRate: 0.5, costPerRun: 0.2, meanRounds: 4, complete: true });
    expect(detail.reports[0].html).toContain("&lt;script&gt;");
    expect(detail.reports[0].html).not.toContain("<script>");
  });

  it("lists checkpoints and diffs the current fixture tree without restoring or changing refs", async () => {
    const repo = path.join(root, "repo");
    await writeFile(path.join(repo, "sample.txt"), "before\n");
    const store = new CheckpointStore(repo);
    const checkpoint = await store.snapshot("before edit");
    await writeFile(path.join(repo, "sample.txt"), "after\n");
    const list = await get("/api/runs/newer/checkpoints");
    expect(list.status).toBe(200);
    expect(JSON.parse(list.body).checkpoints).toEqual([checkpoint]);
    const result = await get(`/api/runs/newer/checkpoints/${checkpoint.id}`);
    expect(result.status).toBe(200);
    expect(JSON.parse(result.body).diff).toContain("-before\n+after");
    expect(await readFile(path.join(repo, "sample.txt"), "utf8")).toBe("after\n");
    expect(await store.list()).toEqual([checkpoint]);
    expect((await get("/api/runs/newer/checkpoints/HEAD")).status).toBe(404);
    expect((await get(`/api/runs/newer/checkpoints/${checkpoint.id}/restore`)).status).toBe(404);
  });
});
