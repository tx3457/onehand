import { describe, expect, it } from "vitest";
import { maskProviderHistory } from "../src/providers/historyMasking.js";

const NOTE = "Context note: older tool observations were masked to save context.\nPlan: 1 in_progress inspect\nModified files: a.ts";
const PUBLIC_SUFFIX = "masked to save context; call the tool again if needed";

describe("observation history masking", () => {
  it("masks old DeepSeek tool rounds without breaking call/result pairing", () => {
    const history: unknown[] = [{ role: "user", content: "original task" }];
    for (let round = 1; round <= 12; round += 1) {
      history.push({
        role: "assistant",
        content: round === 1 ? "assistant text stays" : null,
        reasoning_content: `reasoning ${round}`,
        tool_calls: [{
          id: `call-${round}`,
          type: "function",
          function: {
            name: "read_file",
            arguments: JSON.stringify({
              path: round === 2 ? "p".repeat(2_000) : `src/${round}.ts`, startLine: 1, endLine: 20,
              content: "x".repeat(1_100), unicode: "界".repeat(600)
            })
          }
        }]
      });
      history.push({
        role: "tool",
        tool_call_id: `call-${round}`,
        content: round === 1 ? `${"legitimate output ".repeat(2400)}${PUBLIC_SUFFIX}` : `result ${round} ${"z".repeat(200)}`
      });
    }

    const masked = maskProviderHistory("deepseek", history, NOTE);
    const items = masked.history as any[];

    expect(items[0]).toEqual({ role: "user", content: "original task" });
    expect(items.at(-1)).toEqual({ role: "user", content: NOTE });
    expect(items[1]).toMatchObject({ role: "assistant", content: "assistant text stays", reasoning_content: "[elided]" });
    expect(JSON.parse(items[1].tool_calls[0].function.arguments)).toEqual({
      path: "src/1.ts", startLine: 1, endLine: 20,
      content: "[masked 1100 chars]", unicode: "[masked 600 chars]"
    });
    expect(items[2].content).toMatch(/^read_file \(path=src\/1\.ts, lines=1-20\): \d+ bytes; masked to save context; call the tool again if needed$/);
    expect(items.slice(5, -1)).toEqual(history.slice(5));
    expect(masked.maskedItems).toBe(6);
    expect(masked.bytesRemoved).toBeGreaterThan(0);

    const again = maskProviderHistory("deepseek", masked.history, NOTE.replace("a.ts", "b.ts"));
    expect((again.history as any[]).filter((item) => item.role === "user" && item.content.startsWith("Context note:"))).toHaveLength(1);
    expect(again.history).toBe(masked.history);
    expect((again.history as any[]).at(-1).content).toContain("a.ts");
    expect((again.history as any[])[2].content).toBe(items[2].content);
    expect((again.history as any[]).find((item) => item.role === "tool" && item.tool_call_id === "call-2").content)
      .toBe(items.find((item) => item.role === "tool" && item.tool_call_id === "call-2").content);
    expect(again.maskedItems).toBe(0);
  });

  it("masks old OpenAI Responses rounds while preserving multi-call groups and recent items verbatim", () => {
    const history: unknown[] = [{ role: "user", content: "original task" }];
    for (let round = 1; round <= 11; round += 1) {
      history.push({ type: "reasoning", id: `reason-${round}`, encrypted_content: `opaque-${round}` });
      history.push(
        {
          type: "function_call", call_id: `a-${round}`, name: "search_code",
          arguments: JSON.stringify({ query: round === 1 ? "q".repeat(2_000) : `needle-${round}`, path: "src" })
        },
        { type: "function_call", call_id: `b-${round}`, name: "run_command", arguments: JSON.stringify({ program: "node", args: ["script.js", "x".repeat(1_100)] }) },
        {
          type: "function_call_output", call_id: `a-${round}`,
          output: round === 1 ? `${"legitimate output ".repeat(2400)}${PUBLIC_SUFFIX}` : `search result ${round} ${"q".repeat(100)}`
        },
        { type: "function_call_output", call_id: `b-${round}`, output: `command result ${round} ${"r".repeat(100)}` }
      );
    }
    history.push({ role: "assistant", content: "text remains" });

    const masked = maskProviderHistory("openai", history, NOTE);
    const items = masked.history as any[];

    expect(items[1]).toEqual(history[1]);
    expect(JSON.parse(items[2].arguments)).toEqual({ query: "[masked 2000 chars]", path: "src" });
    expect(JSON.parse(items[3].arguments)).toEqual({ program: "node", args: ["script.js", "[masked 1100 chars]"] });
    expect(items[4].output).toMatch(/^search_code \(path=src, query=\[masked 2000 chars\]\): \d+ bytes; masked to save context; call the tool again if needed$/);
    expect(items[5].output).toMatch(/^run_command \(program=node, args=script\.js,…\): \d+ bytes; masked to save context; call the tool again if needed$/);
    expect(items.slice(6, -1)).toEqual(history.slice(6));
    expect(items.at(-2)).toEqual({ role: "assistant", content: "text remains" });
    expect(items.at(-1)).toEqual({ role: "user", content: NOTE });
    expect(masked.maskedItems).toBe(4);

    const again = maskProviderHistory("openai", masked.history, NOTE);
    expect((again.history as any[]).find((item) => item.call_id === "a-1" && item.type === "function_call_output").output)
      .toBe(items[4].output);
    expect(again.maskedItems).toBe(0);
  });

  it("preserves the initial user prompt, elides old text-turn reasoning, and keeps stubs on one bounded line", () => {
    const initial = `${NOTE}\nThis is still the original task.`;
    const history: unknown[] = [{ role: "user", content: initial }];
    for (let round = 1; round <= 11; round += 1) {
      if (round === 2) history.push({ role: "assistant", content: "visible text", reasoning_content: "old text reasoning" });
      history.push({
        role: "assistant",
        content: null,
        reasoning_content: `reasoning ${round}`,
        tool_calls: [{
          id: `call-${round}`,
          type: "function",
          function: {
            name: round === 1 ? `odd\n${"tool".repeat(30)}` : "search_code",
            arguments: JSON.stringify({ query: `${"q".repeat(300)}\nsecond line` })
          }
        }]
      });
      history.push({ role: "tool", tool_call_id: `call-${round}`, content: round === 1 ? "x".repeat(40_000) : "result" });
    }

    const masked = maskProviderHistory("deepseek", history, NOTE);
    const items = masked.history as any[];
    expect(items[0]).toEqual({ role: "user", content: initial });
    expect(items.find((item) => item.content === "visible text").reasoning_content).toBe("[elided]");
    const stub = items.find((item) => item.role === "tool" && item.tool_call_id === "call-1").content as string;
    expect(stub).not.toContain("\n");
    expect(stub.length).toBeLessThan(400);
  });
});

