import { access } from "node:fs/promises";
import path from "node:path";

const TEST_COMMAND_CANDIDATES: Array<{ file: string; command: string }> = [
  { file: "package.json", command: "npm test" },
  { file: "pnpm-lock.yaml", command: "pnpm test" },
  { file: "yarn.lock", command: "yarn test" },
  { file: "bun.lockb", command: "bun test" },
  { file: "bun.lock", command: "bun test" },
  { file: "pytest.ini", command: "pytest" },
  { file: "pyproject.toml", command: "pytest" },
  { file: "Cargo.toml", command: "cargo test" },
  { file: "go.mod", command: "go test ./..." }
];

export async function detectTestCommand(repoRoot: string): Promise<string | null> {
  for (const candidate of TEST_COMMAND_CANDIDATES) {
    if (await exists(path.join(repoRoot, candidate.file))) {
      return candidate.command;
    }
  }
  return null;
}

async function exists(pathname: string): Promise<boolean> {
  try {
    await access(pathname);
    return true;
  } catch {
    return false;
  }
}
