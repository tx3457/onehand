import path from "node:path";
import { realpath } from "node:fs/promises";

export const DEFAULT_IGNORED_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  ".onehand"
]);

export async function normalizeRepoRoot(repoPath: string): Promise<string> {
  return realpath(path.resolve(repoPath));
}

export function resolveInsideRepo(repoRoot: string, inputPath = "."): string {
  const resolved = path.resolve(
    path.isAbsolute(inputPath) ? inputPath : path.join(repoRoot, inputPath)
  );
  const normalizedRoot = path.resolve(repoRoot);

  if (resolved !== normalizedRoot && !resolved.startsWith(normalizedRoot + path.sep)) {
    throw new Error(`Path escapes repository root: ${inputPath}`);
  }

  return resolved;
}

export function toRepoRelative(repoRoot: string, absolutePath: string): string {
  const relative = path.relative(repoRoot, absolutePath);
  return relative === "" ? "." : relative.split(path.sep).join("/");
}

export function shouldSkipDir(name: string): boolean {
  return DEFAULT_IGNORED_DIRS.has(name);
}
