import { PlanController } from "../agent/planning.js";
import { LocalExecutor, PathMapper, resolveDisplayRoot } from "../runtime/executor.js";
import { ToolExecutionContext, ToolResult } from "../types.js";
import { safeJsonStringify } from "../utils/truncate.js";
import { realpathSync } from "node:fs";
import path from "node:path";
import { commandPolicyError, parseCommand, quoteArg, StructuredCommand } from "./command.js";
import { listFiles, readRepoFile, replaceText, searchCode, writeRepoFile } from "./fileTools.js";
import { gitDiff, gitStatus } from "./git.js";
import { isProtectedRepoPath, resolveSafeRepoPath } from "./pathGuard.js";
import { JsonSchema, parseAndValidateArgs } from "./schema.js";
import { detectTestCommand } from "./testCommand.js";

const MAX_TEST_TARGET_LENGTH = 512;
const TARGETED_RUN_NOTE = "A run with targets does not verify the latest change; run run_tests without targets before finish_task.";
// Their output comes from a process, not from a repository file, so host paths in it are rewritten.
const COMMAND_OUTPUT_TOOLS = new Set(["run_command", "run_tests", "git_status", "git_diff"]);

export type ToolExecutionRecord =
  | { type: "command"; command: string; exitCode: number | null }
  // command is argv shell-quoted for display: parseCommand(command) gives argv back.
  | { type: "test"; command: string; argv: string[]; passed: boolean; exitCode: number | null; targets?: string[] };

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
  // A lexical and a symlinked root name the same checkout; every check and mapping uses its realpath.
  const repoRoot = realpathSync(context.repoRoot);
  const executor = context.executor ?? new LocalExecutor();
  resolveDisplayRoot(executor, repoRoot, context.displayRoot);
  const paths = executor.pathMapper;
  const isolatedGit = executor.kind === "docker";
  // Error text (ENOENT, escapes-root) and command output can name host paths; the model only ever sees
  // display paths. Only a whole path matches: neither /host/repo2 nor /x/host/repo is the host root.
  const escapedHostRoot = paths.hostRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const hostRootInText = new RegExp(`(?<![\\w.-])${escapedHostRoot}(?![\\w.-])`, "g");
  const scrub = (value: unknown): unknown => typeof value === "string"
    ? value.replace(hostRootInText, () => paths.displayRoot)
    : Array.isArray(value) ? value.map(scrub)
      : value && typeof value === "object"
        ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, scrub(item)]))
        : value;
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

      // A model-visible path such as /testbed/x.py names the host checkout before any path check.
      const fileArgs = typeof args.path === "string" ? { ...args, path: paths.toHost(args.path) } : args;
      let result: ToolResult<unknown>;
      switch (name) {
        case "list_files":
          result = await listFiles(repoRoot, fileArgs as any);
          break;
        case "search_code":
          result = await searchCode(repoRoot, fileArgs as any);
          break;
        case "read_file":
          result = await readRepoFile(repoRoot, fileArgs as any);
          break;
        case "write_file":
          result = await writeRepoFile(repoRoot, fileArgs as any);
          if (result.ok) plan.recordWrite();
          break;
        case "replace_text":
          result = await replaceText(repoRoot, fileArgs as any);
          if (result.ok) plan.recordWrite();
          break;
        case "run_command": {
          const program = args.program as string;
          const commandArgs = (args.args as string[] | undefined) ?? [];
          let cwd: string;
          try {
            cwd = await resolveSafeRepoPath(repoRoot, paths.toHost((args.cwd as string | undefined) ?? "."));
            await validateCommandPaths(repoRoot, cwd, program, commandArgs, paths, true);
            assertCommandPolicy(program, commandArgs, context.allowDestructive);
          } catch (error) {
            result = failure(error instanceof Error ? error.message : String(error));
            break;
          }
          // The arguments stay exactly as the model wrote them: the executor's own mapper validated them,
          // and display paths are valid where it runs them.
          const execution = await executor.run({
            program,
            args: commandArgs,
            cwd,
            timeoutSec: (args.timeoutSec as number | undefined) ?? context.timeoutSec,
            truncation: "head_tail"
          });
          if (execution.ok) {
            records.push({ type: "command", command: execution.data.command, exitCode: execution.data.exitCode });
            plan.recordWrite();
          }
          result = execution;
          break;
        }
        case "run_tests": {
          const command = context.testCommand ?? (await detectTestCommand(repoRoot));
          if (!command) {
            result = failure("No test command found. Pass --test or provide a command.");
            break;
          }
          const targets = (args.targets as string[] | undefined) ?? [];
          let parsed: StructuredCommand;
          try {
            parsed = parseCommand(command);
            // An operator-trusted base command (tox, ./tests/runtests.py, ...) is outside the model policy.
            if (!context.trustedTestCommand) {
              await validateCommandPaths(repoRoot, repoRoot, parsed.program, parsed.args, paths);
              assertCommandPolicy(parsed.program, parsed.args, context.allowDestructive);
            }
            for (const target of targets) await validateTestTarget(repoRoot, target, paths);
          } catch (error) {
            result = failure(error instanceof Error ? error.message : String(error));
            break;
          }
          const argv = [parsed.program, ...parsed.args, ...targets];
          const displayCommand = [command, ...targets.map(quoteArg)].join(" ");
          const execution = await executor.run({
            program: parsed.program,
            args: argv.slice(1),
            cwd: repoRoot,
            timeoutSec: (args.timeoutSec as number | undefined) ?? context.timeoutSec,
            truncation: "head_tail",
            displayCommand
          });
          if (execution.ok) {
            const passed = execution.data.exitCode === 0 && !execution.data.timedOut;
            // A subset run verifies the latest change only where the operator allows it (SWE-bench).
            const subsetOnly = targets.length > 0 && !context.allowTargetedVerification;
            const targetData = targets.length ? { targets } : {};
            records.push({ type: "test", command: displayCommand, argv, passed, exitCode: execution.data.exitCode, ...targetData });
            plan.recordWrite();
            plan.recordValidation(passed && !subsetOnly);
            const gate = subsetOnly ? { verifiesLatestChange: false, note: TARGETED_RUN_NOTE } : {};
            result = { ok: true, data: { ...execution.data, passed, ...targetData, ...gate }, truncated: execution.truncated };
          } else result = execution;
          break;
        }
        case "git_status":
          result = await gitStatus(repoRoot, context.timeoutSec, isolatedGit);
          break;
        case "git_diff":
          result = await gitDiff(repoRoot, context.timeoutSec, isolatedGit);
          break;
        default:
          result = failure(`Unknown tool: ${name}`);
      }
      if (paths.hostRoot === paths.displayRoot) return result;
      if (!result.ok) return { ...result, error: scrub(result.error) as string };
      return COMMAND_OUTPUT_TOOLS.has(name) ? { ...result, data: scrub(result.data) } : result;
    }
  };
  return registry;
}

