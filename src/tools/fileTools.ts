import {
  chmod,
  mkdir,
  lstat,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { ToolResult } from "../types.js";
import { DEFAULT_TOOL_OUTPUT_LIMIT, truncateText } from "../utils/truncate.js";
import {
  isProtectedRepoPath,
  resolveSafeRepoPath,
  shouldSkipDir,
  toRepoRelative
} from "./pathGuard.js";
import { runProgramCommand } from "./command.js";
import { runHostGit } from "./git.js";

const DEFAULT_READ_LIMIT = 1024 * 1024;
const DEFAULT_WRITE_LIMIT = 2 * 1024 * 1024;

export type ListedFiles = {
  files: string[];
  directories?: Array<{ path: string; count: number }>;
  note?: string;
};
export type SearchMatch = {
  path: string;
  line: number;
  column: number;
  text: string;
};
export type SearchLine = { line: number; column?: number; text: string; context?: true };
export type SearchGroup = { path: string; lines: SearchLine[]; omitted: number };
export type SearchResults = { matches: SearchMatch[]; groups?: SearchGroup[] };
export type ReadFileResult = {
  path: string;
  content: string;
  bytes: number;
  totalLines?: number;
  startLine?: number;
  endLine?: number;
  outline?: string;
  note?: string;
};

export async function listFiles(
  repoRoot: string,
  args: { path?: string; pattern?: string; maxFiles?: number },
  retrieval = false
): Promise<ToolResult<ListedFiles>> {
  if (retrieval) return listFilesForRetrieval(repoRoot, args);
  try {
    const start = await resolveSafeRepoPath(repoRoot, args.path ?? ".");
    const maxFiles = clampPositiveInt(args.maxFiles, 500);
    const needle = args.pattern?.toLowerCase();
    const files: string[] = [];

    async function walk(current: string): Promise<void> {
      if (files.length >= maxFiles) return;
      const entries = await readdir(current, { withFileTypes: true });
      entries.sort((a, b) => a.name.localeCompare(b.name));

      for (const entry of entries) {
        if (files.length >= maxFiles) return;
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory() && shouldSkipDir(entry.name)) continue;

        const absolute = path.join(current, entry.name);
        if (isProtectedRepoPath(toRepoRelative(repoRoot, absolute))) continue;
        if (entry.isDirectory()) {
          await walk(absolute);
        } else if (entry.isFile()) {
          const relative = toRepoRelative(repoRoot, absolute);
          if (!needle || relative.toLowerCase().includes(needle)) {
            files.push(relative);
          }
        }
      }
    }

    const info = await stat(start);
    if (info.isDirectory()) {
      await walk(start);
    } else if (info.isFile()) {
      files.push(toRepoRelative(repoRoot, start));
    }

    return { ok: true, data: { files }, truncated: files.length >= maxFiles };
  } catch (error) {
    return toolError(error);
  }
}

export async function searchCode(
  repoRoot: string,
  args: {
    query: string;
    path?: string;
    maxResults?: number;
    regex?: boolean;
    glob?: string;
    contextLines?: number;
  },
  retrieval = false
): Promise<ToolResult<SearchResults>> {
  if (retrieval) return searchCodeForRetrieval(repoRoot, args);
  try {
    if (!args.query) {
      return { ok: false, error: "query is required", recoverable: true };
    }

    const regex = args.regex ?? false;
    const maxResults = clampPositiveInt(args.maxResults, 100);
    const start = await resolveSafeRepoPath(repoRoot, args.path ?? ".");
    const rgAvailable = await hasExecutable("rg", repoRoot);

    if (rgAvailable) {
      const rgResult = await runProgramCommand({
        program: "rg",
        args: buildRgArgs(args.query, start, maxResults, regex),
        cwd: repoRoot,
        timeoutSec: 30,
        allowDestructive: false,
        outputLimitBytes: 1024 * 1024
      });

      if (rgResult.ok) {
        if (rgResult.data.exitCode === 1) return { ok: true, data: { matches: [] } };
        if (rgResult.data.exitCode !== 0) {
          return {
            ok: false,
            error: rgResult.data.stderr || `rg failed with exit code ${rgResult.data.exitCode}`,
            recoverable: true
          };
        }
        const matches = parseRgOutput(repoRoot, rgResult.data.stdout).slice(0, maxResults);
        return { ok: true, data: { matches }, truncated: matches.length >= maxResults };
      }
    }

    if (regex) {
      return { ok: false, error: "Regex search requires ripgrep (rg); retry with a literal query", recoverable: true };
    }
    const matches = await fallbackSearch(repoRoot, start, args.query, maxResults);
    return { ok: true, data: { matches }, truncated: matches.length >= maxResults };
  } catch (error) {
    return toolError(error);
  }
}

