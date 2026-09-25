import { spawnSync } from "node:child_process";
import { chmod, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanupTempDir, makeTempDir } from "./helpers.js";
import {
  fallbackSearch,
  listFiles,
  readRepoFile,
  replaceText,
  searchCode,
  writeRepoFile
} from "../src/tools/fileTools.js";
import { normalizeRepoRoot } from "../src/tools/pathGuard.js";

const hasRg = spawnSync("rg", ["--version"]).status === 0;
const REGEX_REQUIRES_RG = "Regex search requires ripgrep (rg); retry with a literal query";

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

  it("keeps the file mode when replaceText overwrites an existing file", async () => {
    if (process.platform === "win32") return;
    await chmod(path.join(root, "src", "index.ts"), 0o755);
    const result = await replaceText(root, { path: "src/index.ts", oldText: "beta", newText: "gamma" });
    expect(result.ok).toBe(true);
    const info = await stat(path.join(root, "src", "index.ts"));
    expect(info.mode & 0o777).toBe(0o755);
  });

  it("keeps the file mode when writeRepoFile overwrites an existing file", async () => {
    if (process.platform === "win32") return;
    await chmod(path.join(root, "src", "index.ts"), 0o640);
    const result = await writeRepoFile(root, { path: "src/index.ts", content: "replaced\n" });
    expect(result.ok).toBe(true);
    const info = await stat(path.join(root, "src", "index.ts"));
    expect(info.mode & 0o777).toBe(0o640);
  });

  it("creates a new file with mode 0o666 minus the process umask", async () => {
    if (process.platform === "win32") return;
    const probe = path.join(root, "umask-probe");
    await writeFile(probe, "", { mode: 0o666 });
    const expected = (await stat(probe)).mode & 0o777;
    const result = await writeRepoFile(root, { path: "src/created.ts", content: "export {};\n" });
    expect(result.ok).toBe(true);
    expect((await stat(path.join(root, "src", "created.ts"))).mode & 0o777).toBe(expected);
  });

  it("drops the setuid bit when replaceText rewrites a file", async () => {
    if (process.platform === "win32") return;
    const file = path.join(root, "src", "index.ts");
    await chmod(file, 0o4755);
    expect((await stat(file)).mode & 0o7777).toBe(0o4755);
    const result = await replaceText(root, { path: "src/index.ts", oldText: "beta", newText: "gamma" });
    expect(result.ok).toBe(true);
    expect((await stat(file)).mode & 0o7777).toBe(0o755);
  });

  it("removes the temporary file when the atomic rename fails", async () => {
    const result = await writeRepoFile(root, { path: "src", content: "src is a directory\n" });
    expect(result.ok).toBe(false);
    expect((await readdir(root)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("finds a literal query through rg and through the fallback", async () => {
    await writeFile(path.join(root, "src", "literal.ts"), "def foo(x):\n  return x\n");

    const viaSearchCode = await searchCode(root, { query: "def foo(" });
    expect(viaSearchCode.ok).toBe(true);
    if (viaSearchCode.ok) {
      expect(viaSearchCode.data.matches.some((match) => match.path === "src/literal.ts")).toBe(true);
    }

    const viaFallback = await fallbackSearch(root, root, "def foo(", 100);
    expect(viaFallback.some((match) => match.path === "src/literal.ts")).toBe(true);
  });

  it("reports 1-based UTF-8 byte columns from the fallback, matching rg", async () => {
    await writeFile(path.join(root, "src", "wide.ts"), "中文 target\n");
    const expected = { path: "src/wide.ts", line: 1, column: 8, text: "中文 target" };
    expect(await fallbackSearch(root, root, "target", 100)).toEqual([expected]);
    expect(await searchCode(root, { query: "target" })).toMatchObject({ ok: true, data: { matches: [expected] } });
  });

  it("uses ripgrep regex syntax when rg is installed and refuses regex search without it", async () => {
    const dotted = await searchCode(root, { query: "be.a", regex: true });
    const caseInsensitive = await searchCode(root, { query: "(?i)BETA", regex: true });
    if (!hasRg) {
      expect(dotted).toEqual({ ok: false, recoverable: true, error: REGEX_REQUIRES_RG });
      expect(caseInsensitive).toEqual({ ok: false, recoverable: true, error: REGEX_REQUIRES_RG });
      return;
    }
    const beta = { path: "src/index.ts", line: 2, column: 1, text: "beta" };
    expect(dotted).toMatchObject({ ok: true, data: { matches: [beta] } });
    expect(caseInsensitive).toMatchObject({ ok: true, data: { matches: [beta] } });
  });

  it("refuses regex search when rg cannot be resolved, even if rg is installed on this machine", async () => {
    const emptyPathDir = await makeTempDir();
    const originalPath = process.env.PATH;
    process.env.PATH = emptyPathDir;
    try {
      const result = await searchCode(root, { query: "be.a", regex: true });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain("requires ripgrep");
    } finally {
      process.env.PATH = originalPath;
      await cleanupTempDir(emptyPathDir);
    }
  });

  it("returns ok:false for an invalid regex", async () => {
    const result = await searchCode(root, { query: "(unclosed", regex: true });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(hasRg ? /regex/i : REGEX_REQUIRES_RG);
  });
});
