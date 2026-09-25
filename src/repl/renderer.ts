import type { Writable } from "node:stream";
import type { AgentEvent } from "../agent/events.js";
import type { PlanSnapshot, RunReport } from "../types.js";

type Clock = {
  now(): number;
  setInterval(callback: () => void, ms: number): ReturnType<typeof setInterval>;
  clearInterval(timer: ReturnType<typeof setInterval>): void;
};

export const systemClock: Clock = {
  now: () => Date.now(),
  setInterval: (callback, ms) => setInterval(callback, ms),
  clearInterval: (timer) => clearInterval(timer)
};

export class ReplRenderer {
  private readonly color: boolean;
  private readonly interactive: boolean;
  private thinkingTimer?: ReturnType<typeof setInterval>;
  private thinkingStarted = 0;
  private thinkingVisible = false;
  private finalRendered = false;

  constructor(
    private readonly output: Writable,
    private readonly clock: Clock = systemClock,
    options: { color?: boolean; interactive?: boolean } = {}
  ) {
    const tty = options.interactive ?? Boolean((output as Writable & { isTTY?: boolean }).isTTY);
    this.interactive = tty && process.env.NO_COLOR === undefined;
    this.color = (options.color ?? tty) && process.env.NO_COLOR === undefined;
  }

  startRun(): void {
    this.finalRendered = false;
    this.thinkingStarted = this.clock.now();
    this.drawThinking();
    if (this.interactive) this.thinkingTimer = this.clock.setInterval(() => this.drawThinking(), 1_000);
  }

  handle = (event: AgentEvent): void => {
    switch (event.type) {
      case "model_turn":
        this.stopThinking();
        break;
      case "tool_started":
        this.stopThinking();
        break;
      case "tool_finished":
        this.stopThinking();
        this.write(`${event.ok ? this.paint("32", "✓") : this.paint("31", "✗")} ${event.name} ${event.summary}`.trimEnd());
        this.restartThinking();
        break;
      case "plan_updated":
        this.stopThinking();
        this.renderPlan(event.plan);
        this.restartThinking();
        break;
      case "run_finished":
        this.stopThinking();
        if (event.finalMessage) {
          this.write(event.finalMessage);
          this.finalRendered = true;
        }
        break;
      default:
        break;
    }
  };

  finish(report: RunReport): void {
    this.stopThinking();
    if (report.finalMessage && !this.finalRendered) this.write(report.finalMessage);
    const usage = report.usage;
    const details = usage
      ? `${usage.modelRounds} rounds · ${usage.totalTokens} tokens`
      : "usage unavailable";
    this.write(this.paint("2", `${report.status} · ${details}`));
  }

  stop(): void {
    this.stopThinking();
  }

  message(value: string): void {
    this.write(value);
  }

  diff(value: string): void {
    if (!value) {
      this.write("No working-tree diff.");
      return;
    }
    for (const line of value.replace(/\n$/, "").split("\n")) {
      const code = line.startsWith("+++") || line.startsWith("---") ? "1"
        : line.startsWith("+") ? "32"
          : line.startsWith("-") ? "31"
            : line.startsWith("@@") ? "36"
              : undefined;
      this.write(code ? this.paint(code, line) : line);
    }
  }

  private renderPlan(plan: PlanSnapshot): void {
    if (plan.steps.length === 0) return;
    this.write(plan.steps.map((step) => `${planMark(step.status)} ${step.description}`).join(" · "));
  }

  private restartThinking(): void {
    if (!this.interactive) return;
    this.thinkingStarted = this.clock.now();
    this.drawThinking();
    if (this.interactive && !this.thinkingTimer) this.thinkingTimer = this.clock.setInterval(() => this.drawThinking(), 1_000);
  }

  private drawThinking(): void {
    const seconds = Math.max(0, Math.floor((this.clock.now() - this.thinkingStarted) / 1_000));
    const text = this.paint("2", `thinking… ${seconds}s`);
    if (this.interactive) this.output.write(`${this.thinkingVisible ? "\r\u001b[2K" : ""}${text}`);
    else if (!this.thinkingVisible) this.write(text);
    this.thinkingVisible = true;
  }

  private stopThinking(): void {
    if (this.thinkingTimer) {
      this.clock.clearInterval(this.thinkingTimer);
      this.thinkingTimer = undefined;
    }
    if (this.interactive && this.thinkingVisible) this.output.write("\r\u001b[2K");
    this.thinkingVisible = false;
  }

  private paint(code: string, value: string): string {
    return this.color ? `\u001b[${code}m${value}\u001b[0m` : value;
  }

  private write(value: string): void {
    this.output.write(`${value}\n`);
  }
}

function planMark(status: PlanSnapshot["steps"][number]["status"]): string {
  if (status === "completed") return "✓";
  if (status === "blocked") return "✗";
  if (status === "in_progress") return "›";
  return "·";
}

export type { Clock };
