import { mkdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadProjectInstructions } from "../src/agent/projectMemory.js";
import { cleanupTempDir, makeTempDir } from "./helpers.js";

describe("project instructions", () => {
  const dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(dirs.splice(0).map(cleanupTempDir));
  });

  it("prefers AGENTS.md and falls back to ONEHAND.md only when absent", async () => {
    const repo = await makeTempDir();
    dirs.push(repo);
    await writeFile(path.join(repo, "ONEHAND.md"), "fallback\n");
    await expect(loadProjectInstructions(repo)).resolves.toBe("fallback\n");
    await writeFile(path.join(repo, "AGENTS.md"), "primary\n");
    await expect(loadProjectInstructions(repo)).resolves.toBe("primary\n");
  });

  it("returns undefined when neither instruction file exists", async () => {
    const repo = await makeTempDir();
    dirs.push(repo);
    await expect(loadProjectInstructions(repo)).resolves.toBeUndefined();
  });

  it("caps content by UTF-8 bytes and appends a truncation note", async () => {
    const repo = await makeTempDir();
    dirs.push(repo);
    await writeFile(path.join(repo, "AGENTS.md"), `${"界".repeat(3_000)}tail`);
    const result = await loadProjectInstructions(repo);
    expect(result).toContain("[onehand: project instructions truncated at 8 KB]");
    expect(Buffer.byteLength(result!, "utf8")).toBeLessThan(8_300);
    expect(result).not.toContain("tail");
    expect(result).not.toContain("�");
  });

  it("refuses instruction symlinks that resolve outside the repository", async () => {
    const repo = await makeTempDir();
    const outside = await makeTempDir();
    dirs.push(repo, outside);
    await writeFile(path.join(outside, "instructions.md"), "secret\n");
    await symlink(path.join(outside, "instructions.md"), path.join(repo, "AGENTS.md"));
    await expect(loadProjectInstructions(repo)).rejects.toThrow(/outside repository root/i);
  });

  it("does not fall back when AGENTS.md exists but cannot be safely read", async () => {
    const repo = await makeTempDir();
    const outside = await makeTempDir();
    dirs.push(repo, outside);
    await writeFile(path.join(outside, "instructions.md"), "secret\n");
    await writeFile(path.join(repo, "ONEHAND.md"), "fallback\n");
    await symlink(path.join(outside, "instructions.md"), path.join(repo, "AGENTS.md"));
    await expect(loadProjectInstructions(repo)).rejects.toThrow(/outside repository root/i);
  });

  it("refuses instruction symlinks to protected files inside the repository", async () => {
    const repo = await makeTempDir();
    dirs.push(repo);
    await writeFile(path.join(repo, ".env"), "DO_NOT_READ=this\n");
    await symlink(path.join(repo, ".env"), path.join(repo, "AGENTS.md"));
    await expect(loadProjectInstructions(repo)).rejects.toThrow(/protected repository path/i);
  });

  it("reads only root-level instruction files", async () => {
    const repo = await makeTempDir();
    dirs.push(repo);
    await mkdir(path.join(repo, "nested"));
    await writeFile(path.join(repo, "nested", "AGENTS.md"), "nested\n");
    await expect(loadProjectInstructions(repo)).resolves.toBeUndefined();
  });
});
