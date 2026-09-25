import { resolveProfile, type AgentProfile } from "./profile.js";

export function resolveLocalProfile(name: string = "ctx"): AgentProfile {
  const profile = resolveProfile(name);
  if (profile.flags.sandboxCommands) {
    throw new Error(`Agent profile ${name} cannot run in the local CLI because it requires Docker sandbox commands`);
  }
  return profile;
}
