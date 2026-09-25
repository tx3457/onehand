import type { Readable, Writable } from "node:stream";
import { homedir } from "node:os";
import { loadProjectInstructions } from "../agent/projectMemory.js";
import { runAgent, type RunAgentOptions } from "../agent/runner.js";
import { runSubagent } from "../agent/subagents.js";
import { summarizeEventArguments, type AgentEvent } from "../agent/events.js";
import type { ModelProvider } from "../providers/index.js";
import { loadMcpConfig, McpManager } from "../mcp/index.js";
import { CheckpointStore } from "../runtime/checkpoints.js";
import {
  loadPermissionConfig,
  PermissionEngine,
  type AuthorizationRequest,
  type PermissionMode,
  type PermissionRules
} from "../policy/permissions.js";
import { gitDiff } from "../tools/git.js";
import { normalizeRepoRoot } from "../tools/pathGuard.js";
import type { PlanSnapshot, RunReport, RunUsage } from "../types.js";
import { ReplInput } from "./input.js";
import { ReplRenderer, systemClock, type Clock } from "./renderer.js";

export type ReplProviderOptions = {
  provider: "openai" | "deepseek";
  model?: string;
  baseURL?: string;
  apiKey?: string;
};

export type RunReplOptions = ReplProviderOptions & {
  repoPath: string;
  mode?: PermissionMode;
  thinking?: "enabled" | "disabled";
  reasoningEffort?: "high" | "max";
  temperature?: number;
  cliRules?: PermissionRules;
  input?: Readable;
  output?: Writable;
  providerFactory(options: ReplProviderOptions): ModelProvider | Promise<ModelProvider>;
  clock?: Clock;
  userHome?: string;
  runAgentFn?: (options: RunAgentOptions) => Promise<RunReport>;
};

type MemoryEntry = { input: string; finalMessage: string };

const HELP = [
  "/help", "/mode <ask|edit|auto>", "/diff", "/undo", "/rewind <n>",
  "/checkpoints", "/cost", "/model <id>", "/memory", "/mcp", "/review", "/exit"
].join(" · ");

