import { PlanController } from "../agent/planning.js";
import { ToolExecutionContext, ToolResult } from "../types.js";
import { safeJsonStringify } from "../utils/truncate.js";
import path from "node:path";
import { parseCommand, runProgramCommand, runShellCommand } from "./command.js";
import { listFiles, readRepoFile, replaceText, searchCode, writeRepoFile } from "./fileTools.js";
import { gitDiff, gitStatus } from "./git.js";
import { isProtectedRepoPath, resolveSafeRepoPath } from "./pathGuard.js";
import { JsonSchema, parseAndValidateArgs } from "./schema.js";
import { detectTestCommand } from "./testCommand.js";

export type ToolExecutionRecord =
  | { type: "command"; command: string; exitCode: number | null }
  | { type: "test"; command: string; passed: boolean; exitCode: number | null };

export type ToolDefinition = {
  type: "function";
  name: string;
  description: string;
  parameters: JsonSchema;
};

export type ToolRegistry = {
  definitions: ToolDefinition[];
  execute(name: string, rawArgs: string | Record<string, unknown>): Promise<ToolResult<unknown>>;
  records: ToolExecutionRecord[];
  plan: PlanController;
  finishAccepted: boolean;
};

export function createToolRegistry(
  context: ToolExecutionContext & { plan?: PlanController }
): ToolRegistry {
  const records: ToolExecutionRecord[] = [];
  const plan = context.plan ?? new PlanController();
  const registry: ToolRegistry = {
    definitions: TOOL_DEFINITIONS,
    records,
    plan,
    finishAccepted: false,
    async execute(name, rawArgs) {
      const definition = TOOL_DEFINITIONS.find((candidate) => candidate.name === name);
      if (!definition) return failure(`Unknown tool: ${name}`);
      let args: Record<string, unknown>;
      try {
        args = parseAndValidateArgs(rawArgs, definition.parameters);
      } catch (error) {
        return failure(error instanceof Error ? error.message : String(error));
      }

      if (name === "set_plan") return plan.setPlan(args.steps as string[]);
      if (name === "update_plan") {
        return plan.updatePlan({
          stepId: args.stepId as number,
          status: args.status as any,
          evidence: args.evidence as string | undefined
        });
      }
      if (name === "finish_task") {
        const result = plan.finish(args.summary as string);
        if (result.ok) registry.finishAccepted = true;
        return result;
      }

      if (context.enforcePlanning && MUTATING_OR_ACTION_TOOLS.has(name)) {
        const authorization = plan.canMutate();
        if (!authorization.ok) return authorization;
      }

      let result: ToolResult<unknown>;
      switch (name) {
        case "list_files":
          result = await listFiles(context.repoRoot, args as any);
          break;
        case "search_code":
          result = await searchCode(context.repoRoot, args as any);
          break;
        case "read_file":
          result = await readRepoFile(context.repoRoot, args as any);
          break;
        case "write_file":
          result = await writeRepoFile(context.repoRoot, args as any);
          if (result.ok) plan.recordWrite();
          break;
        case "replace_text":
          result = await replaceText(context.repoRoot, args as any);
          if (result.ok) plan.recordWrite();
          break;
        case "run_command": {
          let cwd: string;
          try {
            cwd = await resolveSafeRepoPath(context.repoRoot, (args.cwd as string | undefined) ?? ".");
          await validateCommandPaths(
            context.repoRoot,
            cwd,
            args.program as string,
            (args.args as string[] | undefined) ?? [],
            true
          );
          } catch (error) {
            result = failure(error instanceof Error ? error.message : String(error));
            break;
          }
          const execution = await runProgramCommand({
            program: args.program as string,
            args: (args.args as string[] | undefined) ?? [],
            cwd,
            timeoutSec: (args.timeoutSec as number | undefined) ?? context.timeoutSec,
            allowDestructive: context.allowDestructive
          });
          if (execution.ok) {
            records.push({ type: "command", command: execution.data.command, exitCode: execution.data.exitCode });
            plan.recordWrite();
          }
          result = execution;
          break;
        }
        case "run_tests": {
          const command = context.testCommand ?? (await detectTestCommand(context.repoRoot));
          if (!command) {
            result = failure("No test command found. Pass --test or provide a command.");
            break;
          }
          try {
            const parsed = parseCommand(command);
            await validateCommandPaths(context.repoRoot, context.repoRoot, parsed.program, parsed.args);
          } catch (error) {
            result = failure(error instanceof Error ? error.message : String(error));
            break;
          }
          const execution = await runShellCommand({
            command,
            cwd: context.repoRoot,
            timeoutSec: (args.timeoutSec as number | undefined) ?? context.timeoutSec,
            allowDestructive: context.allowDestructive
          });
          if (execution.ok) {
            const passed = execution.data.exitCode === 0 && !execution.data.timedOut;
            records.push({ type: "test", command, passed, exitCode: execution.data.exitCode });
            plan.recordWrite();
            plan.recordValidation(passed);
            result = { ok: true, data: { ...execution.data, passed }, truncated: execution.truncated };
          } else result = execution;
          break;
        }
        case "git_status":
          result = await gitStatus(context.repoRoot, context.timeoutSec);
          break;
        case "git_diff":
          result = await gitDiff(context.repoRoot, context.timeoutSec);
          break;
        default:
          result = failure(`Unknown tool: ${name}`);
      }
      return result;
    }
  };
  return registry;
}

export function serializeToolResult(result: ToolResult<unknown>): string {
  return safeJsonStringify(result);
}

const MUTATING_OR_ACTION_TOOLS = new Set(["write_file", "replace_text", "run_command", "run_tests"]);
const emptyObject: JsonSchema = { type: "object", properties: {}, additionalProperties: false };

