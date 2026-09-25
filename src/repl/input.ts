import { createInterface, type Interface } from "node:readline";
import { Transform, type Readable, type Writable } from "node:stream";
import { StringDecoder } from "node:string_decoder";

type InputEvent = { type: "line"; value: string } | { type: "interrupt"; empty: boolean } | { type: "eof" };

export class ReplInput {
  private readonly readline: Interface;
  private readonly input: Readable;
  private readonly terminal: boolean;
  private readonly transform?: Transform;
  private readonly processInterrupt?: () => void;
  private readonly queued: InputEvent[] = [];
  private readonly waiting: Array<(event: InputEvent) => void> = [];
  private interruptListener?: () => void;
  private ended = false;

  constructor(input: Readable, output: Writable, terminal = Boolean((input as Readable & { isTTY?: boolean }).isTTY)) {
    this.input = input;
    this.terminal = terminal;
    const decoder = new StringDecoder("utf8");
    const owner = this;
    let pendingLine = "";
    const transform = terminal ? undefined : new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        const parts = decoder.write(chunk).split("\u0003");
        for (let index = 0; index < parts.length; index += 1) {
          const part = parts[index]!;
          if (part) {
            pendingLine += part;
            let newline = pendingLine.indexOf("\n");
            while (newline >= 0) {
              this.push(pendingLine.slice(0, newline + 1));
              pendingLine = pendingLine.slice(newline + 1);
              newline = pendingLine.indexOf("\n");
            }
          }
          if (index < parts.length - 1) {
            owner.interrupt(pendingLine.length === 0);
            pendingLine = "";
          }
        }
        callback();
      },
      flush(callback) {
        pendingLine += decoder.end();
        if (pendingLine) this.push(pendingLine);
        callback();
      }
    });
    this.transform = transform;
    const source = transform ? input.pipe(transform) : input;
    this.readline = createInterface({ input: source, output, terminal });
    this.readline.on("line", (value) => this.push({ type: "line", value }));
    this.readline.on("SIGINT", () => this.interrupt());
    this.readline.on("close", () => {
      if (!this.ended) {
        this.ended = true;
        this.push({ type: "eof" });
      }
    });
    if (!terminal && input === process.stdin) {
      this.processInterrupt = () => this.interrupt(true);
      process.on("SIGINT", this.processInterrupt);
    }
  }

  async read(prompt: string, output: Writable): Promise<InputEvent> {
    if (this.terminal) {
      this.readline.setPrompt(prompt);
      this.readline.prompt();
    } else output.write(prompt);
    return await new Promise<InputEvent>((resolve) => {
      const event = this.queued.shift();
      if (event) resolve(event);
      else if (this.ended) resolve({ type: "eof" });
      else this.waiting.push(resolve);
    });
  }

  onInterrupt(listener?: () => void): void {
    this.interruptListener = listener;
  }

  close(): void {
    this.readline.close();
    if (this.transform) {
      this.input.unpipe(this.transform);
      this.transform.destroy();
    }
    if (this.processInterrupt) process.off("SIGINT", this.processInterrupt);
    if (this.input === process.stdin) this.input.pause();
  }

  private interrupt(empty?: boolean): void {
    const lineWasEmpty = empty ?? !(this.readline as Interface & { line?: string }).line;
    if (this.terminal && !lineWasEmpty) this.readline.write(null, { ctrl: true, name: "u" });
    if (this.interruptListener) this.interruptListener();
    else this.push({ type: "interrupt", empty: lineWasEmpty });
  }

  private push(event: InputEvent): void {
    const resolve = this.waiting.shift();
    if (resolve) resolve(event);
    else this.queued.push(event);
  }
}

export type { InputEvent };
