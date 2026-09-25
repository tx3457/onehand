import { describe, expect, it } from "vitest";
import { truncateText } from "../src/utils/truncate.js";
import { legacyTruncateText } from "./fixtures/legacyTruncate.js";

describe("truncateText", () => {
  it("preserves existing string results, including unpaired surrogates, below the limit", () => {
    for (const value of ["plain", "中文🎉", "a\ud800b", "\udc00"]) {
      expect(truncateText(value, 100)).toEqual(legacyTruncateText(value, 100));
    }
  });
  it("does not truncate output under the limit", () => {
    const result = truncateText("hello world", 1000, "head_tail");
    expect(result).toEqual({ text: "hello world", truncated: false });
  });

  it("preserves the tail of a long output with the head_tail strategy", () => {
    const lines = Array.from({ length: 300 }, (_, i) => `line ${i}: padding padding padding`);
    const value = [...lines, "FAILED: last line"].join("\n");
    const result = truncateText(value, 800, "head_tail");
    expect(result.truncated).toBe(true);
    expect(result.text).toContain("FAILED: last line");
  });

  it("keeps head_tail output within the byte limit", () => {
    const value = "y".repeat(50_000);
    const limit = 1000;
    const result = truncateText(value, limit, "head_tail");
    expect(Buffer.byteLength(result.text, "utf8")).toBeLessThanOrEqual(limit);
  });

  it("keeps head-only output within the byte limit", () => {
    const value = "y".repeat(50_000);
    const limit = 1000;
    const result = truncateText(value, limit, "head");
    expect(Buffer.byteLength(result.text, "utf8")).toBeLessThanOrEqual(limit);
  });

  it("never splits multi-byte UTF-8 characters with head_tail (Chinese)", () => {
    const value = "中文测试字符串".repeat(200);
    const result = truncateText(value, 500, "head_tail");
    expect(result.truncated).toBe(true);
    expect(result.text).not.toContain("�");
  });

  it("never splits multi-byte UTF-8 characters with head (emoji)", () => {
    const value = "🎉🚀🔥💡✨".repeat(200);
    const result = truncateText(value, 500, "head");
    expect(result.truncated).toBe(true);
    expect(result.text).not.toContain("�");
  });

  it("returns a marker-free head slice when the limit cannot hold the marker", () => {
    expect(truncateText("abcdef".repeat(10), 5)).toEqual({ text: "abcde", truncated: true });
    expect(truncateText("中文".repeat(10), 7, "head_tail")).toEqual({ text: "中文", truncated: true });
    expect(truncateText("abc", 0)).toEqual({ text: "", truncated: true });
    expect(truncateText("abc", -1, "head_tail")).toEqual({ text: "", truncated: true });
  });

  it("fits every limit on character boundaries for both strategies", () => {
    for (const prefix of ["", "a", "ab", "abc"]) {
      const value = prefix + "中文🎉".repeat(15);
      const bytes = Buffer.byteLength(value, "utf8");
      for (let limit = 1; limit <= 200; limit += 1) {
        for (const strategy of ["head", "head_tail"] as const) {
          const result = truncateText(value, limit, strategy);
          const label = `prefix=${prefix.length} limit=${limit} ${strategy}`;
          expect(Buffer.byteLength(result.text, "utf8"), label).toBeLessThanOrEqual(limit);
          expect(result.text, label).not.toContain("�");
          expect(result.truncated, label).toBe(bytes > limit);
        }
      }
    }
  });
});
