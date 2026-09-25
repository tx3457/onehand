import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { redactDeep } from "../agent/persistence.js";
import { CheckpointStore } from "../runtime/checkpoints.js";
import { WEB_CSS, WEB_HTML, WEB_JS } from "./assets.js";
import { listEvaluations, readEvaluation } from "./evaluations.js";
import { ConfinedDirectory, HttpError, validName } from "./files.js";
import { listRuns, readRun, readRunState } from "./runs.js";

const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; frame-ancestors 'none'";
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

export type WebUiOptions = { host?: string; port?: number; runsDir?: string; resultsDir?: string };

export async function startWebUi(options: WebUiOptions = {}) {
  if (options.host !== undefined && options.host !== "127.0.0.1") throw new Error("Web UI must bind to 127.0.0.1");
  const port = options.port ?? 0;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Port must be an integer between 0 and 65535");
  const runsDir = expandHome(options.runsDir ?? path.join(homedir(), ".onehand", "runs"));
  const resultsDir = expandHome(options.resultsDir ?? path.join(process.cwd(), "eval", "results"));
  const bootstrapToken = randomBytes(32).toString("hex");
  const sessionToken = randomBytes(32).toString("hex");
  let tokenAvailable = true;
  let origin = "";
  let boundPort = 0;
  // CheckpointStore uses a shared shadow index: never overlap its list/diff operations.
  let checkpointQueue: Promise<unknown> = Promise.resolve();

  const server = createServer((request, response) => {
    response.setHeader("Content-Security-Policy", CSP);
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("Cache-Control", "no-store");
    void (async () => {
      const hosts = request.rawHeaders.filter((_, index) => index % 2 === 0 && request.rawHeaders[index].toLowerCase() === "host");
      if (hosts.length !== 1 || (request.headers.host !== `127.0.0.1:${boundPort}` && request.headers.host !== `localhost:${boundPort}`)) {
        throw new HttpError(403, "Forbidden Host");
      }
      if (request.method !== "GET") {
        response.setHeader("Allow", "GET");
        throw new HttpError(405, "Only GET is supported");
      }
      const raw = request.url ?? "/";
      const rawPath = raw.split("?")[0];
      let segments: string[];
      try {
        segments = rawPath === "/" ? [] : rawPath.slice(1).split("/").map(decodeURIComponent);
        if (!raw.startsWith("/") || raw.startsWith("//") || segments.some((part) => !validName(part))) throw new Error();
      } catch { throw new HttpError(404, "Not found"); }
      const url = new URL(raw, origin);
      const cookieName = `onehand_ui_${boundPort}`;
      if (segments[0] === "api" && request.headers.origin !== undefined && request.headers.origin !== origin) {
        throw new HttpError(403, "Forbidden Origin");
      }
      if (url.searchParams.has("token")) {
        if (rawPath !== "/" || !tokenAvailable || url.searchParams.getAll("token").length !== 1 || !matches(url.searchParams.get("token") ?? "", bootstrapToken)) {
          throw new HttpError(401, "Unauthorized");
        }
        tokenAvailable = false;
        response.setHeader("Set-Cookie", `${cookieName}=${sessionToken}; Path=/; HttpOnly; SameSite=Strict`);
        response.setHeader("Location", "/");
        send(response, "", "text/plain; charset=utf-8", 303);
        return;
      }
      const cookies = (request.headers.cookie ?? "").split(";").map((entry) => entry.trim()).filter((entry) => entry.startsWith(`${cookieName}=`));
      if (cookies.length !== 1 || !matches(cookies[0].slice(cookieName.length + 1), sessionToken)) throw new HttpError(401, "Unauthorized");
      if (rawPath === "/") return send(response, WEB_HTML, "text/html; charset=utf-8");
      if (rawPath === "/app.js") return send(response, WEB_JS, "text/javascript; charset=utf-8");
      if (rawPath === "/app.css") return send(response, WEB_CSS, "text/css; charset=utf-8");
      if (segments[0] !== "api") throw new HttpError(404, "Not found");
      const runs = new ConfinedDirectory(runsDir);
      const results = new ConfinedDirectory(resultsDir);
      const [, resource, id, child, checkpointId] = segments;
      if (resource === "runs") {
        if (segments.length === 2) return json(response, { runs: await listRuns(runs) });
        if (segments.length === 3) return json(response, await readRun(runs, id));
        if (child === "checkpoints" && (segments.length === 4 || segments.length === 5)) {
          if (checkpointId !== undefined && !/^[a-f0-9]{40,64}$/i.test(checkpointId)) throw new HttpError(404, "Not found");
          const state = await readRunState(runs, id);
          if (typeof state.repo !== "string" || !path.isAbsolute(state.repo)) throw new HttpError(404, "Repository unavailable");
          const repo = await realpath(state.repo);
          const operation = checkpointQueue.catch(() => {}).then(async () => {
            const store = new CheckpointStore(repo);
            const checkpoints = await store.list();
            if (checkpointId === undefined) return { checkpoints: redactDeep(checkpoints) };
            if (!checkpoints.some((checkpoint) => checkpoint.id === checkpointId)) throw new HttpError(404, "Not found");
            const diff = Buffer.from(redactDeep(await store.diff(checkpointId)));
            const limit = 512 * 1024;
            return { diff: diff.subarray(0, limit).toString("utf8"), truncated: diff.length > limit };
          });
          checkpointQueue = operation;
          return json(response, await operation);
        }
      }
      if (resource === "evaluations") {
        if (segments.length === 2) return json(response, { evaluations: await listEvaluations(results) });
        if (segments.length === 3) return json(response, await readEvaluation(results, id));
      }
      throw new HttpError(404, "Not found");
    })().catch((error: unknown) => {
      if (response.destroyed || response.headersSent) return;
      const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
      const status = error instanceof HttpError ? error.status : missing ? 404 : 500;
      json(response, { error: error instanceof HttpError ? error.message : missing ? "Not found" : "Unable to read local artifact" }, status);
    });
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  server.timeout = 60_000;
  server.maxRequestsPerSocket = 100;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Unable to bind loopback server");
  boundPort = address.port;
  origin = `http://127.0.0.1:${boundPort}`;
  return {
    server, origin, url: `${origin}/?token=${bootstrapToken}`,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
      server.closeAllConnections();
    })
  };
}

function matches(candidate: string, expected: string): boolean {
  return /^[a-f0-9]{64}$/.test(candidate) && timingSafeEqual(Buffer.from(candidate, "hex"), Buffer.from(expected, "hex"));
}

function send(response: ServerResponse, body: string, contentType: string, status = 200): void {
  const length = Buffer.byteLength(body);
  if (length > MAX_RESPONSE_BYTES) throw new HttpError(413, "Response exceeds the display limit");
  response.writeHead(status, { "Content-Type": contentType, "Content-Length": length });
  response.end(body);
}

function json(response: ServerResponse, body: unknown, status = 200): void {
  send(response, JSON.stringify(body), "application/json; charset=utf-8", status);
}

function expandHome(value: string): string {
  return path.resolve(value === "~" ? homedir() : value.startsWith("~/") ? path.join(homedir(), value.slice(2)) : value);
}
