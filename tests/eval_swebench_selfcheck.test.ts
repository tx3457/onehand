import { describe, expect, it } from "vitest";
import { normalizeRecord } from "../eval/swebench/dataset.js";
import {
  AdapterCheck, classifyInstance, GradeCheck, InstanceSelfcheck, noopTarget, renderSelfcheckMarkdown, SelfcheckReport, TestRun
} from "../eval/swebench/selfcheck.js";

const graded = (kind: "gold" | "noop", repetition: number, resolved: boolean): GradeCheck => ({
  kind, repetition, outcome: resolved ? "resolved" : "unresolved", warnings: [],
  grade: {
    resolved, patchApplied: true, outcome: "scored", f2p: { success: resolved ? 2 : 0, failure: resolved ? 0 : 2 }, p2p: { success: 5, failure: 0 },
    reportPath: `/out/grading/logs/${kind}-${repetition}/report.json`
  }
});
const testRun = (overrides: Partial<TestRun> = {}): TestRun => ({
  command: "./tests/runtests.py --parallel 1 auth_tests.test_forms", exitCode: 1, durationMs: 12_300, passed: false,
  timedOut: false, runnerStarted: true, outputTail: "FAILED (failures=2)", ...overrides
});
const adapterOk: AdapterCheck = {
  targets: ["auth_tests.test_forms"], beforeGold: testRun(), afterGold: testRun({ exitCode: 0, passed: true, durationMs: 11_900 })
};

