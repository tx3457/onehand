import { access, readFile } from "node:fs/promises";
import { resolveSafeRepoPath } from "./pathGuard.js";

const PACKAGE_COMMANDS = {
  npm: "npm test",
  pnpm: "pnpm test",
  yarn: "yarn test",
  bun: "bun run test"
} as const;

type PackageManager = keyof typeof PACKAGE_COMMANDS;

export interface TestCommandResolution {
  command: string | null;
  status: "selected" | "missing" | "ambiguous" | "invalid";
  detail: string;
}

type FileState =
  | { status: "present"; content: string }
  | { status: "missing" }
  | { status: "invalid" };

type PresenceState = "present" | "missing" | "invalid";

const LOCKFILES: Record<PackageManager, readonly string[]> = {
  npm: ["package-lock.json", "npm-shrinkwrap.json"],
  pnpm: ["pnpm-lock.yaml"],
  yarn: ["yarn.lock"],
  bun: ["bun.lock", "bun.lockb"]
};

export async function detectTestCommand(repoRoot: string): Promise<string | null> {
  return (await resolveTestCommand(repoRoot)).command;
}

export async function resolveTestCommand(repoRoot: string): Promise<TestCommandResolution> {
  const packageJson = await readOptionalRepoFile(repoRoot, "package.json");
  if (packageJson.status === "invalid") {
    return invalid("package.json could not be read safely; pass --test <command>.");
  }

  let packageWithoutTest = false;
  if (packageJson.status === "present") {
    const packageCommand = await detectPackageTestCommand(repoRoot, packageJson.content);
    if (packageCommand.status !== "continue") return packageCommand;
    packageWithoutTest = true;
  }

  const pytestIni = await safeFileState(repoRoot, "pytest.ini");
  if (pytestIni === "invalid") return invalid("pytest.ini could not be read safely; pass --test <command>.");
  if (pytestIni === "present") return selected("pytest", "Selected pytest from pytest.ini.");

  const pyproject = await readOptionalRepoFile(repoRoot, "pyproject.toml");
  if (pyproject.status === "invalid") {
    return invalid("pyproject.toml could not be read safely; pass --test <command>.");
  }
  if (pyproject.status === "present" && /^\s*\[tool\.pytest\.ini_options\]\s*(?:#.*)?$/mu.test(pyproject.content)) {
    return selected("pytest", "Selected pytest from pyproject.toml pytest configuration.");
  }

  const cargo = await safeFileState(repoRoot, "Cargo.toml");
  if (cargo === "invalid") return invalid("Cargo.toml could not be read safely; pass --test <command>.");
  if (cargo === "present") return selected("cargo test", "Selected cargo test from Cargo.toml.");

  const goMod = await safeFileState(repoRoot, "go.mod");
  if (goMod === "invalid") return invalid("go.mod could not be read safely; pass --test <command>.");
  if (goMod === "present") return selected("go test ./...", "Selected go test ./... from go.mod.");

  return {
    command: null,
    status: "missing",
    detail: packageWithoutTest
      ? "package.json has no non-empty scripts.test and no other supported test configuration was detected; pass --test <command>."
      : "No supported test configuration was detected; pass --test <command>."
  };
}

async function detectPackageTestCommand(
  repoRoot: string,
  source: string
): Promise<TestCommandResolution | { status: "continue" }> {
  let manifest: unknown;
  try {
    manifest = JSON.parse(source);
  } catch {
    return invalid("package.json is not valid JSON; repair it or pass --test <command>.");
  }
  if (!isRecord(manifest)) {
    return invalid("package.json must contain a JSON object; repair it or pass --test <command>.");
  }

  const scripts = manifest.scripts;
  const testScript = isRecord(scripts) ? scripts.test : undefined;
  if (typeof testScript !== "string" || testScript.trim() === "") {
    return { status: "continue" };
  }

  if (manifest.packageManager !== undefined) {
    const manager = parsePackageManager(manifest.packageManager);
    if (manager === null) {
      const detail = typeof manifest.packageManager === "string" && manifest.packageManager.includes("@")
        ? "package.json packageManager names an unsupported runner; use a supported package manager or pass --test <command>."
        : "package.json packageManager must use name@version syntax; repair it or pass --test <command>.";
      return invalid(detail);
    }
    const command = PACKAGE_COMMANDS[manager];
    return selected(command, `Selected ${command} from package.json packageManager metadata.`);
  }

  const managersWithLocks: PackageManager[] = [];
  for (const manager of Object.keys(LOCKFILES) as PackageManager[]) {
    const state = await anyExists(repoRoot, LOCKFILES[manager]);
    if (state === "invalid") {
      return invalid("A recognized package manager lockfile could not be read safely; pass --test <command>.");
    }
    if (state === "present") managersWithLocks.push(manager);
  }
  if (managersWithLocks.length > 1) {
    return {
      command: null,
      status: "ambiguous",
      detail: `Conflicting package manager lockfiles were detected for ${managersWithLocks.join(" and ")}; set packageManager in package.json or pass --test <command>.`
    };
  }
  const manager = managersWithLocks[0] ?? "npm";
  const command = PACKAGE_COMMANDS[manager];
  return selected(
    command,
    managersWithLocks.length === 1
      ? `Selected ${command} from the ${manager} lockfile.`
      : "Selected npm test because package.json defines scripts.test and no package manager metadata or lockfile selected another runner."
  );
}

function parsePackageManager(value: unknown): PackageManager | null {
  if (typeof value !== "string") return null;
  const match = /^(npm|pnpm|yarn|bun)@\S+$/.exec(value);
  return (match?.[1] as PackageManager | undefined) ?? null;
}

async function anyExists(repoRoot: string, filenames: readonly string[]): Promise<PresenceState> {
  for (const filename of filenames) {
    const state = await safeFileState(repoRoot, filename);
    if (state !== "missing") return state;
  }
  return "missing";
}

async function safeFileState(repoRoot: string, filename: string): Promise<PresenceState> {
  try {
    const pathname = await resolveSafeRepoPath(repoRoot, filename);
    await access(pathname);
    return "present";
  } catch (error) {
    return isMissingError(error) ? "missing" : "invalid";
  }
}

async function readOptionalRepoFile(repoRoot: string, filename: string): Promise<FileState> {
  try {
    const pathname = await resolveSafeRepoPath(repoRoot, filename);
    return { status: "present", content: await readFile(pathname, "utf8") };
  } catch (error) {
    return { status: isMissingError(error) ? "missing" : "invalid" };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissingError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function selected(command: string, detail: string): TestCommandResolution {
  return { command, status: "selected", detail };
}

function invalid(detail: string): TestCommandResolution {
  return { command: null, status: "invalid", detail };
}
