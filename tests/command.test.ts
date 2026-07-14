import { describe, expect, it } from "vitest";
import { makeTempDir, cleanupTempDir } from "./helpers.js";
import { isDestructiveCommand, runShellCommand } from "../src/tools/command.js";

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

  it("blocks denied destructive commands", async () => {
    expect(isDestructiveCommand("sudo whoami")).toBe(true);
    expect(isDestructiveCommand("git reset --hard")).toBe(true);
    expect(isDestructiveCommand("git clean -fdx")).toBe(true);
    expect(isDestructiveCommand("rm -rf /")).toBe(true);
    expect(isDestructiveCommand("rm -rf ~")).toBe(true);
  });
});
