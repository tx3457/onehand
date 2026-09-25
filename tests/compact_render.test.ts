import { describe, expect, it } from "vitest";
import { renderToolResult } from "../src/tools/render.js";
import type { ToolResult } from "../src/types.js";

describe("renderToolResult", () => {
  it("renders recoverable and environment errors without losing recovery information", () => {
    expect(renderToolResult("read_file", { ok: false, error: "missing", recoverable: true }))
      .toBe("error: missing");
    expect(renderToolResult("run_tests", {
      ok: false, error: "container stopped", recoverable: false, code: "environment"
    })).toBe("error: container stopped (not recoverable)\ncode: environment");
  });

  it("renders numbered file text without JSON escaping", () => {
    const result: ToolResult<unknown> = {
      ok: true,
      data: {
        path: "src/a.py", content: "   8\tdef f():\n   9\t    return 世界",
        totalLines: 12, startLine: 8, endLine: 9
      }
    };
    expect(renderToolResult("read_file", result)).toBe(
      "src/a.py (lines 8–9 of 12)\n   8\tdef f():\n   9\t    return 世界"
    );
  });

  it("renders an outline and range note around read content", () => {
    const result: ToolResult<unknown> = {
      ok: true,
      data: {
        path: "big.py", content: "   1\tclass A:", outline: " 250\tdef later():",
        totalLines: 900, startLine: 1, endLine: 200,
        note: "File has 900 lines; showing 1–200. Pass startLine/endLine to read other parts."
      }
    };
    expect(renderToolResult("read_file", result)).toBe(
      "big.py (lines 1–200 of 900)\noutline:\n 250\tdef later():\n   1\tclass A:\nFile has 900 lines; showing 1–200. Pass startLine/endLine to read other parts."
    );
  });

  it("renders a compact-only baseline read without fake zero line metadata", () => {
    expect(renderToolResult("read_file", {
      ok: true, data: { path: "plain.txt", content: "alpha\r\nbeta", bytes: 11 }
    })).toBe("plain.txt (lines 1–2 of 2)\n     1\talpha\n     2\tbeta");
  });

  it("identifies an empty compact-only file with explicit zero line metadata", () => {
    expect(renderToolResult("read_file", {
      ok: true, data: { path: "empty.txt", content: "", bytes: 0 }
    })).toBe("empty.txt (lines 0–0 of 0)");
  });

  it("groups search matches by file and marks context lines", () => {
    const result: ToolResult<unknown> = {
      ok: true,
      data: {
        matches: [],
        groups: [
          { path: "a.py", lines: [
            { line: 4, column: 2, text: "needle()" },
            { line: 5, text: "after", context: true }
          ], omitted: 0 },
          { path: "b.py", lines: [{ line: 9, column: 1, text: "needle again" }], omitted: 2 }
        ],
        note: "Results capped at 100 matches."
      }
    };
    expect(renderToolResult("search_code", result)).toBe(
      "a.py\n  4: needle()\n  5- after\nb.py\n  9: needle again\n(+2 more in this file)\nResults capped at 100 matches."
    );
  });

  it("renders file paths or an overflow directory summary with its note", () => {
    expect(renderToolResult("list_files", {
      ok: true, data: { files: ["a.ts", "src/b.ts"] }
    })).toBe("a.ts\nsrc/b.ts");
    expect(renderToolResult("list_files", {
      ok: true,
      data: {
        files: ["README.md"],
        directories: [{ path: "src", count: 8 }, { path: "tests", count: 3 }],
        note: "11 more files; narrow path or pass pattern."
      },
      truncated: true
    })).toBe("README.md\nsrc/ (8 files)\ntests/ (3 files)\n11 more files; narrow path or pass pattern.");
  });

  it("keeps a recognizable cap trailer when search and list data have no note", () => {
    expect(renderToolResult("search_code", {
      ok: true, data: { matches: [{ path: "a.ts", line: 1, column: 1, text: "x" }] }, truncated: true
    })).toBe("a.ts\n  1: x\n[onehand: results truncated]");
    expect(renderToolResult("list_files", {
      ok: true, data: { files: ["a.ts"] }, truncated: true
    })).toBe("a.ts\n[onehand: results truncated]");
  });

  it("renders command status, notes, and non-empty streams", () => {
    expect(renderToolResult("run_command", {
      ok: true,
      data: {
        command: "npm test", exitCode: null, durationMs: 1_250, timedOut: true,
        stdout: "partial", stderr: "", truncated: false
      }
    })).toBe("$ npm test\nexit null · 1.25s · timed out\n--- stdout ---\npartial");
  });

  it("puts captured test failures before truncated output", () => {
    expect(renderToolResult("run_tests", {
      ok: true,
      data: {
        command: "pytest", exitCode: 1, durationMs: 250, timedOut: false,
        passed: false, note: "Run the full suite.", verifiesLatestChange: false,
        failures: ["FAILED pkg/test_x.py::test_x"], stdout: "head\n[onehand: output truncated, 100 bytes omitted]\ntail",
        stderr: "warning", truncated: true
      },
      truncated: true
    })).toBe([
      "$ pytest", "exit 1 · 0.25s · failed", "Run the full suite.",
      "verifiesLatestChange: false", "failures:", "FAILED pkg/test_x.py::test_x",
      "--- stdout ---", "head\n[onehand: output truncated, 100 bytes omitted]\ntail",
      "--- stderr ---", "warning"
    ].join("\n"));
  });

  it("caps rendered failures at forty and preserves status plus both output tails within the byte limit", () => {
    const failures = Array.from({ length: 45 }, (_, index) => `FAILED test_${index}`);
    const rendered = renderToolResult("run_tests", {
      ok: true,
      data: {
        command: "pytest", exitCode: 1, durationMs: 100, timedOut: false, passed: false,
        failures, stdout: `OUT_HEAD${"x".repeat(30_000)}OUT_TAIL`,
        stderr: `ERR_HEAD${"y".repeat(30_000)}ERR_TAIL`, truncated: true
      },
      truncated: true
    });
    expect(rendered).toContain("$ pytest\nexit 1 · 0.1s · failed\nfailures:");
    expect(rendered).toContain("FAILED test_39");
    expect(rendered).not.toContain("FAILED test_40");
    expect(rendered).toContain("--- stdout ---\nOUT_HEAD");
    expect(rendered).toContain("OUT_TAIL");
    expect(rendered).toContain("--- stderr ---\nERR_HEAD");
    expect(rendered).toContain("ERR_TAIL");
    expect(Buffer.byteLength(rendered, "utf8")).toBeLessThanOrEqual(20 * 1024);
  });

  it("uses compact one-line JSON for every other tool", () => {
    const result: ToolResult<unknown> = { ok: true, data: { path: "a.ts", replacements: 1 } };
    expect(renderToolResult("replace_text", result)).toBe('{"ok":true,"data":{"path":"a.ts","replacements":1}}');
  });

  it("enforces the observation byte limit with a recognizable marker", () => {
    const rendered = renderToolResult("read_file", {
      ok: true,
      data: { path: "huge.txt", content: "界".repeat(20_000), totalLines: 1, startLine: 1, endLine: 1 }
    });
    expect(Buffer.byteLength(rendered, "utf8")).toBeLessThanOrEqual(20 * 1024);
    expect(rendered).toMatch(/\[onehand: output truncated, \d+ bytes omitted\]/);
  });
});
