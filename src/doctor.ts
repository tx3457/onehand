import { spawnSync } from "node:child_process";

export type DoctorStatus = "ok" | "missing" | "failed";

export interface DoctorCheck {
  name: string;
  status: DoctorStatus;
  required: boolean;
  detail?: string;
}

export interface DoctorResult {
  checks: DoctorCheck[];
  ok: boolean;
}

export interface DoctorProbeResult {
  status: number | null;
  error?: Error & { code?: string };
}

export type DoctorProbe = (command: string, args: readonly string[]) => DoctorProbeResult;

export interface DoctorOptions {
  provider?: "openai" | "deepseek";
  env?: NodeJS.ProcessEnv;
  probe?: DoctorProbe;
}

/** Runs fixed, local readiness probes and returns checks suitable for CLI rendering. */
export function runDoctor(options: DoctorOptions = {}): DoctorResult {
  const probe = options.probe ?? defaultProbe;
  const checks: DoctorCheck[] = [
    executableCheck("git", ["--version"], true, probe),
    withRgFallback(executableCheck("rg", ["--version"], false, probe)),
    { name: "node", status: "ok", required: true, detail: process.version }
  ];

  if (options.provider) {
    const keyName = options.provider === "deepseek" ? "DEEPSEEK_API_KEY" : "OPENAI_API_KEY";
    const present = Boolean((options.env ?? process.env)[keyName]?.trim());
    checks.push({ name: keyName, status: present ? "ok" : "missing", required: true });
  }

  return {
    checks,
    ok: checks.every((check) => !check.required || check.status === "ok")
  };
}

function defaultProbe(command: string, args: readonly string[]): DoctorProbeResult {
  const result = spawnSync(command, [...args], {
    encoding: "utf8",
    shell: false,
    timeout: 10_000
  });
  return { status: result.status, error: result.error };
}

function executableCheck(
  name: string,
  args: readonly string[],
  required: boolean,
  probe: DoctorProbe
): DoctorCheck {
  let result: DoctorProbeResult;
  try {
    result = probe(name, args);
  } catch {
    return { name, status: "failed", required, detail: "probe error" };
  }
  if (result.error?.code === "ENOENT") return { name, status: "missing", required };
  if (result.error) return { name, status: "failed", required, detail: "probe error" };
  if (result.status === 0) return { name, status: "ok", required };
  if (result.status === null) return { name, status: "failed", required, detail: "no exit status" };
  return { name, status: "failed", required, detail: `exit ${result.status}` };
}

function withRgFallback(check: DoctorCheck): DoctorCheck {
  return {
    ...check,
    detail: check.status === "missing"
      ? "optional; Node fallback will be used"
      : "optional; Node fallback is available"
  };
}
