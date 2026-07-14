import { writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanupTempDir, git, initGitRepo, makeTempDir } from "./helpers.js";
import { gitDiff } from "../src/tools/git.js";

describe("git tools", () => {
  let repo: string;

  beforeEach(async () => {
    repo = await makeTempDir();
  });

  afterEach(async () => {
    await cleanupTempDir(repo);
  });

  it("returns diff inside a git repository", async () => {
    await initGitRepo(repo);
    await writeFile(path.join(repo, "answer.txt"), "before\n");
    await writeFile(path.join(repo, ".env"), "SECRET=before\n");
    await git(["add", "answer.txt", ".env"], repo);
    await git(["commit", "-m", "initial"], repo);
    await writeFile(path.join(repo, "answer.txt"), "after\n");
    await writeFile(path.join(repo, ".env"), "SECRET=after\n");

    const result = await gitDiff(repo, 10);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.diff).toContain("-before");
      expect(result.data.diff).toContain("+after");
      expect(result.data.diff).not.toContain("SECRET");
      expect(result.data.diff).not.toContain(".env");
    }
  });

  it("returns a graceful error outside a git repository", async () => {
    const result = await gitDiff(repo, 10);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.recoverable).toBe(true);
      expect(result.error).toBe("Not a git repository");
    }
  });
});
