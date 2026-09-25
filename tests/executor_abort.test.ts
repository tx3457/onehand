import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LocalExecutor } from "../src/runtime/executor.js";
import { cleanupTempDir, makeTempDir } from "./helpers.js";

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(cleanupTempDir));
});

describe("LocalExecutor cancellation", () => {
  it("preserves normal execution when no signal is supplied", async () => {
    const cwd = await makeTempDir();
    dirs.push(cwd);

    const result = await new LocalExecutor().run({
      program: "node",
      args: ["-e", "process.stdout.write('done')"],
      cwd,
      timeoutSec: 10
    });

    expect(result).toMatchObject({
      ok: true,
      data: { exitCode: 0, stdout: "done", timedOut: false }
    });
  });

  it("does not start a command when its signal is already aborted", async () => {
    const cwd = await makeTempDir();
    dirs.push(cwd);
    const output = path.join(cwd, "executed.txt");
    const controller = new AbortController();
    controller.abort();

    const result = await new LocalExecutor().run({
      program: "node",
      args: ["-e", `require('node:fs').writeFileSync(${JSON.stringify(output)}, 'ran')`],
      cwd,
      timeoutSec: 10,
      signal: controller.signal
    });

    expect(result).toMatchObject({ ok: false, error: "Command aborted", recoverable: true });
    await expect(access(output)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("kills the running command process group before a child can mutate later", async () => {
    const cwd = await makeTempDir();
    dirs.push(cwd);
    const started = path.join(cwd, "started.txt");
    const trailing = path.join(cwd, "trailing.txt");
    const childScript = `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(trailing)}, 'late'), 1200)`;
    const parentScript = [
      `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(childScript)}], { stdio: 'ignore' })`,
      `require('node:fs').writeFileSync(${JSON.stringify(started)}, 'ready')`,
      "setTimeout(() => {}, 10_000)"
    ].join(";");
    const controller = new AbortController();
    const pending = new LocalExecutor().run({
      program: "node",
      args: ["-e", parentScript],
      cwd,
      timeoutSec: 10,
      signal: controller.signal
    });

    await waitForFile(started);
    controller.abort();

    await expect(pending).resolves.toMatchObject({ ok: false, error: "Command aborted", recoverable: true });
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    await expect(access(trailing)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(started, "utf8")).resolves.toBe("ready");
  });

  it("still escalates the process group when its parent exits but a descendant ignores TERM", async () => {
    const cwd = await makeTempDir();
    dirs.push(cwd);
    const started = path.join(cwd, "descendant-ready.txt");
    const trailing = path.join(cwd, "trailing.txt");
    const childScript = [
      "process.on('SIGTERM', () => {})",
      `require('node:fs').writeFileSync(${JSON.stringify(started)}, 'ready')`,
      `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(trailing)}, 'late'), 1500)`
    ].join(";");
    const parentScript = [
      `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(childScript)}], { stdio: 'ignore' })`,
      "setTimeout(() => {}, 10_000)"
    ].join(";");
    const controller = new AbortController();
    const pending = new LocalExecutor().run({
      program: "node", args: ["-e", parentScript], cwd, timeoutSec: 10, signal: controller.signal
    });
    await waitForFile(started);
    controller.abort();
    await expect(pending).resolves.toMatchObject({ ok: false, error: "Command aborted" });
    await new Promise((resolve) => setTimeout(resolve, 1800));
    await expect(access(trailing)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

async function waitForFile(file: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try {
      await access(file);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error(`Timed out waiting for ${file}`);
}
