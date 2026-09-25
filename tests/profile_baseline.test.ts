import { describe, expect, it } from "vitest";
import { agentBehaviorFingerprint } from "../src/agent/fingerprint.js";
import { PROFILES } from "../src/agent/profile.js";
import { serializeToolResult, TOOL_DEFINITIONS } from "../src/tools/registry.js";

describe("frozen baseline behavior", () => {
  it("keeps the pre-experiment behavior fingerprint", () => {
    expect(agentBehaviorFingerprint(PROFILES.baseline)).toBe("674793f83c5ac14a6ed46e1fd0e4327b964cbb2101250aa7db05fc7102486f09");
  });

  it("keeps tool definitions including object key order", () => {
    expect(JSON.stringify(TOOL_DEFINITIONS, null, 2)).toMatchSnapshot();
  });

  it("keeps escaped, indented tool observations", () => {
    expect(serializeToolResult({
      ok: true, data: { path: "hello.py", content: 'def hello():\r\n    return "你好"\n', bytes: 38 }, truncated: false
    })).toMatchSnapshot();
    expect(serializeToolResult({ ok: false, error: "Missing file", recoverable: false, code: "environment" })).toMatchSnapshot();
  });
});
