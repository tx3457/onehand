import { execFileSync } from "node:child_process";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { WEB_JS } from "../src/web/assets.js";
import { renderMarkdown } from "../src/web/markdown.js";

class FakeElement {
  children: FakeElement[] = [];
  className = "";
  textContent = "";
  href = "";

  appendChild(child: FakeElement): FakeElement {
    this.children.push(child);
    return child;
  }

  replaceChildren(...children: FakeElement[]) {
    this.children = children;
  }

  setAttribute() {}
  addEventListener() {}
}

describe("renderMarkdown", () => {
  it("escapes raw HTML before applying Markdown formatting", () => {
    const html = renderMarkdown("# Report\n\n<script>alert('x')</script> **safe**");

    expect(html).toContain("<h1>Report</h1>");
    expect(html).toContain("&lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt; <strong>safe</strong>");
    expect(html).not.toContain("<script>");
  });

  it("renders fenced and inline code without interpreting Markdown inside code", () => {
    const html = renderMarkdown("Use `a < b` now.\n\n```ts\nconst tag = '<b>no</b>';\n```");

    expect(html).toContain("<p>Use <code>a &lt; b</code> now.</p>");
    expect(html).toContain("<pre><code class=\"language-ts\">const tag = &#39;&lt;b&gt;no&lt;/b&gt;&#39;;</code></pre>");
    expect(html).not.toContain("<strong>");
  });

  it("renders unordered and ordered lists", () => {
    const html = renderMarkdown("- first\n- **second**\n\n1. alpha\n2. beta");

    expect(html).toContain("<ul><li>first</li><li><strong>second</strong></li></ul>");
    expect(html).toContain("<ol><li>alpha</li><li>beta</li></ol>");
  });

  it("makes forward progress for empty list items", () => {
    const script = [
      'import { renderMarkdown } from "./src/web/markdown.ts";',
      'const rendered = renderMarkdown("- \\n\\n1. ");',
      'if (rendered !== "<ul><li></li></ul>\\n<ol><li></li></ol>") process.exit(2);'
    ].join("\n");

    expect(() => execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: process.cwd(), timeout: 5_000, stdio: "pipe"
    })).not.toThrow();
  });

  it("renders a table with escaped cells and alignment-free markup", () => {
    const html = renderMarkdown([
      "| Variant | Result |",
      "| --- | ---: |",
      "| A | **50%** |",
      "| <B> | `ok` |"
    ].join("\n"));

    expect(html).toContain("<table><thead><tr><th>Variant</th><th>Result</th></tr></thead>");
    expect(html).toContain("<tbody><tr><td>A</td><td><strong>50%</strong></td></tr>");
    expect(html).toContain("<tr><td>&lt;B&gt;</td><td><code>ok</code></td></tr></tbody></table>");
  });

  it("bounds work and output for adversarially wide and long tables", () => {
    const script = [
      'import { renderMarkdown } from "./src/web/markdown.ts";',
      'const header = "|" + Array.from({ length: 5000 }, (_, index) => "h" + index).join("|") + "|";',
      'const separator = "|" + Array.from({ length: 5000 }, () => "---").join("|") + "|";',
      'const source = [header, separator, ...Array.from({ length: 5000 }, () => "| x |")].join("\\n");',
      'const rendered = renderMarkdown(source);',
      'if (Buffer.byteLength(rendered) >= 1024 * 1024 || !rendered.includes("[table truncated:")) process.exit(2);'
    ].join("\n");

    expect(() => execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: process.cwd(), timeout: 5_000, stdio: "pipe"
    })).not.toThrow();
  });

  it("renders malformed bracket floods in bounded time", () => {
    const script = [
      'import { renderMarkdown } from "./src/web/markdown.ts";',
      'const rendered = renderMarkdown("[".repeat(250_000) + "](" + "(".repeat(250_000));',
      'if (rendered.length > 600_000) process.exit(2);'
    ].join("\n");

    expect(() => execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: process.cwd(), timeout: 5_000, stdio: "pipe"
    })).not.toThrow();
  });

  it("allows local and HTTPS links but leaves unsafe URLs as text", () => {
    const html = renderMarkdown([
      "[local](./report.md)",
      "[secure](https://example.test/report)",
      "[bad](javascript:alert(1))"
    ].join("\n\n"));

    expect(html).toContain('<a href="./report.md">local</a>');
    expect(html).toContain('<a href="https://example.test/report">secure</a>');
    expect(html).toContain("<p>bad</p>");
    expect(html).not.toContain("javascript:");
  });
});

describe("evaluation browser rendering", () => {
  it("renders readable completeness, recorded tokens, and dashes only for missing tokens", () => {
    const document = {
      getElementById: () => new FakeElement(),
      createElement: () => new FakeElement(),
      createElementNS: () => new FakeElement(),
      createDocumentFragment: () => new FakeElement(),
      createTextNode: (text: string) => Object.assign(new FakeElement(), { textContent: text }),
      querySelectorAll: () => []
    };
    const context = {
      document,
      window: { addEventListener() {} },
      location: { hash: "#runs" },
      fetch: async () => ({ ok: true, json: async () => ({ runs: [] }) }),
      Intl: { NumberFormat: class { format(value: number) { return String(value); } } }
    } as Record<string, unknown>;
    runInNewContext(`${WEB_JS}\nglobalThis.renderVariantTable = variantTable;`, context);
    const renderVariantTable = context.renderVariantTable as (variants: unknown[]) => FakeElement;

    const wrap = renderVariantTable([
      { name: "recorded", resolvedRate: null, costPerRun: null, meanRounds: null, meanInputTokens: 0, meanOutputTokens: 17, completenessLabel: "complete · 25/25 runs" },
      { name: "missing", resolvedRate: null, costPerRun: null, meanRounds: null, meanInputTokens: null, meanOutputTokens: null, completenessLabel: "incomplete · 24/25 runs · 1 missing" }
    ]);
    const rows = wrap.children[0]!.children[1]!.children;

    expect(rows[0]!.children.map((cell) => cell.textContent)).toEqual([
      "recorded", "—", "—", "—", "0", "17", "complete · 25/25 runs"
    ]);
    expect(rows[1]!.children.map((cell) => cell.textContent)).toEqual([
      "missing", "—", "—", "—", "—", "—", "incomplete · 24/25 runs · 1 missing"
    ]);
  });
});
