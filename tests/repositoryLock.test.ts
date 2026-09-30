import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, realpath, symlink, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acquireRepositoryLock, withRepositoryLock } from "../src/runtime/repositoryLock.js";
import { cleanupTempDir, makeTempDir } from "./helpers.js";

type ChildMessage = { type: "ready" | "acquired" | "error"; message?: string };

describe("repository locks", () => {
  let repo: string;
  let storageRoot: string;
  const children = new Set<ChildProcess>();

  beforeEach(async () => {
    repo = await makeTempDir("onehand-lock-repo-");
    storageRoot = await makeTempDir("onehand-lock-store-");
  });

  afterEach(async () => {
    const exits = [...children].map((child) => {
      child.kill("SIGKILL");
      return waitForExit(child);
    });
    await Promise.all(exits);
    await Promise.all([cleanupTempDir(repo), cleanupTempDir(storageRoot)]);
  });

  it("treats canonical aliases as one lock and releases after normal and error exits", async () => {
    const aliasRoot = await makeTempDir("onehand-lock-alias-");
    const alias = `${aliasRoot}/repo`;
    await symlink(repo, alias);
    try {
      const child = spawnLockHolder(alias, storageRoot);
      await waitForMessage(child, "acquired");

      await expect(acquireRepositoryLock(repo, { scope: "chat", storageRoot })).rejects.toThrow(/already locked/i);
      child.send?.("release");
      await waitForExit(child);

      await withRepositoryLock(repo, { scope: "chat", storageRoot }, async () => undefined);
      await expect(withRepositoryLock(repo, { scope: "chat", storageRoot }, async () => {
        throw new Error("operation failed");
      })).rejects.toThrow("operation failed");
      await (await acquireRepositoryLock(repo, { scope: "chat", storageRoot })).release();
    } finally {
      await cleanupTempDir(aliasRoot);
    }
  });

  it("recovers a lock whose same-host owner was killed", async () => {
    const child = spawnLockHolder(repo, storageRoot);
    await waitForMessage(child, "acquired");
    child.kill("SIGKILL");
    await waitForExit(child);

    const recovered = await acquireRepositoryLock(repo, { scope: "chat", storageRoot });
    await recovered.release();
  });

  it("prints a command that clears a lock whose owner only looks alive", async () => {
    const child = spawnLockHolder(repo, storageRoot);
    await waitForMessage(child, "acquired");

    const error = await acquireRepositoryLock(repo, { scope: "chat", storageRoot }).then(() => undefined, (reason: Error) => reason);
    const clear = /clear the stale lock with: (git --git-dir .+)$/.exec(error?.message ?? "")?.[1];
    expect(clear).toMatch(/update-ref -d 'refs\/onehand-locks\/chat\//);
    execFileSync("sh", ["-c", clear!]);

    const recovered = await acquireRepositoryLock(repo, { scope: "chat", storageRoot });
    await recovered.release();
  });

  it("allows only one contender to reclaim the same dead lock", async () => {
    const deadOwner = spawnLockHolder(repo, storageRoot);
    await waitForMessage(deadOwner, "acquired");
    deadOwner.kill("SIGKILL");
    await waitForExit(deadOwner);

    const first = spawnLockHolder(repo, storageRoot, true);
    const second = spawnLockHolder(repo, storageRoot, true);
    await Promise.all([waitForMessage(first, "ready"), waitForMessage(second, "ready")]);
    first.send?.("go");
    second.send?.("go");
    const outcomes = await Promise.all([waitForOutcome(first), waitForOutcome(second)]);
    expect(outcomes.map((message) => message.type).sort()).toEqual(["acquired", "error"]);
    expect(outcomes.find((message) => message.type === "error")?.message).toMatch(/already locked/i);

    const winner = outcomes[0]!.type === "acquired" ? first : second;
    winner.send?.("release");
    await Promise.all([waitForExit(first), waitForExit(second)]);
  });

  it("fails promptly when existing lock storage is not a bare Git repository", async () => {
    await mkdir(`${storageRoot}/repository-locks.git`);

    await expect(acquireRepositoryLock(repo, { scope: "chat", storageRoot })).rejects.toThrow(
      /repository lock storage|not a git repository/i
    );
  }, 2_000);

  it("bounds retries when Git persistently rejects a ref update", async () => {
    await (await acquireRepositoryLock(repo, { scope: "chat", storageRoot })).release();
    const key = createHash("sha256").update(await realpath(repo)).digest("hex");
    const refDirectory = `${storageRoot}/repository-locks.git/refs/onehand-locks/chat`;
    await mkdir(refDirectory, { recursive: true });
    await writeFile(`${refDirectory}/${key}.lock`, "blocked");

    await expect(acquireRepositoryLock(repo, { scope: "chat", storageRoot, waitMs: 50 })).rejects.toThrow(
      /could not acquire repository lock/i
    );
  }, 2_000);

  function spawnLockHolder(repoPath: string, root: string, gated = false): ChildProcess {
    const moduleUrl = pathToFileURL(`${process.cwd()}/src/runtime/repositoryLock.ts`).href;
    const script = `
      import { acquireRepositoryLock } from ${JSON.stringify(moduleUrl)};
      const acquire = async () => {
        try {
          const lock = await acquireRepositoryLock(${JSON.stringify(repoPath)}, {
            scope: "chat", storageRoot: ${JSON.stringify(root)}
          });
          process.send({ type: "acquired" });
          process.on("message", async (message) => {
            if (message === "release") { await lock.release(); process.exit(0); }
          });
        } catch (error) {
          process.send({ type: "error", message: error instanceof Error ? error.message : String(error) });
          process.exit(0);
        }
      };
      if (${gated}) {
        process.send({ type: "ready" });
        process.once("message", (message) => { if (message === "go") void acquire(); });
      } else void acquire();
    `;
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      stdio: ["ignore", "ignore", "pipe", "ipc"]
    });
    children.add(child);
    child.once("exit", () => children.delete(child));
    return child;
  }
});

function waitForMessage(child: ChildProcess, type: ChildMessage["type"]): Promise<ChildMessage> {
  return new Promise((resolve, reject) => {
    const onMessage = (message: ChildMessage) => {
      if (message.type !== type) return;
      cleanup();
      resolve(message);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      reject(new Error(`lock child exited before ${type}: code=${code} signal=${signal}`));
    };
    const cleanup = () => {
      child.off("message", onMessage);
      child.off("exit", onExit);
    };
    child.on("message", onMessage);
    child.on("exit", onExit);
  });
}

function waitForOutcome(child: ChildProcess): Promise<ChildMessage> {
  return new Promise((resolve, reject) => {
    const onMessage = (message: ChildMessage) => {
      if (message.type !== "acquired" && message.type !== "error") return;
      cleanup();
      resolve(message);
    };
    const onExit = () => {
      cleanup();
      reject(new Error("lock child exited without an outcome"));
    };
    const cleanup = () => {
      child.off("message", onMessage);
      child.off("exit", onExit);
    };
    child.on("message", onMessage);
    child.on("exit", onExit);
  });
}

function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once("exit", () => resolve()));
}