const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    type: "function", name: "set_plan",
    description: "Create or replace the task plan before modifying the repository.",
    parameters: {
      type: "object", properties: { steps: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 8 } },
      required: ["steps"], additionalProperties: false
    }
  },
  {
    type: "function", name: "update_plan",
    description: "Update a plan step after observing repository or tool results.",
    parameters: {
      type: "object",
      properties: {
        stepId: { type: "integer", minimum: 1, maximum: 8 },
        status: { type: "string", enum: ["pending", "in_progress", "completed", "blocked"] },
        evidence: { type: "string" }
      },
      required: ["stepId", "status"], additionalProperties: false
    }
  },
  {
    type: "function", name: "finish_task",
    description: "Finish only after all plan steps are complete and the latest file change is verified.",
    parameters: {
      type: "object", properties: { summary: { type: "string" } }, required: ["summary"], additionalProperties: false
    }
  },
  {
    type: "function", name: "list_files",
    description: "List repository files under an optional path, skipping generated, secret, and dependency paths.",
    parameters: { type: "object", properties: { path: { type: "string" }, pattern: { type: "string" }, maxFiles: { type: "integer", minimum: 1, maximum: 2000 } }, additionalProperties: false }
  },
  {
    type: "function", name: "search_code",
    description: "Search repository text with rg when available, otherwise use Node traversal.",
    parameters: { type: "object", properties: { query: { type: "string" }, path: { type: "string" }, maxResults: { type: "integer", minimum: 1, maximum: 500 } }, required: ["query"], additionalProperties: false }
  },
  {
    type: "function", name: "read_file",
    description: "Read a UTF-8 repository file. Secret and repository-control paths are refused.",
    parameters: { type: "object", properties: { path: { type: "string" }, maxBytes: { type: "integer", minimum: 1, maximum: 1048576 } }, required: ["path"], additionalProperties: false }
  },
  {
    type: "function", name: "write_file",
    description: "Atomically create or replace a UTF-8 repository file after a plan exists.",
    parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"], additionalProperties: false }
  },
  {
    type: "function", name: "replace_text",
    description: "Atomically replace one exact text occurrence inside a repository file.",
    parameters: {
      type: "object", properties: { path: { type: "string" }, oldText: { type: "string" }, newText: { type: "string" }, occurrence: { type: "integer", minimum: 1 } },
      required: ["path", "oldText", "newText"], additionalProperties: false
    }
  },
  {
    type: "function", name: "run_command",
    description: "Run one structured local diagnostic/build command without a shell. Network, installs, and mutating Git are refused.",
    parameters: {
      type: "object", properties: { program: { type: "string" }, args: { type: "array", items: { type: "string" }, maxItems: 64 }, cwd: { type: "string" }, timeoutSec: { type: "integer", minimum: 1, maximum: 600 } },
      required: ["program", "args"], additionalProperties: false
    }
  },
  {
    type: "function", name: "run_tests",
    description: "Run the configured, explicit, or auto-detected verification command without shell operators.",
    parameters: { type: "object", properties: { timeoutSec: { type: "integer", minimum: 1, maximum: 600 } }, additionalProperties: false }
  },
  { type: "function", name: "git_status", description: "Return git status --short.", parameters: emptyObject },
  { type: "function", name: "git_diff", description: "Return the current working tree diff.", parameters: emptyObject }
];

function failure(error: string): ToolResult<never> {
  return { ok: false, error, recoverable: true };
}

async function validateCommandPaths(
  repoRoot: string,
  cwd: string,
  program: string,
  args: string[],
  modelSelected = false
): Promise<void> {
  const base = path.basename(program).toLowerCase();
  if (modelSelected && new Set(["rg", "grep", "sed", "cat", "head", "tail", "ls", "find", "git"]).has(base)) {
    throw new Error(`Use the dedicated repository tool instead of run_command: ${base}`);
  }
  if (["node", "python", "python3", "ruby", "php"].includes(base) && ["-e", "-p", "-c"].includes(args[0] ?? "")) {
    throw new Error(`Inline code execution is disabled for model tools: ${base} ${args[0]}`);
  }
  const fileConsumers = new Set(["cat", "head", "tail", "node", "python", "python3", "ruby", "php"]);
  for (const [index, arg] of args.entries()) {
    if (arg.includes("\0")) throw new Error("Command arguments must not contain NUL bytes");
    const optionValue = arg.startsWith("-") && arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : arg;
    const protectedCandidate = optionValue.replace(/[:=,]/g, path.sep);
    if (isProtectedRepoPath(protectedCandidate)) {
      throw new Error(`Protected repository path is not accessible from commands: ${optionValue}`);
    }
    if ((base === "find" && ["-delete", "-exec", "-execdir", "-ok", "-okdir"].includes(arg)) ||
        (base === "sed" && (arg === "-i" || arg.startsWith("-i") || arg === "--in-place" || arg.startsWith("--in-place="))) ||
        (base === "rg" && (arg === "--pre" || arg.startsWith("--pre=")))) {
      throw new Error(`Command option is disabled: ${base} ${arg}`);
    }
    if (optionValue.startsWith("-") || optionValue === "") continue;
    const shouldValidate = path.isAbsolute(optionValue) || optionValue === ".." ||
      optionValue.startsWith(`..${path.sep}`) || optionValue.includes(`${path.sep}..${path.sep}`) ||
      fileConsumers.has(base) || !arg.startsWith("-");
    if (!shouldValidate) continue;
    const absolute = path.isAbsolute(optionValue) ? optionValue : path.resolve(cwd, optionValue);
    await resolveSafeRepoPath(repoRoot, absolute);
  }
}
