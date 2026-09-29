import { describe, expect, it, vi } from "vitest";
import { agentBehaviorFingerprint, fingerprintOf } from "../src/agent/fingerprint.js";
import { PROFILES, resolveFeatures, resolveProfile } from "../src/agent/profile.js";
import * as prompts from "../src/agent/prompt.js";
import * as runner from "../src/agent/runner.js";

const BUDGET_NOTICE_PROMPT = "- The runtime posts budget notices as user messages: the share of the run budget used, and whether the latest change is verified and stable. Every round resends the whole history, so late rounds cost the most. When a notice says the latest change is verified and stable and the task is done, mark the remaining plan steps completed with evidence and call finish_task instead of exploring further.";

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
  it("keeps the seven v0.3.0 profile fingerprints frozen", () => {
    // Computed at commit 5cf6470 (v0.3.0).
    expect(agentBehaviorFingerprint(PROFILES.baseline)).toBe("674793f83c5ac14a6ed46e1fd0e4327b964cbb2101250aa7db05fc7102486f09");
    expect(agentBehaviorFingerprint(PROFILES.ctx)).toBe("9bc9203921b32815a791ae99358191da81907c87899d30fc1d9352add1d281ec");
    expect(agentBehaviorFingerprint(PROFILES["ctx-sandbox"])).toBe("e7797b1a43ae1c14f94e6335b3098e02925ed010db410e8b565696c90c833792");
    expect(agentBehaviorFingerprint(PROFILES["ctx-sandbox-mask"])).toBe("0154454540dddb75a0398b96bf0b067be82995b0a8c2f46c6c1808771701a0ab");
    expect(agentBehaviorFingerprint(PROFILES.full)).toBe("c9edf2f143c91269296caef5292fcdb6dd5bc58f30475587ba7f6df618a4842e");
    expect(agentBehaviorFingerprint(PROFILES["ctx-sandbox-plan"])).toBe("804d32f8b7b90a2892a3cc577b24c869489fc509c3a00f04adaaa9e3e520c329");
    expect(agentBehaviorFingerprint(PROFILES["ctx-sandbox-plan-explore"])).toBe("ff74ca6855e22b9fe33a43f9a8254daee28d5f70c792715c5a6165575d4b52f1");
  });

  it("gives notice profiles distinct fingerprints from their parents and each other", () => {
    const ctxNotices = agentBehaviorFingerprint(PROFILES["ctx-notices"]);
    const sandboxNotices = agentBehaviorFingerprint(PROFILES["ctx-sandbox-notices"]);
    expect(ctxNotices).not.toBe(agentBehaviorFingerprint(PROFILES.ctx));
    expect(sandboxNotices).not.toBe(agentBehaviorFingerprint(PROFILES["ctx-sandbox"]));
    expect(ctxNotices).not.toBe(sandboxNotices);
  });

  it("hashes notice templates only for profiles that enable notices", () => {
    const baseline = agentBehaviorFingerprint(PROFILES.ctx);
    const notices = agentBehaviorFingerprint(PROFILES["ctx-notices"]);
    const template = vi.spyOn(runner, "BUDGET_NOTICE_TEMPLATE", "get")
      .mockReturnValue("changed notice template" as unknown as typeof runner.BUDGET_NOTICE_TEMPLATE);
    try {
      expect(agentBehaviorFingerprint(PROFILES.ctx)).toBe(baseline);
      expect(agentBehaviorFingerprint(PROFILES["ctx-notices"])).not.toBe(notices);
    } finally {
      template.mockRestore();
    }
  });

  it("hashes the effective profile prompt", () => {
    const before = agentBehaviorFingerprint(PROFILES.full);
    const effective = vi.spyOn(prompts, "effectiveSystemPrompt").mockReturnValue("changed profile instructions");
    try {
      expect(agentBehaviorFingerprint(PROFILES.full)).not.toBe(before);
      expect(effective).toHaveBeenCalledWith(expect.objectContaining({ leanPlanning: true }));
    } finally {
      effective.mockRestore();
    }
  });
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

describe("budget notice prompt", () => {
  it("preserves the system prompt byte-for-byte when notices are disabled", () => {
    expect(prompts.effectiveSystemPrompt(resolveFeatures({}))).toBe(prompts.SYSTEM_PROMPT);
    expect(prompts.effectiveSystemPrompt(resolveFeatures({ budgetNotices: false }))).toBe(prompts.SYSTEM_PROMPT);
  });

  it("appends the notice guidance as the final bullet", () => {
    const prompt = prompts.effectiveSystemPrompt(resolveFeatures({ budgetNotices: true }));
    expect(prompt).toBe(`${prompts.SYSTEM_PROMPT}\n${BUDGET_NOTICE_PROMPT}`);
    expect(prompt.endsWith(BUDGET_NOTICE_PROMPT)).toBe(true);
  });

  it("applies lean replacements before appending notice guidance", () => {
    const lean = prompts.effectiveSystemPrompt(resolveFeatures({ leanPlanning: true }));
    expect(prompts.effectiveSystemPrompt(resolveFeatures({ leanPlanning: true, budgetNotices: true }))).toBe(`${lean}\n${BUDGET_NOTICE_PROMPT}`);
  });
});
