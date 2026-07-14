export const DEFAULT_TOOL_OUTPUT_LIMIT = 20 * 1024;

export function truncateText(
  value: string,
  limitBytes = DEFAULT_TOOL_OUTPUT_LIMIT
): { text: string; truncated: boolean } {
  const buffer = Buffer.from(value, "utf8");
  if (buffer.byteLength <= limitBytes) {
    return { text: value, truncated: false };
  }

  const suffix = "\n\n[onehand: output truncated]";
  const suffixBytes = Buffer.byteLength(suffix, "utf8");
  const sliceLimit = Math.max(0, limitBytes - suffixBytes);
  return {
    text: buffer.subarray(0, sliceLimit).toString("utf8") + suffix,
    truncated: true
  };
}

export function safeJsonStringify(value: unknown): string {
  return JSON.stringify(value, null, 2);
}
