import { writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { makeTempDir, cleanupTempDir } from "./helpers.js";
import { isDestructiveCommand, parseCommand, quoteArg, runShellCommand } from "../src/tools/command.js";
import { createToolRegistry } from "../src/tools/registry.js";

const LARGE_OUTPUT = "node -e \"process.stdout.write('HEAD' + 'x'.repeat(1000) + 'TAIL')\"";

describe("command runner", () => {
  it("captures stdout, stderr, and exit code", async () => {
    const cwd = await makeTempDir();
    try {
      const result = await runShellCommand({
        command: "node -e \"console.log('out'); console.error('err'); process.exit(7)\"",
        cwd,
        timeoutSec: 10
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.stdout.trim()).toBe("out");
        expect(result.data.stderr.trim()).toBe("err");
        expect(result.data.exitCode).toBe(7);
      }
    } finally {
      await cleanupTempDir(cwd);
    }
  });

  it("times out long-running commands", async () => {
    const cwd = await makeTempDir();
    try {
      const result = await runShellCommand({
        command: "node -e \"setTimeout(() => {}, 5000)\"",
        cwd,
        timeoutSec: 1
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.timedOut).toBe(true);
        expect(result.data.exitCode).toBeNull();
      }
    } finally {
      await cleanupTempDir(cwd);
    }
  });

  it("truncates large output", async () => {
    const cwd = await makeTempDir();
    try {
      const result = await runShellCommand({
        command: "node -e \"console.log('x'.repeat(1000))\"",
        cwd,
        timeoutSec: 10,
        outputLimitBytes: 100
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.truncated).toBe(true);
        expect(result.data.stdout).toContain("output truncated");
      }
    } finally {
      await cleanupTempDir(cwd);
    }
  });

  it("keeps only the head of large output by default", async () => {
    const cwd = await makeTempDir();
    try {
      const result = await runShellCommand({ command: LARGE_OUTPUT, cwd, timeoutSec: 10, outputLimitBytes: 100 });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.stdout).toMatch(/^HEADx+\n\n\[onehand: output truncated, \d+ bytes omitted\]\n\n$/);
      }
    } finally {
      await cleanupTempDir(cwd);
    }
  });

  it("keeps the head and the tail of large output with head_tail truncation", async () => {
    const cwd = await makeTempDir();
    try {
      const result = await runShellCommand({
        command: LARGE_OUTPUT, cwd, timeoutSec: 10, outputLimitBytes: 100, truncation: "head_tail"
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.stdout).toMatch(/^HEADx+\n\n\[onehand: output truncated, \d+ bytes omitted\]\n\nx+TAIL$/);
      }
    } finally {
      await cleanupTempDir(cwd);
    }
  });

  it("keeps the tail of large model-facing test output", async () => {
    const repo = await makeTempDir();
    try {
      await writeFile(path.join(repo, "test.cjs"), "process.stdout.write('x'.repeat(30000) + '\\nFAILED: last line\\n');process.exit(1);\n");
      const registry = createToolRegistry({ repoRoot: repo, testCommand: "node test.cjs", timeoutSec: 10, allowDestructive: false });
      const result = await registry.execute("run_tests", {});
      expect(result).toMatchObject({ ok: true, truncated: true, data: { passed: false } });
      if (result.ok) expect((result.data as { stdout: string }).stdout).toContain("FAILED: last line");
    } finally {
      await cleanupTempDir(repo);
    }
  });

  it("shell-quotes arguments so that parseCommand reads them back unchanged", () => {
    const values = ["plain/path.py::test_a", "two words", "it's", "", "a\nb", "$(touch x) `y` | z", "t[a b]", "--k=v", 'q"uote'];
    expect(values.slice(0, 1).map(quoteArg)).toEqual(["plain/path.py::test_a"]);
    const parsed = parseCommand(["pytest", ...values].map(quoteArg).join(" "));
    expect([parsed.program, ...parsed.args]).toEqual(["pytest", ...values]);
  });

  it("blocks denied destructive commands", async () => {
    expect(isDestructiveCommand("sudo whoami")).toBe(true);
    expect(isDestructiveCommand("git reset --hard")).toBe(true);
    expect(isDestructiveCommand("git clean -fdx")).toBe(true);
    expect(isDestructiveCommand("rm -rf /")).toBe(true);
    expect(isDestructiveCommand("rm -rf ~")).toBe(true);
  });
});