describe("self-check classification", () => {
  it("passes an instance whose gold always resolves, whose no-op does not, and whose runner starts", () => {
    const verdict = classifyInstance({
      instanceId: "django__django-11790", gold: [graded("gold", 1, true), graded("gold", 2, true)], noop: graded("noop", 1, false), adapter: adapterOk
    });
    expect(verdict).toEqual({ status: "pass", failures: [], warnings: [], errors: [] });
  });

  it("suggests an exclusion when a gold grading is unresolved or the no-op resolves", () => {
    const verdict = classifyInstance({
      instanceId: "django__django-1", gold: [graded("gold", 1, true), graded("gold", 2, false)], noop: graded("noop", 1, true), adapter: adapterOk
    });
    expect(verdict.status).toBe("fail");
    expect(verdict.failures).toEqual([
      "gold patch unresolved on 1 of 2 gradings", "no-op patch resolved, so the tests do not detect a missing fix"
    ]);
    expect(verdict.exclusion).toEqual({
      instanceId: "django__django-1",
      reason: "gold patch unresolved on 1 of 2 gradings; no-op patch resolved, so the tests do not detect a missing fix",
      evidence: "gold resolved 1/2; no-op resolved; gold #1: /out/grading/logs/gold-1/report.json; " +
        "gold #2: /out/grading/logs/gold-2/report.json; noop #1: /out/grading/logs/noop-1/report.json"
    });
  });

  it("reports infrastructure errors and skipped controls without suggesting an exclusion", () => {
    const verdict = classifyInstance({
      instanceId: "django__django-2",
      gold: [graded("gold", 1, true), { kind: "gold", repetition: 2, outcome: "error", detail: "docker cp failed", warnings: [] }],
      noop: { kind: "noop", repetition: 1, outcome: "skipped", detail: "the gold patch modifies no existing non-test .py file", warnings: [] },
      adapter: { targets: [], error: "Docker image x is not available locally" }
    });
    expect(verdict).toEqual({
      status: "error",
      failures: [],
      warnings: ["noop #1 skipped: the gold patch modifies no existing non-test .py file"],
      errors: ["gold #2: docker cp failed", "adapter: Docker image x is not available locally"]
    });
  });

  it("fails when the test runner cannot start and warns about unexpected test outcomes", () => {
    const base = { instanceId: "sympy__sympy-1", gold: [graded("gold", 1, true)], noop: graded("noop", 1, false) };
    const missing = classifyInstance({
      ...base, adapter: { targets: ["a.py"], beforeGold: testRun({ exitCode: 127, runnerStarted: false }), afterGold: testRun({ exitCode: 127, runnerStarted: false }) }
    });
    expect(missing.status).toBe("fail");
    expect(missing.failures).toHaveLength(2);
    expect(missing.failures[0]).toMatch(/test runner did not start before the gold patch: .* \(exit 127\)/);
    expect(missing.exclusion).toBeUndefined();

    const surprising = classifyInstance({
      ...base, adapter: { targets: ["a.py"], beforeGold: testRun({ exitCode: 0, passed: true }), afterGold: testRun({ exitCode: 1 }) }
    });
    expect(surprising).toMatchObject({ status: "pass", failures: [] });
    expect(surprising.warnings).toEqual([
      "tests passed before the gold patch; expected a failure", "tests did not pass after the gold patch (exit 1)"
    ]);
    const slow = classifyInstance({ ...base, adapter: { targets: ["a.py"], beforeGold: testRun(), afterGold: testRun({ exitCode: null, timedOut: true }) } });
    expect(slow.warnings).toEqual(["tests timed out after the gold patch"]);
  });

  it("picks the first modified non-test Python file of the gold patch for the no-op control", () => {
    const section = (file: string, extra = "") => `diff --git a/${file} b/${file}\n${extra}--- a/${file}\n+++ b/${file}\n@@ -1 +1 @@\n-a\n+b\n`;
    const record = (patch: string) => normalizeRecord({
      instance_id: "x__x-1", repo: "x/x", base_commit: "a", environment_setup_commit: "b", version: "1", created_at: "c",
      difficulty: "d", eval_type: "pass_and_fail", image: "i", log_parser: "p", eval_script: "", problem_statement: "",
      hints_text: "", FAIL_TO_PASS: [], PASS_TO_PASS: [], patch, test_patch: section("pkg/tests/test_mod.py")
    });
    expect(noopTarget(record([
      section("pkg/created.py", "new file mode 100644\n"),
      section("docs/index.rst"),
      section("pkg/tests/test_mod.py"),
      section("pkg/testing/helpers.py"),
      section("pkg/conftest.py"),
      section("django/test/client.py"),
      section("pkg/mod.py")
    ].join("")))).toBe("django/test/client.py");
    expect(noopTarget(record(section("pkg/created.py", "new file mode 100644\n") + section("README.md")))).toBeUndefined();
  });

  it("renders the per-instance table, findings, and suggested exclusions", () => {
    const passing: InstanceSelfcheck = {
      instanceId: "django__django-11790", repo: "django/django", durationMs: 1, gold: [graded("gold", 1, true)], noop: graded("noop", 1, false),
      adapter: adapterOk, status: "pass", failures: [], warnings: [], errors: []
    };
    const failing: InstanceSelfcheck = {
      ...passing, instanceId: "django__django-1", gold: [graded("gold", 1, false)], status: "fail", failures: ["gold patch unresolved on 1 of 1 gradings"],
      exclusion: { instanceId: "django__django-1", reason: "gold patch unresolved on 1 of 1 gradings", evidence: "e" }
    };
    const report: SelfcheckReport = {
      schemaVersion: 1, createdAt: "2026-09-25T00:00:00.000Z", split: "dev", repeat: 1, runPrefix: "selfcheck-x", imageSource: "epoch",
      datasetRevision: "rev", dataFileSha256: "sha", swebenchVersion: "5.0.2",
      summary: { total: 2, pass: 1, fail: 1, error: 0 }, instances: [passing, failing]
    };
    const markdown = renderSelfcheckMarkdown(report);
    expect(markdown).toContain("- Split: dev; gold gradings per instance: 1; run: selfcheck-x; images: epoch\n");
    expect(markdown).toContain("| django__django-11790 | 1/1 | unresolved | exit 1, 12.3s | exit 0, 11.9s | pass |");
    expect(markdown).toContain("| django__django-1 | 0/1 | unresolved | exit 1, 12.3s | exit 0, 11.9s | fail |");
    expect(markdown).toContain("- Result: 1 pass, 1 fail, 0 error, of 2");
    expect(markdown).toContain("- django__django-1 (failure): gold patch unresolved on 1 of 1 gradings");
    expect(markdown).toMatch(/## Suggested exclusions\n\n- django__django-1: gold patch unresolved on 1 of 1 gradings\n/);
  });
});
