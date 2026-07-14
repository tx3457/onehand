import { ToolExecutionContext, ToolResult } from "../types.js";
import { safeJsonStringify } from "../utils/truncate.js";
import { runShellCommand } from "./command.js";
import {
  listFiles,
  readRepoFile,
  replaceText,
  searchCode,
  writeRepoFile
} from "./fileTools.js";
import { gitDiff, gitStatus } from "./git.js";
import { detectTestCommand } from "./testCommand.js";

export type ToolName =
  | "list_files"
  | "search_code"
  | "read_file"
  | "write_file"
  | "replace_text"
  | "run_command"
  | "run_tests"
  | "git_status"
  | "git_diff";

export type ToolExecutionRecord =
  | { type: "command"; command: string; exitCode: number | null }
  | { type: "test"; command: string; passed: boolean; exitCode: number | null };

export type ToolRegistry = {
  definitions: unknown[];
  execute(name: string, rawArgs: string | Record<string, unknown>): Promise<ToolResult<unknown>>;
  records: ToolExecutionRecord[];
};

export function createToolRegistry(context: ToolExecutionContext): ToolRegistry {
  const records: ToolExecutionRecord[] = [];

  return {
    definitions: TOOL_DEFINITIONS,
    records,
    async execute(name, rawArgs) {
      const args = parseArgs(rawArgs);

      switch (name as ToolName) {
        case "list_files":
          return listFiles(context.repoRoot, args);
        case "search_code":
          return searchCode(context.repoRoot, args as Parameters<typeof searchCode>[1]);
        case "read_file":
          return readRepoFile(context.repoRoot, args as Parameters<typeof readRepoFile>[1]);
        case "write_file":
          return writeRepoFile(context.repoRoot, args as Parameters<typeof writeRepoFile>[1]);
        case "replace_text":
          return replaceText(context.repoRoot, args as Parameters<typeof replaceText>[1]);
        case "run_command": {
          const command = stringArg(args.command, "command");
          const result = await runShellCommand({
            command,
            cwd: context.repoRoot,
            timeoutSec: numberArg(args.timeoutSec) ?? context.timeoutSec,
            allowDestructive: context.allowDestructive
          });
          if (result.ok) {
            records.push({
              type: "command",
              command,
              exitCode: result.data.exitCode
            });
          }
          return result;
        }
        case "run_tests": {
          const command =
            maybeStringArg(args.command) ??
            context.testCommand ??
            (await detectTestCommand(context.repoRoot));
          if (!command) {
            return {
              ok: false,
              error: "No test command found. Pass --test or provide a command.",
              recoverable: true
            };
          }
          const result = await runShellCommand({
            command,
            cwd: context.repoRoot,
            timeoutSec: numberArg(args.timeoutSec) ?? context.timeoutSec,
            allowDestructive: context.allowDestructive
          });
          if (result.ok) {
            records.push({
              type: "test",
              command,
              passed: result.data.exitCode === 0 && !result.data.timedOut,
              exitCode: result.data.exitCode
            });
          }
          return result.ok
            ? {
                ok: true,
                data: {
                  ...result.data,
                  passed: result.data.exitCode === 0 && !result.data.timedOut
                },
                truncated: result.truncated
              }
            : result;
        }
        case "git_status":
          return gitStatus(context.repoRoot, context.timeoutSec);
        case "git_diff":
          return gitDiff(context.repoRoot, context.timeoutSec);
        default:
          return {
            ok: false,
            error: `Unknown tool: ${name}`,
            recoverable: true
          };
      }
    }
  };
}

export function serializeToolResult(result: ToolResult<unknown>): string {
  return safeJsonStringify(result);
}

function parseArgs(rawArgs: string | Record<string, unknown>): Record<string, any> {
  if (typeof rawArgs !== "string") return rawArgs as Record<string, any>;
  if (rawArgs.trim() === "") return {};
  const parsed = JSON.parse(rawArgs) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Tool arguments must be a JSON object");
  }
  return parsed as Record<string, any>;
}

function stringArg(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function maybeStringArg(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberArg(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

const TOOL_DEFINITIONS = [
  {
    type: "function",
    name: "list_files",
    description: "List repository files under an optional path, skipping generated and dependency directories.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        pattern: { type: "string" },
        maxFiles: { type: "number" }
      },
      additionalProperties: false
    }
  },
  {
    type: "function",
    name: "search_code",
    description: "Search repository text with rg when available, falling back to Node traversal.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string" },
        path: { type: "string" },
        maxResults: { type: "number" }
      },
      required: ["query"],
      additionalProperties: false
    }
  },
  {
    type: "function",
    name: "read_file",
    description: "Read a UTF-8 file inside the repository. Output is truncated by default at 1MB.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        maxBytes: { type: "number" }
      },
      required: ["path"],
      additionalProperties: false
    }
  },
  {
    type: "function",
    name: "write_file",
    description: "Write a UTF-8 file inside the repository, creating parent directories as needed.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" }
      },
      required: ["path", "content"],
      additionalProperties: false
    }
  },
  {
    type: "function",
    name: "replace_text",
    description: "Replace text in a file. oldText must match exactly once unless occurrence is provided.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        oldText: { type: "string" },
        newText: { type: "string" },
        occurrence: { type: "number" }
      },
      required: ["path", "oldText", "newText"],
      additionalProperties: false
    }
  },
  {
    type: "function",
    name: "run_command",
    description: "Run a shell command in the target repository. Obvious destructive commands are refused by default.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string" },
        timeoutSec: { type: "number" }
      },
      required: ["command"],
      additionalProperties: false
    }
  },
  {
    type: "function",
    name: "run_tests",
    description: "Run the configured test command, an explicit test command, or an auto-detected test command.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string" },
        timeoutSec: { type: "number" }
      },
      additionalProperties: false
    }
  },
  {
    type: "function",
    name: "git_status",
    description: "Return git status --short for the target repository.",
    parameters: { type: "object", properties: {}, additionalProperties: false }
  },
  {
    type: "function",
    name: "git_diff",
    description: "Return git diff for the target repository.",
    parameters: { type: "object", properties: {}, additionalProperties: false }
  }
];
