import { execFile } from "node:child_process";
import { chmod, mkdir, readdir, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanupTempDir, git, initGitRepo, makeTempDir } from "./helpers.js";
import { gitDiff, gitStatus } from "../src/tools/git.js";

const execFileAsync = promisify(execFile);

describe("git tools", () => {
  let repo: string;
  const dirs: string[] = [];

  beforeEach(async () => {
    repo = await makeTempDir();
  });

  afterEach(async () => {
    await Promise.all([repo, ...dirs.splice(0)].map(cleanupTempDir));
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

  it("never runs a program that repository config names: fsmonitor, hooks, external diff, or textconv", async () => {
    const markers = await makeTempDir();
    dirs.push(markers);
    const probe = async (name: string) => {
      const script = path.join(markers, name);
      await writeFile(script, `#!/bin/sh\ntouch "${script}.ran"\n`);
      await chmod(script, 0o755);
      return script;
    };
    const ran = async () => (await readdir(markers)).filter((name) => name.endsWith(".ran")).sort();
    // A changed mtime on an unchanged file makes status rewrite the index, which runs post-index-change.
    const touchUnchanged = (seconds: number) => utimes(path.join(repo, "same.txt"), Date.now() / 1000 + seconds, Date.now() / 1000 + seconds);

    await initGitRepo(repo);
    await writeFile(path.join(repo, "a.txt"), "before\n");
    await writeFile(path.join(repo, "same.txt"), "same\n");
    await writeFile(path.join(repo, ".gitattributes"), "*.txt diff=probe\n");
    await git(["add", "."], repo);
    await git(["commit", "-m", "initial"], repo);
    await mkdir(path.join(markers, "hooks"));
    await probe(path.join("hooks", "post-index-change"));
    await git(["config", "core.fsmonitor", await probe("fsmonitor")], repo);
    await git(["config", "core.hooksPath", path.join(markers, "hooks")], repo);
    await git(["config", "diff.external", await probe("external")], repo);
    await git(["config", "diff.probe.textconv", await probe("textconv")], repo);
    await writeFile(path.join(repo, "a.txt"), "after\n");

    await touchUnchanged(60);
    expect(await gitStatus(repo, 10)).toMatchObject({ ok: true, data: { changedFiles: ["a.txt"] } });
    const diff = await gitDiff(repo, 10);
    expect(diff.ok && diff.data.diff).toContain("-before\n+after\n");
    expect(await ran()).toEqual([]);

    // Control: plain git runs every one of them.
    await touchUnchanged(120);
    await execFileAsync("git", ["status"], { cwd: repo });
    await execFileAsync("git", ["diff"], { cwd: repo });
    await execFileAsync("git", ["diff", "--no-ext-diff"], { cwd: repo });
    expect(await ran()).toEqual(["external.ran", "fsmonitor.ran", "textconv.ran"]);
    expect(await readdir(path.join(markers, "hooks"))).toContain("post-index-change.ran");
  });

  it("ignores the user's global config only when isolated from a container checkout", async () => {
    await initGitRepo(repo);
    await writeFile(path.join(repo, "tracked.txt"), "x\n");
    await git(["add", "."], repo);
    await git(["commit", "-m", "initial"], repo);
    await writeFile(path.join(repo, "notes.local"), "untracked\n");
    const home = await makeTempDir();
    dirs.push(home);
    await writeFile(path.join(home, "excludes"), "*.local\n");
    await writeFile(path.join(home, ".gitconfig"), `[core]\n\texcludesFile = ${path.join(home, "excludes")}\n`);
    const previousHome = process.env.HOME;
    process.env.HOME = home;
    try {
      expect(await gitStatus(repo, 10)).toMatchObject({ ok: true, data: { changedFiles: [] } });
      expect(await gitStatus(repo, 10, true)).toMatchObject({ ok: true, data: { changedFiles: ["notes.local"] } });
    } finally {
      process.env.HOME = previousHome;
    }
  });
});