export async function readRepoFile(
  repoRoot: string,
  args: { path: string; maxBytes?: number; startLine?: number; endLine?: number },
  retrieval = false
): Promise<ToolResult<ReadFileResult>> {
  if (retrieval) return readRepoFileForRetrieval(repoRoot, args);
  try {
    const absolute = await resolveSafeRepoPath(repoRoot, args.path);
    const maxBytes = clampPositiveInt(args.maxBytes, DEFAULT_READ_LIMIT);
    const content = await readFile(absolute, "utf8");
    const bytes = Buffer.byteLength(content, "utf8");
    const truncated = truncateText(content, maxBytes);

    return {
      ok: true,
      data: {
        path: toRepoRelative(repoRoot, absolute),
        content: truncated.text,
        bytes
      },
      truncated: truncated.truncated
    };
  } catch (error) {
    return toolError(error);
  }
}

export async function writeRepoFile(
  repoRoot: string,
  args: { path: string; content: string }
): Promise<ToolResult<{ path: string; bytes: number }>> {
  try {
    const absolute = await resolveSafeRepoPath(repoRoot, args.path);
    const bytes = Buffer.byteLength(args.content, "utf8");
    if (bytes > DEFAULT_WRITE_LIMIT) {
      return { ok: false, error: `File content exceeds ${DEFAULT_WRITE_LIMIT} bytes`, recoverable: true };
    }
    await mkdir(path.dirname(absolute), { recursive: true });
    await atomicWrite(absolute, args.content);
    return {
      ok: true,
      data: {
        path: toRepoRelative(repoRoot, absolute),
        bytes
      }
    };
  } catch (error) {
    return toolError(error);
  }
}

export async function replaceText(
  repoRoot: string,
  args: { path: string; oldText: string; newText: string; occurrence?: number },
  retrieval = false
): Promise<ToolResult<{ path: string; replacements: number }>> {
  try {
    if (!args.oldText) {
      return { ok: false, error: "oldText must not be empty", recoverable: true };
    }

    const absolute = await resolveSafeRepoPath(repoRoot, args.path);
    const content = await readFile(absolute, "utf8");
    const indices = allIndices(content, args.oldText);

    if (indices.length === 0) {
      if (retrieval && numberedTextMatches(content, args.oldText)) {
        return {
          ok: false,
          error: "oldText includes read_file line numbers; remove the line-number prefixes and retry",
          recoverable: true
        };
      }
      return { ok: false, error: "oldText was not found", recoverable: true };
    }

    if (args.occurrence === undefined && indices.length !== 1) {
      return {
        ok: false,
        error: `oldText matched ${indices.length} times; provide a 1-based occurrence`,
        recoverable: true
      };
    }

    const occurrence = args.occurrence ?? 1;
    if (!Number.isInteger(occurrence) || occurrence < 1 || occurrence > indices.length) {
      return {
        ok: false,
        error: `occurrence must be between 1 and ${indices.length}`,
        recoverable: true
      };
    }

    const index = indices[occurrence - 1]!;
    const updated =
      content.slice(0, index) +
      args.newText +
      content.slice(index + args.oldText.length);
    if (Buffer.byteLength(updated, "utf8") > DEFAULT_WRITE_LIMIT) {
      return { ok: false, error: `Updated file exceeds ${DEFAULT_WRITE_LIMIT} bytes`, recoverable: true };
    }
    await atomicWrite(absolute, updated);

    return {
      ok: true,
      data: { path: toRepoRelative(repoRoot, absolute), replacements: 1 }
    };
  } catch (error) {
    return toolError(error);
  }
}

