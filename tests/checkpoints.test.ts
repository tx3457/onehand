import { execFile } from "node:child_process";
import { lstat, mkdir, readFile, readdir, readlink, symlink, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CheckpointStore } from "../src/runtime/checkpoints.js";
import { cleanupTempDir, git, initGitRepo, makeTempDir } from "./helpers.js";

const execFileAsync = promisify(execFile);

describe("CheckpointStore", () => {
  let repo: string;
  let checkpointBase: string;
  let previousCheckpointDir: string | undefined;

  beforeEach(async () => {
    repo = await makeTempDir("onehand-checkpoint-repo-");
    checkpointBase = await makeTempDir("onehand-checkpoint-store-");
    previousCheckpointDir = process.env.ONEHAND_CHECKPOINT_DIR;
    process.env.ONEHAND_CHECKPOINT_DIR = checkpointBase;
    await initGitRepo(repo);
    await writeFile(path.join(repo, "tracked.txt"), "source head\n");
    await git(["add", "tracked.txt"], repo);
    await git(["commit", "-m", "source"], repo);
  });

  afterEach(async () => {
    if (previousCheckpointDir === undefined) delete process.env.ONEHAND_CHECKPOINT_DIR;
    else process.env.ONEHAND_CHECKPOINT_DIR = previousCheckpointDir;
    await Promise.all([cleanupTempDir(repo), cleanupTempDir(checkpointBase)]);
  });

  it("restores modified and newly created files without changing the source repository metadata", async () => {
    const before = await sourceGitState(repo);
    await writeFile(path.join(repo, "tracked.txt"), "checkpoint value\n");
    const store = new CheckpointStore(repo);
    const checkpoint = await store.snapshot("before edits");

    await writeFile(path.join(repo, "tracked.txt"), "later value\n");
    await writeFile(path.join(repo, "created.txt"), "created later\n");
    expect(await store.diff(checkpoint.id)).toContain("+later value");

    await store.restore(checkpoint.id);

    expect(await readFile(path.join(repo, "tracked.txt"), "utf8")).toBe("checkpoint value\n");
    await expect(lstat(path.join(repo, "created.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await sourceGitState(repo)).toEqual(before);
    expect(await store.list()).toEqual([checkpoint]);
  });

  it("leaves ignored and protected files out of snapshots and notes files over 5 MB", async () => {
    await writeFile(path.join(repo, ".gitignore"), "ignored.txt\n");
    await writeFile(path.join(repo, "ignored.txt"), "ignored before\n");
    await writeFile(path.join(repo, ".env"), "SECRET=before\n");
    await writeFile(path.join(repo, "large.bin"), Buffer.alloc(5 * 1024 * 1024 + 1, 7));
    const store = new CheckpointStore(repo);
    const checkpoint = await store.snapshot("safe files only");

    expect(checkpoint.notes).toEqual(["Skipped large.bin: exceeds 5 MB"]);
    await unlink(path.join(repo, ".gitignore"));
    await writeFile(path.join(repo, "ignored.txt"), "ignored after\n");
    await writeFile(path.join(repo, ".env"), "SECRET=after\n");
    const secretMetadata = await fileMetadata(path.join(repo, ".env"));
    await writeFile(path.join(repo, "large.bin"), "small replacement\n");
    await store.restore(checkpoint.id);

    expect(await readFile(path.join(repo, "ignored.txt"), "utf8")).toBe("ignored after\n");
    expect(await fileMetadata(path.join(repo, ".env"))).toEqual(secretMetadata);
    expect(await readFile(path.join(repo, "large.bin"), "utf8")).toBe("small replacement\n");
    const diff = await store.diff(checkpoint.id);
    expect(diff).not.toContain("SECRET");
    expect(diff).not.toContain("ignored.txt");
  });

  it("does not overwrite a snapshot path that the current work tree now ignores", async () => {
    await writeFile(path.join(repo, "local.txt"), "checkpoint value\n");
    const store = new CheckpointStore(repo);
    const checkpoint = await store.snapshot("before local override");
    await writeFile(path.join(repo, ".gitignore"), "local.txt\n");
    await writeFile(path.join(repo, "local.txt"), "ignored override\n");

    await store.restore(checkpoint.id);

    expect(await readFile(path.join(repo, "local.txt"), "utf8")).toBe("ignored override\n");
  });

  it("restores file, directory, and symlink transitions without following an outside symlink", async () => {
    const outside = await makeTempDir("onehand-checkpoint-outside-");
    try {
      await writeFile(path.join(outside, "target.txt"), "outside\n");
      await writeFile(path.join(repo, "node"), "plain file\n");
      await symlink(path.join(outside, "target.txt"), path.join(repo, "outside-link"));
      const store = new CheckpointStore(repo);
      const checkpoint = await store.snapshot("path types");

      await Promise.all([unlink(path.join(repo, "node")), unlink(path.join(repo, "outside-link"))]);
      await mkdir(path.join(repo, "node"));
      await writeFile(path.join(repo, "node", "child.txt"), "child\n");
      await writeFile(path.join(repo, "outside-link"), "local replacement\n");
      await store.restore(checkpoint.id);

      expect((await lstat(path.join(repo, "node"))).isFile()).toBe(true);
      expect(await readFile(path.join(repo, "node"), "utf8")).toBe("plain file\n");
      expect((await lstat(path.join(repo, "outside-link"))).isSymbolicLink()).toBe(true);
      expect(await readlink(path.join(repo, "outside-link"))).toBe(path.join(outside, "target.txt"));
      expect(await readFile(path.join(outside, "target.txt"), "utf8")).toBe("outside\n");
    } finally {
      await cleanupTempDir(outside);
    }
  });

  it("preserves ignored children when a snapshot file is now a directory", async () => {
    await writeFile(path.join(repo, "node"), "snapshot file\n");
    const store = new CheckpointStore(repo);
    const checkpoint = await store.snapshot("file before directory");
    await unlink(path.join(repo, "node"));
    await mkdir(path.join(repo, "node"));
    await writeFile(path.join(repo, ".gitignore"), "node/ignored.txt\n");
    await writeFile(path.join(repo, "node", "ignored.txt"), "keep\n");

    await store.restore(checkpoint.id);

    expect((await lstat(path.join(repo, "node"))).isDirectory()).toBe(true);
    expect(await readFile(path.join(repo, "node", "ignored.txt"), "utf8")).toBe("keep\n");
  });

  it("treats pathspec-like filenames literally without snapshotting protected files", async () => {
    await writeFile(path.join(repo, "*"), "literal star\n");
    await writeFile(path.join(repo, ":(glob)**"), "literal magic\n");
    await writeFile(path.join(repo, ".env"), "SECRET=never staged\n");
    const store = new CheckpointStore(repo);
    const checkpoint = await store.snapshot("literal pathspecs");

    expect(await checkpointTreeNames(checkpointBase, checkpoint.id)).toEqual([
      "*",
      ":(glob)**",
      "tracked.txt"
    ]);
  });

  it("lists durable snapshots newest first while diff leaves the list unchanged", async () => {
    const store = new CheckpointStore(repo);
    const first = await store.snapshot("first");
    await writeFile(path.join(repo, "tracked.txt"), "second\n");
    const second = await store.snapshot("second");

    await store.diff(first.id);

    expect(await store.list()).toEqual([second, first]);
  });

  it("serializes concurrent checkpoint operations from separate store objects", async () => {
    const stores = Array.from({ length: 6 }, () => new CheckpointStore(repo));
    const snapshots = await Promise.all(stores.map((store, index) => store.snapshot(`parallel ${index}`)));

    const listed = await new CheckpointStore(repo).list();

    expect(listed).toHaveLength(snapshots.length);
    expect(new Set(listed.map((checkpoint) => checkpoint.id))).toEqual(new Set(snapshots.map((checkpoint) => checkpoint.id)));
  });

  it("refuses checkpoint storage inside the work tree, including a symlink into its Git directory", async () => {
    const before = await sourceGitState(repo);
    process.env.ONEHAND_CHECKPOINT_DIR = path.join(repo, ".git", "checkpoints");
    await expect(new CheckpointStore(repo).snapshot("unsafe location")).rejects.toThrow("outside the work tree");
    await expect(lstat(path.join(repo, ".git", "checkpoints"))).rejects.toMatchObject({ code: "ENOENT" });
    const alias = path.join(checkpointBase, "alias");
    await symlink(path.join(repo, ".git"), alias);
    process.env.ONEHAND_CHECKPOINT_DIR = path.join(alias, "checkpoints");
    await expect(new CheckpointStore(repo).snapshot("unsafe alias")).rejects.toThrow("outside the work tree");
    expect(await sourceGitState(repo)).toEqual(before);
  });

  it("supports an empty checkpoint and removes later files without touching ignored content", async () => {
    const emptyRepo = await makeTempDir("onehand-checkpoint-empty-");
    try {
      await initGitRepo(emptyRepo);
      await writeFile(path.join(emptyRepo, ".env"), "SECRET=keep\n");
      const store = new CheckpointStore(emptyRepo);
      const checkpoint = await store.snapshot("empty");
      await writeFile(path.join(emptyRepo, ".gitignore"), "ignored.txt\n");
      await writeFile(path.join(emptyRepo, "created.txt"), "later\n");
      await writeFile(path.join(emptyRepo, "ignored.txt"), "keep\n");

      await store.restore(checkpoint.id);

      await expect(lstat(path.join(emptyRepo, "created.txt"))).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readFile(path.join(emptyRepo, "ignored.txt"), "utf8")).toBe("keep\n");
    } finally {
      await cleanupTempDir(emptyRepo);
    }
  });
});

async function sourceGitState(repo: string): Promise<{ head: string; index: string; refs: string }> {
  const [head, index, refs] = await Promise.all([
    execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repo }),
    readFile(path.join(repo, ".git", "index")),
    execFileAsync("git", ["show-ref"], { cwd: repo })
  ]);
  return { head: head.stdout, index: index.toString("base64"), refs: refs.stdout };
}

async function checkpointTreeNames(base: string, id: string): Promise<string[]> {
  const gitDir = path.join(base, (await readdir(base)).find((name) => name.endsWith(".git"))!);
  const result = await execFileAsync("git", [`--git-dir=${gitDir}`, "ls-tree", "-r", "--name-only", id]);
  return result.stdout.trim().split("\n").filter(Boolean).sort();
}

async function fileMetadata(file: string): Promise<{ size: number; mode: number; mtimeMs: number }> {
  const info = await lstat(file);
  return { size: info.size, mode: info.mode, mtimeMs: info.mtimeMs };
}