export async function runRepl(options: RunReplOptions): Promise<void> {
  const inputStream = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const interactive = Boolean((output as Writable & { isTTY?: boolean }).isTTY);
  const repoRoot = await normalizeRepoRoot(options.repoPath);
  const projectInstructions = await loadProjectInstructions(repoRoot);
  const config = await loadPermissionConfig(repoRoot, options.userHome ?? homedir());
  const mcpConfig = await loadMcpConfig(repoRoot, options.userHome ?? homedir());
  const permissions = new PermissionEngine({
    mode: options.mode ?? "edit",
    cliRules: options.cliRules,
    projectRules: config.project,
    userRules: config.user
  });
  const checkpoints = new CheckpointStore(repoRoot);
  const reader = new ReplInput(inputStream, output, interactive && process.env.NO_COLOR === undefined);
  const renderer = new ReplRenderer(output, options.clock ?? systemClock, { interactive });
  const mcp = new McpManager({ warn: (message) => renderer.message(message) });
  const run = options.runAgentFn ?? runAgent;
  const memory: MemoryEntry[] = [];
  const totals = emptyUsage();
  let model = options.model;
  let lastRunCheckpoint: string | undefined;
  let firstEmptyInterrupt = false;
  let activeAbort: (() => void) | undefined;
  let lastTask = "Review the current repository changes for correctness.";
  let lastPlan: PlanSnapshot | undefined;

  renderer.message(`OneHand chat · ${permissions.mode} mode · ${repoRoot}`);
  try {
    await mcp.connect(mcpConfig);
    while (true) {
      const event = await reader.read("onehand> ", output);
      if (event.type === "eof") break;
      if (event.type === "interrupt") {
        if (event.empty && firstEmptyInterrupt) break;
        firstEmptyInterrupt = event.empty;
        renderer.message(event.empty ? "Press Ctrl+C again to exit." : "^C");
        continue;
      }
      firstEmptyInterrupt = false;
      const value = event.value.trim();
      if (!value) continue;
      if (value.startsWith("/")) {
        try {
          if (await handleCommand(value)) break;
        } catch (error) {
          renderer.message(`Command failed: ${error instanceof Error ? error.message : String(error)}`);
        }
        continue;
      }

      const controller = new AbortController();
      activeAbort = () => controller.abort();
      reader.onInterrupt(activeAbort);
      let checkpointForRun: string | undefined;
      renderer.startRun();
      try {
        const provider = await options.providerFactory({
          provider: options.provider,
          model,
          baseURL: options.baseURL,
          apiKey: options.apiKey
        });
        const report = await run({
          task: taskWithMemory(value, memory),
          repoPath: repoRoot,
          provider,
          model,
          thinking: options.thinking,
          reasoningEffort: options.reasoningEffort,
          temperature: options.temperature,
          enforcePlanning: permissions.mode !== "ask",
          persistence: false,
          mode: permissions.mode,
          authorize,
          extraTools: mcp,
          interactiveTools: ["review_changes"],
          completion: permissions.mode === "ask" ? "answer" : "finish_task",
          checkpoints: permissions.mode === "ask" ? false : checkpoints,
          projectInstructions,
          signal: controller.signal,
          onEvent: (agentEvent: AgentEvent) => {
            if (agentEvent.type === "checkpoint_created") checkpointForRun ??= agentEvent.id;
            renderer.handle(agentEvent);
          }
        });
        lastRunCheckpoint = checkpointForRun;
        lastTask = value;
        lastPlan = report.plan;
        addUsage(totals, report.usage);
        renderer.finish(report);
        memory.push({ input: value, finalMessage: report.finalMessage });
        if (memory.length > 5) memory.splice(0, memory.length - 5);
      } catch (error) {
        lastRunCheckpoint = checkpointForRun;
        renderer.stop();
        renderer.message(`Run failed: ${error instanceof Error ? error.message : String(error)}`);
        renderer.message("failed · usage unavailable");
      } finally {
        activeAbort = undefined;
        reader.onInterrupt(undefined);
      }
    }
  } finally {
    renderer.stop();
    reader.close();
    await mcp.close();
  }

  async function authorize(request: AuthorizationRequest): Promise<"allow" | "deny"> {
    const resolved = permissions.resolve(request);
    if (resolved.decision !== "ask") return resolved.decision;

    reader.onInterrupt(undefined);
    const summary = summarizeEventArguments(request.args);
    try {
      const answer = await reader.read(`Allow ${request.name}${summary ? ` ${summary}` : ""}? [y]es / [n]o / [a]lways `, output);
      if (answer.type !== "line") return "deny";
      const normalized = answer.value.trim().toLowerCase();
      if (normalized === "a" || normalized === "always") {
        permissions.allowForSession(request);
        return "allow";
      }
      return normalized === "y" || normalized === "yes" ? "allow" : "deny";
    } finally {
      reader.onInterrupt(activeAbort);
    }
  }

  async function handleCommand(line: string): Promise<boolean> {
    const [command, ...args] = line.split(/\s+/);
    switch (command) {
      case "/exit":
        return true;
      case "/help":
        renderer.message(HELP);
        return false;
      case "/mode": {
        const next = args[0];
        if (next !== "ask" && next !== "edit" && next !== "auto") {
          renderer.message("Usage: /mode <ask|edit|auto>");
        } else {
          permissions.setMode(next);
          renderer.message(`Mode: ${next}`);
        }
        return false;
      }
      case "/diff": {
        const result = await gitDiff(repoRoot, 120);
        if (result.ok) renderer.diff(result.data.diff);
        else renderer.message(`Diff failed: ${result.error}`);
        return false;
      }
      case "/undo":
        if (!lastRunCheckpoint) renderer.message("No checkpoint is available for the last run.");
        else {
          await checkpoints.restore(lastRunCheckpoint);
          renderer.message(`Restored checkpoint ${shortId(lastRunCheckpoint)}.`);
          lastRunCheckpoint = undefined;
        }
        return false;
      case "/rewind": {
        const index = Number(args[0]);
        const available = await checkpoints.list();
        if (available.length > 0) renderer.message(formatCheckpoints(available));
        if (!Number.isInteger(index) || index < 1 || index > available.length) {
          renderer.message("Usage: /rewind <n> (use /checkpoints to list numbers)");
        } else {
          const selected = available[index - 1]!;
          await checkpoints.restore(selected.id);
          renderer.message(`Restored checkpoint ${index}: ${selected.label}.`);
        }
        return false;
      }
      case "/checkpoints": {
        const available = await checkpoints.list();
        renderer.message(available.length
          ? formatCheckpoints(available)
          : "No checkpoints.");
        return false;
      }
      case "/cost":
        renderer.message(`${totals.modelRounds} rounds${totals.subagentRounds ? ` + ${totals.subagentRounds} subagent rounds` : ""} · ${totals.toolCalls} tool calls · ${totals.totalTokens} tokens`);
        return false;
      case "/mcp":
        renderer.message(mcp.servers.length
          ? mcp.servers.map((server) => `${server.name}: ${server.tools.length ? server.tools.join(", ") : "(no tools)"}`).join("\n")
          : "No MCP servers connected.");
        return false;
      case "/review": {
        const controller = new AbortController();
        activeAbort = () => controller.abort();
        reader.onInterrupt(activeAbort);
        renderer.startRun();
        try {
          const provider = await options.providerFactory({ provider: options.provider, model, baseURL: options.baseURL, apiKey: options.apiKey });
          const report = await runSubagent({
            preset: "review", task: lastTask, plan: lastPlan,
            parent: {
              repoPath: repoRoot, provider, model,
              thinking: options.thinking, reasoningEffort: options.reasoningEffort, temperature: options.temperature,
              mode: permissions.mode, authorize, projectInstructions,
              persistence: false, signal: controller.signal, onEvent: renderer.handle
            }
          });
          addUsage(totals, report.usage);
          renderer.finish(report);
        } finally {
          renderer.stop();
          activeAbort = undefined;
          reader.onInterrupt(undefined);
        }
        return false;
      }
      case "/model":
        if (!args.length) renderer.message(`Model: ${model ?? "provider default"}`);
        else {
          model = args.join(" ");
          renderer.message(`Model: ${model}`);
        }
        return false;
      case "/memory":
        renderer.message(projectInstructions || "No AGENTS.md or ONEHAND.md instructions loaded.");
        return false;
      default:
        renderer.message(`Unknown command: ${command}. Use /help.`);
        return false;
    }
  }
}

