import { readFile } from "node:fs/promises";

const ALLOWED_KEYS = new Set([
  "DEEPSEEK_API_KEY",
  "Deepseek_API_KEY",
  "LLM_API_KEY",
  "DEEPSEEK_BASE_URL",
  "Deepseek_BASE_URL",
  "LLM_BASE_URL"
]);

export async function loadDeepSeekEnvironment(filePath: string): Promise<{
  apiKey: string;
  baseURL: string;
  sourceKey: string;
}> {
  const raw = await readFile(filePath, "utf8");
  const values = new Map<string, string>();
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(trimmed);
    if (!match || !ALLOWED_KEYS.has(match[1]!)) continue;
    values.set(match[1]!, unquote(match[2]!));
  }
  const keyNames = ["DEEPSEEK_API_KEY", "Deepseek_API_KEY", "LLM_API_KEY"];
  const sourceKey = keyNames.find((key) => values.get(key));
  if (!sourceKey) throw new Error("No allowlisted DeepSeek API key variable was found");
  const baseURL = values.get("DEEPSEEK_BASE_URL") ?? values.get("Deepseek_BASE_URL") ??
    values.get("LLM_BASE_URL") ?? "https://api.deepseek.com";
  return { apiKey: values.get(sourceKey)!, baseURL, sourceKey };
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}
