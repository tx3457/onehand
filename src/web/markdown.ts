const MAX_TABLE_COLUMNS = 64;
const MAX_TABLE_ROWS = 512;

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function renderInline(value: string): string {
  const code: string[] = [];
  let rendered = value.replace(/`([^`\n]+)`/g, (_match, contents: string) => {
    const index = code.push(`<code>${contents}</code>`) - 1;
    return `\u0000CODE${index}\u0000`;
  });

  rendered = renderLinks(rendered);
  rendered = rendered.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
  return rendered.replace(/\u0000CODE(\d+)\u0000/g, (_match, index: string) => code[Number(index)] ?? "");
}

function renderLinks(value: string): string {
  const output: string[] = [];
  let cursor = 0;
  while (cursor < value.length) {
    const open = value.indexOf("[", cursor);
    if (open === -1) {
      output.push(value.slice(cursor));
      break;
    }
    output.push(value.slice(cursor, open));

    let close = -1;
    const labelLimit = Math.min(value.length, open + 502);
    for (let index = open + 1; index < labelLimit; index += 1) {
      if (value[index] === "[") break;
      if (value[index] === "]") {
        close = index;
        break;
      }
    }
    if (close === -1 || value[close + 1] !== "(") {
      output.push("[");
      cursor = open + 1;
      continue;
    }

    const hrefStart = close + 2;
    const hrefLimit = Math.min(value.length, hrefStart + 2_001);
    let hrefEnd = -1;
    let depth = 1;
    for (let index = hrefStart; index < hrefLimit; index += 1) {
      const character = value[index] ?? "";
      if (/\s/.test(character)) break;
      if (character === "(") depth += 1;
      if (character === ")") {
        depth -= 1;
        if (depth === 0) {
          hrefEnd = index;
          break;
        }
      }
    }
    if (hrefEnd === -1) {
      output.push("[");
      cursor = open + 1;
      continue;
    }

    const label = value.slice(open + 1, close);
    const href = value.slice(hrefStart, hrefEnd);
    output.push(isSafeHref(href) ? `<a href="${href}">${label}</a>` : label);
    cursor = hrefEnd + 1;
  }
  return output.join("");
}

function isSafeHref(href: string): boolean {
  return /^(?:https?:\/\/|\.{0,2}\/|#)/i.test(href);
}

function tableCells(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed.split("|").map((cell) => cell.trim());
}

function limitedTableCells(line: string): { cells: string[]; truncated: boolean } {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  const cells: string[] = [];
  let start = 0;
  while (cells.length < MAX_TABLE_COLUMNS) {
    const separator = trimmed.indexOf("|", start);
    if (separator === -1) {
      cells.push(trimmed.slice(start).trim());
      return { cells, truncated: false };
    }
    cells.push(trimmed.slice(start, separator).trim());
    start = separator + 1;
  }
  return { cells, truncated: start < trimmed.length };
}

function isTableSeparator(line: string): boolean {
  const cells = tableCells(line);
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function startsBlock(lines: string[], index: number): boolean {
  const line = lines[index] ?? "";
  return line.trim() === ""
    || /^```/.test(line)
    || /^#{1,6}\s+/.test(line)
    || /^\s*[-*+]\s+/.test(line)
    || /^\s*\d+\.\s+/.test(line)
    || (line.includes("|") && isTableSeparator(lines[index + 1] ?? ""));
}

export function renderMarkdown(source: string): string {
  const lines = escapeHtml(source.replace(/\r\n?/g, "\n")).split("\n");
  const output: string[] = [];

  for (let index = 0; index < lines.length;) {
    const line = lines[index] ?? "";
    if (line.trim() === "") {
      index += 1;
      continue;
    }

    const fence = /^```([\w-]*)\s*$/.exec(line);
    if (fence) {
      const contents: string[] = [];
      index += 1;
      while (index < lines.length && !/^```\s*$/.test(lines[index] ?? "")) {
        contents.push(lines[index] ?? "");
        index += 1;
      }
      if (index < lines.length) index += 1;
      const language = fence[1] ? ` class="language-${fence[1]}"` : "";
      output.push(`<pre><code${language}>${contents.join("\n")}</code></pre>`);
      continue;
    }

    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading) {
      const level = heading[1]?.length ?? 1;
      output.push(`<h${level}>${renderInline(heading[2] ?? "")}</h${level}>`);
      index += 1;
      continue;
    }

    if (line.includes("|") && isTableSeparator(lines[index + 1] ?? "")) {
      const header = limitedTableCells(line);
      const headers = header.cells;
      index += 2;
      const rows: string[][] = [];
      let rowCount = 0;
      while (index < lines.length && (lines[index] ?? "").includes("|") && (lines[index] ?? "").trim() !== "") {
        if (rows.length < MAX_TABLE_ROWS) {
          rows.push(limitedTableCells(lines[index] ?? "").cells);
        }
        rowCount += 1;
        index += 1;
      }
      const head = headers.map((cell) => `<th>${renderInline(cell)}</th>`).join("");
      const body = rows.map((row) => `<tr>${row.map((cell) => `<td>${renderInline(cell)}</td>`).join("")}</tr>`).join("");
      output.push(`<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`);
      if (header.truncated || rowCount > MAX_TABLE_ROWS) {
        output.push(`<p>[table truncated: showing at most ${MAX_TABLE_COLUMNS} columns and ${MAX_TABLE_ROWS} rows]</p>`);
      }
      continue;
    }

    const unordered = /^\s*[-*+]\s+/.test(line);
    const ordered = /^\s*\d+\.\s+/.test(line);
    if (unordered || ordered) {
      const tag = ordered ? "ol" : "ul";
      const pattern = ordered ? /^\s*\d+\.\s+(.*)$/ : /^\s*[-*+]\s+(.*)$/;
      const items: string[] = [];
      while (index < lines.length) {
        const item = pattern.exec(lines[index] ?? "");
        if (!item) break;
        items.push(`<li>${renderInline(item[1] ?? "")}</li>`);
        index += 1;
      }
      output.push(`<${tag}>${items.join("")}</${tag}>`);
      continue;
    }

    const paragraph: string[] = [line.trim()];
    index += 1;
    while (index < lines.length && !startsBlock(lines, index)) {
      paragraph.push((lines[index] ?? "").trim());
      index += 1;
    }
    output.push(`<p>${renderInline(paragraph.join(" "))}</p>`);
  }

  return output.join("\n");
}
