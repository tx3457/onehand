import { describe, expect, it } from "vitest";
import { fingerprintOf } from "../src/agent/fingerprint.js";

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
