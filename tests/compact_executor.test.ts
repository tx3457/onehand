import { describe, expect, it } from "vitest";
import { LocalExecutor } from "../src/runtime/executor.js";
import { renderToolResult } from "../src/tools/render.js";

describe("compact observation failure capture", () => {
  it("keeps failure identifiers from full output when opted-in truncated output hides them", async () => {
    const result = await new LocalExecutor().run({
      program: "node",
      args: ["-e", [
        "process.stdout.write('HEAD' + 'x'.repeat(2_000) + '\\n')",
        "process.stdout.write('FAILED pkg/test_mod.py::test_middle - AssertionError\\n')",
        "process.stdout.write('y'.repeat(2_000) + 'TAIL\\n')"
      ].join(";")],
      cwd: process.cwd(),
      timeoutSec: 10,
      outputLimitBytes: 200,
      truncation: "head_tail",
      captureFailures: true
    });

    expect(result).toMatchObject({
      ok: true,
      truncated: true,
      data: {
        failures: ["FAILED pkg/test_mod.py::test_middle - AssertionError"]
      }
    });
    if (result.ok) expect(result.data.stdout).not.toContain("test_middle");
  });

  it("does not change execution data unless capture is explicitly requested", async () => {
    const result = await new LocalExecutor().run({
      program: "node",
      args: ["-e", "process.stdout.write('FAILED hidden\\n' + 'x'.repeat(2_000))"],
      cwd: process.cwd(),
      timeoutSec: 10,
      outputLimitBytes: 100
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).not.toHaveProperty("failures");
  });

  it("caps captured failure lines at forty and accepts supported failure formats", async () => {
    const lines = [
      "FAIL: unittest_case",
      "ERROR: unittest_error",
      "E   AssertionError: expected true",
      ...Array.from({ length: 20 }, (_, index) => `FAILED test_${index}`),
      ...Array.from({ length: 20 }, (_, index) => `ERROR test_${index}`),
      "not a failure line"
    ];
    const script = `process.stdout.write(${JSON.stringify(`${"x".repeat(500)}\n${lines.join("\n")}\n${"y".repeat(500)}`)})`;
    const result = await new LocalExecutor().run({
      program: "node", args: ["-e", script], cwd: process.cwd(), timeoutSec: 10,
      outputLimitBytes: 100, captureFailures: true
    });

    expect(result.ok && result.data.failures).toHaveLength(40);
    if (result.ok) {
      expect(result.data.failures?.slice(0, 3)).toEqual([
        "FAIL: unittest_case", "ERROR: unittest_error", "E   AssertionError: expected true"
      ]);
      expect(result.data.failures?.[39]).toBe("ERROR test_16");
    }
  });

  it("preserves a middle failure when separate streams fit but their combined observation does not", async () => {
    const script = [
      `process.stdout.write(${"`"}OUT_HEAD${"x".repeat(6_000)}\\nFAILED pkg/test_big.py::test_middle\\n${"y".repeat(6_000)}OUT_TAIL${"`"})`,
      `process.stderr.write(${"`"}ERR_HEAD${"z".repeat(12_000)}ERR_TAIL${"`"})`
    ].join(";");
    const execution = await new LocalExecutor().run({
      program: "node", args: ["-e", script], cwd: process.cwd(), timeoutSec: 10,
      captureFailures: true, displayCommand: "pytest"
    });

    expect(execution).toMatchObject({
      ok: true,
      truncated: false,
      data: { truncated: false, failures: ["FAILED pkg/test_big.py::test_middle"] }
    });
    if (!execution.ok) return;
    const rendered = renderToolResult("run_tests", {
      ok: true,
      data: { ...execution.data, passed: false },
      truncated: execution.truncated
    });
    expect(rendered).toContain("failures:\nFAILED pkg/test_big.py::test_middle");
    expect(rendered).toContain("OUT_HEAD");
    expect(rendered).toContain("OUT_TAIL");
    expect(rendered).toContain("ERR_HEAD");
    expect(rendered).toContain("ERR_TAIL");
    expect(Buffer.byteLength(rendered, "utf8")).toBeLessThanOrEqual(20 * 1024);
  });
});
