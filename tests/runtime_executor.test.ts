import type { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { access, mkdir, realpath, symlink } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildDockerExecArgs, DockerExecutor, LocalExecutor, PathMapper } from "../src/runtime/executor.js";
import { cleanupTempDir, makeTempDir } from "./helpers.js";

const dirs: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(dirs.splice(0).map(cleanupTempDir));
});

class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  kill = vi.fn((signal?: string) => {
    this.emit("close", null, signal);
    return true;
  });
}

// Each spawned fake child replays `script` on the next tick: emitted output, then a close code.
function fakeSpawn(script: (child: FakeChild) => void) {
  const calls: Array<{ program: string; args: string[]; options: { env?: NodeJS.ProcessEnv } }> = [];
  const children: FakeChild[] = [];
  const spawnImpl = ((program: string, args: string[], options: { env?: NodeJS.ProcessEnv }) => {
    const child = new FakeChild();
    calls.push({ program, args, options });
    children.push(child);
    setImmediate(() => script(child));
    return child;
  }) as unknown as typeof spawn;
  return { spawnImpl, calls, children };
}

const mapper = new PathMapper("/host/repo", "/testbed");

describe("PathMapper", () => {
  it("is the identity when both roots are equal", () => {
    const identity = new PathMapper("/repo", "/repo/");
    for (const value of ["/repo", "/repo/a.py", "a.py", "/etc/passwd"]) {
      expect(identity.toHost(value)).toBe(value);
      expect(identity.toDisplay(value)).toBe(value);
    }
  });

  it("maps the display root and paths below it to the host root and leaves everything else", () => {
    expect(mapper.toHost("/testbed")).toBe("/host/repo");
    expect(mapper.toHost("/testbed/django/db/models/query.py")).toBe("/host/repo/django/db/models/query.py");
    expect(mapper.toHost("django/db/models/query.py")).toBe("django/db/models/query.py");
    expect(mapper.toHost("../testbed/x.py")).toBe("../testbed/x.py");
    expect(mapper.toHost("/etc/passwd")).toBe("/etc/passwd");
  });

  it("never matches a partial path segment", () => {
    expect(mapper.toHost("/testbed2/x.py")).toBe("/testbed2/x.py");
    expect(mapper.toHost("/testbed.bak")).toBe("/testbed.bak");
    expect(mapper.toDisplay("/host/repository/x.py")).toBe("/host/repository/x.py");
  });

  it("normalizes trailing slashes on both roots", () => {
    const slashed = new PathMapper("/host/repo/", "/testbed//");
    expect([slashed.hostRoot, slashed.displayRoot]).toEqual(["/host/repo", "/testbed"]);
    expect(slashed.toHost("/testbed/")).toBe("/host/repo/");
    expect(slashed.toHost("/testbed/a/b.py")).toBe("/host/repo/a/b.py");
    expect(slashed.toDisplay("/host/repo")).toBe("/testbed");
  });

  it("maps host paths back to display paths", () => {
    expect(mapper.toDisplay("/host/repo")).toBe("/testbed");
    expect(mapper.toDisplay("/host/repo/sub/dir")).toBe("/testbed/sub/dir");
    expect(mapper.toDisplay(mapper.toHost("/testbed/a/b.py"))).toBe("/testbed/a/b.py");
    expect(mapper.toDisplay("/testbed/x.py")).toBe("/testbed/x.py");
  });

  it("resolves a symlinked host root to its realpath and reports which host paths it maps", async () => {
    const base = await makeTempDir();
    dirs.push(base);
    const real = await realpath(base);
    await mkdir(path.join(real, "repo"));
    await symlink(path.join(real, "repo"), path.join(real, "link"));
    const linked = new PathMapper(path.join(real, "link"), "/testbed");
    expect(linked.hostRoot).toBe(path.join(real, "repo"));
    expect(linked.toDisplay(path.join(real, "repo", "sub"))).toBe("/testbed/sub");
    expect(linked.toHost("/testbed/sub")).toBe(path.join(real, "repo", "sub"));
    expect([linked.maps(path.join(real, "repo")), linked.maps(path.join(real, "repo", "sub"))]).toEqual([true, true]);
    expect([linked.maps(path.join(real, "repo2")), linked.maps(real), linked.maps("/tmp")]).toEqual([false, false, false]);
  });
});

