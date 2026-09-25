const CONTEXT_NOTE_PREFIX = "Context note: older tool observations were masked to save context.";
const MASKED_RESULT_SUFFIX = "masked to save context; call the tool again if needed";
const LARGE_ARGUMENT_BYTES = 1_024;
const KEPT_HISTORY_BYTES = 48 * 1_024;
const MIN_MASKING_GAIN_BYTES = 32 * 1_024;

type HistoryItem = Record<string, any>;
type ToolRound = { start: number; calls: HistoryItem[] };

export type HistoryMaskingResult = {
  history: unknown[];
  maskedItems: number;
  bytesRemoved: number;
  bytesKept: number;
  keptRounds: number;
};

export function maskProviderHistory(
  provider: "openai" | "deepseek",
  history: unknown[],
  contextNote: string
): HistoryMaskingResult {
  const items = cloneHistory(history.filter((item, index) => index === 0 || !isContextNote(item)));
  const rounds = toolRounds(provider, items);
  let keptRounds = 0;
  let bytesKept = 0;
  for (let index = rounds.length - 1; index >= 0 && keptRounds < 10; index -= 1) {
    const bytes = historyBytes(items.slice(rounds[index]!.start));
    if (keptRounds >= 2 && bytes > KEPT_HISTORY_BYTES) break;
    keptRounds += 1;
    bytesKept = bytes;
  }
  const result = provider === "deepseek"
    ? maskDeepSeekHistory(items, rounds, keptRounds)
    : maskOpenAIHistory(items, rounds, keptRounds);
  const candidate = [...items, { role: "user", content: contextNote }];
  const bytesRemoved = historyBytes(history) - historyBytes(candidate);
  if (result.maskedItems === 0 || bytesRemoved < MIN_MASKING_GAIN_BYTES) {
    return { history, maskedItems: 0, bytesRemoved: 0, bytesKept, keptRounds };
  }
  return {
    history: candidate,
    maskedItems: result.maskedItems,
    bytesRemoved,
    bytesKept,
    keptRounds
  };
}

function toolRounds(provider: "openai" | "deepseek", items: HistoryItem[]): ToolRound[] {
  if (provider === "deepseek") {
    return items.flatMap((item, start) => item.role === "assistant" && Array.isArray(item.tool_calls) && item.tool_calls.length > 0
      ? [{ start, calls: item.tool_calls as HistoryItem[] }]
      : []);
  }
  const rounds: ToolRound[] = [];
  let current: ToolRound | undefined;
  let assistantStart: number | undefined;
  for (const [index, item] of items.entries()) {
    if (item.type === "function_call") {
      if (!current) {
        current = { start: assistantStart ?? index, calls: [] };
        rounds.push(current);
      }
      current.calls.push(item);
    } else if (item.type === "reasoning" || item.role === "assistant" ||
        (item.type === "message" && item.role === undefined)) {
      if (!current) assistantStart ??= index;
    } else {
      current = undefined;
      assistantStart = undefined;
    }
  }
  return rounds;
}

function maskDeepSeekHistory(items: HistoryItem[], rounds: ToolRound[], keepRecentToolRounds: number): { maskedItems: number } {
  const oldRounds = rounds.slice(0, Math.max(0, rounds.length - keepRecentToolRounds));
  const firstKeptRound = rounds[Math.max(0, rounds.length - keepRecentToolRounds)];
  const calls = new Map<string, { name: string; summary: string }>();
  let maskedItems = 0;

  if (oldRounds.length > 0) {
    const boundary = firstKeptRound?.start ?? items.length;
    for (let index = 0; index < boundary; index += 1) {
      const item = items[index]!;
      if (item.role === "assistant" && typeof item.reasoning_content === "string" && item.reasoning_content !== "[elided]") {
        item.reasoning_content = "[elided]";
        maskedItems += 1;
      }
    }
  }
  for (const round of oldRounds) {
    for (const call of round.calls) {
      const id = typeof call.id === "string" ? call.id : "";
      const fn = isRecord(call.function) ? call.function : {};
      const name = typeof fn.name === "string" ? fn.name : "tool";
      const args = fn.arguments;
      const masked = maskLargeArguments(args);
      if (masked.changed) {
        fn.arguments = masked.value;
        maskedItems += 1;
      }
      calls.set(id, { name: compact(name, 80), summary: summarizeArguments(fn.arguments) });
    }
  }
  for (const item of items) {
    if (item.role !== "tool" || typeof item.tool_call_id !== "string") continue;
    const call = calls.get(item.tool_call_id);
    if (!call || typeof item.content !== "string" || isMaskedResult(item.content, call)) continue;
    item.content = maskedResult(call, item.content);
    maskedItems += 1;
  }
  return { maskedItems };
}

