import { execFile } from "node:child_process";
import { access, lstat, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { CONTAINER_ROOT, docker, ensureImage, OPAQUE_NAME } from "./container.js";
import { ImageSource, imageFor, SwebenchRecord } from "./dataset.js";
import { git } from "./patch.js";

const execFileAsync = promisify(execFile);

export type SwebenchWorkspace = {
  root: string;
  // realpath of the host checkout that is bind-mounted at /testbed.
  repo: string;
  baseCommit: string;
  cleanup(): Promise<void>;
};

// Copies /testbed out of the instance image into <tmpdir>/<name>/testbed with a one-commit history. `name`
// comes from opaqueName(): the bind mount's host path is visible in the container.
export async function prepareWorkspace(record: SwebenchRecord, name: string, imageSource: ImageSource): Promise<SwebenchWorkspace> {
  if (!OPAQUE_NAME.test(name)) throw new Error(`Workspace names must be opaque (onehand-<16 hex>), got ${name}`);
  const image = imageFor(record, imageSource);
  await ensureImage(image);
  const root = path.join(tmpdir(), name);
  await mkdir(root, { mode: 0o700 });
  const cleanup = () => removeTree(root);
  try {
    const created = (await docker(["create", "--label", "onehand=1", image])).trim();
    try {
      await docker(["cp", `${created}:${CONTAINER_ROOT}`, path.join(root, "testbed")], 900_000);
    } finally {
      await docker(["rm", "-f", created]);
    }
    const repo = await realpath(path.join(root, "testbed"));
    return { root, repo, baseCommit: await rebuildGitBase(repo), cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

// The image's .git has tags and a reflog that reach commits after the issue, so the history is
// replaced by one commit of the working tree. The repository's .gitignore still applies, and as in
// git itself it never untracks a file the original history tracked.
export async function rebuildGitBase(repo: string): Promise<string> {
  const trackedIgnored = await access(path.join(repo, ".git")).then(
    () => git(repo, ["ls-files", "-z", "--cached", "--ignored", "--exclude-standard"]),
    () => ""
  );
  await rm(path.join(repo, ".git"), { recursive: true, force: true });
  await git(repo, ["init", "-q", "-b", "main"]);
  await git(repo, ["config", "user.name", "onehand"]);
  await git(repo, ["config", "user.email", "onehand@localhost"]);
  await mkdir(path.join(repo, ".git", "info"), { recursive: true });
  await writeFile(path.join(repo, ".git", "info", "exclude"), ".scratch/\n", "utf8");
  await git(repo, ["add", "-A"]);
  const keep: string[] = [];
  for (const file of trackedIgnored.split("\0").filter(Boolean)) {
    if (await lstat(path.join(repo, file)).then(() => true, () => false)) keep.push(file);
  }
  if (keep.length) {
    await git(repo, ["add", "-f", "--pathspec-from-file=-", "--pathspec-file-nul"], { input: keep.join("\0") });
  }
  await git(repo, ["commit", "-q", "--no-verify", "-m", "onehand base"]);
  return (await git(repo, ["rev-parse", "HEAD"])).trim();
}

// Image trees can contain read-only directories, which a plain recursive rm cannot empty.
async function removeTree(root: string): Promise<void> {
  await execFileAsync("chmod", ["-R", "u+w", root]).catch(() => undefined);
  await rm(root, { recursive: true, force: true });
}
