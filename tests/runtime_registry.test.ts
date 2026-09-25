import type { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdir, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DockerExecutor, ExecRequest, Executor, LocalExecutor, PathMapper } from "../src/runtime/executor.js";
import { parseCommand } from "../src/tools/command.js";
import { normalizeRepoRoot } from "../src/tools/pathGuard.js";
import { createToolRegistry } from "../src/tools/registry.js";
import { cleanupTempDir, makeTempDir } from "./helpers.js";

function recordingExecutor(hostRoot: string, exitCode = 0) {
  const requests: ExecRequest[] = [];
  const executor: Executor = {
    kind: "docker",
    pathMapper: new PathMapper(hostRoot, "/testbed"),
    run: async (request) => {
      requests.push(request);
      return {
        ok: true,
        data: {
          command: request.displayCommand ?? [request.program, ...request.args].join(" "),
          exitCode, stdout: "", stderr: "", timedOut: false, durationMs: 0, truncated: false
        }
      };
    }
  };
  return { executor, requests };
}

// A real DockerExecutor whose docker client is a fake that replays the given output and exit code.
function fakeDocker(hostRoot: string, reply: { code: number; stdout?: string; stderr?: string }) {
  const calls: string[][] = [];
  const spawnImpl = ((_program: string, args: string[]) => {
    const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), kill: () => true });
    calls.push(args);
    setImmediate(() => {
      if (reply.stdout) child.stdout.emit("data", Buffer.from(reply.stdout));
      if (reply.stderr) child.stderr.emit("data", Buffer.from(reply.stderr));
      child.emit("close", reply.code);
    });
    return child;
  }) as unknown as typeof spawn;
  return { executor: new DockerExecutor({ container: "sweb-1", pathMapper: new PathMapper(hostRoot, "/testbed"), spawnImpl }), calls };
}

