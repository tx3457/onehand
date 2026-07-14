import path from "node:path";
import { realpath } from "node:fs/promises";

export const DEFAULT_IGNORED_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  ".onehand"
]);

const PROTECTED_NAMES = new Set([
  ".git",
  ".onehand",
  ".npmrc",
  ".pypirc",
  "id_rsa",
  "id_ed25519"
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

export async function resolveSafeRepoPath(
  repoRoot: string,
  inputPath = ".",
  options: { protectSecrets?: boolean } = {}
): Promise<string> {
  const root = await realpath(path.resolve(repoRoot));
  const lexical = resolveInsideRepo(root, inputPath);
  const relative = path.relative(root, lexical);
  if (options.protectSecrets !== false) assertNotProtected(relative);

  let probe = lexical;
  const missing: string[] = [];
  let resolvedParent: string;
  for (;;) {
    try {
      resolvedParent = await realpath(probe);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = path.dirname(probe);
      if (parent === probe) throw error;
      missing.unshift(path.basename(probe));
      probe = parent;
    }
  }
  const resolved = path.resolve(resolvedParent, ...missing);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error(`Path resolves outside repository root: ${inputPath}`);
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

export function isProtectedRepoPath(relativePath: string): boolean {
  const components = relativePath.split(/[\\/]+/).filter(Boolean);
  return components.some((component) => {
    const lower = component.toLowerCase();
    return PROTECTED_NAMES.has(lower) || lower === ".env" || lower.startsWith(".env.") ||
      lower.endsWith(".pem") || lower.endsWith(".key") || lower.endsWith(".p12");
  });
}

function assertNotProtected(relativePath: string): void {
  if (isProtectedRepoPath(relativePath)) {
    throw new Error(`Protected repository path is not accessible: ${relativePath}`);
  }
}
