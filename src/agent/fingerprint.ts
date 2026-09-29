import { createHash } from "node:crypto";
import { AgentProfile, PROFILES, resolveFeatures } from "./profile.js";
import { buildUserPrompt, effectiveSystemPrompt } from "./prompt.js";
import {
  BUDGET_NOTICE_TEMPLATE,
  CACHE_ISOLATION_TEMPLATE,
  CLOSEOUT_NOTICE_TEMPLATE,
  OUTPUT_LIMIT_NUDGE,
  TEXT_ONLY_NUDGE
} from "./runner.js";
import { toolDefinitionsFor } from "../tools/registry.js";

// sha256 of `parts` serialized as JSON with every object's keys sorted by code point, so the
// digest is stable regardless of property insertion order and independent of locale-aware sorting.
export function fingerprintOf(parts: unknown): string {
  return createHash("sha256").update(JSON.stringify(parts, sortKeysByCodePoint)).digest("hex");
}

// Hash of exactly what can change the agent's behavior: the system prompt, the cache-isolation
// template placed ahead of it (the per-run nonce inside it is deliberately excluded), the user-prompt
// template (rendered with and without a test command, and with a test-target hint), the
// text-only/output-limit nudge texts, the tool definitions, and the agent profile. Notice profiles
// additionally cover the fixed budget and close-out templates. A resumed evaluation with a
// different fingerprint means the agent version changed underneath it.
export function agentBehaviorFingerprint(profile: AgentProfile = PROFILES.baseline): string {
  const placeholders = { task: "<task>", repo: "<repo>" };
  const features = resolveFeatures(profile.flags);
  return fingerprintOf({
    systemPrompt: effectiveSystemPrompt(features),
    cacheIsolationTemplate: CACHE_ISOLATION_TEMPLATE,
    userPrompts: [
      buildUserPrompt({ ...placeholders, testCommand: "<test-command>" }),
      buildUserPrompt(placeholders),
      buildUserPrompt({ ...placeholders, testCommand: "<test-command>", testTargetHint: "<test-targets>" })
    ],
    nudges: { textOnly: TEXT_ONLY_NUDGE, outputLimit: OUTPUT_LIMIT_NUDGE },
    ...(features.budgetNotices ? { noticeTemplates: [BUDGET_NOTICE_TEMPLATE, CLOSEOUT_NOTICE_TEMPLATE] } : {}),
    tools: toolDefinitionsFor(features),
    profile: { name: profile.name, flags: profile.flags }
  });
}

function sortKeysByCodePoint(_key: string, value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}
