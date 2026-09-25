export type AgentProfile = { name: string; flags: Readonly<Record<string, boolean | number | string>> };

// Named agent variants for A/B evaluation. No behavior reads the flags yet.
export const PROFILES = {
  baseline: { name: "baseline", flags: {} }
} satisfies Record<string, AgentProfile>;

export function resolveProfile(name: string): AgentProfile {
  if (!Object.hasOwn(PROFILES, name)) throw new Error(`Unknown agent profile: ${name}`);
  return PROFILES[name as keyof typeof PROFILES];
}
