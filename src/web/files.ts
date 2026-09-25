import { constants } from "node:fs";
import { open, readdir, realpath } from "node:fs/promises";
import path from "node:path";

export class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export function validName(name: string): boolean {
  return name.length > 0 && name.length <= 255 && name !== "." && name !== ".." &&
    !/[\\/\x00-\x1f\x7f]/.test(name) && !/^\.env(?:\.|$)/i.test(name);
}

function inside(root: string, target: string): boolean {
  return target.startsWith(root + path.sep);
}

// Bound JSON depth before invoking the persistence layer's recursive redactor.
export function parseArtifactJson(source: string): unknown {
  const value: unknown = JSON.parse(source);
  let count = 0;
  function visit(entry: unknown, depth: number): void {
    if (++count > 200_000 || depth > 64) throw new HttpError(413, "Artifact exceeds the structure limit");
    if (Array.isArray(entry)) {
      for (const child of entry) visit(child, depth + 1);
    } else if (entry !== null && typeof entry === "object") {
      for (const key in entry) {
        if (Object.hasOwn(entry, key)) visit((entry as Record<string, unknown>)[key], depth + 1);
      }
    }
  }
  visit(value, 0);
  return value;
}

// Request-scoped snapshot of actual IDs; each file is still rechecked when opened.
// There is no arbitrary-file endpoint and no repeated whole-root scan for each run.
export class ConfinedDirectory {
  private listing?: Promise<{ root: string; ids: string[] }>;
  constructor(private readonly root: string) {}

  async directories(): Promise<string[]> {
    return [...(await this.snapshot()).ids];
  }

  private snapshot(): Promise<{ root: string; ids: string[] }> {
    return this.listing ??= this.loadListing();
  }

  private async loadListing(): Promise<{ root: string; ids: string[] }> {
    try {
      const root = await realpath(this.root);
      const entries = await readdir(root, { withFileTypes: true });
      return { root, ids: entries.filter((entry) => entry.isDirectory() && validName(entry.name)).map((entry) => entry.name).sort() };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { root: "", ids: [] };
      throw error;
    }
  }

  private async directory(id: string): Promise<{ root: string; directory: string }> {
    if (!validName(id)) throw new HttpError(404, "Not found");
    const { root, ids } = await this.snapshot();
    if (!ids.includes(id)) throw new HttpError(404, "Not found");
    const directory = await realpath(path.join(root, id));
    if (!inside(root, directory) || directory !== path.join(root, id)) throw new HttpError(404, "Not found");
    return { root, directory };
  }

  async files(id: string): Promise<string[]> {
    const { directory } = await this.directory(id);
    return (await readdir(directory)).filter(validName).sort();
  }

  private async file(id: string, name: string) {
    if (!validName(name)) throw new HttpError(404, "Not found");
    const { root, directory } = await this.directory(id);
    if (!(await readdir(directory)).includes(name)) throw new HttpError(404, "Not found");
    const requested = path.join(directory, name);
    let target: string;
    try { target = await realpath(requested); }
    catch { throw new HttpError(404, "Not found"); }
    if (!inside(root, target) || !inside(directory, target) || target.split(path.sep).some((part) => /^\.env(?:\.|$)/i.test(part))) {
      throw new HttpError(404, "Not found");
    }
    const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || await realpath(requested) !== target || await realpath(directory) !== directory) {
        throw new HttpError(404, "Not found");
      }
      return { handle, size: stat.size };
    } catch (error) {
      await handle.close();
      throw error;
    }
  }

  async read(id: string, name: string, limitBytes = 2 * 1024 * 1024): Promise<string> {
    const { handle, size } = await this.file(id, name);
    try {
      if (size > limitBytes) throw new HttpError(413, "Artifact exceeds the display limit");
      const bytes = Buffer.alloc(Math.min(size + 1, limitBytes + 1));
      let total = 0;
      while (total < bytes.length) {
        const { bytesRead } = await handle.read(bytes, total, bytes.length - total, total);
        if (bytesRead === 0) break;
        total += bytesRead;
      }
      if (total > limitBytes) throw new HttpError(413, "Artifact exceeds the display limit");
      return bytes.subarray(0, total).toString("utf8");
    } finally { await handle.close(); }
  }

  async tail(id: string, name: string, limitBytes: number): Promise<{ text: string; truncated: boolean }> {
    const { handle, size } = await this.file(id, name);
    try {
      const start = Math.max(0, size - limitBytes);
      const bytes = Buffer.alloc(Math.min(size, limitBytes));
      let total = 0;
      while (total < bytes.length) {
        const { bytesRead } = await handle.read(bytes, total, bytes.length - total, start + total);
        if (bytesRead === 0) break;
        total += bytesRead;
      }
      let text = bytes.subarray(0, total).toString("utf8");
      // The first line may start inside a UTF-8 character or JSON record.
      if (start > 0) text = text.includes("\n") ? text.slice(text.indexOf("\n") + 1) : "";
      return { text, truncated: start > 0 };
    } finally { await handle.close(); }
  }
}
