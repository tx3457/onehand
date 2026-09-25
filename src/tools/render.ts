import type { ToolResult } from "../types.js";
import { DEFAULT_TOOL_OUTPUT_LIMIT, truncateText } from "../utils/truncate.js";

type Data = Record<string, unknown>;

export function renderToolResult(name: string, result: ToolResult<unknown>): string {
  let rendered: string;
  if (!result.ok) {
    rendered = `error: ${result.error}${result.recoverable ? "" : " (not recoverable)"}`;
    if (result.code) rendered += `\ncode: ${result.code}`;
  } else if (name === "read_file") {
    rendered = renderReadFile(result.data as Data);
  } else if (name === "search_code") {
    rendered = renderSearchCode(result.data as Data, result.truncated ?? false);
  } else if (name === "list_files") {
    rendered = renderListFiles(result.data as Data, result.truncated ?? false);
  } else if (name === "run_command" || name === "run_tests") {
    rendered = renderCommand(name, result.data as Data, result.truncated ?? false);
  } else {
    rendered = JSON.stringify(result);
  }
  return truncateText(rendered).text;
}

function renderReadFile(data: Data): string {
  let content = string(data.content);
  let startLine = finiteNumber(data.startLine);
  let endLine = finiteNumber(data.endLine);
  let totalLines = finiteNumber(data.totalLines);
  if (startLine === undefined || endLine === undefined || totalLines === undefined) {
    const rawLines = splitFileLines(content);
    startLine = rawLines.length > 0 ? 1 : 0;
    endLine = totalLines = rawLines.length;
    content = rawLines.map((line, index) => `${String(index + 1).padStart(6)}\t${line}`).join("\n");
  }
  const lines = [`${string(data.path)} (lines ${startLine}–${endLine} of ${totalLines})`];
  const outline = optionalString(data.outline);
  if (outline) lines.push("outline:", outline);
  if (content) lines.push(content);
  const note = optionalString(data.note);
  if (note) lines.push(note);
  return lines.join("\n");
}

function renderSearchCode(data: Data, truncated: boolean): string {
  const groups = Array.isArray(data.groups) ? data.groups as Data[] : groupMatches(data.matches);
  const rendered: string[] = [];
  for (const group of groups) {
    rendered.push(string(group.path));
    const lines = Array.isArray(group.lines) ? group.lines as Data[] : [];
    for (const line of lines) {
      rendered.push(`  ${number(line.line)}${line.context === true ? "-" : ":"} ${string(line.text)}`);
    }
    const omitted = number(group.omitted);
    if (omitted > 0) rendered.push(`(+${omitted} more in this file)`);
  }
  const note = optionalString(data.note);
  if (note) rendered.push(note);
  else if (truncated) rendered.push("[onehand: results truncated]");
  return rendered.join("\n");
}

function groupMatches(value: unknown): Data[] {
  if (!Array.isArray(value)) return [];
  const groups = new Map<string, Data[]>();
  for (const item of value as Data[]) {
    const path = string(item.path);
    const group = groups.get(path) ?? [];
    group.push(item);
    groups.set(path, group);
  }
  return [...groups].map(([path, lines]) => ({ path, lines, omitted: 0 }));
}

function renderListFiles(data: Data, truncated: boolean): string {
  const rendered = Array.isArray(data.files) ? data.files.map(string) : [];
  if (Array.isArray(data.directories)) {
    for (const directory of data.directories as Data[]) {
      const path = string(directory.path).replace(/\/+$/, "");
      rendered.push(`${path}/ (${number(directory.count)} files)`);
    }
  }
  const note = optionalString(data.note);
  if (note) rendered.push(note);
  else if (truncated) rendered.push("[onehand: results truncated]");
  return rendered.join("\n");
}

function renderCommand(name: string, data: Data, resultTruncated: boolean): string {
  const isTest = name === "run_tests";
  const status = [`exit ${data.exitCode === null ? "null" : number(data.exitCode)}`, `${formatSeconds(number(data.durationMs))}s`];
  if (data.timedOut === true) status.push("timed out");
  if (isTest) status.push(data.passed === true ? "passed" : "failed");
  const rendered = [`$ ${string(data.command)}`, status.join(" · ")];

  const note = optionalString(data.note);
  if (note) rendered.push(note);
  if (typeof data.verifiesLatestChange === "boolean") {
    rendered.push(`verifiesLatestChange: ${data.verifiesLatestChange}`);
  }

  const stdout = optionalString(data.stdout);
  const stderr = optionalString(data.stderr);
  const outputs = [
    ...(stdout ? [{ heading: "--- stdout ---", content: stdout }] : []),
    ...(stderr ? [{ heading: "--- stderr ---", content: stderr }] : [])
  ];
  const failures = Array.isArray(data.failures) ? data.failures.slice(0, 40).map(string) : [];
  const combinedOutputTooLarge = commandTextBytes(rendered.join("\n"), outputs) > DEFAULT_TOOL_OUTPUT_LIMIT;
  if (isTest && (resultTruncated || data.truncated === true || combinedOutputTooLarge) && failures.length > 0) {
    rendered.push("failures:", ...failures);
  }
  return renderBoundedCommand(rendered.join("\n"), outputs);
}

function renderBoundedCommand(prefixValue: string, outputs: Array<{ heading: string; content: string }>): string {
  const full = commandText(prefixValue, outputs);
  if (Buffer.byteLength(full, "utf8") <= DEFAULT_TOOL_OUTPUT_LIMIT) return full;
  const prefix = truncateText(prefixValue, Math.floor(DEFAULT_TOOL_OUTPUT_LIMIT * 0.4)).text;
  if (outputs.length === 0) return prefix;
  const separators = outputs.length;
  const remaining = Math.max(0, DEFAULT_TOOL_OUTPUT_LIMIT - Buffer.byteLength(prefix, "utf8") - separators);
  const baseBudget = Math.floor(remaining / outputs.length);
  let extra = remaining % outputs.length;
  const sections = outputs.map(({ heading, content }) => {
    const budget = baseBudget + (extra-- > 0 ? 1 : 0);
    return truncateText(`${heading}\n${content}`, budget, "head_tail").text;
  });
  return [prefix, ...sections].join("\n");
}

function commandTextBytes(prefix: string, outputs: Array<{ heading: string; content: string }>): number {
  return Buffer.byteLength(commandText(prefix, outputs), "utf8");
}

function commandText(prefix: string, outputs: Array<{ heading: string; content: string }>): string {
  return [prefix, ...outputs.map(({ heading, content }) => `${heading}\n${content}`)].join("\n");
}

function formatSeconds(durationMs: number): string {
  return (durationMs / 1_000).toFixed(3).replace(/\.?0+$/, "");
}

function string(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "");
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function number(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function splitFileLines(value: string): string[] {
  const normalized = value.replaceAll("\r\n", "\n");
  if (normalized.length === 0) return [];
  return (normalized.endsWith("\n") ? normalized.slice(0, -1) : normalized).split("\n");
}
