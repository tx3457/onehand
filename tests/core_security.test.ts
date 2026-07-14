import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runShellCommand } from "../src/tools/command.js";
import { readRepoFile, writeRepoFile } from "../src/tools/fileTools.js";
import { createToolRegistry } from "../src/tools/registry.js";
import { cleanupTempDir, makeTempDir } from "./helpers.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map(cleanupTempDir));
});

describe("command and path safety", () => {
  it("executes one quoted program without a shell and strips unrelated environment", async () => {
    const cwd = await makeTempDir();
    dirs.push(cwd);
    process.env.ONEHAND_TEST_SECRET = "do-not-forward";
    const result = await runShellCommand({
      command: "node -e \"console.log(process.env.ONEHAND_TEST_SECRET ?? 'absent')\"",
      cwd,
      timeoutSec: 5
    });
    delete process.env.ONEHAND_TEST_SECRET;
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.stdout.trim()).toBe("absent");
  });

  it.each(["node -v | cat", "curl https://example.com", "git push origin main", "npm install zod"])(
    "refuses unsafe command %s",
    async (command) => {
      const cwd = await makeTempDir();
      dirs.push(cwd);
      await expect(runShellCommand({ command, cwd, timeoutSec: 5 })).resolves.toMatchObject({ ok: false });
    }
  );

  it("refuses protected files and symlink escape including missing descendants", async () => {
    const repo = await makeTempDir();
    const outside = await makeTempDir();
    dirs.push(repo, outside);
    await writeFile(path.join(repo, ".env"), "SECRET=x\n");
    await mkdir(path.join(outside, "nested"));
    await symlink(outside, path.join(repo, "escape"));
    expect(await readRepoFile(repo, { path: ".env" })).toMatchObject({ ok: false });
    expect(await writeRepoFile(repo, { path: "escape/nested/new.txt", content: "x" })).toMatchObject({ ok: false });
    await expect(readFile(path.join(outside, "nested", "new.txt"), "utf8")).rejects.toThrow();
  });

  it("validates arguments before dispatch and blocks writes without a plan", async () => {
    const repo = await makeTempDir();
    dirs.push(repo);
    const registry = createToolRegistry({ repoRoot: repo, testCommand: "node --version", timeoutSec: 5, allowDestructive: false, enforcePlanning: true });
    expect(await registry.execute("read_file", { path: "x", extra: true })).toMatchObject({ ok: false });
    expect(await registry.execute("write_file", { path: "x", content: "y" })).toMatchObject({ ok: false });
    expect(await registry.execute("set_plan", { steps: ["write", "verify"] })).toMatchObject({ ok: true });
    expect(await registry.execute("write_file", { path: "x", content: "y" })).toMatchObject({ ok: true });
    expect(await registry.execute("run_command", { program: "cat", args: ["../secret"] })).toMatchObject({ ok: false });
    expect(await registry.execute("run_command", { program: "node", args: ["-e", "console.log(process.env)"] })).toMatchObject({ ok: false });
    expect(await registry.execute("run_command", { program: "/tmp/node", args: ["--version"] })).toMatchObject({ ok: false });
    expect(await registry.execute("run_command", { program: "rg", args: ["SECRET", ".env"] })).toMatchObject({ ok: false });
    expect(await registry.execute("run_command", { program: "git", args: ["show", "HEAD:.env"] })).toMatchObject({ ok: false });
    expect(await registry.execute("run_command", { program: "find", args: [".", "-exec", "node", "x.cjs", ";"] })).toMatchObject({ ok: false });
  });

  it("invalidates an earlier verification after any general command", async () => {
    const repo = await makeTempDir();
    dirs.push(repo);
    const registry = createToolRegistry({ repoRoot: repo, testCommand: "node --version", timeoutSec: 5, allowDestructive: false, enforcePlanning: true });
    expect(await registry.execute("set_plan", { steps: ["diagnose and verify"] })).toMatchObject({ ok: true });
    expect(await registry.execute("run_tests", {})).toMatchObject({ ok: true });
    expect(await registry.execute("update_plan", { stepId: 1, status: "completed", evidence: "verified" })).toMatchObject({ ok: true });
    expect(await registry.execute("run_command", { program: "node", args: ["--version"] })).toMatchObject({ ok: true });
    expect(await registry.execute("finish_task", { summary: "done" })).toMatchObject({ ok: false });
    expect(await registry.execute("run_tests", {})).toMatchObject({ ok: true });
    expect(await registry.execute("finish_task", { summary: "done" })).toMatchObject({ ok: true });
  });

  it("does not let model arguments replace the configured verification command", async () => {
    const repo = await makeTempDir();
    dirs.push(repo);
    await writeFile(path.join(repo, "test.cjs"), "process.exit(0);\n");
    const registry = createToolRegistry({
      repoRoot: repo,
      testCommand: "node test.cjs",
      timeoutSec: 5,
      allowDestructive: false,
      enforcePlanning: true
    });
    await registry.execute("set_plan", { steps: ["verify"] });
    expect(await registry.execute("run_tests", { command: "node --version" })).toMatchObject({ ok: false });
    expect(await registry.execute("run_tests", {})).toMatchObject({ ok: true });
    expect(registry.records.at(-1)).toMatchObject({ type: "test", command: "node test.cjs", passed: true });
  });
});