function taskWithMemory(input: string, memory: MemoryEntry[]): string {
  if (memory.length === 0) return input;
  const earlier = memory.slice(-5).map((entry) =>
    `Input: ${cap(entry.input, 500)}\nOneHand: ${cap(entry.finalMessage, 500)}`
  ).join("\n\n");
  return `${input}\n\nEarlier in this session:\n${earlier}`;
}

function cap(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
}

function shortId(id: string): string {
  return id.slice(0, 12);
}

function formatCheckpoints(checkpoints: Awaited<ReturnType<CheckpointStore["list"]>>): string {
  return checkpoints.map((item, index) => {
    const notes = item.notes?.length ? ` · ${item.notes.join("; ")}` : "";
    return `${index + 1}. ${shortId(item.id)} ${item.label} · ${item.createdAt}${notes}`;
  }).join("\n");
}

function emptyUsage(): RunUsage {
  return {
    modelRounds: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0,
    cacheHitInputTokens: 0, cacheMissInputTokens: 0, totalTokens: 0,
    reasoningTokens: 0, wallTimeMs: 0
  };
}

function addUsage(total: RunUsage, usage?: RunUsage): void {
  if (!usage) return;
  total.modelRounds += usage.modelRounds;
  if (usage.subagentRounds) total.subagentRounds = (total.subagentRounds ?? 0) + usage.subagentRounds;
  total.toolCalls += usage.toolCalls;
  total.inputTokens += usage.inputTokens;
  total.outputTokens += usage.outputTokens;
  total.cacheHitInputTokens += usage.cacheHitInputTokens;
  total.cacheMissInputTokens += usage.cacheMissInputTokens;
  total.totalTokens += usage.totalTokens;
  total.reasoningTokens = (total.reasoningTokens ?? 0) + (usage.reasoningTokens ?? 0);
  total.wallTimeMs += usage.wallTimeMs;
}