async function listFilesForRetrieval(
  repoRoot: string,
  args: { path?: string; pattern?: string; maxFiles?: number }
): Promise<ToolResult<ListedFiles>> {
  try {
    const start = await resolveSafeRepoPath(repoRoot, args.path ?? ".");
    const info = await stat(start);
    const needle = args.pattern?.toLowerCase();
    const gitFiles = await gitVisibleFiles(repoRoot, start);
    if (info.isFile()) {
      const file = toRepoRelative(repoRoot, start);
      const files = (gitFiles ?? [file]).filter((candidate) => !needle || candidate.toLowerCase().includes(needle));
      return { ok: true, data: { files }, truncated: false };
    }

    const maxFiles = clampPositiveInt(args.maxFiles, 200);
    const files = (gitFiles ?? await walkAllFiles(repoRoot, start))
      .filter((file) => !needle || file.toLowerCase().includes(needle))
      .sort((a, b) => a.localeCompare(b));

    if (files.length <= maxFiles) {
      return { ok: true, data: { files }, truncated: false };
    }

    const startRelative = toRepoRelative(repoRoot, start);
    const directFiles: string[] = [];
    const counts = new Map<string, number>();
    for (const file of files) {
      const relativeToStart = startRelative === "." ? file : path.posix.relative(startRelative, file);
      const parts = relativeToStart.split("/");
      if (parts.length === 1) {
        directFiles.push(file);
      } else {
        const directory = startRelative === "." ? parts[0]! : `${startRelative}/${parts[0]!}`;
        counts.set(directory, (counts.get(directory) ?? 0) + 1);
      }
    }

    return {
      ok: true,
      data: {
        files: directFiles,
        directories: [...counts].map(([directoryPath, count]) => ({ path: directoryPath, count })),
        note: `${files.length} files under ${startRelative}; showing direct files and recursive counts. Narrow path or pass pattern.`
      },
      truncated: true
    };
  } catch (error) {
    return toolError(error);
  }
}

async function searchCodeForRetrieval(
  repoRoot: string,
  args: {
    query: string;
    path?: string;
    maxResults?: number;
    regex?: boolean;
    glob?: string;
    contextLines?: number;
  }
): Promise<ToolResult<SearchResults>> {
  try {
    if (!args.query) return { ok: false, error: "query is required", recoverable: true };
    const contextLines = args.contextLines ?? 0;
    if (!Number.isInteger(contextLines) || contextLines < 0 || contextLines > 5) {
      return { ok: false, error: "contextLines must be an integer between 0 and 5", recoverable: true };
    }

    const regex = args.regex ?? false;
    const maxResults = clampPositiveInt(args.maxResults, 100);
    const start = await resolveSafeRepoPath(repoRoot, args.path ?? ".");
    let allMatches: SearchMatch[];
    if (await hasExecutable("rg", repoRoot)) {
      const result = await runProgramCommand({
        program: "rg",
        args: buildRetrievalRgArgs(args.query, start, regex, args.glob),
        cwd: repoRoot,
        timeoutSec: 30,
        allowDestructive: false,
        outputLimitBytes: 1024 * 1024
      });
      if (result.ok && result.data.exitCode === 1) allMatches = [];
      else if (!result.ok || result.data.exitCode !== 0) {
        return {
          ok: false,
          error: result.ok ? result.data.stderr || `rg failed with exit code ${result.data.exitCode}` : result.error,
          recoverable: true
        };
      } else if (result.truncated) {
        return { ok: false, error: "rg output exceeded the safe search limit; narrow path or pass glob", recoverable: true };
      } else {
        allMatches = parseRgOutput(repoRoot, result.data.stdout);
      }
    } else {
      if (regex) {
        return { ok: false, error: "Regex search requires ripgrep (rg); retry with a literal query", recoverable: true };
      }
      allMatches = await fallbackRetrievalSearch(repoRoot, start, args.query, args.glob);
    }

    const groupedMatches = new Map<string, { kept: SearchMatch[]; omitted: number }>();
    let keptCount = 0;
    for (const match of allMatches) {
      const group = groupedMatches.get(match.path) ?? { kept: [], omitted: 0 };
      if (group.kept.length < 20 && keptCount < maxResults) {
        group.kept.push(match);
        keptCount += 1;
      } else {
        group.omitted += 1;
      }
      groupedMatches.set(match.path, group);
    }

    const groups: SearchGroup[] = [];
    const matches: SearchMatch[] = [];
    for (const [file, group] of groupedMatches) {
      if (group.kept.length === 0) continue;
      matches.push(...group.kept);
      groups.push({
        path: file,
        lines: await searchLinesWithContext(repoRoot, file, group.kept, contextLines),
        omitted: group.omitted
      });
    }
    const truncated = allMatches.length > matches.length;
    return { ok: true, data: { matches, groups }, truncated };
  } catch (error) {
    return toolError(error);
  }
}

