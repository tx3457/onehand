import { writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { PROFILES } from "../src/agent/profile.js";
import { runAgent } from "../src/agent/runner.js";
import { emptyTokenUsage, type ModelProvider, type ProviderRequest } from "../src/providers/types.js";
import { cleanupTempDir, initGitRepo, makeTempDir } from "./helpers.js";

let root: string;
beforeEach(async () => { root = await makeTempDir(); await initGitRepo(root); });
afterEach(async () => { await cleanupTempDir(root); });

it("uses profile definitions and compact observations throughout the runner", async () => {
  await writeFile(path.join(root, "a.py"), "first\nsecond\n");
  const observations: string[] = [];
  const requests: ProviderRequest[] = [];
  const provider: ModelProvider = {
    name: "openai", initialHistory: (content) => [{ role: "user", content }],
    async complete(request) {
      requests.push(request);
      return { historyItems: [], toolCalls: [
        { id: "read", name: "read_file", arguments: { path: "a.py", startLine: 2, endLine: 2 } },
        { id: "skip", name: "read_file", arguments: { path: "a.py" } }
      ], message: "", usage: emptyTokenUsage() };
    },
    toolResultItem: (call, output) => { observations.push(output); return { id: call.id, output }; }
  };
  await runAgent({ task: "inspect", repoPath: root, provider, profile: PROFILES.ctx, persistence: false, enforcePlanning: false, maxToolCalls: 1 });
  expect(observations[0]).toBe("a.py (lines 2–2 of 2)\n     2\tsecond");
  expect(observations.slice(1).every((value) => value.startsWith("error: ") && value.includes("not recoverable"))).toBe(true);
  expect(requests[0]!.tools).toContainEqual(expect.objectContaining({
    name: "read_file", parameters: expect.objectContaining({ properties: expect.objectContaining({ startLine: { type: "integer", minimum: 1 } }) })
  }));
});
