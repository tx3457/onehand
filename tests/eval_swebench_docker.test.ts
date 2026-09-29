import { execFileSync } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createToolRegistry } from "../src/tools/registry.js";
import { buildDockerRunArgs, docker, OPAQUE_NAME, opaqueName, startContainer, SwebenchContainer } from "../eval/swebench/container.js";
import { imageFor, loadRecords, SwebenchRecord, testCommandFor } from "../eval/swebench/dataset.js";
import { extractPatch, git } from "../eval/swebench/patch.js";
import { prepareWorkspace, SwebenchWorkspace } from "../eval/swebench/workspace.js";

// Opt-in: ONEHAND_SWEBENCH_IT=1 and the django-11790 image already pulled (tests never pull). The official
// image is the default; ONEHAND_SWEBENCH_IMAGE_SOURCE=epoch runs the same tests on Epoch's image.
const INSTANCE = "django__django-11790";
const SOURCE = process.env.ONEHAND_SWEBENCH_IMAGE_SOURCE ?? "official";
if (SOURCE !== "epoch" && SOURCE !== "official") throw new Error(`ONEHAND_SWEBENCH_IMAGE_SOURCE must be epoch or official, got ${SOURCE}`);
const IMAGE = imageFor({ instance_id: INSTANCE, image: "swebench/sweb.eval.x86_64.django_1776_django-11790:latest" }, SOURCE);
const enabled = process.env.ONEHAND_SWEBENCH_IT === "1" && imagePresent();