describe("registry with a display root", () => {
  let root: string;
  const extraDirs: string[] = [];

  beforeEach(async () => {
    root = await normalizeRepoRoot(await makeTempDir());
    await mkdir(path.join(root, "pkg"));
    await mkdir(path.join(root, "sub"));
    await writeFile(path.join(root, "pkg", "mod.py"), "VALUE = 1\n");
  });

  afterEach(async () => {
    await Promise.all([root, ...extraDirs.splice(0)].map(cleanupTempDir));
  });

  const registryFor = (
    executor: Executor,
    extra: { testCommand?: string; trustedTestCommand?: boolean; allowTargetedVerification?: boolean; enforcePlanning?: boolean } = {}
  ) => createToolRegistry({
    repoRoot: root, displayRoot: "/testbed", executor, testCommand: "python -m pytest -q", timeoutSec: 5, allowDestructive: false, ...extra
  });

  it("accepts /testbed paths in every file tool and never shows host paths in errors", async () => {
    const { executor, requests } = recordingExecutor(root);
    const registry = registryFor(executor);
    expect(await registry.execute("read_file", { path: "/testbed/pkg/mod.py" }))
      .toMatchObject({ ok: true, data: { path: "pkg/mod.py", content: "VALUE = 1\n" } });
    expect(await registry.execute("write_file", { path: "/testbed/pkg/new.py", content: "NEW = 2\n" }))
      .toMatchObject({ ok: true, data: { path: "pkg/new.py" } });
    expect(await registry.execute("replace_text", { path: "/testbed/pkg/mod.py", oldText: "1", newText: "3" }))
      .toMatchObject({ ok: true, data: { path: "pkg/mod.py" } });
    expect(await readFile(path.join(root, "pkg", "mod.py"), "utf8")).toBe("VALUE = 3\n");
    expect(await readFile(path.join(root, "pkg", "new.py"), "utf8")).toBe("NEW = 2\n");
    expect(await registry.execute("search_code", { query: "VALUE", path: "/testbed/pkg" }))
      .toMatchObject({ ok: true, data: { matches: [{ path: "pkg/mod.py", line: 1, text: "VALUE = 3" }] } });
    expect(await registry.execute("list_files", { path: "/testbed/pkg" }))
      .toMatchObject({ ok: true, data: { files: ["pkg/mod.py", "pkg/new.py"] } });

    const missing = await registry.execute("read_file", { path: "/testbed/pkg/missing.py" });
    expect(missing).toMatchObject({ ok: false, error: expect.stringContaining("'/testbed/pkg/missing.py'") });
    const escape = await registry.execute("read_file", { path: "/testbed/../etc/passwd" });
    expect(escape).toMatchObject({ ok: false, error: "Path escapes repository root: /testbed/../etc/passwd" });
    for (const result of [missing, escape]) expect(JSON.stringify(result)).not.toContain(root);
    expect(await registry.execute("read_file", { path: "/testbed2/pkg/mod.py" })).toMatchObject({ ok: false });
    expect(requests).toEqual([]);
  });

  it("refuses a display root its executor would not honor, so the validated path is the one that runs", async () => {
    // A local executor runs arguments verbatim on the host: `node /outside/x.cjs` would validate as
    // <repo>/x.cjs through the display root yet execute the file outside the repository.
    const outside = await normalizeRepoRoot(await makeTempDir());
    extraDirs.push(outside);
    const base = { repoRoot: root, testCommand: "node x.cjs", timeoutSec: 5, allowDestructive: false };
    for (const executor of [undefined, new LocalExecutor()]) {
      for (const displayRoot of [outside, "/testbed"]) {
        expect(() => createToolRegistry({ ...base, displayRoot, executor }))
          .toThrow(`A local executor runs commands on the host, so displayRoot must be the repository root ${root}, not ${displayRoot}`);
      }
    }
    expect(() => createToolRegistry({ ...base, displayRoot: root })).not.toThrow();
    // A container executor must map this very checkout, under the display root the caller names.
    expect(() => createToolRegistry({ ...base, executor: recordingExecutor(outside).executor }))
      .toThrow(`The executor maps ${outside}, not the repository root ${root}`);
    expect(() => createToolRegistry({ ...base, displayRoot: "/elsewhere", executor: recordingExecutor(root).executor }))
      .toThrow("displayRoot /elsewhere does not match the executor's display root /testbed");
  });

  it("validates run_command paths on the host and executes the model's own arguments in the host cwd", async () => {
    const { executor, requests } = recordingExecutor(root);
    const registry = registryFor(executor);
    const args = ["/testbed/pkg/mod.py", "--config=/testbed/setup.cfg"];
    expect(await registry.execute("run_command", { program: "python", args, cwd: "/testbed/sub" }))
      .toMatchObject({ ok: true, data: { command: "python /testbed/pkg/mod.py --config=/testbed/setup.cfg", exitCode: 0 } });
    expect(requests).toEqual([{ program: "python", args, cwd: path.join(root, "sub"), timeoutSec: 5, truncation: "head_tail" }]);
    expect(registry.records).toEqual([{ type: "command", command: "python /testbed/pkg/mod.py --config=/testbed/setup.cfg", exitCode: 0 }]);

    for (const call of [
      { program: "python", args: ["/etc/passwd"] },
      { program: "python", args: ["--config=/etc/passwd"] },
      { program: "python", args: ["/testbed/../etc/passwd"] },
      { program: "python", args: ["pkg/mod.py"], cwd: "/etc" },
      { program: "python", args: ["-c", "print(1)"] },
      { program: "curl", args: ["https://example.com"] }
    ]) {
      const result = await registry.execute("run_command", call);
      expect(result, JSON.stringify(call)).toMatchObject({ ok: false });
      expect(JSON.stringify(result)).not.toContain(root);
    }
    expect(requests).toHaveLength(1);
  });

  it("works from a symlinked repository root and scrubs the host root from command output at path boundaries", async () => {
    const linkDir = await normalizeRepoRoot(await makeTempDir());
    extraDirs.push(linkDir);
    const link = path.join(linkDir, "repo");
    await symlink(root, link);
    const { executor, calls } = fakeDocker(link, {
      code: 1,
      stdout: `FAILED ${root}/pkg/mod.py::test_x\n`,
      stderr: `see ${root}2/other and /mnt${root}/copy, then ${root}`
    });
    const registry = createToolRegistry({ repoRoot: link, executor, testCommand: "python -m pytest -q", timeoutSec: 5, allowDestructive: false });
    expect(await registry.execute("read_file", { path: "/testbed/pkg/mod.py" })).toMatchObject({ ok: true, data: { path: "pkg/mod.py" } });
    expect(await registry.execute("run_tests", {})).toMatchObject({
      ok: true,
      data: { passed: false, stdout: "FAILED /testbed/pkg/mod.py::test_x\n", stderr: `see ${root}2/other and /mnt${root}/copy, then /testbed` }
    });
    expect(calls[0]!.slice(0, 3)).toEqual(["exec", "-w", "/testbed"]);
  });

  it("returns docker failures as scrubbed environment failures", async () => {
    const { executor } = fakeDocker(root, {
      code: 126, stderr: `OCI runtime exec failed: exec failed: error mounting "${root}/sub": no such file or directory`
    });
    const result = await registryFor(executor).execute("run_command", { program: "python", args: ["--version"] });
    expect(result).toEqual({
      ok: false,
      error: 'docker exec failed with exit 126: OCI runtime exec failed: exec failed: error mounting "/testbed/sub": no such file or directory',
      recoverable: false,
      code: "environment"
    });
  });

  it("appends validated run_tests targets and records the argv with a round-tripping display command", async () => {
    const { executor, requests } = recordingExecutor(root);
    const registry = registryFor(executor);
    const targets = ["tests/test_x.py::TestA::test_b", "/testbed/tests/test_y.py", "auth_tests.test_forms", "test_root.py::test_c[a b-it's]"];
    const command = `python -m pytest -q tests/test_x.py::TestA::test_b /testbed/tests/test_y.py auth_tests.test_forms 'test_root.py::test_c[a b-it'"'"'s]'`;
    const argv = ["python", "-m", "pytest", "-q", ...targets];
    expect(await registry.execute("run_tests", { targets })).toMatchObject({ ok: true, data: { command, passed: true, targets } });
    expect(requests.at(-1)).toEqual({
      program: "python", args: argv.slice(1), cwd: root, timeoutSec: 5, truncation: "head_tail", displayCommand: command
    });
    expect(registry.records.at(-1)).toEqual({ type: "test", command, argv, passed: true, exitCode: 0, targets });
    const parsed = parseCommand(command);
    expect([parsed.program, ...parsed.args]).toEqual(argv);

    expect(await registry.execute("run_tests", {})).toMatchObject({ ok: true, data: { command: "python -m pytest -q" } });
    expect(requests.at(-1)?.args).toEqual(["-m", "pytest", "-q"]);
    expect(registry.records.at(-1)).toEqual({
      type: "test", command: "python -m pytest -q", argv: ["python", "-m", "pytest", "-q"], passed: true, exitCode: 0
    });
  });

  it("rejects option, traversal, protected, and malformed test targets before running anything", async () => {
    const { executor, requests } = recordingExecutor(root);
    const registry = registryFor(executor);
    for (const target of [
      "-k", "--rootdir=/", "-p", "@args.txt", "../outside.py", "..", "/etc/passwd", "/testbed/../outside.py::test_a",
      "tests/a\0.py", "", "  ", "x".repeat(513), ".env.py",
      ".env", ".git", "id_rsa", "server.pem", "tests/.git/..", "config.key", "tests/.env::test_a", "pkg=.env"
    ]) {
      const result = await registry.execute("run_tests", { targets: ["tests/test_ok.py", target] });
      expect(result, JSON.stringify(target)).toMatchObject({ ok: false });
      expect(JSON.stringify(result)).not.toContain(root);
    }
    expect(await registry.execute("run_tests", { targets: [".git"] }))
      .toEqual({ ok: false, error: "Protected repository path is not accessible from test targets: .git", recoverable: true });
    expect(await registry.execute("run_tests", { targets: Array.from({ length: 33 }, (_, i) => `t${i}`) }))
      .toMatchObject({ ok: false, error: "arguments.targets must contain at most 32 items" });
    expect(requests).toEqual([]);
    expect(registry.records).toEqual([]);
  });

  it("counts a passing targeted run as verification only when targeted verification is allowed", async () => {
    const attempt = async (allowTargetedVerification?: boolean) => {
      const registry = registryFor(recordingExecutor(root).executor, { enforcePlanning: true, allowTargetedVerification });
      expect(await registry.execute("set_plan", { steps: ["fix and verify"] })).toMatchObject({ ok: true });
      expect(await registry.execute("write_file", { path: "/testbed/pkg/mod.py", content: "VALUE = 2\n" })).toMatchObject({ ok: true });
      const targeted = await registry.execute("run_tests", { targets: ["tests/test_mod.py"] });
      expect(await registry.execute("update_plan", { stepId: 1, status: "completed", evidence: "targeted run passed" })).toMatchObject({ ok: true });
      return { registry, targeted, finish: await registry.execute("finish_task", { summary: "done" }) };
    };

    const strict = await attempt();
    expect(strict.targeted).toMatchObject({
      ok: true, data: { passed: true, targets: ["tests/test_mod.py"], verifiesLatestChange: false, note: expect.stringContaining("without targets before finish_task") }
    });
    expect(strict.registry.records.at(-1)).toMatchObject({ type: "test", passed: true, targets: ["tests/test_mod.py"] });
    expect(strict.finish).toMatchObject({ ok: false, error: "Run a passing verification after the most recent file change" });
    const full = await strict.registry.execute("run_tests", {});
    expect(full).toMatchObject({ ok: true, data: { passed: true } });
    expect(full.ok && full.data).not.toHaveProperty("verifiesLatestChange");
    expect(await strict.registry.execute("finish_task", { summary: "done" })).toMatchObject({ ok: true });

    const allowed = await attempt(true);
    expect(allowed.targeted).toMatchObject({ ok: true, data: { passed: true, targets: ["tests/test_mod.py"] } });
    expect(allowed.targeted.ok && allowed.targeted.data).not.toHaveProperty("verifiesLatestChange");
    expect(allowed.finish).toMatchObject({ ok: true });
  });

  it("runs a trusted base command outside the model policy but still validates targets and shell operators", async () => {
    const { executor, requests } = recordingExecutor(root);
    const tox = "tox --current-env -epy39 -v --";
    const trusted = registryFor(executor, { testCommand: tox, trustedTestCommand: true });
    expect(await trusted.execute("run_tests", { targets: ["auth_tests.test_forms"] })).toMatchObject({ ok: true });
    expect(requests.at(-1)).toMatchObject({ program: "tox", args: ["--current-env", "-epy39", "-v", "--", "auth_tests.test_forms"], cwd: root });
    expect(trusted.records.at(-1)).toEqual({
      type: "test", command: `${tox} auth_tests.test_forms`, argv: ["tox", "--current-env", "-epy39", "-v", "--", "auth_tests.test_forms"],
      passed: true, exitCode: 0, targets: ["auth_tests.test_forms"]
    });
    expect(await trusted.execute("run_tests", { targets: ["--help"] })).toMatchObject({ ok: false });

    const runtests = registryFor(executor, { testCommand: "./tests/runtests.py --settings=test_sqlite --parallel 1", trustedTestCommand: true });
    expect(await runtests.execute("run_tests", { targets: ["auth_tests.test_forms"] })).toMatchObject({ ok: true });
    expect(requests.at(-1)).toMatchObject({ program: "./tests/runtests.py", args: ["--settings=test_sqlite", "--parallel", "1", "auth_tests.test_forms"] });

    const requestCount = requests.length;
    expect(await registryFor(executor, { testCommand: tox }).execute("run_tests", {}))
      .toMatchObject({ ok: false, error: "Program is outside the local execution allowlist: tox" });
    expect(await registryFor(executor, { testCommand: "./tests/runtests.py" }).execute("run_tests", {}))
      .toMatchObject({ ok: false, error: "Executable paths are disabled; use an allowlisted program name" });
    expect(await registryFor(executor, { testCommand: "tox | cat", trustedTestCommand: true }).execute("run_tests", {}))
      .toMatchObject({ ok: false, error: expect.stringContaining("Shell operator") });
    expect(requests).toHaveLength(requestCount);
  });

  it("passes run_tests targets through the default local executor", async () => {
    await writeFile(path.join(root, "args.cjs"), "process.stdout.write(JSON.stringify(process.argv.slice(2)));\n");
    const registry = createToolRegistry({ repoRoot: root, testCommand: "node args.cjs", timeoutSec: 10, allowDestructive: false });
    const targets = ["tests/test_x.py::TestA::test_b", "auth_tests.test_forms"];
    const result = await registry.execute("run_tests", { targets });
    expect(result).toMatchObject({ ok: true, data: { passed: true, command: `node args.cjs ${targets.join(" ")}` } });
    expect(result.ok && JSON.parse((result.data as { stdout: string }).stdout)).toEqual(targets);
  });

  it("resolves a lexical path to a symlinked root for the default local executor", async () => {
    const linkDir = await realpath(await makeTempDir());
    extraDirs.push(linkDir);
    const link = path.join(linkDir, "repo");
    await symlink(root, link);
    const registry = createToolRegistry({ repoRoot: link, timeoutSec: 5, allowDestructive: false });
    expect(await registry.execute("read_file", { path: "pkg/mod.py" })).toMatchObject({ ok: true, data: { path: "pkg/mod.py" } });
    expect(await registry.execute("read_file", { path: path.join(root, "pkg", "mod.py") })).toMatchObject({ ok: true, data: { path: "pkg/mod.py" } });
  });
});
