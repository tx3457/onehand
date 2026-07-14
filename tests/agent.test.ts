import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runAgent, ResponsesClient } from "../src/agent/runner.js";
import { cleanupTempDir, git, initGitRepo, makeTempDir } from "./helpers.js";

describe("agent runner", () => {
  let repo: string;

  beforeEach(async () => {
    repo = await makeTempDir();
    await initGitRepo(repo);
  });

  afterEach(async () => {
    await cleanupTempDir(repo);
  });

  it("handles a read -> edit -> test -> report tool-call sequence", async () => {
    await mkdir(path.join(repo, "src"));
    await writeFile(path.join(repo, "src", "answer.cjs"), "exports.answer = () => 41;\n");
    await writeFile(
      path.join(repo, "test.cjs"),
      "const assert = require('node:assert/strict'); const { answer } = require('./src/answer.cjs'); assert.equal(answer(), 42);\n"
    );
    await git(["add", "."], repo);
    await git(["commit", "-m", "initial"], repo);

    const client = fakeClient([
      functionCall("read_file", { path: "src/answer.cjs" }, "call_1"),
      functionCall(
        "replace_text",
        {
          path: "src/answer.cjs",
          oldText: "exports.answer = () => 41;",
          newText: "exports.answer = () => 42;"
        },
        "call_2"
      ),
      functionCall("run_tests", {}, "call_3"),
      message("Fixed the failing test and verified it passes.")
    ]);

    const report = await runAgent({
      task: "fix the failing test",
      repoPath: repo,
      testCommand: "node test.cjs",
      client,
      maxSteps: 10,
      timeoutSec: 10
    });

    expect(await readFile(path.join(repo, "src", "answer.cjs"), "utf8")).toContain("42");
    expect(report.status).toBe("success");
    expect(report.changedFiles).toEqual(["src/answer.cjs"]);
    expect(report.tests).toEqual([{ command: "node test.cjs", passed: true, exitCode: 0 }]);
    expect(report.diff).toContain("+exports.answer = () => 42;");
    expect(client.responses.create).toHaveBeenCalledTimes(4);
  });

  it("continues after a failed test and fixes the code", async () => {
    await writeFile(path.join(repo, "answer.cjs"), "exports.answer = () => 40;\n");
    await writeFile(
      path.join(repo, "test.cjs"),
      "const assert = require('node:assert/strict'); const { answer } = require('./answer.cjs'); assert.equal(answer(), 42);\n"
    );
    await git(["add", "."], repo);
    await git(["commit", "-m", "initial"], repo);

    const client = fakeClient([
      functionCall("read_file", { path: "answer.cjs" }, "call_1"),
      functionCall(
        "replace_text",
        {
          path: "answer.cjs",
          oldText: "exports.answer = () => 40;",
          newText: "exports.answer = () => 41;"
        },
        "call_2"
      ),
      functionCall("run_tests", {}, "call_3"),
      functionCall("read_file", { path: "answer.cjs" }, "call_4"),
      functionCall(
        "replace_text",
        {
          path: "answer.cjs",
          oldText: "exports.answer = () => 41;",
          newText: "exports.answer = () => 42;"
        },
        "call_5"
      ),
      functionCall("run_tests", {}, "call_6"),
      message("The second test run passed after correcting the value.")
    ]);

    const report = await runAgent({
      task: "fix the failing test",
      repoPath: repo,
      testCommand: "node test.cjs",
      client,
      maxSteps: 10,
      timeoutSec: 10
    });

    expect(report.status).toBe("success");
    expect(report.tests).toEqual([
      { command: "node test.cjs", passed: false, exitCode: 1 },
      { command: "node test.cjs", passed: true, exitCode: 0 }
    ]);
    expect(await readFile(path.join(repo, "answer.cjs"), "utf8")).toContain("42");
  });
});

function fakeClient(items: Array<Record<string, unknown>>): ResponsesClient {
  return {
    responses: {
      create: vi.fn(async () => {
        const item = items.shift();
        if (!item) return { output: [], output_text: "done" };
        return {
          output: [item],
          output_text: item.type === "message" ? "done" : ""
        };
      })
    }
  };
}

function functionCall(name: string, args: Record<string, unknown>, callId: string) {
  return {
    type: "function_call",
    name,
    arguments: JSON.stringify(args),
    call_id: callId
  };
}

function message(text: string) {
  return {
    type: "message",
    content: [{ type: "output_text", text }]
  };
}