export function serializeToolResult(result: ToolResult<unknown>): string {
  return safeJsonStringify(result);
}

const MUTATING_OR_ACTION_TOOLS = new Set(["write_file", "replace_text", "run_command", "run_tests"]);
const emptyObject: JsonSchema = { type: "object", properties: {}, additionalProperties: false };

export const TOOL_DEFINITIONS: ToolDefinition[] = [
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
    description: "Search repository text. The query is literal by default. Set regex=true to use a ripgrep (Rust) regular expression, e.g. (?i) for case-insensitive matching; regex search requires rg.",
    parameters: { type: "object", properties: { query: { type: "string" }, path: { type: "string" }, maxResults: { type: "integer", minimum: 1, maximum: 500 }, regex: { type: "boolean" } }, required: ["query"], additionalProperties: false }
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
    description: "Run the configured verification command. Optionally pass targets (test file paths, pytest node ids, or framework test labels such as Django dotted labels) to run a subset.",
    parameters: {
      type: "object", properties: { targets: { type: "array", items: { type: "string" }, maxItems: 32 }, timeoutSec: { type: "integer", minimum: 1, maximum: 600 } },
      additionalProperties: false
    }
  },
  { type: "function", name: "git_status", description: "Return git status --short.", parameters: emptyObject },
  { type: "function", name: "git_diff", description: "Return the current working tree diff.", parameters: emptyObject }
];

function failure(error: string): ToolResult<never> {
  return { ok: false, error, recoverable: true };
}

function assertCommandPolicy(program: string, args: string[], allowDestructive: boolean): void {
  const policyError = commandPolicyError(program, args, allowDestructive);
  if (policyError) throw new Error(policyError);
}

// Targets are appended to the verification argv, so each must be a test path, node id, or label.
async function validateTestTarget(repoRoot: string, target: string, paths: PathMapper): Promise<void> {
  if (target.trim() === "" || target.length > MAX_TEST_TARGET_LENGTH) {
    throw new Error(`Test targets must be non-empty and at most ${MAX_TEST_TARGET_LENGTH} characters`);
  }
  if (target.includes("\0")) throw new Error("Test targets must not contain NUL bytes");
  // "@file" reads arguments from a file in pytest 8.2+ and argparse-based runners.
  if (target.startsWith("-") || target.startsWith("@")) throw new Error(`Test target options are disabled: ${target}`);
  // Every path-like piece and every bare name, before normalization can drop one (tests/.git/.. is tests).
  if (isProtectedRepoPath(target.replace(/[:=,]/g, "/"))) {
    throw new Error(`Protected repository path is not accessible from test targets: ${target}`);
  }
  const file = target.split("::")[0]!;
  if (target.includes("/") || file.endsWith(".py") || file === "..") {
    await resolveSafeRepoPath(repoRoot, paths.toHost(file));
  }
}

async function validateCommandPaths(
  repoRoot: string,
  cwd: string,
  program: string,
  args: string[],
  paths: PathMapper,
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
    const absolute = path.isAbsolute(optionValue) ? paths.toHost(optionValue) : path.resolve(cwd, optionValue);
    await resolveSafeRepoPath(repoRoot, absolute);
  }
}
