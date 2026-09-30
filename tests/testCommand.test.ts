import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { detectTestCommand, resolveTestCommand } from "../src/tools/testCommand.js";

describe("detectTestCommand", () => {
  let repo: string;

  beforeEach(async () => {
    repo = await mkdtemp(path.join(tmpdir(), "onehand-test-command-"));
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  test.each([
    ["npm", undefined, ["package-lock.json"], "npm test"],
    ["pnpm metadata", "pnpm@9.15.0", ["package-lock.json"], "pnpm test"],
    ["pnpm lock", undefined, ["pnpm-lock.yaml"], "pnpm test"],
    ["yarn", "yarn@4.6.0", [], "yarn test"],
    ["bun", undefined, ["bun.lock"], "bun run test"]
  ])("uses the %s package runner only when scripts.test exists", async (_label, packageManager, lockfiles, expected) => {
    await writeFile(path.join(repo, "package.json"), JSON.stringify({
      ...(packageManager ? { packageManager } : {}),
      scripts: { test: "vitest run" }
    }));
    await Promise.all(lockfiles.map((file) => writeFile(path.join(repo, file), "")));

    expect(await detectTestCommand(repo)).toBe(expected);
  });

  test("does not let package.json without a test script mask a Python test configuration", async () => {
    await writeFile(path.join(repo, "package.json"), JSON.stringify({ scripts: { build: "tsc" } }));
    await writeFile(path.join(repo, "pyproject.toml"), "[tool.pytest.ini_options]\naddopts = '-q'\n");

    expect(await detectTestCommand(repo)).toBe("pytest");
  });

  test.each([
    ["malformed package JSON", "{", ["pnpm-lock.yaml"]],
    ["malformed packageManager", JSON.stringify({ packageManager: "pnpm", scripts: { test: "vitest" } }), []],
    ["unsupported packageManager", JSON.stringify({ packageManager: "other@1.0.0", scripts: { test: "vitest" } }), []],
    ["conflicting lockfiles", JSON.stringify({ scripts: { test: "vitest" } }), ["pnpm-lock.yaml", "yarn.lock"]],
    ["empty test script", JSON.stringify({ scripts: { test: "  " } }), ["pnpm-lock.yaml"]]
  ])("returns null for %s", async (_label, packageJson, lockfiles) => {
    await writeFile(path.join(repo, "package.json"), packageJson);
    await Promise.all(lockfiles.map((file) => writeFile(path.join(repo, file), "")));

    expect(await detectTestCommand(repo)).toBeNull();
  });

  test("does not infer pytest from an unrelated pyproject", async () => {
    await writeFile(path.join(repo, "pyproject.toml"), "[project]\nname = 'example'\n");

    expect(await detectTestCommand(repo)).toBeNull();
  });

  test("does not read a package manifest through a symlink outside the repository", async () => {
    const external = path.join(path.dirname(repo), `${path.basename(repo)}-outside.json`);
    await writeFile(external, JSON.stringify({ scripts: { test: "vitest" } }));
    await symlink(external, path.join(repo, "package.json"));
    try {
      expect(await detectTestCommand(repo)).toBeNull();
    } finally {
      await rm(external, { force: true });
    }
  });

  test.each([
    ["pytest.ini", "[pytest]\n", "pytest"],
    ["Cargo.toml", "[package]\nname = 'x'\n", "cargo test"],
    ["go.mod", "module example.com/x\n", "go test ./..."]
  ])("detects %s", async (file, content, expected) => {
    await writeFile(path.join(repo, file), content);

    expect(await detectTestCommand(repo)).toBe(expected);
  });

  test("returns an actionable selected result while preserving the command-only wrapper", async () => {
    await writeFile(path.join(repo, "package.json"), JSON.stringify({
      packageManager: "pnpm@9.15.0",
      scripts: { test: "vitest run" }
    }));

    expect(await resolveTestCommand(repo)).toEqual({
      command: "pnpm test",
      status: "selected",
      detail: "Selected pnpm test from package.json packageManager metadata."
    });
    expect(await detectTestCommand(repo)).toBe("pnpm test");
  });

  test("reports conflicting lockfile families as ambiguous", async () => {
    await writeFile(path.join(repo, "package.json"), JSON.stringify({ scripts: { test: "vitest run" } }));
    await writeFile(path.join(repo, "pnpm-lock.yaml"), "");
    await writeFile(path.join(repo, "yarn.lock"), "");

    const result = await resolveTestCommand(repo);

    expect(result).toMatchObject({ command: null, status: "ambiguous" });
    expect(result.detail).toMatch(/pnpm.*yarn.*packageManager.*--test/i);
  });

  test.each([
    ["malformed JSON", "{", /package\.json.*valid JSON.*--test/i],
    ["malformed packageManager", JSON.stringify({ packageManager: "pnpm", scripts: { test: "vitest" } }), /packageManager.*name@version.*--test/i],
    ["unsupported packageManager", JSON.stringify({ packageManager: "other@1.0.0", scripts: { test: "vitest" } }), /packageManager.*supported.*--test/i]
  ])("reports %s as invalid metadata", async (_label, packageJson, detail) => {
    await writeFile(path.join(repo, "package.json"), packageJson);

    const result = await resolveTestCommand(repo);

    expect(result).toMatchObject({ command: null, status: "invalid" });
    expect(result.detail).toMatch(detail);
  });

  test("reports an absent scripts.test as missing when no other framework is configured", async () => {
    await writeFile(path.join(repo, "package.json"), JSON.stringify({ scripts: { build: "tsc" } }));

    expect(await resolveTestCommand(repo)).toEqual({
      command: null,
      status: "missing",
      detail: "package.json has no non-empty scripts.test and no other supported test configuration was detected; pass --test <command>."
    });
  });

  test("reports a repository without a supported test configuration as missing", async () => {
    await writeFile(path.join(repo, "pyproject.toml"), "[project]\nname = 'example'\n");

    expect(await resolveTestCommand(repo)).toEqual({
      command: null,
      status: "missing",
      detail: "No supported test configuration was detected; pass --test <command>."
    });
  });

  test("reports an unsafe package manifest symlink without exposing its target", async () => {
    const external = path.join(path.dirname(repo), `${path.basename(repo)}-secret-package.json`);
    await writeFile(external, JSON.stringify({ scripts: { test: "secret command" } }));
    await symlink(external, path.join(repo, "package.json"));
    try {
      const result = await resolveTestCommand(repo);
      expect(result).toMatchObject({ command: null, status: "invalid" });
      expect(result.detail).toMatch(/package\.json.*safely.*--test/i);
      expect(result.detail).not.toContain(path.basename(external));
      expect(result.detail).not.toContain("secret command");
    } finally {
      await rm(external, { force: true });
    }
  });

  test("does not read a package manifest symlinked to a protected file inside the repository", async () => {
    const secret = "internal-secret-command";
    await writeFile(path.join(repo, ".env"), JSON.stringify({ scripts: { test: secret } }));
    await symlink(".env", path.join(repo, "package.json"));

    const result = await resolveTestCommand(repo);

    expect(result).toMatchObject({ command: null, status: "invalid" });
    expect(result.detail).toMatch(/package\.json.*safely.*--test/i);
    expect(result.detail).not.toContain(secret);
    expect(await detectTestCommand(repo)).toBeNull();
  });

  test("rejects an unsafe lockfile symlink instead of silently falling back to npm", async () => {
    const external = path.join(path.dirname(repo), `${path.basename(repo)}-secret-lock.yaml`);
    await writeFile(path.join(repo, "package.json"), JSON.stringify({ scripts: { test: "vitest" } }));
    await writeFile(external, "secret lock content");
    await symlink(external, path.join(repo, "pnpm-lock.yaml"));
    try {
      const result = await resolveTestCommand(repo);
      expect(result).toMatchObject({ command: null, status: "invalid" });
      expect(result.detail).toMatch(/lockfile.*safely.*--test/i);
      expect(result.detail).not.toContain(path.basename(external));
      expect(result.detail).not.toContain("secret lock content");
    } finally {
      await rm(external, { force: true });
    }
  });
});
