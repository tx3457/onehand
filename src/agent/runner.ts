import OpenAI from "openai";
import { RunReport } from "../types.js";
import { createToolRegistry, serializeToolResult } from "../tools/registry.js";
import { gitDiff, gitStatus } from "../tools/git.js";
import { normalizeRepoRoot } from "../tools/pathGuard.js";
import { buildUserPrompt, SYSTEM_PROMPT } from "./prompt.js";

export type ResponsesClient = {
  responses: {
    create(input: Record<string, unknown>): Promise<ResponseLike>;
  };
};

type ResponseLike = {
  id?: string;
  output?: ResponseOutputItem[];
  output_text?: string;
  status?: string;
};

type ResponseOutputItem = {
  type?: string;
  name?: string;
  arguments?: string | Record<string, unknown>;
  call_id?: string;
  content?: Array<{ type?: string; text?: string }>;
  [key: string]: unknown;
};

export type RunAgentOptions = {
  task: string;
  repoPath: string;
  testCommand?: string;
  model?: string;
  maxSteps?: number;
  timeoutSec?: number;
  allowDestructive?: boolean;
  client?: ResponsesClient;
};

export async function runAgent(options: RunAgentOptions): Promise<RunReport> {
  const repoRoot = await normalizeRepoRoot(options.repoPath);
  const model = options.model ?? process.env.OPENAI_MODEL ?? "gpt-5.5";
  const maxSteps = options.maxSteps ?? 20;
  const timeoutSec = options.timeoutSec ?? 120;
  const client = options.client ?? (new OpenAI() as ResponsesClient);
  const registry = createToolRegistry({
    repoRoot,
    testCommand: options.testCommand,
    timeoutSec,
    allowDestructive: options.allowDestructive ?? false
  });

  const inputItems: unknown[] = [
    {
      role: "user",
      content: buildUserPrompt({
        task: options.task,
        repo: repoRoot,
        testCommand: options.testCommand
      })
    }
  ];

  let finalMessage = "";
  let stoppedByLimit = true;

  for (let step = 0; step < maxSteps; step += 1) {
    const response = await client.responses.create({
      model,
      instructions: SYSTEM_PROMPT,
      input: inputItems,
      tools: registry.definitions,
      reasoning: { effort: "medium" },
      text: { verbosity: "low" }
    });

    const output = response.output ?? [];
    inputItems.push(...output);
    finalMessage = extractMessage(response) || finalMessage;

    const calls = output.filter(isFunctionCall);
    if (calls.length === 0) {
      stoppedByLimit = false;
      break;
    }

    for (const call of calls) {
      const result = await executeToolCall(registry, call);
      inputItems.push({
        type: "function_call_output",
        call_id: call.call_id,
        output: serializeToolResult(result)
      });
    }
  }

  const statusResult = await gitStatus(repoRoot, timeoutSec);
  const diffResult = await gitDiff(repoRoot, timeoutSec);
  const tests = registry.records
    .filter((record) => record.type === "test")
    .map((record) => ({
      command: record.command,
      passed: record.passed,
      exitCode: record.exitCode
    }));
  const commands = registry.records
    .filter((record) => record.type === "command")
    .map((record) => ({
      command: record.command,
      exitCode: record.exitCode
    }));

  const lastTest = tests.at(-1);
  const status: RunReport["status"] = stoppedByLimit
    ? "stopped"
    : lastTest
      ? lastTest.passed
        ? "success"
        : "failed"
      : "success";

  return {
    status,
    task: options.task,
    repo: repoRoot,
    changedFiles: statusResult.ok ? statusResult.data.changedFiles : [],
    commands,
    tests,
    diff: diffResult.ok ? diffResult.data.diff : null,
    finalMessage
  };
}

async function executeToolCall(
  registry: ReturnType<typeof createToolRegistry>,
  call: ResponseOutputItem
) {
  try {
    return await registry.execute(call.name!, call.arguments ?? {});
  } catch (error) {
    return {
      ok: false as const,
      error: error instanceof Error ? error.message : String(error),
      recoverable: true
    };
  }
}

function isFunctionCall(item: ResponseOutputItem): item is ResponseOutputItem & {
  name: string;
  call_id: string;
} {
  return item.type === "function_call" && typeof item.name === "string" && typeof item.call_id === "string";
}

function extractMessage(response: ResponseLike): string {
  if (typeof response.output_text === "string" && response.output_text.length > 0) {
    return response.output_text;
  }

  const chunks: string[] = [];
  for (const item of response.output ?? []) {
    if (item.type !== "message") continue;
    for (const content of item.content ?? []) {
      if (typeof content.text === "string") chunks.push(content.text);
    }
  }
  return chunks.join("\n").trim();
}