describe.each(["deepseek", "openai"] as const)("%s block masking", (provider) => {
  function round(id: number, outputBytes: number, reasoningBytes = 4_000, textBytes = 2_000): any[] {
    const calls = ["a", "b"].map((suffix) => ({
      id: `${id}-${suffix}`, type: "function", function: { name: "read_file", arguments: '{"path":"a.txt"}' }
    }));
    if (provider === "deepseek") return [
      { role: "assistant", content: "t".repeat(textBytes), reasoning_content: "r".repeat(reasoningBytes), tool_calls: calls },
      ...calls.map((call) => ({ role: "tool", tool_call_id: call.id, content: "x".repeat(outputBytes / 2) }))
    ];
    return [
      { type: "reasoning", id: `rs-${id}`, encrypted_content: "r".repeat(reasoningBytes) },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "t".repeat(textBytes) }] },
      ...calls.map((call) => ({ type: "function_call", call_id: call.id, ...call.function })),
      ...calls.map((call) => ({ type: "function_call_output", call_id: call.id, output: "x".repeat(outputBytes / 2) }))
    ];
  }

  it("counts assistant text, reasoning and every result in the retained byte budget", () => {
    const rounds = Array.from({ length: 12 }, (_, index) => round(index, 6_500));
    const history = [{ role: "user", content: "initial" }, ...rounds.flat()];
    const result = maskProviderHistory(provider, history, NOTE);
    expect(result.keptRounds).toBe(3);
    expect(result.bytesKept).toBe(Buffer.byteLength(JSON.stringify(rounds.slice(-3).flat())));
    expect(result.bytesKept).toBeLessThanOrEqual(48 * 1024);
    expect(Buffer.byteLength(JSON.stringify(rounds.slice(-4).flat()))).toBeGreaterThan(48 * 1024);
    expect(result.history.slice(-rounds.slice(-3).flat().length - 1, -1)).toEqual(rounds.slice(-3).flat());
    expect(result.bytesRemoved).toBe(Buffer.byteLength(JSON.stringify(history)) - Buffer.byteLength(JSON.stringify(result.history)));
  });

  it("keeps two complete rounds even when they exceed 48 KiB", () => {
    const rounds = Array.from({ length: 6 }, (_, index) => round(index, 60_000));
    const history = [{ role: "user", content: "initial" }, ...rounds.flat()];
    const result = maskProviderHistory(provider, history, NOTE);
    expect(result.keptRounds).toBe(2);
    expect(result.bytesKept).toBe(Buffer.byteLength(JSON.stringify(rounds.slice(-2).flat())));
    expect(result.bytesKept).toBeGreaterThan(48 * 1024);
    expect(result.history.slice(-rounds.slice(-2).flat().length - 1, -1)).toEqual(rounds.slice(-2).flat());
    for (const count of [0, 1, 2]) {
      const short = [{ role: "user", content: "initial" }, ...rounds.slice(0, count).flat()];
      expect(maskProviderHistory(provider, short, NOTE).history).toBe(short);
    }
  });

  it("caps the kept window at ten small rounds", () => {
    const rounds = Array.from({ length: 12 }, (_, index) => round(index, index < 2 ? 40_000 : 100, 20, 20));
    const result = maskProviderHistory(provider, [{ role: "user", content: "initial" }, ...rounds.flat()], NOTE);
    expect(result.keptRounds).toBe(10);
    expect(result.bytesKept).toBe(Buffer.byteLength(JSON.stringify(rounds.slice(-10).flat())));
    expect(result.maskedItems).toBeGreaterThan(0);
  });

  it("leaves low-gain history and an existing note byte-identical, including note overhead", () => {
    const rounds = Array.from({ length: 11 }, (_, index) => round(index, index === 0 ? 34_000 : 100, 20, 20));
    const history = [
      { role: "user", content: "initial" }, ...rounds[0]!, { role: "user", content: NOTE }, ...rounds.slice(1).flat()
    ];
    const serialized = JSON.stringify(history);
    const result = maskProviderHistory(provider, history, `${NOTE}\n${"plan description ".repeat(100)}`);
    expect(result.maskedItems).toBe(0);
    expect(result.bytesRemoved).toBe(0);
    expect(result.history).toBe(history);
    expect(JSON.stringify(result.history)).toBe(serialized);
  });

  it("accepts a net reduction of exactly 32 KiB, but skips one byte less", () => {
    const rounds = Array.from({ length: 11 }, (_, index) => round(index, index === 0 ? 34_000 : 100, 20, 20));
    const history = [{ role: "user", content: "initial" }, ...rounds.flat()];
    const expected = structuredClone(history) as any[];
    const field = provider === "deepseek" ? "content" : "output";
    const resultIndexes: number[] = [];
    for (let index = 1; index <= rounds[0]!.length; index += 1) {
      const item = expected[index];
      if (provider === "deepseek" && item.role === "assistant") item.reasoning_content = "[elided]";
      if (item.role === "tool" || item.type === "function_call_output") {
        resultIndexes.push(index);
        item[field] = `read_file (path=a.txt): 17000 bytes; ${PUBLIC_SUFFIX}`;
      }
    }
    expected.push({ role: "user", content: NOTE });
    const gain = Buffer.byteLength(JSON.stringify(history)) - Buffer.byteLength(JSON.stringify(expected));
    for (const offset of [-1, 0]) {
      const tuned = structuredClone(history) as any[];
      tuned[resultIndexes[0]!][field] = "x".repeat(17_000 + 32 * 1024 - gain + offset);
      const result = maskProviderHistory(provider, tuned, NOTE);
      if (offset === -1) {
        expect(result.history).toBe(tuned);
        expect(result.maskedItems).toBe(0);
      } else {
        expect(result.bytesRemoved).toBe(32 * 1024);
        expect(result.maskedItems).toBeGreaterThan(0);
      }
    }
  });
});