describe("buildDockerExecArgs", () => {
  const base = { container: "sweb-1", containerCwd: "/testbed", timeoutSec: 30, program: "python", args: ["-m", "pytest", "tests/test_x.py"] };

  it("builds the exact argv without activation", () => {
    expect(buildDockerExecArgs(base)).toEqual([
      "exec", "-w", "/testbed", "sweb-1",
      "timeout", "--signal=TERM", "--kill-after=5s", "30s",
      "bash", "-c", 'exec -- "$@"', "onehand", "python", "-m", "pytest", "tests/test_x.py"
    ]);
  });

  it("adds the user, env, working directory, and activation script", () => {
    expect(buildDockerExecArgs({
      ...base,
      containerCwd: "/testbed/sub",
      user: "root",
      env: { PYTHONDONTWRITEBYTECODE: "1", LABEL: "two words" },
      activation: "source /opt/miniconda3/bin/activate && conda activate testbed"
    })).toEqual([
      "exec", "-w", "/testbed/sub", "-u", "root", "-e", "PYTHONDONTWRITEBYTECODE=1", "-e", "LABEL=two words", "sweb-1",
      "timeout", "--signal=TERM", "--kill-after=5s", "30s",
      "bash", "-c",
      'onehand_argv=("$@"); set --; source /opt/miniconda3/bin/activate && conda activate testbed && exec -- "${onehand_argv[@]}"',
      "onehand", "python", "-m", "pytest", "tests/test_x.py"
    ]);
  });

  it("runs a program named like an exec option as a program, not as `exec -a`", async () => {
    const cwd = await makeTempDir();
    dirs.push(cwd);
    // Without `--`, bash would read this as `exec -a argv0 node ...` and run node.
    const printer = ["argv0", "node", "-e", "process.stdout.write('ran')"];
    for (const activation of [undefined, "true"]) {
      const argv = buildDockerExecArgs({ ...base, activation, program: "-a", args: printer });
      const inContainer = argv.slice(argv.indexOf("bash"));
      const result = await new LocalExecutor().run({ program: inContainer[0]!, args: inContainer.slice(1), cwd, timeoutSec: 10 });
      expect(result, String(activation)).toMatchObject({ ok: true, data: { exitCode: 127, stdout: "" } });
    }
  });

  it("passes hostile arguments only as positional argv elements, never inside the bash script", async () => {
    const hostile = ["$(touch pwned-subst)", "'; touch pwned-quote #", '"$(touch pwned-double)"', "`touch pwned-tick`"];
    // `$#` shows what a sourced activation script would receive as its own arguments.
    const activation = 'export ONEHAND_ACTIVATED="yes:$#"';
    const argv = buildDockerExecArgs({ ...base, activation, program: "node", args: hostile });
    const script = argv[argv.indexOf("-c") + 1]!;
    expect(script).toBe(`onehand_argv=("$@"); set --; ${activation} && exec -- "\${onehand_argv[@]}"`);
    for (const value of hostile) expect(script).not.toContain(value);
    expect(argv.slice(argv.indexOf("onehand") + 1)).toEqual(["node", ...hostile]);

    // Run the in-container half (bash -c ... onehand node ...) for real: every value arrives verbatim.
    const cwd = await makeTempDir();
    dirs.push(cwd);
    const printer = "process.stdout.write(JSON.stringify([process.env.ONEHAND_ACTIVATED, ...process.argv.slice(1)]))";
    const shellArgv = buildDockerExecArgs({ ...base, activation, program: "node", args: ["-e", printer, ...hostile] });
    const inContainer = shellArgv.slice(shellArgv.indexOf("bash"));
    const result = await new LocalExecutor().run({ program: inContainer[0]!, args: inContainer.slice(1), cwd, timeoutSec: 10 });
    expect(result.ok && JSON.parse(result.data.stdout)).toEqual(["yes:0", ...hostile]);
    for (const marker of ["pwned-subst", "pwned-quote", "pwned-double", "pwned-tick"]) {
      await expect(access(path.join(cwd, marker))).rejects.toThrow();
    }
  });
});

