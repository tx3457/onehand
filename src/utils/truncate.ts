export const DEFAULT_TOOL_OUTPUT_LIMIT = 20 * 1024;

export function truncateText(
  value: string,
  limitBytes = DEFAULT_TOOL_OUTPUT_LIMIT,
  strategy: "head" | "head_tail" = "head"
): { text: string; truncated: boolean } {
  const buffer = Buffer.from(value, "utf8");
  const totalBytes = buffer.byteLength;
  if (totalBytes <= limitBytes) {
    return { text: value, truncated: false };
  }

  // Upper bound on marker size: omitted bytes can't exceed totalBytes, so its digit count
  // can't exceed totalBytes's digit count. Reserving budget against this bound guarantees
  // the real marker (computed after cut points are chosen) still fits within limitBytes.
  const markerBudget = Buffer.byteLength(marker(totalBytes), "utf8");
  if (limitBytes < markerBudget) {
    // No room for the marker: keep only the head that fits.
    return { text: buffer.subarray(0, backToCharBoundary(buffer, limitBytes)).toString("utf8"), truncated: true };
  }
  const contentBudget = limitBytes - markerBudget;

  if (strategy === "head_tail") {
    const headBudget = Math.floor(contentBudget * 0.3);
    const tailBudget = contentBudget - headBudget;
    const headEnd = backToCharBoundary(buffer, Math.min(headBudget, totalBytes));
    const tailStart = forwardToCharBoundary(buffer, Math.max(totalBytes - tailBudget, headEnd));
    const omitted = tailStart - headEnd;
    return {
      text:
        buffer.subarray(0, headEnd).toString("utf8") +
        marker(omitted) +
        buffer.subarray(tailStart).toString("utf8"),
      truncated: true
    };
  }

  const headEnd = backToCharBoundary(buffer, Math.min(contentBudget, totalBytes));
  const omitted = totalBytes - headEnd;
  return {
    text: buffer.subarray(0, headEnd).toString("utf8") + marker(omitted),
    truncated: true
  };
}

function marker(omittedBytes: number): string {
  return `\n\n[onehand: output truncated, ${omittedBytes} bytes omitted]\n\n`;
}

// Move a head cut point backward off a UTF-8 continuation byte (0b10xxxxxx) so the slice
// before it ends on a full character.
function backToCharBoundary(buffer: Buffer, index: number): number {
  let i = Math.max(0, Math.min(index, buffer.length));
  while (i > 0 && (buffer[i]! & 0b11000000) === 0b10000000) i--;
  return i;
}

// Move a tail cut point forward off a UTF-8 continuation byte so the slice from it starts
// on a full character.
function forwardToCharBoundary(buffer: Buffer, index: number): number {
  let i = Math.max(0, Math.min(index, buffer.length));
  while (i < buffer.length && (buffer[i]! & 0b11000000) === 0b10000000) i++;
  return i;
}

export function safeJsonStringify(value: unknown): string {
  return JSON.stringify(value, null, 2);
}
