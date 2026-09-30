import { describe, expect, test } from "vitest";
import { runDoctor, type DoctorProbe } from "../src/doctor.js";

function probeWith(outcomes: Record<string, { status: number | null; errorCode?: string }>): DoctorProbe {
  return (command, args) => {
    const outcome = outcomes[`${command} ${args.join(" ")}`];
    if (!outcome) throw new Error(`Unexpected probe: ${command} ${args.join(" ")}`);
    return {
      status: outcome.status,
      error: outcome.errorCode ? Object.assign(new Error(outcome.errorCode), { code: outcome.errorCode }) : undefined
    };
  };
}

describe("runDoctor", () => {
  test("reports required Git, optional rg, and the current Node runtime", () => {
    const result = runDoctor({
      env: {},
      probe: probeWith({
        "git --version": { status: 0 },
        "rg --version": { status: 0 }
      })
    });

    expect(result).toEqual({
      checks: [
        { name: "git", status: "ok", required: true },
        { name: "rg", status: "ok", required: false, detail: "optional; Node fallback is available" },
        { name: "node", status: "ok", required: true, detail: process.version }
      ],
      ok: true
    });
  });

  test("distinguishes a missing required executable from a failed probe", () => {
    const missing = runDoctor({
      probe: probeWith({
        "git --version": { status: null, errorCode: "ENOENT" },
        "rg --version": { status: 0 }
      })
    });
    const failed = runDoctor({
      probe: probeWith({
        "git --version": { status: 2 },
        "rg --version": { status: 0 }
      })
    });

    expect(missing.checks[0]).toEqual({ name: "git", status: "missing", required: true });
    expect(missing.ok).toBe(false);
    expect(failed.checks[0]).toEqual({ name: "git", status: "failed", required: true, detail: "exit 2" });
    expect(failed.ok).toBe(false);
  });

  test("keeps a missing optional rg probe non-fatal and explains the fallback", () => {
    const result = runDoctor({
      probe: probeWith({
        "git --version": { status: 0 },
        "rg --version": { status: null, errorCode: "ENOENT" }
      })
    });

    expect(result.checks[1]).toEqual({
      name: "rg",
      status: "missing",
      required: false,
      detail: "optional; Node fallback will be used"
    });
    expect(result.ok).toBe(true);
  });

  test.each([
    ["openai", "OPENAI_API_KEY"],
    ["deepseek", "DEEPSEEK_API_KEY"]
  ] as const)("checks only the selected %s provider key without exposing its value", (provider, keyName) => {
    const secret = "do-not-print-this-secret";
    const result = runDoctor({
      provider,
      env: { [keyName]: secret },
      probe: probeWith({
        "git --version": { status: 0 },
        "rg --version": { status: 0 }
      })
    });

    expect(result.checks.at(-1)).toEqual({ name: keyName, status: "ok", required: true });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(result.checks.some((check) => check.name.endsWith("API_KEY") && check.name !== keyName)).toBe(false);
    expect(result.ok).toBe(true);
  });

  test("a missing selected provider key makes the doctor result unhealthy", () => {
    const result = runDoctor({
      provider: "openai",
      env: {},
      probe: probeWith({
        "git --version": { status: 0 },
        "rg --version": { status: 0 }
      })
    });

    expect(result.checks.at(-1)).toEqual({ name: "OPENAI_API_KEY", status: "missing", required: true });
    expect(result.ok).toBe(false);
  });
});
