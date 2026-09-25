import { spawnSync } from "node:child_process";
import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  listFiles,
  readRepoFile,
  replaceText,
  searchCode
} from "../src/tools/fileTools.js";
import { renderToolResult } from "../src/tools/render.js";
import { DEFAULT_TOOL_OUTPUT_LIMIT } from "../src/utils/truncate.js";
import * as gitTools from "../src/tools/git.js";
import { normalizeRepoRoot } from "../src/tools/pathGuard.js";
import { cleanupTempDir, makeTempDir } from "./helpers.js";

const hasRg = spawnSync("rg", ["--version"]).status === 0;

describe("retrieval file tools", () => {
  let temporaryRoot: string;
  let root: string;

  beforeEach(async () => {
    temporaryRoot = await makeTempDir();
    root = await normalizeRepoRoot(temporaryRoot);
    await mkdir(path.join(root, "src"), { recursive: true });
  });

  afterEach(async () => {
    await cleanupTempDir(temporaryRoot);
  });

  it("returns a whole short file with cat-n numbering without corrupting UTF-8", async () => {
    await writeFile(path.join(root, "src", "short.txt"), "中文\nlast");

    const result = await readRepoFile(root, { path: "src/short.txt" }, true);

    expect(result).toEqual({
      ok: true,
      data: {
        path: "src/short.txt",
        content: "     1\t中文\n     2\tlast",
        bytes: 11,
        totalLines: 2,
        startLine: 1,
        endLine: 2
      },
      truncated: false
    });
  });

  it("returns an empty file as an empty whole-file window", async () => {
    await writeFile(path.join(root, "src", "empty.txt"), "");
    expect(await readRepoFile(root, { path: "src/empty.txt" }, true)).toEqual({
      ok: true,
      data: {
        path: "src/empty.txt",
        content: "",
        bytes: 0,
        totalLines: 0,
        startLine: 1,
        endLine: 0
      },
      truncated: false
    });
  });

  it("returns all 400 lines but windows a longer Python file and includes its outline", async () => {
    const fourHundred = Array.from({ length: 400 }, (_, index) => `line ${index + 1}`).join("\n");
    await writeFile(path.join(root, "src", "boundary.txt"), fourHundred);
    const whole = await readRepoFile(root, { path: "src/boundary.txt" }, true);
    expect(whole).toMatchObject({ ok: true, data: { totalLines: 400, startLine: 1, endLine: 400 } });

    const lines = Array.from({ length: 401 }, (_, index) => {
      if (index === 7) return "class Example:";
      if (index === 249) return "async def later():";
      return `value_${index + 1} = ${index + 1}`;
    });
    await writeFile(path.join(root, "src", "large.py"), `${lines.join("\n")}\n`);

    const result = await readRepoFile(root, { path: "src/large.py" }, true);
    expect(result).toMatchObject({
      ok: true,
      data: {
        totalLines: 401,
        startLine: 1,
        endLine: 200,
        outline: "     8\tclass Example:\n   250\tasync def later():",
        note: "File has 401 lines; showing 1–200. Pass startLine/endLine to read other parts."
      }
    });
    if (result.ok) {
      expect(result.data.content).toContain("     1\tvalue_1 = 1");
      expect(result.data.content).toContain("   200\tvalue_200 = 200");
      expect(result.data.content).not.toContain("value_201");
    }
  });

  it("windows a long non-Python file without an outline and caps Python outlines at 150 entries", async () => {
    await writeFile(path.join(root, "src", "long.txt"), Array.from({ length: 401 }, () => "text").join("\n"));
    const plain = await readRepoFile(root, { path: "src/long.txt" }, true);
    expect(plain).toMatchObject({ ok: true, data: { startLine: 1, endLine: 200 } });
    if (plain.ok) expect(plain.data.outline).toBeUndefined();

    await writeFile(path.join(root, "src", "outlined.py"), Array.from({ length: 401 }, (_, index) => `def f_${index}():`).join("\n"));
    const python = await readRepoFile(root, { path: "src/outlined.py" }, true);
    expect(python).toMatchObject({ ok: true });
    if (python.ok) expect(python.data.outline?.split("\n")).toHaveLength(150);
  });

  it("supports explicit inclusive ranges and caps them at 600 lines", async () => {
    const lines = Array.from({ length: 800 }, (_, index) => `line ${index + 1}`);
    await writeFile(path.join(root, "src", "large.txt"), lines.join("\r\n"));

    const range = await readRepoFile(root, { path: "src/large.txt", startLine: 10, endLine: 12 }, true);
    expect(range).toMatchObject({
      ok: true,
      data: {
        content: "    10\tline 10\n    11\tline 11\n    12\tline 12",
        totalLines: 800,
        startLine: 10,
        endLine: 12
      }
    });

    const capped = await readRepoFile(root, { path: "src/large.txt", startLine: 50, endLine: 800 }, true);
    expect(capped).toMatchObject({
      ok: true,
      data: {
        totalLines: 800,
        startLine: 50,
        endLine: 649,
        note: "Requested range has 751 lines; showing 50–649 (maximum 600 lines)."
      }
    });

    const beyondEof = await readRepoFile(root, { path: "src/large.txt", startLine: 700, endLine: 2_000 }, true);
    expect(beyondEof).toMatchObject({ ok: true, data: { startLine: 700, endLine: 800 } });
    if (beyondEof.ok) expect(beyondEof.data.note).toBeUndefined();
  });

  it("reports totalLines when an explicit start is beyond EOF", async () => {
    await writeFile(path.join(root, "src", "tiny.txt"), "one\r\ntwo");
    const result = await readRepoFile(root, { path: "src/tiny.txt", startLine: 3 }, true);
    expect(result).toEqual({
      ok: false,
      error: "startLine 3 is beyond end of file (totalLines: 2)",
      recoverable: true
    });
  });

  it("warns when replace_text receives numbered read_file text", async () => {
    await writeFile(path.join(root, "src", "edit.txt"), "alpha\nbeta\n");
    const result = await replaceText(root, {
      path: "src/edit.txt",
      oldText: "     1\talpha\n     2\tbeta",
      newText: "gamma"
    }, true);
    expect(result).toEqual({
      ok: false,
      error: "oldText includes read_file line numbers; remove the line-number prefixes and retry",
      recoverable: true
    });

    await writeFile(path.join(root, "src", "windows.txt"), "alpha\r\nbeta\r\n");
    expect(await replaceText(root, {
      path: "src/windows.txt",
      oldText: "     1\talpha\n     2\tbeta\n",
      newText: "gamma"
    }, true)).toMatchObject({ ok: false, error: expect.stringContaining("line numbers") });
  });

  it("keeps the numbered outline and content within maxBytes", async () => {
    const lines = Array.from({ length: 401 }, (_, index) => index % 2 === 0 ? `def function_${index}():` : "  pass");
    await writeFile(path.join(root, "src", "outlined.py"), lines.join("\n"));
    const result = await readRepoFile(root, { path: "src/outlined.py", maxBytes: 200 }, true);
    expect(result).toMatchObject({ ok: true, truncated: true });
    if (result.ok) {
      expect(Buffer.byteLength(`${result.data.outline ?? ""}\n${result.data.content}`, "utf8")).toBeLessThanOrEqual(200);
      expect(`${result.data.outline}${result.data.content}`).not.toContain("[onehand: output truncated");
      expect(result.data.note).toContain("output size limit");
    }
  });

  it("discloses a byte-limited outline even when the whole content window fits", async () => {
    const lines = [...Array<string>(200).fill("x"),
      ...Array.from({ length: 201 }, (_, index) => `def f_${String(index + 201).padStart(4, "0")}(): #${"x".repeat(285)}`)];
    await writeFile(path.join(root, "outline-only.py"), lines.join("\n"));
    const result = await readRepoFile(root, { path: "outline-only.py" }, true);
    expect(result).toMatchObject({ ok: true, truncated: true, data: { startLine: 1, endLine: 200, totalLines: 401 } });
    if (!result.ok) throw new Error(result.error);
    const rendered = renderToolResult("read_file", result);
    expect(rendered).toContain("Outline limited to 21 entries (output size limit).");
    expect(rendered).toContain("outline-only.py (lines 1–200 of 401)");
    expect(rendered).toContain("Pass startLine/endLine to read other parts.");
    expect(rendered).not.toContain("[onehand: output truncated");
    expect(Buffer.byteLength(rendered, "utf8")).toBeLessThanOrEqual(DEFAULT_TOOL_OUTPUT_LIMIT);
  });

  it("rejects a byte budget too small to show a numbered truncated line", async () => {
    await writeFile(path.join(root, "tiny-budget.txt"), "界".repeat(100));
    for (const maxBytes of [1, 50]) {
      expect(await readRepoFile(root, { path: "tiny-budget.txt", maxBytes }, true)).toMatchObject({
        ok: false, error: expect.stringContaining("increase maxBytes"), recoverable: true
      });
    }
  });

  it.each([
    { name: "a short file with long UTF-8 lines", file: "short.txt", total: 200, start: 1, end: 53, outline: false, giant: false },
    { name: "an explicit 600-line window", file: "range.txt", total: 800, start: 101, end: 153, outline: false, giant: false },
    { name: "the default window with a large Python outline", file: "large.py", total: 401, start: 1, end: 32, outline: true, giant: false },
    { name: "a single giant UTF-8 line", file: "giant.txt", total: 1, start: 1, end: 1, outline: false, giant: true }
  ])("keeps read data and rendering consistent for $name", async ({ file, total, start, end, outline, giant }) => {
    const lines = Array.from({ length: total }, (_, index) => outline
      ? `def f_${String(index + 1).padStart(4, "0")}(): #${"x".repeat(285)}`
      : "界".repeat(giant ? 20_000 : 100));
    await writeFile(path.join(root, file), lines.join("\n"));
    const range = start === 101 ? { startLine: 101, endLine: 700 } : {};
    const result = await readRepoFile(root, { path: file, ...range }, true);
    expect(result).toMatchObject({ ok: true, truncated: true, data: { startLine: start, endLine: end, totalLines: total } });
    if (!result.ok) throw new Error(result.error);
    const rendered = renderToolResult("read_file", result);
    const note = `Showing ${start}–${end} of ${total} (output size limit); continue with startLine=${end + 1}.`;
    expect(result.data.note).toBe(note);
    expect(rendered).toContain(`${file} (lines ${start}–${end} of ${total})`);
    expect(rendered.endsWith(note)).toBe(true);
    expect(Buffer.byteLength(rendered, "utf8")).toBeLessThanOrEqual(DEFAULT_TOOL_OUTPUT_LIMIT);
    expect(rendered).not.toContain("\uFFFD");
    const renderedNumbers = [...rendered.matchAll(/^ *([0-9]+)\t/gm)].map((match) => Number(match[1]));
    expect(renderedNumbers.at(-1)).toBe(result.data.endLine);
    const contentLines = result.data.content.split("\n").filter((line) => /^ *[0-9]+\t/.test(line));
    expect(contentLines).toHaveLength(end - start + 1);
    if (giant) {
      expect(rendered.match(/\[onehand: output truncated/g)).toHaveLength(1);
      expect(result.data.outline).toBeUndefined();
      expect(result.data.content).toContain("界");
    } else {
      expect(rendered).not.toContain("[onehand: output truncated");
      expect(contentLines.map((line) => line.slice(line.indexOf("\t") + 1))).toEqual(lines.slice(start - 1, end));
    }
    if (outline) {
      expect(result.data.outline!.split("\n")).toHaveLength(21);
      expect(Buffer.byteLength(result.data.outline!, "utf8")).toBeLessThanOrEqual(16 * 1024 * 0.4);
      expect(result.data.outline!.split("\n").map((line) => line.slice(line.indexOf("\t") + 1))).toEqual(lines.slice(0, 21));
    }
  });

  it.skipIf(!hasRg)("groups rg matches, includes context lines, applies glob, and caps each file", async () => {
    await writeFile(path.join(root, "src", "many.py"), ["before", ...Array.from({ length: 22 }, () => "target"), "after"].join("\n"));
    await writeFile(path.join(root, "src", "excluded.ts"), "target\n");

    const result = await searchCode(root, { query: "target", glob: "*.py", contextLines: 1 }, true);

    expect(result).toMatchObject({
      ok: true,
      truncated: true,
      data: {
        matches: expect.arrayContaining([{ path: "src/many.py", line: 2, column: 1, text: "target" }]),
        groups: [{ path: "src/many.py", omitted: 2 }]
      }
    });
    if (result.ok) {
      expect(result.data.matches).toHaveLength(20);
      expect(result.data.matches.every((match) => match.path.endsWith(".py"))).toBe(true);
      expect(result.data.groups![0]?.lines[0]).toEqual({ line: 1, text: "before", context: true });
      expect(result.data.groups![0]?.lines.at(-1)).toEqual({ line: 22, text: "target", context: true });
    }
  });

  it.skipIf(!hasRg)("does not let a user glob reinclude protected files", async () => {
    await writeFile(path.join(root, ".npmrc"), "target\n");
    await writeFile(path.join(root, "src", "safe.py"), "target\n");
    const result = await searchCode(root, { query: "target", glob: "*" }, true);
    expect(result).toMatchObject({
      ok: true,
      data: { matches: [{ path: "src/safe.py", line: 1, column: 1, text: "target" }] }
    });
  });

  it("keeps the fallback grouped search working while excluding gitignored files", async () => {
    expect(spawnSync("git", ["init", "-q"], { cwd: root }).status).toBe(0);
    await writeFile(path.join(root, ".gitignore"), "ignored/\n");
    await mkdir(path.join(root, "ignored"), { recursive: true });
    await writeFile(path.join(root, "ignored", "secret.py"), "target\n");
    await writeFile(path.join(root, "src", "visible.py"), "before\ntarget\nafter\n");
    await writeFile(path.join(root, "src", "tracked_ignored.py"), "target\n");
    expect(spawnSync("git", ["add", "src/tracked_ignored.py"], { cwd: root }).status).toBe(0);
    await writeFile(path.join(root, ".gitignore"), "ignored/\nsrc/tracked_ignored.py\n");
    await writeFile(path.join(root, "src", "excluded.ts"), "target\n");
    const commandDir = await makeTempDir();
    await symlink(spawnSync("which", ["git"], { encoding: "utf8" }).stdout.trim(), path.join(commandDir, "git"));
    const originalPath = process.env.PATH;
    process.env.PATH = commandDir;
    try {
      const result = await searchCode(root, { query: "target", glob: "*.py", contextLines: 1 }, true);
      expect(result).toMatchObject({
        ok: true,
        data: {
          matches: [{ path: "src/visible.py", line: 2, column: 1, text: "target" }],
          groups: [{
            path: "src/visible.py",
            lines: [
              { line: 1, text: "before", context: true },
              { line: 2, column: 1, text: "target" },
              { line: 3, text: "after", context: true }
            ],
            omitted: 0
          }]
        }
      });
    } finally {
      process.env.PATH = originalPath;
      await cleanupTempDir(commandDir);
    }
  });

  it("fails closed when fallback search cannot determine ignored files", async () => {
    expect(spawnSync("git", ["init", "-q"], { cwd: root }).status).toBe(0);
    await writeFile(path.join(root, "src", "visible.py"), "target\n");
    const commandDir = await makeTempDir();
    await symlink(spawnSync("which", ["git"], { encoding: "utf8" }).stdout.trim(), path.join(commandDir, "git"));
    const originalPath = process.env.PATH;
    const runHostGit = gitTools.runHostGit;
    const spy = vi.spyOn(gitTools, "runHostGit").mockImplementation((repo, args, options) => {
      if (args.includes("--ignored")) return Promise.resolve({ ok: false, error: "Cannot read ignore rules", recoverable: true });
      return runHostGit(repo, args, options);
    });
    process.env.PATH = commandDir;
    try {
      expect(await searchCode(root, { query: "target" }, true)).toEqual({
        ok: false, error: "Cannot read ignore rules", recoverable: true
      });
    } finally {
      spy.mockRestore();
      process.env.PATH = originalPath;
      await cleanupTempDir(commandDir);
    }
  });

  it("lists git-visible files and summarizes directories instead of alphabetically truncating", async () => {
    expect(spawnSync("git", ["init", "-q"], { cwd: root }).status).toBe(0);
    await writeFile(path.join(root, ".gitignore"), "ignored/\n");
    await writeFile(path.join(root, "root.txt"), "root\n");
    await mkdir(path.join(root, "src", "nested"), { recursive: true });
    await mkdir(path.join(root, "tests"), { recursive: true });
    await mkdir(path.join(root, "ignored"), { recursive: true });
    await writeFile(path.join(root, "src", "a.ts"), "a\n");
    await writeFile(path.join(root, "src", "nested", "b.ts"), "b\n");
    await writeFile(path.join(root, "tests", "c.ts"), "c\n");
    await writeFile(path.join(root, "ignored", "secret.ts"), "secret\n");

    const all = await listFiles(root, {}, true);
    expect(all).toMatchObject({ ok: true });
    if (all.ok) {
      expect(all.data.files).toContain("src/a.ts");
      expect(all.data.files).not.toContain("ignored/secret.ts");
    }

    const summary = await listFiles(root, { maxFiles: 2 }, true);
    expect(summary).toEqual({
      ok: true,
      data: {
        files: [".gitignore", "root.txt"],
        directories: [
          { path: "src", count: 2 },
          { path: "tests", count: 1 }
        ],
        note: "5 files under .; showing direct files and recursive counts. Narrow path or pass pattern."
      },
      truncated: true
    });
  });

  it("treats git listing paths literally and excludes tracked symlinks", async () => {
    expect(spawnSync("git", ["init", "-q"], { cwd: root }).status).toBe(0);
    await mkdir(path.join(root, "odd[dir"), { recursive: true });
    await writeFile(path.join(root, "odd[dir", "visible.ts"), "visible\n");
    await symlink("../outside.txt", path.join(root, "odd[dir", "escape.ts"));
    await writeFile(path.join(root, "outside.txt"), "outside\n");
    expect(spawnSync("git", ["add", "odd[dir/visible.ts", "odd[dir/escape.ts"], { cwd: root }).status).toBe(0);

    const result = await listFiles(root, { path: "odd[dir" }, true);
    expect(result).toEqual({ ok: true, data: { files: ["odd[dir/visible.ts"] }, truncated: false });
  });

  it("does not list an explicit ignored file in a git repository", async () => {
    expect(spawnSync("git", ["init", "-q"], { cwd: root }).status).toBe(0);
    await writeFile(path.join(root, ".gitignore"), "ignored.txt\n");
    await writeFile(path.join(root, "ignored.txt"), "ignored\n");
    expect(await listFiles(root, { path: "ignored.txt", pattern: "ignored" }, true)).toEqual({
      ok: true,
      data: { files: [] },
      truncated: false
    });
  });

  it("rejects indexed paths whose parent was replaced by an escaping symlink", async () => {
    expect(spawnSync("git", ["init", "-q"], { cwd: root }).status).toBe(0);
    await mkdir(path.join(root, "linked"), { recursive: true });
    await writeFile(path.join(root, "linked", "file.ts"), "inside\n");
    expect(spawnSync("git", ["add", "linked/file.ts"], { cwd: root }).status).toBe(0);
    const outside = await makeTempDir();
    await writeFile(path.join(outside, "file.ts"), "outside\n");
    await rm(path.join(root, "linked"), { recursive: true });
    await symlink(outside, path.join(root, "linked"));
    try {
      expect(await listFiles(root, {}, true)).toMatchObject({ ok: true, data: { files: expect.not.arrayContaining(["linked/file.ts"]) } });
    } finally {
      await cleanupTempDir(outside);
    }
  });

  it("matches root and nested files for a double-star fallback glob", async () => {
    await writeFile(path.join(root, "root.py"), "target\n");
    await writeFile(path.join(root, "src", "nested.py"), "target\n");
    const commandDir = await makeTempDir();
    const originalPath = process.env.PATH;
    process.env.PATH = commandDir;
    try {
      const result = await searchCode(root, { query: "target", glob: "**/*.py" }, true);
      expect(result).toMatchObject({
        ok: true,
        data: { matches: [
          { path: "root.py", line: 1, column: 1, text: "target" },
          { path: "src/nested.py", line: 1, column: 1, text: "target" }
        ] }
      });
    } finally {
      process.env.PATH = originalPath;
      await cleanupTempDir(commandDir);
    }
  });

  it("enforces per-file and global fallback caps and supports a negative glob", async () => {
    await writeFile(path.join(root, "src", "a.py"), Array.from({ length: 25 }, () => "target").join("\n"));
    await writeFile(path.join(root, "src", "b.py"), Array.from({ length: 90 }, () => "target").join("\n"));
    await writeFile(path.join(root, "src", "excluded.ts"), "target\n");
    const commandDir = await makeTempDir();
    const originalPath = process.env.PATH;
    process.env.PATH = commandDir;
    try {
      const capped = await searchCode(root, { query: "target", maxResults: 25 }, true);
      expect(capped).toMatchObject({
        ok: true,
        truncated: true,
        data: {
          matches: expect.any(Array),
          groups: [
            { path: "src/a.py", omitted: 5 },
            { path: "src/b.py", omitted: 85 }
          ]
        }
      });
      if (capped.ok) expect(capped.data.matches).toHaveLength(25);

      const negative = await searchCode(root, { query: "target", glob: "!*.ts", maxResults: 100 }, true);
      expect(negative).toMatchObject({ ok: true });
      if (negative.ok) {
        expect(negative.data.matches.map((match) => match.path)).toContain("src/a.py");
        expect(negative.data.matches.every((match) => !match.path.endsWith(".ts"))).toBe(true);
      }
    } finally {
      process.env.PATH = originalPath;
      await cleanupTempDir(commandDir);
    }
  });
});
