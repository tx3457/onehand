import { mkdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupTempDir, makeTempDir } from "./helpers.js";
import {
  PermissionEngine,
  classifyToolRisk,
  loadPermissionConfig
} from "../src/policy/permissions.js";
import { TOOL_DEFINITIONS } from "../src/tools/registry.js";

const command = (program: string, args: string[] = []) => ({
  name: "run_command",
  args: { program, args },
  risk: classifyToolRisk("run_command", { program, args })
});

describe("permission policy", () => {
  const dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(dirs.splice(0).map(cleanupTempDir));
  });

  it("classifies tools and recognizes only safe inspection commands as reads", () => {
    expect(classifyToolRisk("read_file", { path: "src/x.ts" })).toBe("read");
    expect(classifyToolRisk("search_code", { query: "TODO" })).toBe("read");
    expect(classifyToolRisk("set_plan", { steps: [] })).toBe("plan");
    expect(classifyToolRisk("write_file", { path: "x", content: "" })).toBe("write");
    expect(classifyToolRisk("run_tests", {})).toBe("exec");
    expect(classifyToolRisk("run_command", { program: "rg", args: ["TODO", "src"] })).toBe("read");
    expect(classifyToolRisk("run_command", { program: "node", args: ["script.js"] })).toBe("exec");
    expect(classifyToolRisk("run_command", { program: "sed", args: ["-i", "s/a/b/", "x"] })).toBe("exec");
  });

  it("classifies every registered tool", () => {
    const risks = Object.fromEntries(TOOL_DEFINITIONS.map(({ name }) => [name, classifyToolRisk(name, {})]));
    expect(risks).toEqual({
      set_plan: "plan",
      update_plan: "plan",
      finish_task: "plan",
      list_files: "read",
      search_code: "read",
      read_file: "read",
      write_file: "write",
      replace_text: "write",
      run_command: "exec",
      run_tests: "exec",
      git_status: "read",
      git_diff: "read"
    });
  });

  it("uses mode defaults", () => {
    const write = { name: "write_file", args: {}, risk: "write" as const };
    const read = { name: "read_file", args: {}, risk: "read" as const };

    expect(new PermissionEngine({ mode: "ask" }).resolve(write)).toEqual({ decision: "deny", source: "mode" });
    expect(new PermissionEngine({ mode: "edit" }).resolve(write)).toEqual({ decision: "ask", source: "mode" });
    expect(new PermissionEngine({ mode: "auto" }).resolve(write)).toEqual({ decision: "allow", source: "mode" });
    expect(new PermissionEngine({ mode: "ask" }).resolve(read)).toEqual({ decision: "allow", source: "mode" });
  });

  it("applies deny globally and otherwise gives earlier sources priority", () => {
    const request = command("npm", ["test", "--", "unit"]);
    const denied = new PermissionEngine({
      mode: "auto",
      cliRules: { allow: ["run_command:npm test"] },
      projectRules: { deny: ["run_command:npm"] }
    });
    expect(denied.resolve(request)).toEqual({ decision: "deny", source: "project" });

    const allowed = new PermissionEngine({
      mode: "ask",
      cliRules: { allow: ["run_command:npm test"] },
      projectRules: { allow: ["run_command:npm"] },
      userRules: { allow: ["run_command"] }
    });
    expect(allowed.resolve(request)).toEqual({ decision: "allow", source: "cli" });
    expect(allowed.resolve(command("npm", ["run", "test"]))).toEqual({ decision: "allow", source: "project" });
    expect(allowed.resolve(command("node", ["x.js"]))).toEqual({ decision: "allow", source: "user" });
  });

  it("matches command argument prefixes by tokens rather than string prefixes", () => {
    const engine = new PermissionEngine({ mode: "ask", cliRules: { allow: ["run_command:npm test"] } });
    expect(engine.resolve(command("npm", ["test", "--", "unit"])).decision).toBe("allow");
    expect(engine.resolve(command("npm", ["testing"])).decision).toBe("deny");
    expect(engine.resolve(command("pnpm", ["test"])).decision).toBe("deny");
  });

  it("keeps session approvals across mode changes without overriding denies", () => {
    const request = command("npm", ["test"]);
    const engine = new PermissionEngine({ mode: "edit", projectRules: { deny: ["run_command:git"] } });
    engine.allowForSession(request);
    expect(engine.resolve(command("npm", ["run", "lint"]))).toEqual({ decision: "allow", source: "session" });
    engine.setMode("ask");
    expect(engine.mode).toBe("ask");
    expect(engine.resolve(command("npm", ["run", "lint"]))).toEqual({ decision: "allow", source: "session" });

    engine.allowForSession(command("git", ["status"]));
    expect(engine.resolve(command("git", ["status"]))).toEqual({ decision: "deny", source: "project" });
  });

  it("loads project and user rules and validates malformed configuration", async () => {
    const repo = await makeTempDir();
    const home = await makeTempDir();
    dirs.push(repo, home);
    await mkdir(path.join(repo, ".onehand"));
    await mkdir(path.join(home, ".onehand"));
    await writeFile(path.join(repo, ".onehand", "config.json"), JSON.stringify({ permissions: { allow: ["write_file"] } }));
    await writeFile(path.join(home, ".onehand", "config.json"), JSON.stringify({ permissions: { deny: ["run_tests"] } }));
    await expect(loadPermissionConfig(repo, home)).resolves.toEqual({
      project: { allow: ["write_file"] },
      user: { deny: ["run_tests"] }
    });

    await writeFile(path.join(repo, ".onehand", "config.json"), "{");
    await expect(loadPermissionConfig(repo, home)).rejects.toThrow(/project permission config.*invalid JSON/i);
    await writeFile(path.join(repo, ".onehand", "config.json"), JSON.stringify({ permissions: { allow: "write_file" } }));
    await expect(loadPermissionConfig(repo, home)).rejects.toThrow(/project permission config.*allow.*array/i);
    await writeFile(path.join(repo, ".onehand", "config.json"), JSON.stringify({ permissions: { allow: ["   "] } }));
    await expect(loadPermissionConfig(repo, home)).rejects.toThrow(/project permission config.*pattern/i);
    await writeFile(path.join(repo, ".onehand", "config.json"), JSON.stringify({ permissions: { prompt: ["write_file"] } }));
    await expect(loadPermissionConfig(repo, home)).rejects.toThrow(/project permission config.*unknown.*prompt/i);
  });

  it("refuses symlinked config files and config directories", async () => {
    const repo = await makeTempDir();
    const outside = await makeTempDir();
    dirs.push(repo, outside);
    await writeFile(path.join(outside, "secret.json"), JSON.stringify({ permissions: { allow: ["run_command"] } }));
    await mkdir(path.join(repo, ".onehand"));
    await symlink(path.join(outside, "secret.json"), path.join(repo, ".onehand", "config.json"));
    await expect(loadPermissionConfig(repo, outside)).rejects.toThrow(/symbolic link/i);

    const repo2 = await makeTempDir();
    dirs.push(repo2);
    await symlink(outside, path.join(repo2, ".onehand"));
    await expect(loadPermissionConfig(repo2, path.join(outside, "missing-home"))).rejects.toThrow(/symbolic link/i);
  });
});