function maskOpenAIHistory(items: HistoryItem[], rounds: ToolRound[], keepRecentToolRounds: number): { maskedItems: number } {
  const oldRounds = rounds.slice(0, Math.max(0, rounds.length - keepRecentToolRounds));
  const calls = new Map<string, { name: string; summary: string }>();
  let maskedItems = 0;
  for (const round of oldRounds) {
    for (const item of round.calls) {
      const id = typeof item.call_id === "string" ? item.call_id : "";
      const name = typeof item.name === "string" ? item.name : "tool";
      const masked = maskLargeArguments(item.arguments);
      if (masked.changed) {
        item.arguments = masked.value;
        maskedItems += 1;
      }
      calls.set(id, { name: compact(name, 80), summary: summarizeArguments(item.arguments) });
    }
  }
  for (const item of items) {
    if (item.type !== "function_call_output" || typeof item.call_id !== "string") continue;
    const call = calls.get(item.call_id);
    if (!call || typeof item.output !== "string" || isMaskedResult(item.output, call)) continue;
    item.output = maskedResult(call, item.output);
    maskedItems += 1;
  }
  return { maskedItems };
}

function maskLargeArguments(args: unknown): { value: unknown; changed: boolean } {
  const serialized = typeof args === "string" ? args : JSON.stringify(args);
  if (typeof serialized !== "string" || Buffer.byteLength(serialized) <= LARGE_ARGUMENT_BYTES) {
    return { value: args, changed: false };
  }
  let parsed: unknown;
  try {
    parsed = typeof args === "string" ? JSON.parse(args) : args;
  } catch {
    return { value: args, changed: false };
  }
  const masked = maskLargeStrings(parsed);
  if (!masked.changed) return { value: args, changed: false };
  return { value: typeof args === "string" ? JSON.stringify(masked.value) : masked.value, changed: true };
}

function maskLargeStrings(value: unknown): { value: unknown; changed: boolean } {
  if (typeof value === "string") {
    return Buffer.byteLength(value) > LARGE_ARGUMENT_BYTES
      ? { value: `[masked ${value.length} chars]`, changed: true }
      : { value, changed: false };
  }
  if (Array.isArray(value)) {
    let changed = false;
    const output = value.map((item) => {
      const masked = maskLargeStrings(item);
      changed ||= masked.changed;
      return masked.value;
    });
    return { value: output, changed };
  }
  if (isRecord(value)) {
    let changed = false;
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      const masked = maskLargeStrings(item);
      changed ||= masked.changed;
      output[key] = masked.value;
    }
    return { value: output, changed };
  }
  return { value, changed: false };
}

function summarizeArguments(args: unknown): string {
  let value: HistoryItem;
  try {
    value = (typeof args === "string" ? JSON.parse(args) : args) as HistoryItem;
  } catch {
    return "arguments unavailable";
  }
  if (!isRecord(value)) return "arguments unavailable";
  const fields: string[] = [];
  if (typeof value.path === "string") fields.push(`path=${compact(value.path, 100)}`);
  if (typeof value.startLine === "number" || typeof value.endLine === "number") {
    fields.push(`lines=${value.startLine ?? "?"}-${value.endLine ?? "?"}`);
  }
  if (typeof value.query === "string") fields.push(`query=${compact(value.query, 80)}`);
  if (typeof value.program === "string") fields.push(`program=${compact(value.program, 80)}`);
  if (Array.isArray(value.args) && value.args.length > 0) {
    fields.push(`args=${compact(String(value.args[0]), 60)}${value.args.length > 1 ? ",…" : ""}`);
  }
  return compact(fields.length > 0 ? fields.join(", ") : "arguments omitted", 240);
}

function compact(value: string, maxChars: number): string {
  const oneLine = value.replace(/\s+/g, " ").trim();
  return oneLine.length > maxChars ? `${oneLine.slice(0, maxChars - 1)}…` : oneLine;
}

function maskedResult(call: { name: string; summary: string }, original: string): string {
  return `${call.name} (${call.summary}): ${Buffer.byteLength(original)} bytes; ${MASKED_RESULT_SUFFIX}`;
}

function isMaskedResult(value: string, call: { name: string; summary: string }): boolean {
  if (value.length > 400 || /[\r\n]/.test(value)) return false;
  const prefix = `${call.name} (${call.summary}): `;
  const suffix = ` bytes; ${MASKED_RESULT_SUFFIX}`;
  if (!value.startsWith(prefix) || !value.endsWith(suffix)) return false;
  return /^\d+$/.test(value.slice(prefix.length, -suffix.length));
}

function isContextNote(item: unknown): boolean {
  return isRecord(item) && item.role === "user" && typeof item.content === "string" && item.content.startsWith(CONTEXT_NOTE_PREFIX);
}

function cloneHistory(history: unknown[]): HistoryItem[] {
  return structuredClone(history) as HistoryItem[];
}

function historyBytes(history: unknown[]): number {
  return Buffer.byteLength(JSON.stringify(history));
}

function isRecord(value: unknown): value is HistoryItem {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
