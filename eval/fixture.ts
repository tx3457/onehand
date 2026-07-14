import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { EvaluationTask } from "./tasks.js";

const execFileAsync = promisify(execFile);

export type PreparedFixture = {
  root: string;
  repo: string;
  hiddenTestPath: string;
  initialHead: string;
  outsideHashes: Record<string, string>;
  initialOutsideEntries: string[];
  materializeHiddenTest(): Promise<void>;
  cleanup(): Promise<void>;
};

export async function prepareFixture(task: EvaluationTask, runLabel: string): Promise<PreparedFixture> {
  const root = await mkdtemp(path.join(tmpdir(), `onehand-eval-${task.id}-${runLabel}-`));
  const repo = path.join(root, "repo");
  const hiddenDir = path.join(root, "hidden");
  await mkdir(repo, { recursive: true });

  for (const [relative, content] of Object.entries(task.files)) {
    await write(repo, relative, content);
  }
  await write(repo, "test.cjs", task.publicTest);
  const hiddenTestPath = path.join(hiddenDir, "acceptance.cjs");
  const hiddenTestSource = task.hiddenTest.replaceAll("require('./", "require(process.cwd()+'/");
  for (const [relative, content] of Object.entries(task.seedOutsideFiles ?? {})) {
    await write(root, relative, content);
  }
  await writeFile(path.join(root, "task.json"), JSON.stringify({
    id: task.id,
    split: task.split,
    category: task.category,
    prompt: task.prompt,
    expectedMutation: task.expectedMutation,
    forbiddenPaths: task.forbiddenPaths,
    taskHash: hashTask(task)
  }, null, 2) + "\n", "utf8");

  await git(["init", "-b", "main"], repo);
  await git(["config", "user.email", "onehand-eval@example.com"], repo);
  await git(["config", "user.name", "onehand-eval"], repo);
  await git(["add", "."], repo);
  await git(["commit", "-m", "fixture baseline"], repo);
  const initialHead = (await git(["rev-parse", "HEAD"], repo)).trim();
  const outsideHashes: Record<string, string> = {};
  for (const relative of ["task.json", ...Object.keys(task.seedOutsideFiles ?? {})]) {
    outsideHashes[relative] = sha256(await readFile(path.join(root, relative)));
  }
  const initialOutsideEntries = (await readdir(root)).sort();

  return {
    root,
    repo,
    hiddenTestPath,
    initialHead,
    outsideHashes,
    initialOutsideEntries,
    async materializeHiddenTest() {
      await mkdir(hiddenDir);
      await writeFile(hiddenTestPath, hiddenTestSource, { encoding: "utf8", flag: "wx" });
      outsideHashes["hidden/acceptance.cjs"] = sha256(await readFile(hiddenTestPath));
      initialOutsideEntries.splice(0, initialOutsideEntries.length, ...(await readdir(root)).sort());
    },
    cleanup: () => rm(root, { recursive: true, force: true })
  };
}

export function hashTask(task: EvaluationTask): string {
  return sha256(Buffer.from(stableJson(task), "utf8"));
}

async function write(root: string, relative: string, content: string): Promise<void> {
  const target = path.join(root, relative);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content, "utf8");
}

async function git(args: string[], cwd: string): Promise<string> {
  const result = await execFileAsync("git", args, { cwd, env: safeEnv() });
  return result.stdout;
}

function safeEnv(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    LANG: process.env.LANG ?? "C.UTF-8"
  };
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
