export type AgentFeatures = Readonly<{
  retrieval: boolean;
  compactObservations: boolean;
  sandboxCommands: boolean;
  observationMasking: boolean;
  leanPlanning: boolean;
  exploreSubagent: boolean;
  budgetNotices: boolean;
}>;

export type AgentProfile = { name: string; flags: Partial<AgentFeatures> };

const full = {
  name: "full",
  flags: { retrieval: true, compactObservations: true, sandboxCommands: true, observationMasking: true, leanPlanning: true }
} satisfies AgentProfile;

const ctxSandboxPlan = {
  name: "ctx-sandbox-plan",
  flags: { retrieval: true, compactObservations: true, sandboxCommands: true, leanPlanning: true }
} satisfies AgentProfile;

export const PROFILES = {
  baseline: { name: "baseline", flags: {} },
  ctx: { name: "ctx", flags: { retrieval: true, compactObservations: true } },
  "ctx-sandbox": { name: "ctx-sandbox", flags: { retrieval: true, compactObservations: true, sandboxCommands: true } },
  "ctx-sandbox-mask": { name: "ctx-sandbox-mask", flags: { retrieval: true, compactObservations: true, sandboxCommands: true, observationMasking: true } },
  full,
  "ctx-sandbox-plan": ctxSandboxPlan,
  "ctx-sandbox-plan-explore": { name: "ctx-sandbox-plan-explore", flags: { ...ctxSandboxPlan.flags, exploreSubagent: true } },
  "ctx-notices": { name: "ctx-notices", flags: { retrieval: true, compactObservations: true, budgetNotices: true } },
  "ctx-sandbox-notices": { name: "ctx-sandbox-notices", flags: { retrieval: true, compactObservations: true, sandboxCommands: true, budgetNotices: true } }
} satisfies Record<string, AgentProfile>;

export function resolveFeatures(flags: unknown = {}): AgentFeatures {
  if (!flags || typeof flags !== "object" || Array.isArray(flags)) {
    throw new Error("Agent profile flags must be an object");
  }
  const features = {
    retrieval: false,
    compactObservations: false,
    sandboxCommands: false,
    observationMasking: false,
    leanPlanning: false,
    exploreSubagent: false,
    budgetNotices: false
  };
  for (const key of Reflect.ownKeys(flags)) {
    if (typeof key !== "string" || !Object.hasOwn(features, key)) {
      throw new Error(`Unknown agent feature: ${String(key)}`);
    }
    const value = (flags as Record<string, unknown>)[key];
    if (typeof value !== "boolean") throw new Error(`Agent feature ${key} must be a boolean`);
    features[key as keyof AgentFeatures] = value;
  }
  return features;
}

export function resolveProfile(name: string): AgentProfile {
  if (!Object.hasOwn(PROFILES, name)) throw new Error(`Unknown agent profile: ${name}`);
  const profile = PROFILES[name as keyof typeof PROFILES];
  resolveFeatures(profile.flags);
  return profile;
}
