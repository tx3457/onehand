import { createHash } from "node:crypto";
import { buildUserPrompt, SYSTEM_PROMPT } from "./prompt.js";
import { OUTPUT_LIMIT_NUDGE, TEXT_ONLY_NUDGE } from "./runner.js";
import { TOOL_DEFINITIONS } from "../tools/registry.js";

// sha256 of `parts` serialized as JSON with every object's keys sorted by code point, so the
// digest is stable regardless of property insertion order and independent of locale-aware sorting.
export function fingerprintOf(parts: unknown): string {
  return createHash("sha256").update(JSON.stringify(parts, sortKeysByCodePoint)).digest("hex");
}

// Hash of exactly what the model sees that can change its behavior: the system prompt, the
// user-prompt template (rendered with and without a test command), the text-only/output-limit
// nudge texts, and the tool definitions. A resumed evaluation with a different fingerprint means
// the agent version changed underneath it.
export function agentBehaviorFingerprint(): string {
  const placeholders = { task: "<task>", repo: "<repo>" };
  return fingerprintOf({
    systemPrompt: SYSTEM_PROMPT,
    userPrompts: [
      buildUserPrompt({ ...placeholders, testCommand: "<test-command>" }),
      buildUserPrompt(placeholders)
    ],
    nudges: { textOnly: TEXT_ONLY_NUDGE, outputLimit: OUTPUT_LIMIT_NUDGE },
    tools: TOOL_DEFINITIONS
  });
}

function sortKeysByCodePoint(_key: string, value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}
