import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { realpath } from "node:fs/promises";
import { promisify } from "node:util";
import { DockerExecutor, PathMapper } from "../../src/runtime/executor.js";
import { FatalJobError } from "../core.js";
import { ImageSource, imageFor, importPackageFor, SwebenchRecord, testCommandFor } from "./dataset.js";

const execFileAsync = promisify(execFile);

export const CONTAINER_ROOT = "/testbed";
export const CONDA_ACTIVATION = "source /opt/miniconda3/bin/activate && conda activate testbed";
export const DEFAULT_CONTAINER_LIMITS = { cpus: 2, memory: "4g" };
export const OPAQUE_NAME = /^onehand-[0-9a-f]{16}$/;

export type ContainerLimits = typeof DEFAULT_CONTAINER_LIMITS;

export type SwebenchContainer = {
  name: string;
  executor: DockerExecutor;
  // docker rm -f; idempotent. Call it from a finally block.
  stop(): Promise<void>;
};

// A retryable infrastructure failure (Docker, a missing image, a crashed harness). It is never a
// verdict on the agent's patch.
export class InfraError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "InfraError";
  }
}

export async function docker(args: string[], timeoutMs = 120_000): Promise<string> {
  try {
    const { stdout } = await execFileAsync("docker", args, {
      env: dockerEnvironment(), timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024
    });
    return stdout;
  } catch (error) {
    const detail = String((error as { stderr?: unknown }).stderr ?? "").trim() || (error as Error).message;
    throw new InfraError(`docker ${args[0]} failed: ${detail}`, { cause: error });
  }
}

// The pinned image a run finds under its tag is not the one the evaluation started with. Retrying cannot fix
// that, so it stops the evaluation.
export class ImageMismatchError extends FatalJobError {
  constructor(message: string) {
    super(message);
    this.name = "ImageMismatchError";
  }
}

// A name for a container and its workspace directory that says nothing about the instance or the variant:
// the agent can see the bind mount's host path, and the name must not tell it what it is solving or how.
export function opaqueName(): string {
  return `onehand-${randomBytes(8).toString("hex")}`;
}

// The local image ID behind a tag, or undefined when the image is not present locally.
export async function imageIdOf(image: string): Promise<string | undefined> {
  try {
    return (await docker(["image", "inspect", "--format", "{{.Id}}", image], 60_000)).trim();
  } catch (error) {
    if (/No such image/i.test((error as Error).message)) return undefined;
    throw error;
  }
}

// Images are pulled out of band over a slow link; a run must never trigger a pull.
export async function ensureImage(image: string): Promise<void> {
  if (!(await imageIdOf(image))) {
    throw new InfraError(`Docker image ${image} is not available locally; pull it first (OneHand never pulls images)`);
  }
}

export async function startContainer(
  record: SwebenchRecord,
  hostRepo: string,
  name: string,
  imageSource: ImageSource,
  opts: Partial<ContainerLimits> = {}
): Promise<SwebenchContainer> {
  const limits = { ...DEFAULT_CONTAINER_LIMITS, ...opts };
  const image = imageFor(record, imageSource);
  // The executor maps paths against the same realpath the tool registry resolves the repo to.
  const repo = await realpath(hostRepo);
  const containerName = name.replace(/[^A-Za-z0-9_.-]/g, "-").replace(/^[^A-Za-z0-9]+/, "");
  const user = `${process.getuid!()}:${process.getgid!()}`;
  await ensureImage(image);
  await docker(buildDockerRunArgs({ name: containerName, image, repo, user, limits }));
  const stop = async () => {
    await docker(["rm", "-f", containerName]);
  };
  try {
    const executor = new DockerExecutor({
      container: containerName,
      pathMapper: new PathMapper(repo, CONTAINER_ROOT),
      user,
      // The official eval script's exports (e.g. LANG) apply to every command, as they do there.
      env: { ...testCommandFor(record).env, PYTHONDONTWRITEBYTECODE: "1" },
      activation: CONDA_ACTIVATION
    });
    await assertEditableInstall(record, executor, repo);
    return { name: containerName, executor, stop };
  } catch (error) {
    await stop().catch(() => undefined);
    throw error;
  }
}

// Offline, unprivileged (no capabilities, no privilege gain through setuid), PID-limited, with an init that
// reaps orphaned exec children. .git is read-only, so container commands cannot plant hooks or config that
// host git would then read.
export function buildDockerRunArgs(options: {
  name: string;
  image: string;
  repo: string;
  user: string;
  limits: ContainerLimits;
}): string[] {
  return [
    "run", "-d", "--init", "--name", options.name, "--label", "onehand=1", "--network", "none", "--cap-drop=ALL",
    "--security-opt=no-new-privileges", "--user", options.user,
    "--pids-limit", "1024", "-e", "HOME=/tmp", "--cpus", String(options.limits.cpus), "--memory", options.limits.memory,
    "-v", `${options.repo}:${CONTAINER_ROOT}`, "-v", `${options.repo}/.git:${CONTAINER_ROOT}/.git:ro`,
    "--entrypoint", "sleep", options.image, "infinity"
  ];
}

// With -I, Python puts neither the working directory nor PYTHONPATH on sys.path, so from /testbed the
// import still resolves through the installed environment: this proves the editable install points at the
// bind-mounted checkout. -B keeps the check from writing bytecode into it.
async function assertEditableInstall(record: SwebenchRecord, executor: DockerExecutor, repo: string): Promise<void> {
  const pkg = importPackageFor(record.repo);
  const result = await executor.run({
    program: "python", args: ["-I", "-B", "-c", `import ${pkg}; print(${pkg}.__file__)`], cwd: repo, timeoutSec: 120
  });
  const location = result.ok ? result.data.stdout.trim().split("\n").at(-1) ?? "" : "";
  if (!result.ok || result.data.exitCode !== 0 || !location.startsWith(`${CONTAINER_ROOT}/`)) {
    const detail = result.ok ? `exit ${result.data.exitCode}: ${result.data.stderr.trim().slice(-500)}` : result.error;
    throw new InfraError(`Sanity check failed: import ${pkg} resolved to ${JSON.stringify(location)} (${detail})`);
  }
}

function dockerEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: process.env.HOME, LANG: "C.UTF-8" };
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith("DOCKER_") && value !== undefined) env[key] = value;
  }
  return env;
}