function imagePresent(): boolean {
  try {
    execFileSync("docker", ["image", "inspect", IMAGE], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

describe("SWE-bench container arguments", () => {
  it("starts offline, without capabilities or privilege gain, PID-limited, with an init process and a read-only .git", () => {
    expect(buildDockerRunArgs({ name: "c1", image: "img:latest", repo: "/host/repo", user: "1000:1000", limits: { cpus: 2, memory: "4g" } }))
      .toEqual([
        "run", "-d", "--init", "--name", "c1", "--label", "onehand=1", "--network", "none", "--cap-drop=ALL",
        "--security-opt=no-new-privileges", "--user", "1000:1000", "--pids-limit", "1024", "-e", "HOME=/tmp", "--cpus", "2",
        "--memory", "4g", "-v", "/host/repo:/testbed", "-v", "/host/repo/.git:/testbed/.git:ro",
        "--entrypoint", "sleep", "img:latest", "infinity"
      ]);
  });

  it("names containers and workspaces opaquely: onehand- and 16 random hex digits", () => {
    const names = Array.from({ length: 50 }, opaqueName);
    for (const name of names) expect(name).toMatch(OPAQUE_NAME);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe.skipIf(!enabled)(`SWE-bench Docker integration (${INSTANCE}, ${SOURCE} image)`, () => {
  let record: SwebenchRecord;
  let workspace: SwebenchWorkspace | undefined;
  let container: SwebenchContainer | undefined;

  beforeAll(async () => {
    record = (await loadRecords()).records.get(INSTANCE)!;
  }, 60_000);

  afterAll(async () => {
    await container?.stop();
    await workspace?.cleanup();
  }, 120_000);

  const registry = () => createToolRegistry({
    repoRoot: workspace!.repo,
    displayRoot: "/testbed",
    executor: container!.executor,
    testCommand: testCommandFor(record).base,
    trustedTestCommand: true,
    allowTargetedVerification: true,
    timeoutSec: 600,
    allowDestructive: false
  });

  it("prepares a workspace whose history is one commit with no tags", async () => {
    await expect(prepareWorkspace(record, `onehand-${INSTANCE}`, SOURCE)).rejects.toThrow(/must be opaque/);
    const name = opaqueName();
    workspace = await prepareWorkspace(record, name, SOURCE);
    expect(workspace.root).toBe(path.join(tmpdir(), name));
    expect(await git(workspace.repo, ["log", "--all", "--format=%H"])).toBe(`${workspace.baseCommit}\n`);
    expect(await git(workspace.repo, ["tag"])).toBe("");
    expect(await git(workspace.repo, ["status", "--porcelain"])).toBe("");
    expect(await readFile(path.join(workspace.repo, ".git", "info", "exclude"), "utf8")).toBe(".scratch/\n");
    expect(await readFile(path.join(workspace.repo, "django", "contrib", "auth", "forms.py"), "utf8")).toContain("class AuthenticationForm");
  }, 600_000);

  it("starts an offline, unprivileged container whose editable install is the bind-mounted checkout", async () => {
    container = await startContainer(record, workspace!.repo, path.basename(workspace!.root), SOURCE);
    const [inspect] = JSON.parse(await docker(["inspect", container.name]));
    expect(inspect.Config.Image).toBe(IMAGE);
    expect(inspect.HostConfig.NetworkMode).toBe("none");
    expect(inspect.HostConfig.CapDrop).toEqual(["ALL"]);
    expect(inspect.HostConfig.SecurityOpt).toEqual(["no-new-privileges"]);
    // The bind mount's host path, which the container can see, names neither the instance nor the variant.
    const mounted = await container.executor.run({ program: "cat", args: ["/proc/self/mountinfo"], cwd: workspace!.repo, timeoutSec: 30 });
    expect(mounted.ok && mounted.data.stdout).toContain(path.basename(workspace!.root));
    expect(mounted.ok && mounted.data.stdout).not.toContain(INSTANCE);
    expect(inspect.HostConfig.Init).toBe(true);
    expect(inspect.HostConfig.PidsLimit).toBe(1024);
    expect(inspect.Config.User).toBe(`${process.getuid!()}:${process.getgid!()}`);
    expect(inspect.Config.Labels.onehand).toBe("1");
    const mounts = Object.fromEntries(inspect.Mounts.map((mount: { Destination: string; RW: boolean }) => [mount.Destination, mount.RW]));
    expect(mounts).toMatchObject({ "/testbed": true, "/testbed/.git": false });
    const located = await container.executor.run({
      program: "python", args: ["-I", "-B", "-c", "import django; print(django.__file__)"], cwd: workspace!.repo, timeoutSec: 60
    });
    expect(located.ok && located.data.stdout.trim()).toBe("/testbed/django/__init__.py");
    expect(await container.executor.run({ program: "true", args: [], cwd: "/tmp", timeoutSec: 30 }))
      .toMatchObject({ ok: false, recoverable: false, code: "environment" });
    expect(await container.executor.run({ program: "true", args: [], cwd: path.join(workspace!.repo, "gone"), timeoutSec: 30 }))
      .toEqual({ ok: false, error: "Working directory does not exist in the container: /testbed/gone", recoverable: true });
    const gitWrite = await container.executor.run({ program: "touch", args: [".git/onehand-probe"], cwd: workspace!.repo, timeoutSec: 30 });
    expect(gitWrite.ok && gitWrite.data.exitCode).not.toBe(0);
  }, 300_000);

  it("runs a real Django label through the agent's run_tests without dirtying the checkout", async () => {
    const result = await registry().execute("run_tests", { targets: ["auth_tests.test_forms"] });
    expect(result).toMatchObject({
      ok: true,
      data: { command: `${testCommandFor(record).base} auth_tests.test_forms`, exitCode: 0, passed: true }
    });
    const text = JSON.stringify(result);
    expect(text).toMatch(/Ran \d+ tests/);
    expect(text).not.toContain(workspace!.repo);
    expect(await git(workspace!.repo, ["status", "--porcelain"])).toBe("");
  }, 600_000);

  it("extracts the patch for edits made through /testbed paths, without scratch files", async () => {
    const tools = registry();
    expect(await tools.execute("replace_text", {
      path: "/testbed/django/contrib/auth/forms.py",
      oldText: "class AuthenticationForm(forms.Form):",
      newText: "class AuthenticationForm(forms.Form):\n    # onehand integration probe"
    })).toMatchObject({ ok: true });
    expect(await tools.execute("write_file", { path: "/testbed/.scratch/repro.py", content: "print('probe')\n" })).toMatchObject({ ok: true });
    const extracted = await extractPatch(workspace!.repo, workspace!.baseCommit);
    expect(extracted.files).toEqual(["django/contrib/auth/forms.py"]);
    expect(extracted.patch).toContain("+    # onehand integration probe");
  }, 120_000);

  it("leaves neither its container nor its workspace behind after cleanup", async () => {
    await container!.stop();
    await workspace!.cleanup();
    // Other onehand jobs (e.g. a concurrent self-check) may own containers of their own, so only this test's is checked.
    const names = (await docker(["ps", "-a", "--filter", "label=onehand=1", "--filter", `name=${container!.name}`, "--format", "{{.Names}}"]))
      .split("\n").filter(Boolean);
    expect(names).not.toContain(container!.name);
    await expect(access(workspace!.root)).rejects.toThrow();
  }, 120_000);
});