async function readRepoFileForRetrieval(
  repoRoot: string,
  args: { path: string; maxBytes?: number; startLine?: number; endLine?: number }
): Promise<ToolResult<ReadFileResult>> {
  try {
    const absolute = await resolveSafeRepoPath(repoRoot, args.path);
    const maxBytes = clampPositiveInt(args.maxBytes, DEFAULT_READ_LIMIT);
    const original = await readFile(absolute, "utf8");
    const bytes = Buffer.byteLength(original, "utf8");
    const lines = splitFileLines(original);
    const totalLines = lines.length;
    const hasRange = args.startLine !== undefined || args.endLine !== undefined;
    if (args.startLine !== undefined && (!Number.isInteger(args.startLine) || args.startLine < 1)) {
      return { ok: false, error: "startLine must be a positive integer", recoverable: true };
    }
    if (args.endLine !== undefined && (!Number.isInteger(args.endLine) || args.endLine < 1)) {
      return { ok: false, error: "endLine must be a positive integer", recoverable: true };
    }

    const requestedStart = args.startLine ?? 1;
    if (hasRange && requestedStart > totalLines) {
      return {
        ok: false,
        error: `startLine ${requestedStart} is beyond end of file (totalLines: ${totalLines})`,
        recoverable: true
      };
    }
    const requestedEnd = args.endLine ?? totalLines;
    if (requestedEnd < requestedStart && (hasRange || totalLines > 0)) {
      return { ok: false, error: "endLine must be greater than or equal to startLine", recoverable: true };
    }

    let startLine = requestedStart;
    let endLine = Math.min(requestedEnd, totalLines);
    let note: string | undefined;
    let outline: string | undefined;
    if (!hasRange && totalLines > 400) {
      startLine = 1;
      endLine = Math.min(200, totalLines);
      note = `File has ${totalLines} lines; showing 1–200. Pass startLine/endLine to read other parts.`;
      if (path.extname(absolute).toLowerCase() === ".py") {
        outline = lines
          .map((line, index) => ({ line, number: index + 1 }))
          .filter(({ line }) => /^\s*(?:async\s+def|def|class)\s+\w+/.test(line))
          .slice(0, 150)
          .map(({ line, number }) => numberLine(number, line))
          .join("\n");
        if (!outline) outline = undefined;
      }
    } else if (hasRange && endLine - requestedStart + 1 > 600) {
      endLine = Math.min(requestedStart + 599, totalLines);
      note = `Requested range has ${requestedEnd - requestedStart + 1} lines; showing ${startLine}–${endLine} (maximum 600 lines).`;
    }

    const relativePath = toRepoRelative(repoRoot, absolute);
    // Leave room for the path, line header, and continuation note in compact observations.
    const windowBudget = Math.min(maxBytes, DEFAULT_TOOL_OUTPUT_LIMIT - 4096,
      Math.max(0, DEFAULT_TOOL_OUTPUT_LIMIT - Buffer.byteLength(relativePath, "utf8") - 2048));
    const numbered = lines.slice(startLine - 1, endLine).map((line, index) => numberLine(startLine + index, line));
    let outlineWasTruncated = false;
    if (outline !== undefined) {
      const entries = outline.split("\n");
      const included = wholeLinesWithinBudget(entries, Math.floor(windowBudget * 0.4));
      outline = included.join("\n") || undefined;
      outlineWasTruncated = included.length < entries.length;
      if (outlineWasTruncated) note = `Outline limited to ${included.length} entries (output size limit). ${note ?? ""}`.trim();
    }
    const contentBudget = windowBudget - Buffer.byteLength(outline ?? "", "utf8") - (outline ? 1 : 0);
    const included = wholeLinesWithinBudget(numbered, contentBudget);
    const contentWasTruncated = included.length < numbered.length;
    let content = included.join("\n");
    if (contentWasTruncated) {
      if (included.length === 0) {
        content = truncateText(numbered[0]!, contentBudget).text;
        if (!content.startsWith(numberLine(startLine, "")) || !content.includes("[onehand: output truncated,")) {
          return { ok: false, error: "maxBytes is too small for a numbered line and truncation marker; increase maxBytes", recoverable: true };
        }
      }
      endLine = startLine + Math.max(1, included.length) - 1;
      note = `Showing ${startLine}–${endLine} of ${totalLines} (output size limit); continue with startLine=${endLine + 1}.`;
    }
    return {
      ok: true,
      data: {
        path: relativePath,
        content,
        bytes,
        totalLines,
        startLine,
        endLine,
        ...(outline === undefined ? {} : { outline }),
        ...(note === undefined ? {} : { note })
      },
      truncated: outlineWasTruncated || contentWasTruncated
    };
  } catch (error) {
    return toolError(error);
  }
}

