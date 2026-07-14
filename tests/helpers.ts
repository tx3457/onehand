import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function makeTempDir(prefix = "onehand-"): Promise<string> {
  return mkdtemp(path.join(tmpdir(), prefix));
}

export async function cleanupTempDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

export async function git(args: string[], cwd: string): Promise<void> {
  await execFileAsync("git", args, { cwd });
}

export async function initGitRepo(cwd: string): Promise<void> {
  await git(["init"], cwd);
  await git(["config", "user.email", "onehand@example.com"], cwd);
  await git(["config", "user.name", "onehand"], cwd);
}
