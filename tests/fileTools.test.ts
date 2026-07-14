import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanupTempDir, makeTempDir } from "./helpers.js";
import {
  listFiles,
  readRepoFile,
  replaceText,
  searchCode,
  writeRepoFile
} from "../src/tools/fileTools.js";
import { normalizeRepoRoot } from "../src/tools/pathGuard.js";

describe("file tools", () => {
  let repo: string;
  let root: string;

  beforeEach(async () => {
    repo = await makeTempDir();
    root = await normalizeRepoRoot(repo);
    await mkdir(path.join(root, "src"), { recursive: true });
    await mkdir(path.join(root, "node_modules", "pkg"), { recursive: true });
    await writeFile(path.join(root, "src", "index.ts"), "alpha\nbeta\nalpha\n");
    await writeFile(path.join(root, ".env"), "SECRET=alpha\n");
    await writeFile(path.join(root, "src", "private.key"), "alpha-private\n");
    await writeFile(path.join(root, "node_modules", "pkg", "ignored.js"), "alpha\n");
  });

  afterEach(async () => {
    await cleanupTempDir(repo);
  });

  it("lists files while skipping ignored directories", async () => {
    const result = await listFiles(root, {});
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.files).toEqual(["src/index.ts"]);
    }
  });

  it("searches code in fixture files", async () => {
    const result = await searchCode(root, { query: "beta" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.matches).toContainEqual({
        path: "src/index.ts",
        line: 2,
        column: 1,
        text: "beta"
      });
      expect(result.data.matches.map((match) => match.path)).not.toContain(".env");
      expect(result.data.matches.map((match) => match.path)).not.toContain("src/private.key");
    }
  });

  it("reads and writes files inside the repository", async () => {
    const write = await writeRepoFile(root, {
      path: "src/new.ts",
      content: "export const value = 1;\n"
    });
    expect(write.ok).toBe(true);

    const read = await readRepoFile(root, { path: "src/new.ts" });
    expect(read.ok).toBe(true);
    if (read.ok) {
      expect(read.data.content).toBe("export const value = 1;\n");
    }
  });

  it("requires unique replace_text matches unless occurrence is specified", async () => {
    const ambiguous = await replaceText(root, {
      path: "src/index.ts",
      oldText: "alpha",
      newText: "gamma"
    });
    expect(ambiguous.ok).toBe(false);

    const replaced = await replaceText(root, {
      path: "src/index.ts",
      oldText: "alpha",
      newText: "gamma",
      occurrence: 2
    });
    expect(replaced.ok).toBe(true);
    expect(await readFile(path.join(root, "src", "index.ts"), "utf8")).toBe("alpha\nbeta\ngamma\n");
  });
});
