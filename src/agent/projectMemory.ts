import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import { isProtectedRepoPath, resolveSafeRepoPath, toRepoRelative } from "../tools/pathGuard.js";

const MAX_INSTRUCTION_BYTES = 8 * 1024;
const TRUNCATION_NOTE = "\n\n[onehand: project instructions truncated at 8 KB]";

export async function loadProjectInstructions(repoRoot: string): Promise<string | undefined> {
  const root = await realpath(path.resolve(repoRoot));
  for (const name of ["AGENTS.md", "ONEHAND.md"]) {
    const file = await resolveSafeRepoPath(root, name);
    const relative = toRepoRelative(root, file);
    if (isProtectedRepoPath(relative)) {
      throw new Error(`Protected repository path is not accessible: ${relative}`);
    }
    const contents = await readCappedFile(file);
    if (contents !== undefined) return contents;
  }
  return undefined;
}

async function readCappedFile(file: string): Promise<string | undefined> {
  try {
    const info = await lstat(file);
    if (!info.isFile()) throw new Error(`Project instructions path is not a file: ${path.basename(file)}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }

  let handle;
  try {
    handle = await open(file, "r");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }

  try {
    const info = await handle.stat();
    const buffer = Buffer.alloc(Math.min(MAX_INSTRUCTION_BYTES + 1, Math.max(1, info.size)));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead <= MAX_INSTRUCTION_BYTES) return buffer.subarray(0, bytesRead).toString("utf8");
    return decodeCompleteUtf8Prefix(buffer.subarray(0, MAX_INSTRUCTION_BYTES)) + TRUNCATION_NOTE;
  } finally {
    await handle.close();
  }
}

function decodeCompleteUtf8Prefix(buffer: Buffer): string {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for (let end = buffer.length; end >= Math.max(0, buffer.length - 3); end -= 1) {
    try {
      return decoder.decode(buffer.subarray(0, end));
    } catch {
      // A UTF-8 code point can cross the byte cap by at most three bytes.
    }
  }
  throw new Error("Project instructions are not valid UTF-8");
}
