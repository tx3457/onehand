import { describe, expect, it } from "vitest";
import { agentBehaviorFingerprint, fingerprintOf } from "../src/agent/fingerprint.js";
import { PROFILES, resolveProfile } from "../src/agent/profile.js";

describe("fingerprintOf", () => {
  it("changes when any single part changes", () => {
    const base = fingerprintOf({ a: 1, b: [1, 2, 3], c: { nested: "value" } });
    expect(fingerprintOf({ a: 2, b: [1, 2, 3], c: { nested: "value" } })).not.toBe(base);
    expect(fingerprintOf({ a: 1, b: [1, 2, 4], c: { nested: "value" } })).not.toBe(base);
    expect(fingerprintOf({ a: 1, b: [1, 2, 3], c: { nested: "other" } })).not.toBe(base);
    expect(fingerprintOf({ a: 1, b: [1, 2, 3], c: { nested: "value" } })).toBe(base);
  });

  it("is a stable 64-character hex digest independent of object key order", () => {
    const fingerprint = fingerprintOf({ a: 1, b: 2 });
    expect(fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(fingerprintOf({ b: 2, a: 1 })).toBe(fingerprint);
  });
});

describe("agentBehaviorFingerprint", () => {
  it("includes the agent profile name and flags and stays stable", () => {
    const baseline = agentBehaviorFingerprint();
    expect(baseline).toMatch(/^[a-f0-9]{64}$/);
    expect(agentBehaviorFingerprint()).toBe(baseline);
    expect(agentBehaviorFingerprint(PROFILES.baseline)).toBe(baseline);
    expect(agentBehaviorFingerprint({ name: "baseline", flags: {} })).toBe(baseline);
    expect(agentBehaviorFingerprint({ name: "variant", flags: {} })).not.toBe(baseline);
    const flagged = agentBehaviorFingerprint({ name: "baseline", flags: { retrieval: true, compactObservations: true } });
    expect(flagged).not.toBe(baseline);
    expect(agentBehaviorFingerprint({ name: "baseline", flags: { compactObservations: true, retrieval: true } })).toBe(flagged);
    expect(agentBehaviorFingerprint({ name: "baseline", flags: { retrieval: false, compactObservations: true } })).not.toBe(flagged);
  });

  it("resolves only defined profiles", () => {
    expect(resolveProfile("baseline")).toBe(PROFILES.baseline);
    expect(PROFILES.baseline).toEqual({ name: "baseline", flags: {} });
    for (const name of ["missing", "constructor", "toString", "__proto__"]) {
      expect(() => resolveProfile(name), name).toThrow(`Unknown agent profile: ${name}`);
    }
  });
});