describe("DockerExecutor", () => {
  it("runs docker exec in the mapped container cwd and reports the display command", async () => {
    process.env.ONEHAND_TEST_SECRET = "do-not-forward";
    try {
      const { spawnImpl, calls } = fakeSpawn((child) => {
        child.stdout.emit("data", Buffer.from("1 failed\n"));
        child.stderr.emit("data", Buffer.from("warning\n"));
        child.emit("close", 1);
      });
      const executor = new DockerExecutor({
        container: "sweb-1", pathMapper: mapper, user: "root", env: { A: "base", B: "base" }, spawnImpl
      });
      const result = await executor.run({
        program: "python", args: ["-m", "pytest"], cwd: "/host/repo/sub", timeoutSec: 30, env: { B: "request" }
      });
      expect(result).toMatchObject({
        ok: true,
        data: { command: "python -m pytest", exitCode: 1, stdout: "1 failed\n", stderr: "warning\n", timedOut: false, truncated: false }
      });
      expect(calls).toHaveLength(1);
      expect(calls[0]!.program).toBe("docker");
      expect(calls[0]!.args).toEqual([
        "exec", "-w", "/testbed/sub", "-u", "root", "-e", "A=base", "-e", "B=request", "sweb-1",
        "timeout", "--signal=TERM", "--kill-after=5s", "30s", "bash", "-c", 'exec -- "$@"', "onehand", "python", "-m", "pytest"
      ]);
      expect(calls[0]!.options.env).not.toHaveProperty("ONEHAND_TEST_SECRET");
    } finally {
      delete process.env.ONEHAND_TEST_SECRET;
    }
  });

  it("reports 124 or 137 as a timeout only once the in-container deadline has passed", async () => {
    vi.useFakeTimers();
    const closeAfter = async (elapsedMs: number, code: number) => {
      const child = new FakeChild();
      const executor = new DockerExecutor({ container: "sweb-1", pathMapper: mapper, spawnImpl: (() => child) as unknown as typeof spawn });
      const pending = executor.run({ program: "python", args: ["-m", "pytest"], cwd: "/host/repo", timeoutSec: 5 });
      await vi.advanceTimersByTimeAsync(elapsedMs);
      child.stdout.emit("data", Buffer.from("partial output"));
      child.emit("close", code);
      return pending;
    };
    expect(await closeAfter(5_000, 124)).toMatchObject({ ok: true, data: { exitCode: null, timedOut: true, stdout: "partial output" } });
    expect(await closeAfter(10_000, 137)).toMatchObject({ ok: true, data: { exitCode: null, timedOut: true } });
    expect(await closeAfter(4_750, 124)).toMatchObject({ ok: true, data: { exitCode: null, timedOut: true } });
    // The command's own early `exit 124` is an ordinary failure.
    expect(await closeAfter(0, 124)).toMatchObject({ ok: true, data: { exitCode: 124, timedOut: false } });
    expect(await closeAfter(4_749, 137)).toMatchObject({ ok: true, data: { exitCode: 137, timedOut: false } });
  });

  it("fails closed with an environment failure when the cwd is outside the mapped root", async () => {
    const { spawnImpl, calls } = fakeSpawn((child) => child.emit("close", 0));
    const executor = new DockerExecutor({ container: "sweb-1", pathMapper: mapper, spawnImpl });
    for (const cwd of ["/tmp", "/host/repo2", "/host"]) {
      expect(await executor.run({ program: "python", args: [], cwd, timeoutSec: 5 })).toEqual({
        ok: false, error: `Working directory is outside the mapped repository root: ${cwd}`, recoverable: false, code: "environment"
      });
    }
    expect(calls).toEqual([]);
  });

  it("classifies docker exec failures, but not the command's own 125-127 exits, as environment failures", async () => {
    const run = async (code: number, stderr: string, stdout = "") => {
      const { spawnImpl } = fakeSpawn((child) => {
        child.stdout.emit("data", Buffer.from(stdout));
        child.stderr.emit("data", Buffer.from(stderr));
        child.emit("close", code);
      });
      return new DockerExecutor({ container: "sweb-1", pathMapper: mapper, spawnImpl })
        .run({ program: "python", args: [], cwd: "/host/repo", timeoutSec: 5 });
    };
    for (const [code, stderr] of [
      [126, "OCI runtime exec failed: exec failed: unable to start container process: chdir to cwd (\"/testbed\") set in config.json failed"],
      [125, "Error response from daemon: No such container: sweb-1"],
      [126, "Error response from daemon: container 4f2a is not running"],
      [126, "cannot exec in a stopped state: unknown"]
    ] as const) {
      expect(await run(code, stderr), stderr).toEqual({
        ok: false, error: `docker exec failed with exit ${code}: ${stderr}`, recoverable: false, code: "environment"
      });
    }
    expect(await run(127, "onehand: line 1: exec: pytest: not found\n")).toMatchObject({ ok: true, data: { exitCode: 127 } });
    expect(await run(1, "", "Error response from daemon: the test printed this\n")).toMatchObject({ ok: true, data: { exitCode: 1 } });
  });

  it("reports a docker client that cannot start as an environment failure", async () => {
    const { spawnImpl } = fakeSpawn((child) => child.emit("error", new Error("spawn docker ENOENT")));
    const result = await new DockerExecutor({ container: "sweb-1", pathMapper: mapper, spawnImpl })
      .run({ program: "python", args: [], cwd: "/host/repo", timeoutSec: 5 });
    expect(result).toEqual({ ok: false, error: "docker could not be started: spawn docker ENOENT", recoverable: false, code: "environment" });
  });

  it("maps a cwd under the realpath of a symlinked host root", async () => {
    const base = await realpath(await makeTempDir());
    dirs.push(base);
    await mkdir(path.join(base, "repo", "sub"), { recursive: true });
    await symlink(path.join(base, "repo"), path.join(base, "link"));
    const { spawnImpl, calls } = fakeSpawn((child) => child.emit("close", 0));
    const executor = new DockerExecutor({ container: "sweb-1", pathMapper: new PathMapper(path.join(base, "link"), "/testbed"), spawnImpl });
    expect(await executor.run({ program: "python", args: [], cwd: path.join(base, "repo", "sub"), timeoutSec: 5 }))
      .toMatchObject({ ok: true, data: { exitCode: 0 } });
    expect(calls[0]!.args.slice(0, 3)).toEqual(["exec", "-w", "/testbed/sub"]);
  });

  it("truncates output with the requested strategy", async () => {
    const large = `HEAD${"x".repeat(1000)}TAIL`;
    const { spawnImpl } = fakeSpawn((child) => {
      child.stdout.emit("data", Buffer.from(large));
      child.emit("close", 0);
    });
    const executor = new DockerExecutor({ container: "sweb-1", pathMapper: mapper, spawnImpl });
    const request = { program: "python", args: [], cwd: "/host/repo", timeoutSec: 5, outputLimitBytes: 100 };
    const head = await executor.run(request);
    const headTail = await executor.run({ ...request, truncation: "head_tail" });
    expect(head).toMatchObject({ ok: true, truncated: true, data: { truncated: true } });
    expect(head.ok && head.data.stdout).toMatch(/^HEADx+\n\n\[onehand: output truncated, \d+ bytes omitted\]\n\n$/);
    expect(headTail.ok && headTail.data.stdout).toMatch(/^HEADx+\n\n\[onehand: output truncated, \d+ bytes omitted\]\n\nx+TAIL$/);
  });

  it("kills a hung docker client only at the host backstop, 15 seconds past the timeout", async () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    const spawnImpl = (() => child) as unknown as typeof spawn;
    const executor = new DockerExecutor({ container: "sweb-1", pathMapper: mapper, spawnImpl });
    const pending = executor.run({ program: "python", args: [], cwd: "/host/repo", timeoutSec: 2 });
    await vi.advanceTimersByTimeAsync(16_999);
    expect(child.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    await expect(pending).resolves.toMatchObject({ ok: true, data: { exitCode: null, timedOut: true } });
  });
});

describe("LocalExecutor", () => {
  it("uses the identity path mapping, since commands run on the host", () => {
    const { pathMapper } = new LocalExecutor();
    for (const value of ["/testbed/x.py", "/etc/passwd", "x.py"]) {
      expect([pathMapper.toHost(value), pathMapper.toDisplay(value)]).toEqual([value, value]);
    }
  });

  it("merges the request env over the safe environment allowlist", async () => {
    const cwd = await makeTempDir();
    dirs.push(cwd);
    process.env.ONEHAND_TEST_SECRET = "do-not-forward";
    try {
      const result = await new LocalExecutor().run({
        program: "node",
        args: ["-e", "process.stdout.write(`${process.env.ONEHAND_EXTRA}:${process.env.ONEHAND_TEST_SECRET ?? 'absent'}`)"],
        cwd,
        timeoutSec: 10,
        env: { ONEHAND_EXTRA: "forwarded" }
      });
      expect(result).toMatchObject({ ok: true, data: { exitCode: 0, stdout: "forwarded:absent", timedOut: false } });
    } finally {
      delete process.env.ONEHAND_TEST_SECRET;
    }
  });
});
