import {
  mkdir,
  readFile,
  readdir,
  stat,
  writeFile
} from "node:fs/promises";
import path from "node:path";
import { ToolResult } from "../types.js";
import { truncateText } from "../utils/truncate.js";
import {
  resolveInsideRepo,
  shouldSkipDir,
  toRepoRelative
} from "./pathGuard.js";
import { runShellCommand } from "./command.js";

const DEFAULT_READ_LIMIT = 1024 * 1024;

export type ListedFiles = { files: string[] };
export type SearchMatch = {
  path: string;
  line: number;
  column: number;
  text: string;
};

export async function listFiles(
  repoRoot: string,
  args: { path?: string; pattern?: string; maxFiles?: number }
): Promise<ToolResult<ListedFiles>> {
  try {
    const start = resolveInsideRepo(repoRoot, args.path ?? ".");
    const maxFiles = clampPositiveInt(args.maxFiles, 500);
    const needle = args.pattern?.toLowerCase();
    const files: string[] = [];

    async function walk(current: string): Promise<void> {
      if (files.length >= maxFiles) return;
      const entries = await readdir(current, { withFileTypes: true });
      entries.sort((a, b) => a.name.localeCompare(b.name));

      for (const entry of entries) {
        if (files.length >= maxFiles) return;
        if (entry.isDirectory() && shouldSkipDir(entry.name)) continue;

        const absolute = path.join(current, entry.name);
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
  args: { query: string; path?: string; maxResults?: number }
): Promise<ToolResult<{ matches: SearchMatch[] }>> {
  try {
    if (!args.query) {
      return { ok: false, error: "query is required", recoverable: true };
    }

    const maxResults = clampPositiveInt(args.maxResults, 100);
    const start = resolveInsideRepo(repoRoot, args.path ?? ".");
    const rgAvailable = await hasExecutable("rg", repoRoot);

    if (rgAvailable) {
      const rgResult = await runShellCommand({
        command: buildRgCommand(args.query, start, maxResults),
        cwd: repoRoot,
        timeoutSec: 30,
        allowDestructive: false,
        outputLimitBytes: 1024 * 1024
      });

      if (rgResult.ok) {
        const matches = parseRgOutput(repoRoot, rgResult.data.stdout).slice(0, maxResults);
        return { ok: true, data: { matches }, truncated: matches.length >= maxResults };
      }
    }

    const matches = await fallbackSearch(repoRoot, start, args.query, maxResults);
    return { ok: true, data: { matches }, truncated: matches.length >= maxResults };
  } catch (error) {
    return toolError(error);
  }
}

export async function readRepoFile(
  repoRoot: string,
  args: { path: string; maxBytes?: number }
): Promise<ToolResult<{ path: string; content: string; bytes: number }>> {
  try {
    const absolute = resolveInsideRepo(repoRoot, args.path);
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
    const absolute = resolveInsideRepo(repoRoot, args.path);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, args.content, "utf8");
    return {
      ok: true,
      data: {
        path: toRepoRelative(repoRoot, absolute),
        bytes: Buffer.byteLength(args.content, "utf8")
      }
    };
  } catch (error) {
    return toolError(error);
  }
}

export async function replaceText(
  repoRoot: string,
  args: { path: string; oldText: string; newText: string; occurrence?: number }
): Promise<ToolResult<{ path: string; replacements: number }>> {
  try {
    if (!args.oldText) {
      return { ok: false, error: "oldText must not be empty", recoverable: true };
    }

    const absolute = resolveInsideRepo(repoRoot, args.path);
    const content = await readFile(absolute, "utf8");
    const indices = allIndices(content, args.oldText);

    if (indices.length === 0) {
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
    await writeFile(absolute, updated, "utf8");

    return {
      ok: true,
      data: { path: toRepoRelative(repoRoot, absolute), replacements: 1 }
    };
  } catch (error) {
    return toolError(error);
  }
}

async function hasExecutable(command: string, cwd: string): Promise<boolean> {
  const result = await runShellCommand({
    command: `command -v ${command}`,
    cwd,
    timeoutSec: 5,
    allowDestructive: false
  });
  return result.ok && result.data.exitCode === 0;
}

function buildRgCommand(query: string, searchPath: string, maxResults: number): string {
  const args = [
    "rg",
    "--line-number",
    "--column",
    "--color",
    "never",
    "--hidden",
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
    "--max-count",
    String(maxResults),
    "--",
    query,
    searchPath
  ];

  return args.map(shellQuote).join(" ");
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

async function fallbackSearch(
  repoRoot: string,
  start: string,
  query: string,
  maxResults: number
): Promise<SearchMatch[]> {
  const matches: SearchMatch[] = [];

  async function walk(current: string): Promise<void> {
    if (matches.length >= maxResults) return;
    const info = await stat(current);

    if (info.isDirectory()) {
      const entries = await readdir(current, { withFileTypes: true });
      for (const entry of entries) {
        if (matches.length >= maxResults) return;
        if (entry.isDirectory() && shouldSkipDir(entry.name)) continue;
        await walk(path.join(current, entry.name));
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
          column: column + 1,
          text
        });
      }
    });
  }

  await walk(start);
  return matches;
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

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function toolError(error: unknown): ToolResult<never> {
  return {
    ok: false,
    error: error instanceof Error ? error.message : String(error),
    recoverable: true
  };
}
