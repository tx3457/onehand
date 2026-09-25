import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chmod, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { repositoryContentDigest } from "../src/tools/git.js";
import { cleanupTempDir, makeTempDir } from "./helpers.js";

const exec = promisify(execFile);

describe("repository content digest", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map(cleanupTempDir));
  });

  it("tracks content for status-reported files, including nested, deleted, and unusual names", async () => {
    const root = await makeTempDir();
    roots.push(root);
    await exec("git", ["init", "-q"], { cwd: root });
    await mkdir(path.join(root, "nested"));
    await writeFile(path.join(root, ".gitignore"), "ignored.txt\n");
    await writeFile(path.join(root, "nested", "tracked.txt"), "one\n");
    await exec("git", ["add", ".gitignore", "nested/tracked.txt"], { cwd: root });

    const initial = await repositoryContentDigest(root, 5);
    expect(initial.ok).toBe(true);
    await writeFile(path.join(root, "ignored.txt"), "not part of the digest\n");
    expect(await repositoryContentDigest(root, 5)).toEqual(initial);

    await writeFile(path.join(root, "nested", "tracked.txt"), "two\n");
    const modified = await repositoryContentDigest(root, 5);
    expect(modified).not.toEqual(initial);
    await exec("git", ["add", "nested/tracked.txt"], { cwd: root });
    expect(await repositoryContentDigest(root, 5)).toEqual(modified);

    await writeFile(path.join(root, "nested", "tracked.txt"), "dirty again\n");
    const beforeModeChange = await repositoryContentDigest(root, 5);
    await chmod(path.join(root, "nested", "tracked.txt"), 0o755);
    expect(await repositoryContentDigest(root, 5)).not.toEqual(beforeModeChange);

    await rm(path.join(root, "nested", "tracked.txt"));
    const deleted = await repositoryContentDigest(root, 5);
    expect(deleted).not.toEqual(modified);

    const unusual = "nested/space and\nnewline.txt";
    await writeFile(path.join(root, unusual), "untracked\n");
    const withUnusualName = await repositoryContentDigest(root, 5);
    expect(withUnusualName).not.toEqual(deleted);
  });

  it("fails closed instead of following a status path through a symlink escape", async () => {
    const root = await makeTempDir();
    const outside = await makeTempDir();
    roots.push(root, outside);
    await exec("git", ["init", "-q"], { cwd: root });
    await mkdir(path.join(root, "nested"));
    await writeFile(path.join(root, "nested", "tracked.txt"), "inside\n");
    await exec("git", ["add", "nested/tracked.txt"], { cwd: root });
    await rm(path.join(root, "nested"), { recursive: true });
    await writeFile(path.join(outside, "tracked.txt"), "outside secret\n");
    await symlink(outside, path.join(root, "nested"));

    expect(await repositoryContentDigest(root, 5)).toMatchObject({
      ok: false,
      error: expect.stringContaining("outside repository root")
    });
  });

  it("fails closed without reading protected status paths", async () => {
    const root = await makeTempDir();
    roots.push(root);
    await exec("git", ["init", "-q"], { cwd: root });
    await writeFile(path.join(root, "private.key"), "synthetic fixture\n");
    await exec("git", ["add", "private.key"], { cwd: root });

    expect(await repositoryContentDigest(root, 5)).toMatchObject({
      ok: false,
      error: expect.stringContaining("protected path")
    });
  });
});
