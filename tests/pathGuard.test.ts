import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanupTempDir, makeTempDir } from "./helpers.js";
import { normalizeRepoRoot, resolveInsideRepo, toRepoRelative } from "../src/tools/pathGuard.js";

describe("path guard", () => {
  let repo: string;

  beforeEach(async () => {
    repo = await makeTempDir();
    await mkdir(path.join(repo, "src"));
    await writeFile(path.join(repo, "src", "index.ts"), "export const ok = true;\n");
  });

  afterEach(async () => {
    await cleanupTempDir(repo);
  });

  it("resolves relative paths inside the repository", async () => {
    const root = await normalizeRepoRoot(repo);
    const file = resolveInsideRepo(root, "src/index.ts");
    expect(file).toBe(path.join(root, "src", "index.ts"));
    expect(toRepoRelative(root, file)).toBe("src/index.ts");
  });

  it("allows absolute paths inside the repository", async () => {
    const root = await normalizeRepoRoot(repo);
    expect(resolveInsideRepo(root, path.join(root, "src"))).toBe(path.join(root, "src"));
  });

  it("blocks traversal outside the repository", async () => {
    const root = await normalizeRepoRoot(repo);
    expect(() => resolveInsideRepo(root, "../outside.txt")).toThrow(/escapes repository/);
    expect(() => resolveInsideRepo(root, "/etc/passwd")).toThrow(/escapes repository/);
  });
});