function wholeLinesWithinBudget(lines: string[], budget: number): string[] {
  let bytes = 0;
  const included: string[] = [];
  for (const line of lines) {
    const size = Buffer.byteLength(line, "utf8") + (included.length ? 1 : 0);
    if (bytes + size > budget) break;
    included.push(line);
    bytes += size;
  }
  return included;
}

function numberedTextMatches(content: string, oldText: string): boolean {
  const lines = oldText.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  if (lines.length === 0 || !lines.every((line) => /^\s*\d+\t/.test(line))) return false;
  const stripped = oldText.replace(/^\s*\d+\t/gm, "");
  return content.replace(/\r\n/g, "\n").includes(stripped.replace(/\r\n/g, "\n"));
}

function splitFileLines(content: string): string[] {
  if (content === "") return [];
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

function numberLine(line: number, text: string): string {
  return `${String(line).padStart(6, " ")}\t${text}`;
}

async function hasExecutable(command: string, cwd: string): Promise<boolean> {
  const result = await runProgramCommand({
    program: command,
    args: ["--version"],
    cwd,
    timeoutSec: 5,
    allowDestructive: false
  });
  return result.ok && result.data.exitCode === 0;
}

function buildRgArgs(query: string, searchPath: string, maxResults: number, regex: boolean): string[] {
  return [
    "--line-number",
    "--column",
    "--color",
    "never",
    "--hidden",
    ...(regex ? [] : ["--fixed-strings"]),
    "-g",
    "!.git",
    "-g",
    "!node_modules",
    "-g",
    "!dist",
    "-g",
    "!build",
    "-g",
    "!.onehand",
    "-g",
    "!**/.env",
    "-g",
    "!**/.env.*",
    "-g",
    "!**/*.pem",
    "-g",
    "!**/*.key",
    "-g",
    "!**/*.p12",
    "-g",
    "!**/.npmrc",
    "-g",
    "!**/.pypirc",
    "-g",
    "!**/id_rsa",
    "-g",
    "!**/id_ed25519",
    "--max-count",
    String(maxResults),
    "--",
    query,
    searchPath
  ];
}

function buildRetrievalRgArgs(query: string, searchPath: string, regex: boolean, glob?: string): string[] {
  const args = buildRgArgs(query, searchPath, Number.MAX_SAFE_INTEGER, regex);
  args.splice(args.length - 5, 2);
  if (glob) args.splice(args.indexOf("--hidden") + 1, 0, "--glob", glob);
  return args;
}

function parseRgOutput(repoRoot: string, output: string): SearchMatch[] {
  return output
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const match = /^(.*?):(\d+):(\d+):(.*)$/.exec(line);
      if (!match) return null;
      return {
        path: toRepoRelative(repoRoot, path.resolve(match[1]!)),
        line: Number(match[2]),
        column: Number(match[3]),
        text: match[4]!
      };
    })
    .filter((match): match is SearchMatch => match !== null);
}

export async function fallbackSearch(
  repoRoot: string,
  start: string,
  query: string,
  maxResults: number
): Promise<SearchMatch[]> {
  const matches: SearchMatch[] = [];

  async function walk(current: string): Promise<void> {
    if (matches.length >= maxResults) return;
    const info = await lstat(current);
    if (info.isSymbolicLink()) return;

    if (info.isDirectory()) {
      const entries = await readdir(current, { withFileTypes: true });
      for (const entry of entries) {
        if (matches.length >= maxResults) return;
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory() && shouldSkipDir(entry.name)) continue;
        const candidate = path.join(current, entry.name);
        if (isProtectedRepoPath(toRepoRelative(repoRoot, candidate))) continue;
        await walk(candidate);
      }
      return;
    }

    if (!info.isFile() || info.size > DEFAULT_READ_LIMIT) return;
    const content = await readFile(current, "utf8").catch(() => null);
    if (content === null || content.includes("\0")) return;

    const lines = content.split("\n");
    lines.forEach((text, index) => {
      if (matches.length >= maxResults) return;
      const column = text.indexOf(query);
      if (column >= 0) {
        matches.push({
          path: toRepoRelative(repoRoot, current),
          line: index + 1,
          // 1-based UTF-8 byte offset, matching rg --column.
          column: Buffer.byteLength(text.slice(0, column), "utf8") + 1,
          text
        });
      }
    });
  }

  await walk(start);
  return matches;
}

