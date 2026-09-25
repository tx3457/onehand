import { describe, expect, it } from "vitest";
import { agentBehaviorFingerprint } from "../src/agent/fingerprint.js";
import { PROFILES, resolveFeatures, resolveProfile } from "../src/agent/profile.js";
import { toolDefinitionsFor } from "../src/tools/registry.js";

describe("sub-agent profile", () => {
  it("adds explore only to full-explore and gives that arm a distinct fingerprint", () => {
    const profile = resolveProfile("full-explore");

    expect(profile.flags).toEqual({ ...PROFILES.full.flags, exploreSubagent: true });
    expect(resolveFeatures(profile.flags).exploreSubagent).toBe(true);
    expect(toolDefinitionsFor(profile.flags).map((tool) => tool.name)).toContain("explore");
    expect(toolDefinitionsFor(PROFILES.full.flags).map((tool) => tool.name)).not.toContain("explore");
    for (const other of Object.values(PROFILES).filter(({ name }) => name !== "full-explore")) {
      expect(agentBehaviorFingerprint(profile)).not.toBe(agentBehaviorFingerprint(other));
    }
  });

  it("enumerates every profile and defaults every feature to false", () => {
    expect(Object.keys(PROFILES)).toEqual(["baseline", "ctx", "ctx-sandbox", "ctx-sandbox-mask", "full", "full-explore"]);
    expect(resolveFeatures({})).toEqual({
      retrieval: false,
      compactObservations: false,
      sandboxCommands: false,
      observationMasking: false,
      leanPlanning: false,
      exploreSubagent: false
    });
  });
});
