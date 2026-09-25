import { describe, expect, it } from "vitest";
import { agentBehaviorFingerprint } from "../src/agent/fingerprint.js";
import { PROFILES } from "../src/agent/profile.js";
import { serializeToolResult, TOOL_DEFINITIONS } from "../src/tools/registry.js";

describe("frozen baseline behavior", () => {
  it("keeps the pre-experiment behavior fingerprint", () => {
    expect(agentBehaviorFingerprint(PROFILES.baseline)).toBe("674793f83c5ac14a6ed46e1fd0e4327b964cbb2101250aa7db05fc7102486f09");
    expect(agentBehaviorFingerprint(PROFILES.ctx)).toBe("9bc9203921b32815a791ae99358191da81907c87899d30fc1d9352add1d281ec");
    expect(agentBehaviorFingerprint(PROFILES["ctx-sandbox"])).toBe("e7797b1a43ae1c14f94e6335b3098e02925ed010db410e8b565696c90c833792");
    expect(agentBehaviorFingerprint(PROFILES["ctx-sandbox-mask"])).toBe("0154454540dddb75a0398b96bf0b067be82995b0a8c2f46c6c1808771701a0ab");
    expect(agentBehaviorFingerprint(PROFILES.full)).toBe("c9edf2f143c91269296caef5292fcdb6dd5bc58f30475587ba7f6df618a4842e");
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