async function fallbackRetrievalSearch(
  repoRoot: string,
  start: string,
  query: string,
  glob?: string
): Promise<SearchMatch[]> {
  const gitFiles = await gitVisibleFiles(repoRoot, start);
  const ignored = gitFiles === null ? new Set<string>() : await gitIgnoredFiles(repoRoot, start);
  const candidates = (gitFiles ?? await walkAllFiles(repoRoot, start)).filter((file) => !ignored.has(file));
  const matches: SearchMatch[] = [];
  for (const relative of candidates) {
    if (glob && !matchesGlob(relative, glob)) continue;
    const absolute = await resolveSafeRepoPath(repoRoot, relative).catch(() => null);
    if (absolute === null) continue;
    const info = await lstat(absolute).catch(() => null);
    if (!info?.isFile() || info.size > DEFAULT_READ_LIMIT) continue;
    const content = await readFile(absolute, "utf8").catch(() => null);
    if (content === null || content.includes("\0")) continue;
    splitFileLines(content).forEach((text, index) => {
      const column = text.indexOf(query);
      if (column < 0) return;
      matches.push({
        path: relative,
        line: index + 1,
        column: Buffer.byteLength(text.slice(0, column), "utf8") + 1,
        text
      });
    });
  }
  return matches;
}

async function searchLinesWithContext(
  repoRoot: string,
  file: string,
  matches: SearchMatch[],
  contextLines: number
): Promise<SearchLine[]> {
  if (contextLines === 0) return matches.map(({ line, column, text }) => ({ line, column, text }));
  const absolute = await resolveSafeRepoPath(repoRoot, file);
  const content = await readFile(absolute, "utf8");
  const lines = splitFileLines(content);
  const byLine = new Map(matches.map((match) => [match.line, match]));
  const included = new Set<number>();
  for (const match of matches) {
    const first = Math.max(1, match.line - contextLines);
    const last = Math.min(lines.length, match.line + contextLines);
    for (let line = first; line <= last; line += 1) included.add(line);
  }
  return [...included].sort((a, b) => a - b).map((line) => {
    const match = byLine.get(line);
    if (match) return { line, column: match.column, text: match.text };
    return { line, text: lines[line - 1]!, context: true };
  });
}

async function gitVisibleFiles(repoRoot: string, start: string): Promise<string[] | null> {
  const relative = toRepoRelative(repoRoot, start);
  const repoCheck = await runHostGit(repoRoot, ["rev-parse", "--is-inside-work-tree"], {
    timeoutSec: 10,
    isolatedConfig: true
  });
  if (!repoCheck.ok || repoCheck.data.exitCode !== 0 || repoCheck.data.stdout.trim() !== "true") return null;
  const result = await runHostGit(
    repoRoot,
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", `:(literal)${relative}`],
    { timeoutSec: 30, isolatedConfig: true, outputLimitBytes: 8 * 1024 * 1024 }
  );
  if (!result.ok) throw new Error(result.error);
  if (result.data.exitCode !== 0) {
    throw new Error(result.data.stderr || result.data.stdout || "git ls-files failed");
  }
  if (result.truncated) throw new Error("git ls-files output exceeded the safe listing limit");
  const candidates = result.data.stdout
    .split("\0")
    .filter(Boolean)
    .filter((file) => !isProtectedRepoPath(file))
    .sort((a, b) => a.localeCompare(b));
  const files: string[] = [];
  for (const file of candidates) {
    const lexicalInfo = await lstat(path.join(repoRoot, file)).catch(() => null);
    if (!lexicalInfo || lexicalInfo.isSymbolicLink()) continue;
    const absolute = await resolveSafeRepoPath(repoRoot, file).catch(() => null);
    if (absolute === null) continue;
    const info = await lstat(absolute).catch(() => null);
    if (info?.isFile()) files.push(file);
  }
  return files;
}

