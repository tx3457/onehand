import { describe, expect, it } from "vitest";
import { commandPolicyError } from "../src/tools/command.js";

describe("sandbox command policy", () => {
  it.each(["log", "show", "blame", "grep", "diff", "status", "ls-files", "rev-parse", "cat-file"])(
    "allows read-only git %s",
    (subcommand) => {
      expect(commandPolicyError("git", [subcommand], false, true)).toBeNull();
    }
  );

  it("keeps the baseline git policy unchanged", () => {
    expect(commandPolicyError("git", ["branch"])).toBeNull();
    expect(commandPolicyError("git", ["blame"])).toContain("disabled");
    expect(commandPolicyError("git", ["cat-file"])).toContain("disabled");
  });

  it.each(["branch", "checkout", "commit", "push", "fetch", "clone", "remote"])(
    "denies git %s in the sandbox",
    (subcommand) => {
      expect(commandPolicyError("git", [subcommand], false, true)).toContain("disabled");
    }
  );

  it.each([
    ["diff", "--output=patch.txt"],
    ["diff", "--output", "patch.txt"],
    ["diff", "--ext-diff"],
    ["show", "--textconv"],
    ["grep", "--open-files-in-pager=less"],
    ["grep", "-Oless"],
    ["cat-file", "--filters"],
    ["cat-file", "--textconv"]
  ])("denies unsafe git option for git %s", (...args) => {
    expect(commandPolicyError("git", args, false, true)).toContain("option is disabled");
  });

  it.each([
    ["npm", "ci"],
    ["npm", "exec", "eslint"],
    ["npm", "x", "eslint"],
    ["pnpm", "dlx", "eslint"],
    ["yarn", "dlx", "eslint"],
    ["bun", "x", "eslint"],
    ["python", "-m", "pip", "install", "example"],
    ["python3", "-m", "pip", "download", "example"],
    ["python3", "-m", "pip", "uninstall", "example"],
    ["uv", "run", "--with", "requests", "script.py"],
    ["uv", "run", "--with=requests", "script.py"],
    ["npm", "--yes", "exec", "eslint"],
    ["npm", "--prefix", "workspace", "install"],
    ["pnpm", "--silent", "dlx", "eslint"],
    ["python3", "-I", "-m", "pip", "install", "example"],
    ["uv", "--offline", "run", "--with=requests", "script.py"]
  ])("denies sandbox package mutation through %s", (program, ...args) => {
    expect(commandPolicyError(program, args, false, true)).toContain("mutation is disabled");
  });

  it.each([
    ["npm", "test"],
    ["npm", "run", "lint"],
    ["python3", "-I", "script.py"]
  ])("keeps ordinary sandbox execution through %s", (program, ...args) => {
    expect(commandPolicyError(program, args, false, true)).toBeNull();
  });

  it("does not change baseline handling of alternate package commands", () => {
    expect(commandPolicyError("npm", ["ci"])).toBeNull();
    expect(commandPolicyError("python", ["-m", "pip", "install", "example"])).toBeNull();
  });
});
