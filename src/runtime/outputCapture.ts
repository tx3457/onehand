import { StringDecoder } from "node:string_decoder";
import { DEFAULT_TOOL_OUTPUT_LIMIT, truncateCapturedText } from "../utils/truncate.js";

const DECODE_CHUNK_BYTES = 64 * 1024;
const MAX_FAILURE_LINE_CHARS = 64 * 1024;
const MATCHES_FAILURE = /^(?:(?:FAILED|ERROR)\b|(?:FAIL|ERROR):\s|E\s{3})/;

// Never retain incoming chunks: even a small subarray can pin a huge backing allocation.
export class OutputCapture {
  private readonly decoder = new StringDecoder("utf8");
  private readonly head: Buffer;
  private readonly tail: Buffer;
  private headLength = 0;
  private tailPosition = 0;
  private totalBytes = 0;
  private line = "";
  private lineOverflow = false;
  readonly failures: string[] = [];

  constructor(private readonly limitBytes: number, private readonly captureFailures = false) {
    // Both caps exceed the requested limit; lookahead keeps even tiny UTF-8 cuts exact.
    const cap = Math.max(DEFAULT_TOOL_OUTPUT_LIMIT, Math.ceil(limitBytes)) + 4;
    this.head = Buffer.alloc(cap);
    this.tail = Buffer.alloc(cap);
  }

  write(chunk: Buffer): void {
    // StringDecoder matches Buffer.concat(...).toString(), including malformed UTF-8,
    // without decoding an arbitrarily large incoming chunk into one string.
    for (let offset = 0; offset < chunk.length; offset += DECODE_CHUNK_BYTES) {
      this.append(this.decoder.write(chunk.subarray(offset, offset + DECODE_CHUNK_BYTES)));
    }
  }

  finish(strategy: "head" | "head_tail", stdout: boolean): { text: string; truncated: boolean } {
    this.append(this.decoder.end());
    // The old extractor inserted a newline between stdout and stderr, stripping a final
    // stdout CR as part of CRLF; an unterminated stderr CR was kept.
    this.finishLine(stdout);
    const tail = this.totalBytes < this.tail.length ? this.tail.subarray(0, this.totalBytes)
      : Buffer.concat([this.tail.subarray(this.tailPosition), this.tail.subarray(0, this.tailPosition)]);
    return truncateCapturedText(this.head.subarray(0, this.headLength), tail, this.totalBytes, this.limitBytes, strategy);
  }

  private append(text: string): void {
    if (!text) return;
    const bytes = Buffer.from(text, "utf8");
    const headBytes = Math.min(bytes.length, this.head.length - this.headLength);
    bytes.copy(this.head, this.headLength, 0, headBytes);
    this.headLength += headBytes;
    if (bytes.length >= this.tail.length) {
      bytes.copy(this.tail, 0, bytes.length - this.tail.length);
      this.tailPosition = 0;
    } else {
      const first = Math.min(bytes.length, this.tail.length - this.tailPosition);
      bytes.copy(this.tail, this.tailPosition, 0, first);
      bytes.copy(this.tail, 0, first);
      this.tailPosition = (this.tailPosition + bytes.length) % this.tail.length;
    }
    this.totalBytes += bytes.length;
    if (!this.captureFailures || this.failures.length === 40) return;
    let start = 0;
    while (start < text.length && this.failures.length < 40) {
      const newline = text.indexOf("\n", start);
      const end = newline === -1 ? text.length : newline;
      const keep = Math.min(end - start, MAX_FAILURE_LINE_CHARS - this.line.length);
      this.line += text.slice(start, start + keep);
      this.lineOverflow ||= keep < end - start;
      if (newline === -1) break;
      this.finishLine(true);
      start = newline + 1;
    }
  }

  private finishLine(stripCR: boolean): void {
    if (this.captureFailures && this.failures.length < 40 && MATCHES_FAILURE.test(this.line)) {
      // A single unterminated failure line must not reintroduce unbounded capture.
      const line = stripCR && this.line.endsWith("\r") ? this.line.slice(0, -1) : this.line;
      this.failures.push(this.lineOverflow ? `${line} [onehand: failure line truncated]` : line);
    }
    this.line = "";
    this.lineOverflow = false;
  }
}
