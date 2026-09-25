import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DockerExecutor, LocalExecutor, PathMapper } from "../src/runtime/executor.js";
import { renderToolResult } from "../src/tools/render.js";
import { createToolRegistry, serializeToolResult } from "../src/tools/registry.js";
import { legacyTruncateText as truncateText } from "./fixtures/legacyTruncate.js";

const spawn = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async (original) => ({ ...await original<typeof import("node:child_process")>(), spawn }));

class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  kill = vi.fn(() => true);
}

const request = { program: "test", args: [], cwd: process.cwd(), timeoutSec: 10 };
const note = "[onehand: command killed after producing more than 64 MB of output]";
function start(kind: "local" | "docker", options = {}) {
  const child = new FakeChild();
  spawn.mockReturnValue(child);
  const executor = kind === "local" ? new LocalExecutor() : new DockerExecutor({
    container: "fake", pathMapper: new PathMapper(process.cwd(), "/testbed"), spawnImpl: spawn
  });
  return { child, result: executor.run({ ...request, ...options }) };
}

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe("bounded command output", () => {
  it.each(["local", "docker"] as const)("kills 700 MiB of streamed %s output without building a giant buffer", async (kind) => {
    vi.useFakeTimers();
    const { child, result } = start(kind, { captureFailures: true, truncation: "head_tail" });
    // Reuse a chunk and emulate a command that ignores TERM and keeps flooding both pipes.
    const chunk = Buffer.alloc(1024 * 1024, "x");
    const concat = vi.spyOn(Buffer, "concat");
    const externalBefore = process.memoryUsage().external;
    let peakExternal = externalBefore;
    for (let i = 0; i < 700; i++) {
      (i % 7 === 0 ? child.stderr : child.stdout).emit("data", chunk);
      if (i === 63) expect(child.kill).not.toHaveBeenCalled();
      if (i === 64) expect(child.kill).toHaveBeenCalledWith("SIGTERM");
      peakExternal = Math.max(peakExternal, process.memoryUsage().external);
    }
    await vi.advanceTimersByTimeAsync(1000);
    expect(child.kill.mock.calls).toEqual([["SIGTERM"], ["SIGKILL"]]);
    // Even a 137 after the Docker deadline must stay an output kill, not a timeout.
    vi.setSystemTime(Date.now() + 20_000);
    expect(() => child.emit("close", 137)).not.toThrow();
    const captured = await result;
    expect(captured).toMatchObject({ ok: true, data: { timedOut: false, outputLimitExceeded: true, note } });
    expect(peakExternal - externalBefore).toBeLessThan(32 * 1024 * 1024);
    for (const [buffers] of concat.mock.calls) {
      expect(buffers.reduce((sum, buffer) => sum + buffer.length, 0)).toBeLessThan(256 * 1024);
    }
    if (captured.ok) {
      expect(Buffer.byteLength(captured.data.stdout)).toBeLessThanOrEqual(20 * 1024);
      expect(Buffer.byteLength(captured.data.stderr)).toBeLessThanOrEqual(20 * 1024);
      expect(renderToolResult("run_command", captured)).toContain(note);
      expect(serializeToolResult(captured)).toContain(note);
    }
  });

  it.each(["head", "head_tail"] as const)("matches old %s truncation across capture caps and UTF-8 cut points", async (truncation) => {
    for (const size of [10, 20_470, 20_484, 30_000, 41_000, 250_000]) {
      for (const limit of [0, 5, 80, 201, 20_480]) {
        const bytes = Buffer.from(("a中文🎉z".repeat(Math.ceil(size / 12))).slice(0, size));
        const { child, result } = start("local", { outputLimitBytes: limit, truncation });
        for (let i = 0; i < bytes.length; i += 997) child.stdout.emit("data", bytes.subarray(i, i + 997));
        child.emit("close", 0);
        const expected = truncateText(bytes.toString("utf8"), limit, truncation);
        expect(await result).toMatchObject({ ok: true, truncated: expected.truncated,
          data: { stdout: expected.text, stderr: "", timedOut: false } });
      }
    }
  });

  it("matches decoded invalid UTF-8 and split codepoints", async () => {
    const bytes = Buffer.concat([Buffer.from("中文🎉".repeat(10_000)), Buffer.from([0xff, 0xe4, 0xb8])]);
    const { child, result } = start("local", { outputLimitBytes: 207, truncation: "head_tail" });
    for (let i = 0; i < bytes.length; i += 101) child.stdout.emit("data", bytes.subarray(i, i + 101));
    child.emit("close", 0);
    expect(await result).toMatchObject({ ok: true, data: { stdout: truncateText(bytes.toString("utf8"), 207, "head_tail").text } });
  });

  it("extracts the first 40 failures with legacy stdout-first ordering across chunk boundaries", async () => {
    const stdout = "ignored\r\n" + "x".repeat(90_000) + "\n" + [
      "FAILED 中文🎉", "FAIL: unittest", "ERROR: exception", "E   assertion", "FAIL not matched", " FAILED indented",
      ...Array.from({ length: 18 }, (_, i) => `ERROR stdout_${i}`), "FAILED final\r"
    ].join("\r\n");
    const stderr = Array.from({ length: 30 }, (_, i) => `FAILED stderr_${i}`).join("\n");
    const expected = `${stdout}\n${stderr}`.split(/\r?\n/)
      .filter((line) => /^(?:(?:FAILED|ERROR)\b|(?:FAIL|ERROR):\s|E\s{3})/.test(line)).slice(0, 40);
    const { child, result } = start("local", { outputLimitBytes: 100, captureFailures: true });
    for (const [stream, text] of [[child.stderr, stderr], [child.stdout, stdout]] as const) {
      const bytes = Buffer.from(text);
      for (let i = 0; i < bytes.length; i += 7) stream.emit("data", bytes.subarray(i, i + 7));
    }
    child.emit("close", 1);
    expect(await result).toMatchObject({ ok: true, data: { failures: expected } });
  });

  it("keeps an output-kill note on targeted test results and never counts a killed test as passed", async () => {
    const registry = createToolRegistry({
      repoRoot: process.cwd(), testCommand: "npm test", timeoutSec: 10,
      allowDestructive: false, enforcePlanning: false,
      executor: {
        kind: "local", pathMapper: new PathMapper("/", "/"),
        run: async () => ({ ok: true, data: {
          command: "npm test", exitCode: 0, stdout: "", stderr: "", durationMs: 1,
          timedOut: false, outputLimitExceeded: true, truncated: false, note
        } })
      }
    });
    const result = await registry.execute("run_tests", { targets: ["tests/truncate.test.ts"] });
    expect(result).toMatchObject({ ok: true, data: { passed: false, timedOut: false, outputLimitExceeded: true } });
    expect(renderToolResult("run_tests", result)).toContain(note);
    expect(serializeToolResult(result)).toContain(note);
    expect(renderToolResult("run_tests", result)).toContain("does not verify the latest change");
  });

  it("cancels the escalation timer when a process closes after TERM", async () => {
    vi.useFakeTimers();
    const { child, result } = start("local");
    const chunk = Buffer.alloc(1024 * 1024, "x");
    child.kill.mockImplementation(() => { child.emit("close", 0); return true; });
    for (let i = 0; i < 65; i++) child.stdout.emit("data", chunk);
    expect(await result).toMatchObject({ ok: true, data: { exitCode: null, outputLimitExceeded: true, timedOut: false } });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(child.kill.mock.calls).toEqual([["SIGTERM"]]);
  });

  it("reports output overflow even if the timeout has already sent TERM", async () => {
    vi.useFakeTimers();
    const { child, result } = start("local", { timeoutSec: 1 });
    await vi.advanceTimersByTimeAsync(1000);
    const chunk = Buffer.alloc(1024 * 1024, "x");
    for (let i = 0; i < 65; i++) child.stdout.emit("data", chunk);
    await vi.advanceTimersByTimeAsync(1000);
    expect(child.kill.mock.calls).toEqual([["SIGTERM"], ["SIGKILL"]]);
    child.emit("close", null);
    expect(await result).toMatchObject({ ok: true, data: { outputLimitExceeded: true, timedOut: false, note } });
  });

  it("bounds a runaway matching failure line and resumes at the next newline", async () => {
    const { child, result } = start("local", { captureFailures: true });
    child.stdout.emit("data", Buffer.from("FAILED "));
    const chunk = Buffer.alloc(1024 * 1024, "x");
    for (let i = 0; i < 70; i++) child.stdout.emit("data", chunk);
    child.stdout.emit("data", Buffer.from("\r\nERROR next\n"));
    child.emit("close", null);
    const captured = await result;
    expect(captured).toMatchObject({ ok: true, data: { outputLimitExceeded: true, failures: [
      expect.stringMatching(/^FAILED .* \[onehand: failure line truncated\]$/), "ERROR next"
    ] } });
    if (captured.ok) expect(captured.data.failures![0]!.length).toBeLessThan(66_000);
  });

  it("returns a failed ToolResult if building the close result throws", async () => {
    const { child, result } = start("local");
    child.stdout.emit("data", Buffer.from("hello"));
    const toString = vi.spyOn(Buffer.prototype, "toString").mockImplementation(() => { throw new Error("decode failed"); });
    let thrown: unknown;
    try { child.emit("close", 0); } catch (error) { thrown = error; }
    toString.mockRestore();
    if (thrown) child.emit("close", 0);
    expect(thrown).toBeUndefined();
    expect(await result).toMatchObject({ ok: false, recoverable: true, error: expect.stringContaining("decode failed") });
  });
});
