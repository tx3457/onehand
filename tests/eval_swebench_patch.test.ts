import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyPatch, extractPatch, git } from "../eval/swebench/patch.js";
import { rebuildGitBase } from "../eval/swebench/workspace.js";
import { cleanupTempDir, makeTempDir } from "./helpers.js";

const dirs: string[] = [];
afterEach(async () => Promise.all(dirs.splice(0).map(cleanupTempDir)));

const BINARY = Buffer.from([0, 1, 2, 255, 0, 66, 73, 78]);

async function write(root: string, relative: string, content: string | Buffer): Promise<void> {
  await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
  await writeFile(path.join(root, relative), content);
}

// A tree like /testbed in an image: a history with a tag and a later commit that must not survive.
async function imageLikeTree(): Promise<string> {
  const repo = await makeTempDir("onehand-swe-patch-");
  dirs.push(repo);
  await write(repo, "pkg/mod.py", "VALUE = 1\n");
  await write(repo, "pkg/old.py", "OLD = True\n");
  await write(repo, ".gitignore", "*.log\n");
  await write(repo, "pkg/vendored.log", "tracked despite *.log\n");
  await git(repo, ["init", "-q", "-b", "main"]);
  await git(repo, ["add", "-A"]);
  await git(repo, ["add", "-f", "pkg/vendored.log"]);
  await git(repo, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "past"]);
  await git(repo, ["tag", "v1.0"]);
  await git(repo, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "future fix"]);
  await git(repo, ["reset", "-q", "--hard", "HEAD~1"]);
  await write(repo, "build.log", "ignored\n");
  return repo;
}

describe("SWE-bench workspace history", () => {
  it("replaces the image history with one commit, no tags, and the scratch exclude", async () => {
    const repo = await imageLikeTree();
    const baseCommit = await rebuildGitBase(repo);
    expect(await git(repo, ["log", "--all", "--format=%H"])).toBe(`${baseCommit}\n`);
    expect(await git(repo, ["reflog", "--all"])).not.toContain("future fix");
    expect(await git(repo, ["tag"])).toBe("");
    expect(await git(repo, ["rev-parse", "HEAD"])).toBe(`${baseCommit}\n`);
    // .gitignore keeps build.log out but, as in git, never untracks the tracked pkg/vendored.log.
    expect((await git(repo, ["ls-files"])).split("\n").filter(Boolean)).toEqual([".gitignore", "pkg/mod.py", "pkg/old.py", "pkg/vendored.log"]);
    expect(await git(repo, ["status", "--porcelain"])).toBe("");
    expect(await readFile(path.join(repo, ".git", "info", "exclude"), "utf8")).toBe(".scratch/\n");
  });
});

describe("extractPatch", () => {
  it("captures edits, new, deleted, and binary files but never scratch or ignored files", async () => {
    const repo = await imageLikeTree();
    const baseCommit = await rebuildGitBase(repo);
    await write(repo, "pkg/mod.py", "VALUE = 2\n");
    await write(repo, "pkg/new.py", "NEW = 3\n");
    await rm(path.join(repo, "pkg", "old.py"));
    await write(repo, "pkg/data.bin", BINARY);
    await write(repo, ".scratch/repro.py", "print('scratch')\n");
    await write(repo, "debug.log", "ignored\n");
    await write(repo, "pkg/vendored.log", "edited\n");

    const extracted = await extractPatch(repo, baseCommit);
    expect(extracted.files).toEqual(["pkg/data.bin", "pkg/mod.py", "pkg/new.py", "pkg/old.py", "pkg/vendored.log"]);
    expect(extracted.bytes).toBe(Buffer.byteLength(extracted.patch));
    expect(extracted.patch).toContain("GIT binary patch");
    expect(extracted.patch).toContain("deleted file mode");
    expect(extracted.patch).toContain("+NEW = 3");
    expect(extracted.patch).not.toMatch(/scratch|debug\.log/);
    // The repository's own index, which git_status and git_diff report, is unchanged.
    expect(await git(repo, ["diff", "--cached", "--name-only"])).toBe("");
    expect(await git(repo, ["status", "--porcelain"])).toContain("?? pkg/new.py");
    // Scratch files stay out even without the info/exclude entry.
    await writeFile(path.join(repo, ".git", "info", "exclude"), "");
    expect(await extractPatch(repo, baseCommit)).toEqual(extracted);

    // The patch reproduces the change on a pristine copy of the base commit.
    const copy = await makeTempDir("onehand-swe-apply-");
    dirs.push(copy);
    await git(copy, ["clone", "-q", repo, "."]);
    await applyPatch(copy, extracted.patch);
    expect(await readFile(path.join(copy, "pkg", "mod.py"), "utf8")).toBe("VALUE = 2\n");
    expect(await readFile(path.join(copy, "pkg", "new.py"), "utf8")).toBe("NEW = 3\n");
    expect(await readFile(path.join(copy, "pkg", "data.bin"))).toEqual(BINARY);
    expect(await readFile(path.join(copy, "pkg", "vendored.log"), "utf8")).toBe("edited\n");
    await expect(readFile(path.join(copy, "pkg", "old.py"))).rejects.toThrow();
  });

  // Root reads any file, so the tree cannot hold an unreadable one.
  it.skipIf(process.getuid?.() === 0)("extracts every readable change and lists the files git could not read", async () => {
    const repo = await imageLikeTree();
    const baseCommit = await rebuildGitBase(repo);
    await write(repo, "pkg/mod.py", "VALUE = 2\n");
    await write(repo, "pkg/locked.py", "SECRET = 1\n");
    await chmod(path.join(repo, "pkg", "locked.py"), 0o000);
    await write(repo, "pkg/nested/.git", "gitdir: /nonexistent\n");
    await mkdir(path.join(repo, "pkg", "empty-repo", ".git"), { recursive: true });
    try {
      const extracted = await extractPatch(repo, baseCommit);
      expect(extracted.files).toEqual(["pkg/mod.py"]);
      expect(extracted.patch).toContain("+VALUE = 2");
      expect(extracted.warnings).toEqual(expect.arrayContaining(['error: open("pkg/locked.py"): Permission denied']));
      expect(extracted.warnings.every((line) => /^(error|warning): /.test(line))).toBe(true);
    } finally {
      await chmod(path.join(repo, "pkg", "locked.py"), 0o644);
    }
  });

  it("returns an empty patch for an untouched tree and ignores the user's global git config", async () => {
    const repo = await imageLikeTree();
    const baseCommit = await rebuildGitBase(repo);
    expect(await extractPatch(repo, baseCommit)).toEqual({ patch: "", bytes: 0, files: [], warnings: [] });

    const home = await makeTempDir("onehand-swe-home-");
    dirs.push(home);
    await writeFile(path.join(home, "excludes"), "*.py\n");
    await writeFile(path.join(home, ".gitconfig"),
      `[diff]\n\tnoprefix = true\n[color]\n\tui = always\n[core]\n\texcludesFile = ${path.join(home, "excludes")}\n`);
    const previousHome = process.env.HOME;
    process.env.HOME = home;
    try {
      await write(repo, "pkg/extra.py", "EXTRA = 1\n");
      const extracted = await extractPatch(repo, baseCommit);
      expect(extracted.files).toEqual(["pkg/extra.py"]);
      expect(extracted.patch).toContain("diff --git a/pkg/extra.py b/pkg/extra.py");
      expect(extracted.patch).not.toContain("\u001b[");
    } finally {
      process.env.HOME = previousHome;
    }
  });
});