async function gitIgnoredFiles(repoRoot: string, start: string): Promise<Set<string>> {
  const relative = toRepoRelative(repoRoot, start);
  const result = await runHostGit(
    repoRoot,
    ["ls-files", "--cached", "--ignored", "--exclude-standard", "-z", "--", `:(literal)${relative}`],
    { timeoutSec: 30, isolatedConfig: true, outputLimitBytes: 8 * 1024 * 1024 }
  );
  if (!result.ok) throw new Error(result.error);
  if (result.data.exitCode !== 0) {
    throw new Error(result.data.stderr || result.data.stdout || "git ignored-file listing failed");
  }
  if (result.truncated) throw new Error("git ignored-file output exceeded the safe listing limit");
  return new Set(result.data.stdout.split("\0").filter(Boolean));
}

async function walkAllFiles(repoRoot: string, start: string): Promise<string[]> {
  const files: string[] = [];
  async function walk(current: string): Promise<void> {
    const info = await lstat(current);
    if (info.isSymbolicLink()) return;
    if (info.isFile()) {
      const relative = toRepoRelative(repoRoot, current);
      if (!isProtectedRepoPath(relative)) files.push(relative);
      return;
    }
    if (!info.isDirectory()) return;
    const entries = await readdir(current, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.isSymbolicLink() || (entry.isDirectory() && shouldSkipDir(entry.name))) continue;
      const candidate = path.join(current, entry.name);
      if (isProtectedRepoPath(toRepoRelative(repoRoot, candidate))) continue;
      await walk(candidate);
    }
  }
  await walk(start);
  return files;
}

function matchesGlob(file: string, glob: string): boolean {
  if (glob.startsWith("!")) return !matchesGlob(file, glob.slice(1));
  const target = glob.includes("/") ? file : path.posix.basename(file);
  let pattern = "";
  for (let index = 0; index < glob.length; index += 1) {
    const character = glob[index]!;
    if (character === "*") {
      if (glob[index + 1] === "*") {
        if (glob[index + 2] === "/") {
          pattern += "(?:.*/)?";
          index += 2;
          continue;
        }
        pattern += ".*";
        index += 1;
      } else {
        pattern += "[^/]*";
      }
    } else if (character === "?") {
      pattern += "[^/]";
    } else if (character === "[") {
      const end = glob.indexOf("]", index + 1);
      if (end === -1) pattern += "\\[";
      else {
        const value = glob.slice(index + 1, end);
        pattern += `[${value.startsWith("!") ? `^${value.slice(1)}` : value}]`;
        index = end;
      }
    } else if (character === "{") {
      const end = glob.indexOf("}", index + 1);
      if (end === -1) pattern += "\\{";
      else {
        const alternatives = glob.slice(index + 1, end).split(",").map(escapeRegex);
        pattern += `(?:${alternatives.join("|")})`;
        index = end;
      }
    } else {
      pattern += escapeRegex(character);
    }
  }
  return new RegExp(`^${pattern}$`).test(target);
}

function escapeRegex(value: string): string {
  return value.replace(/[|\\{}()[\]^$+*?.-]/g, "\\$&");
}

function allIndices(value: string, needle: string): number[] {
  const indices: number[] = [];
  let cursor = 0;
  while (cursor <= value.length) {
    const index = value.indexOf(needle, cursor);
    if (index === -1) break;
    indices.push(index);
    cursor = index + needle.length;
  }
  return indices;
}

function clampPositiveInt(value: number | undefined, fallback: number): number {
  if (!Number.isInteger(value) || value === undefined || value <= 0) return fallback;
  return value;
}

function toolError(error: unknown): ToolResult<never> {
  return {
    ok: false,
    error: error instanceof Error ? error.message : String(error),
    recoverable: true
  };
}

async function atomicWrite(absolutePath: string, content: string): Promise<void> {
  const temp = path.join(path.dirname(absolutePath), `.${path.basename(absolutePath)}.${randomUUID()}.tmp`);
  const existingMode = await existingFileMode(absolutePath);
  try {
    // A new file gets 0o666 minus the process umask, like any other file the user creates.
    await writeFile(temp, content, { encoding: "utf8", mode: existingMode === undefined ? 0o666 : 0o600 });
    if (existingMode !== undefined) await chmod(temp, existingMode);
    await rename(temp, absolutePath);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}

// Permission bits only: setuid, setgid, and sticky bits are not carried over to the rewritten file.
async function existingFileMode(absolutePath: string): Promise<number | undefined> {
  try {
    const info = await stat(absolutePath);
    return info.isFile() ? info.mode & 0o777 : undefined;
  } catch {
    return undefined;
  }
}
