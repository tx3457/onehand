export const WEB_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Onehand activity</title>
  <link rel="stylesheet" href="/app.css">
</head>
<body>
  <a class="skip-link" href="#main">Skip to content</a>
  <header class="site-header">
    <a class="brand" href="#runs" aria-label="Onehand activity home"><span class="brand-mark" aria-hidden="true">1h</span><span>Onehand</span></a>
    <nav aria-label="Primary navigation">
      <a data-nav="runs" href="#runs">Runs</a>
      <a data-nav="evaluations" href="#evaluations">Evaluations</a>
    </nav>
  </header>
  <main id="main" tabindex="-1">
    <p id="loading" class="status" role="status" aria-live="polite">Loading…</p>
    <div id="view"></div>
  </main>
  <footer>Local, read-only activity viewer</footer>
  <script src="/app.js" defer></script>
</body>
</html>`;

export const WEB_CSS = `:root {
  color-scheme: light dark;
  --bg: #f4f5f2;
  --surface: #ffffff;
  --surface-raised: #fafaf8;
  --text: #1e2421;
  --muted: #66706a;
  --line: #d9ded9;
  --accent: #165c48;
  --accent-soft: #dcece6;
  --success: #176b43;
  --danger: #9f2d35;
  --warning: #8a5b0a;
  --code: #18211d;
  --code-text: #e8efe9;
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); line-height: 1.55; }
a { color: var(--accent); }
button, a { -webkit-tap-highlight-color: transparent; }
button:focus-visible, a:focus-visible { outline: 3px solid #3b9d7f; outline-offset: 3px; }
.skip-link { position: fixed; left: 1rem; top: -5rem; z-index: 10; padding: .6rem 1rem; background: var(--surface); border-radius: .5rem; }
.skip-link:focus { top: 1rem; }
.site-header { display: flex; align-items: center; justify-content: space-between; gap: 1rem; min-height: 4.5rem; padding: .8rem max(1rem, calc((100vw - 76rem) / 2)); background: var(--surface); border-bottom: 1px solid var(--line); }
.brand { display: flex; align-items: center; gap: .65rem; color: var(--text); font-size: 1.05rem; font-weight: 750; text-decoration: none; }
.brand-mark { display: grid; place-items: center; width: 2.25rem; height: 2.25rem; border-radius: .7rem; background: var(--accent); color: white; font-family: ui-monospace, monospace; font-size: .85rem; }
nav { display: flex; gap: .35rem; }
nav a { padding: .5rem .75rem; border-radius: .55rem; color: var(--muted); font-weight: 650; text-decoration: none; }
nav a.active { background: var(--accent-soft); color: var(--accent); }
main { width: min(76rem, calc(100% - 2rem)); min-height: calc(100vh - 9rem); margin: 0 auto; padding: 2rem 0 4rem; }
footer { padding: 1.5rem; border-top: 1px solid var(--line); color: var(--muted); text-align: center; font-size: .85rem; }
h1, h2, h3 { line-height: 1.2; letter-spacing: -.02em; }
h1 { margin: 0 0 .45rem; font-size: clamp(1.75rem, 4vw, 2.5rem); }
h2 { margin: 0 0 1rem; font-size: 1.25rem; }
h3 { font-size: 1rem; }
p { max-width: 75ch; }
.eyebrow { margin: 0 0 .35rem; color: var(--accent); font-size: .76rem; font-weight: 750; letter-spacing: .08em; text-transform: uppercase; }
.lede { margin: 0 0 1.75rem; color: var(--muted); }
.status { margin: 0 0 1rem; color: var(--muted); }
.status:empty { display: none; }
.error { padding: 1rem; border: 1px solid #e5a4a8; border-radius: .7rem; background: #fff1f2; color: #7f1d26; }
.back { display: inline-block; margin-bottom: 1.25rem; font-weight: 650; text-decoration: none; }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 21rem), 1fr)); gap: 1rem; }
.card, .panel { border: 1px solid var(--line); border-radius: .85rem; background: var(--surface); box-shadow: 0 1px 2px rgb(0 0 0 / 4%); }
.card { display: block; padding: 1rem; color: inherit; text-decoration: none; transition: transform .12s ease, border-color .12s ease; }
.card:hover { transform: translateY(-1px); border-color: #9caf9f; }
.card h2, .card h3 { margin: .2rem 0 .75rem; }
.card h2 { display: -webkit-box; overflow: hidden; -webkit-box-orient: vertical; -webkit-line-clamp: 2; }
.panel { margin-top: 1rem; padding: clamp(1rem, 2.5vw, 1.5rem); overflow: hidden; }
.meta, .usage { display: flex; flex-wrap: wrap; gap: .45rem 1rem; margin: .65rem 0; color: var(--muted); font-size: .88rem; }
.usage { display: grid; grid-template-columns: repeat(auto-fit, minmax(8.5rem, 1fr)); margin-top: 1rem; }
.metric { padding: .75rem; border-radius: .65rem; background: var(--surface-raised); }
.metric strong { display: block; margin-top: .15rem; color: var(--text); font-size: 1.15rem; }
.badge { display: inline-flex; align-items: center; width: fit-content; padding: .15rem .5rem; border-radius: 99rem; background: var(--accent-soft); color: var(--accent); font-size: .76rem; font-weight: 750; }
.badge.error, .badge.invalid { background: #f9dadd; color: var(--danger); }
.badge.warning { background: #f7e8c9; color: var(--warning); }
.muted { color: var(--muted); }
.plan, .timeline, .checkpoint-list { display: grid; gap: .7rem; margin: 0; padding: 0; list-style: none; }
.plan li, .timeline li, .checkpoint-list li { padding: .85rem; border: 1px solid var(--line); border-radius: .65rem; background: var(--surface-raised); }
.plan-head, .timeline-head, .checkpoint-head { display: flex; justify-content: space-between; gap: 1rem; align-items: baseline; }
.evidence, .final-message { margin: .55rem 0 0; white-space: pre-wrap; overflow-wrap: anywhere; }
.timeline li { border-left: 4px solid #9caf9f; }
.timeline time { color: var(--muted); font-size: .78rem; }
.timeline-data { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: .25rem .65rem; margin: .55rem 0 0; font-size: .85rem; }
.timeline-data dt { color: var(--muted); }
.timeline-data dd { margin: 0; overflow-wrap: anywhere; white-space: pre-wrap; }
button { padding: .45rem .75rem; border: 1px solid var(--line); border-radius: .55rem; background: var(--surface); color: var(--text); font: inherit; font-weight: 650; cursor: pointer; }
button:hover { border-color: #8da194; }
.diff { max-height: 38rem; margin: 1rem 0 0; padding: .8rem 0; overflow: auto; border-radius: .65rem; background: var(--code); color: var(--code-text); font: .78rem/1.55 ui-monospace, SFMono-Regular, Consolas, monospace; }
.diff span { display: block; min-width: max-content; padding: 0 .85rem; white-space: pre; }
.diff .add { background: rgb(32 105 69 / 38%); color: #b8f3cd; }
.diff .del { background: rgb(136 42 50 / 38%); color: #ffc3c7; }
.diff .hunk { color: #92d5ee; }
.table-wrap { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; }
th, td { padding: .7rem .8rem; border-bottom: 1px solid var(--line); text-align: left; vertical-align: top; }
th { color: var(--muted); font-size: .75rem; letter-spacing: .04em; text-transform: uppercase; }
.chart { width: 100%; min-width: 36rem; height: auto; }
.chart-bg { fill: var(--surface-raised); }
.bar-resolved { fill: #258363; }
.bar-cost { fill: #bf7c27; }
.chart-label { fill: var(--text); font: 12px ui-sans-serif, system-ui, sans-serif; }
.chart-value { fill: var(--muted); font: 11px ui-monospace, monospace; }
.chart-legend { display: flex; gap: 1rem; margin: .4rem 0 1rem; color: var(--muted); font-size: .8rem; }
.legend-dot { width: .75rem; height: .75rem; border-radius: .2rem; display: inline-block; margin-right: .35rem; vertical-align: -.08rem; }
.resolved-dot { background: #258363; }
.cost-dot { background: #bf7c27; }
.markdown { overflow-wrap: anywhere; }
.markdown pre { overflow: auto; padding: 1rem; border-radius: .65rem; background: var(--code); color: var(--code-text); }
.markdown code { padding: .08rem .28rem; border-radius: .25rem; background: #e9eeea; font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: .9em; }
.markdown pre code { padding: 0; background: transparent; }
.markdown blockquote { margin-left: 0; padding-left: 1rem; border-left: 3px solid var(--line); color: var(--muted); }
.empty { padding: 2rem; border: 1px dashed var(--line); border-radius: .85rem; color: var(--muted); text-align: center; }
@media (prefers-color-scheme: dark) {
  :root { --bg: #111613; --surface: #18201c; --surface-raised: #1d2722; --text: #edf2ee; --muted: #aab6af; --line: #344139; --accent: #7bdbb8; --accent-soft: #203e34; --code: #0b0f0d; }
  .error { background: #3a1d20; border-color: #7e3940; color: #ffc3c7; }
  .markdown code { background: #2a352f; }
}
@media (max-width: 42rem) {
  .site-header { align-items: flex-start; }
  .brand > span:last-child { display: none; }
  nav a { padding-inline: .6rem; }
  main { width: min(100% - 1rem, 76rem); padding-top: 1.25rem; }
  .panel { border-radius: .7rem; }
  .plan-head, .timeline-head, .checkpoint-head { align-items: flex-start; flex-direction: column; gap: .35rem; }
}`;

export const WEB_JS = `"use strict";
const view = document.getElementById("view");
const loading = document.getElementById("loading");
const svgNamespace = "http://www.w3.org/2000/svg";
let routeGeneration = 0;

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

function link(href, className, text) {
  const node = element("a", className, text);
  node.href = href;
  return node;
}

function append(parent) {
  for (let index = 1; index < arguments.length; index += 1) {
    const child = arguments[index];
    if (child) parent.appendChild(child);
  }
  return parent;
}

function setStatus(message, generation) {
  if (generation === routeGeneration) loading.textContent = message || "";
}

async function api(path) {
  const response = await fetch(path, { headers: { Accept: "application/json" }, credentials: "same-origin" });
  let body = {};
  try { body = await response.json(); } catch (_error) { body = {}; }
  if (!response.ok) throw new Error(typeof body.error === "string" ? body.error : "Request failed (" + response.status + ")");
  return body;
}

function formatNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? new Intl.NumberFormat().format(value) : "—";
}

function formatPercent(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  return new Intl.NumberFormat(undefined, { style: "percent", maximumFractionDigits: 1 }).format(value);
}

function formatMoney(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  return new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 4 }).format(value);
}

function formatDuration(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  if (value < 1000) return Math.round(value) + " ms";
  if (value < 60000) return (value / 1000).toFixed(1) + " s";
  return (value / 60000).toFixed(1) + " min";
}

function formatDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Unknown time" : date.toLocaleString();
}

function valueText(value) {
  if (value === null || value === undefined) return "—";
  if (typeof value === "string") return value.length > 1200 ? value.slice(0, 1200) + "…" : value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    const text = JSON.stringify(value, null, 2);
    return text.length > 1200 ? text.slice(0, 1200) + "…" : text;
  } catch (_error) { return "[unavailable]"; }
}

function badge(value) {
  const normalized = String(value || "unknown").toLowerCase();
  let className = "badge";
  if (/error|failed|blocked|invalid/.test(normalized)) className += " error";
  else if (/pending|running|in_progress|partial/.test(normalized)) className += " warning";
  return element("span", className, value || "unknown");
}

function pageHeading(eyebrow, title, description) {
  const wrapper = document.createDocumentFragment();
  append(wrapper, element("p", "eyebrow", eyebrow), element("h1", "", title), element("p", "lede", description));
  return wrapper;
}

function metric(label, value) {
  const node = element("div", "metric");
  append(node, element("span", "muted", label), element("strong", "", value));
  return node;
}

function usageGrid(usage) {
  const node = element("div", "usage");
  const data = usage || {};
  append(node,
    metric("Model rounds", formatNumber(data.modelRounds)),
    metric("Tool calls", formatNumber(data.toolCalls)),
    metric("Input tokens", formatNumber(data.inputTokens)),
    metric("Output tokens", formatNumber(data.outputTokens)),
    metric("Total tokens", formatNumber(data.totalTokens)),
    metric("Wall time", formatDuration(data.wallTimeMs))
  );
  if (data.subagentRounds) node.appendChild(metric("Subagent rounds", formatNumber(data.subagentRounds)));
  return node;
}

function runCard(run) {
  const card = link("#runs/" + encodeURIComponent(run.id), "card", "");
  const top = element("div", "plan-head");
  append(top, badge(run.status), element("span", "muted", formatDate(run.updatedAt)));
  append(card, top, element("h2", "", run.task || "Untitled run"));
  const meta = element("div", "meta");
  append(meta,
    element("span", "", run.repo || "Unknown repository"),
    element("span", "", [run.provider, run.model].filter(Boolean).join(" · ") || "Unknown model"),
    element("span", "", run.stopReason ? "Stopped: " + run.stopReason : "")
  );
  append(card, meta, usageGrid(run.usage));
  return card;
}

async function showRuns(target) {
  const data = await api("/api/runs");
  append(target, pageHeading("Activity", "Runs", "Recent local agent runs, ordered by their latest update."));
  if (!Array.isArray(data.runs) || data.runs.length === 0) {
    target.appendChild(element("p", "empty", "No runs found in the configured directory."));
    return;
  }
  const grid = element("div", "grid");
  data.runs.forEach(function (run) { grid.appendChild(runCard(run)); });
  target.appendChild(grid);
}

function planPanel(plan) {
  const panel = element("section", "panel");
  append(panel, element("h2", "", "Plan"));
  if (plan && plan.status) panel.appendChild(badge(plan.status));
  const list = element("ol", "plan");
  const steps = plan && Array.isArray(plan.steps) ? plan.steps : [];
  steps.forEach(function (step) {
    const item = document.createElement("li");
    const head = element("div", "plan-head");
    append(head, element("strong", "", step.description || step.id || "Step"), badge(step.status));
    item.appendChild(head);
    if (step.evidence) item.appendChild(element("p", "evidence muted", valueText(step.evidence)));
    list.appendChild(item);
  });
  panel.appendChild(steps.length ? list : element("p", "muted", "No plan steps recorded."));
  return panel;
}

function timelinePanel(events, truncated, incomplete) {
  const panel = element("section", "panel");
  append(panel, element("h2", "", "Timeline"));
  if (truncated) panel.appendChild(element("p", "muted", "Showing at most the latest 2,000 events (byte limit also applies)."));
  if (incomplete) panel.appendChild(element("p", "badge warning", "Trace data is incomplete."));
  const list = element("ol", "timeline");
  (Array.isArray(events) ? events : []).forEach(function (entry) {
    const item = document.createElement("li");
    const head = element("div", "timeline-head");
    append(head, element("strong", "", String(entry.event || "event").replaceAll("_", " ")), element("time", "", formatDate(entry.ts)));
    item.appendChild(head);
    const data = entry.data && typeof entry.data === "object" ? entry.data : {};
    const details = element("dl", "timeline-data");
    Object.entries(data).forEach(function (pair) {
      append(details, element("dt", "", pair[0]), element("dd", "", valueText(pair[1])));
    });
    if (details.children.length) item.appendChild(details);
    list.appendChild(item);
  });
  panel.appendChild(list.children.length ? list : element("p", "muted", "No trace events recorded."));
  return panel;
}

function diffView(diff) {
  const pre = element("pre", "diff");
  String(diff || "No differences from the current tree.").split("\\n").forEach(function (line) {
    let className = "";
    if (line.startsWith("+") && !line.startsWith("+++")) className = "add";
    else if (line.startsWith("-") && !line.startsWith("---")) className = "del";
    else if (line.startsWith("@@")) className = "hunk";
    pre.appendChild(element("span", className, line || " "));
  });
  return pre;
}

async function checkpointsPanel(runId) {
  const panel = element("section", "panel");
  append(panel, element("h2", "", "Checkpoints"), element("p", "muted", "Shadow-git snapshots for this run's repository. Restoration is intentionally unavailable here."));
  const target = element("div", "");
  panel.appendChild(target);
  try {
    const data = await api("/api/runs/" + encodeURIComponent(runId) + "/checkpoints");
    const checkpoints = Array.isArray(data.checkpoints) ? data.checkpoints : [];
    if (!checkpoints.length) {
      target.appendChild(element("p", "muted", "No checkpoints found."));
      return panel;
    }
    const list = element("ul", "checkpoint-list");
    checkpoints.forEach(function (checkpoint) {
      const item = document.createElement("li");
      const head = element("div", "checkpoint-head");
      append(head,
        element("strong", "", checkpoint.label || checkpoint.id),
        element("span", "muted", formatDate(checkpoint.createdAt))
      );
      const button = element("button", "", "View diff");
      button.type = "button";
      const output = element("div", "");
      button.addEventListener("click", async function () {
        button.disabled = true;
        button.textContent = "Loading…";
        output.replaceChildren();
        try {
          const result = await api("/api/runs/" + encodeURIComponent(runId) + "/checkpoints/" + encodeURIComponent(checkpoint.id));
          output.appendChild(diffView(result.diff));
          if (result.truncated) output.prepend(element("p", "muted", "Diff output was truncated."));
          button.textContent = "Refresh diff";
        } catch (error) {
          output.appendChild(element("p", "error", error instanceof Error ? error.message : "Unable to load diff."));
          button.textContent = "Retry diff";
        } finally { button.disabled = false; }
      });
      append(item, head, checkpoint.notes ? element("p", "muted", checkpoint.notes) : null, button, output);
      list.appendChild(item);
    });
    target.appendChild(list);
  } catch (error) {
    target.appendChild(element("p", "error", error instanceof Error ? error.message : "Unable to load checkpoints."));
  }
  return panel;
}

async function showRun(runId, target) {
  const run = await api("/api/runs/" + encodeURIComponent(runId));
  append(target,
    link("#runs", "back", "← All runs"),
    pageHeading(run.repo || "Run detail", run.task || "Untitled run", [run.provider, run.model].filter(Boolean).join(" · "))
  );
  const status = element("div", "meta");
  append(status, badge(run.status), element("span", "", run.stopReason ? "Stop reason: " + run.stopReason : ""), element("span", "", "Updated " + formatDate(run.updatedAt)));
  append(target, status, usageGrid(run.usage), planPanel(run.plan), timelinePanel(run.timeline, run.timelineTruncated, run.timelineIncomplete));
  const finalPanel = element("section", "panel");
  append(finalPanel, element("h2", "", "Final message"), element("p", "final-message", run.finalMessage || "No final message recorded."));
  append(target, finalPanel, await checkpointsPanel(runId));
}

function evaluationCard(evaluation) {
  if (evaluation.invalidated) {
    const card = element("article", "card");
    append(card, badge("Invalidated"), element("h2", "", evaluation.id), element("p", "muted", "This result directory is excluded from evaluation views."));
    return card;
  }
  const card = link("#evaluations/" + encodeURIComponent(evaluation.id), "card", "");
  append(card, badge("Available"), element("h2", "", evaluation.id), element("p", "muted", "View metrics, comparisons, and analysis."));
  return card;
}

async function showEvaluations(target) {
  const data = await api("/api/evaluations");
  append(target, pageHeading("Benchmarks", "Evaluations", "Local deterministic and recorded evaluation results."));
  if (!Array.isArray(data.evaluations) || data.evaluations.length === 0) {
    target.appendChild(element("p", "empty", "No evaluation results found in the configured directory."));
    return;
  }
  const grid = element("div", "grid");
  data.evaluations.forEach(function (evaluation) { grid.appendChild(evaluationCard(evaluation)); });
  target.appendChild(grid);
}

function variantTable(variants) {
  const wrap = element("div", "table-wrap");
  const table = document.createElement("table");
  const thead = document.createElement("thead");
  const header = document.createElement("tr");
  ["Variant", "Resolved", "Cost / run", "Rounds", "Input tokens", "Output tokens", "Completeness"].forEach(function (title) {
    header.appendChild(element("th", "", title));
  });
  thead.appendChild(header);
  const tbody = document.createElement("tbody");
  variants.forEach(function (variant) {
    const row = document.createElement("tr");
    [variant.name, formatPercent(variant.resolvedRate), formatMoney(variant.costPerRun), formatNumber(variant.meanRounds), formatNumber(variant.meanInputTokens), formatNumber(variant.meanOutputTokens), variant.completenessLabel || "Completeness unrecorded"].forEach(function (value) {
      row.appendChild(element("td", "", value));
    });
    tbody.appendChild(row);
  });
  append(table, thead, tbody);
  wrap.appendChild(table);
  return wrap;
}

function svgElement(tag, attributes, text) {
  const node = document.createElementNS(svgNamespace, tag);
  Object.entries(attributes || {}).forEach(function (pair) { node.setAttribute(pair[0], String(pair[1])); });
  if (text !== undefined) node.textContent = String(text);
  return node;
}

function comparisonChart(variants) {
  const wrap = element("div", "table-wrap");
  const legend = element("div", "chart-legend");
  const resolved = element("span", "");
  append(resolved, element("i", "legend-dot resolved-dot"), document.createTextNode("Resolved rate"));
  const cost = element("span", "");
  append(cost, element("i", "legend-dot cost-dot"), document.createTextNode("Cost per run (relative)"));
  append(legend, resolved, cost);
  wrap.appendChild(legend);
  const rowHeight = 62;
  const width = 760;
  const height = Math.max(90, variants.length * rowHeight + 24);
  const svg = svgElement("svg", { class: "chart", viewBox: "0 0 " + width + " " + height, role: "img", "aria-label": "Cost and resolved-rate comparison by variant" });
  const maxCost = Math.max(0, ...variants.map(function (variant) { return typeof variant.costPerRun === "number" ? variant.costPerRun : 0; }));
  variants.forEach(function (variant, index) {
    const y = index * rowHeight + 12;
    const resolvedValue = typeof variant.resolvedRate === "number" ? Math.max(0, Math.min(1, variant.resolvedRate)) : 0;
    const costValue = typeof variant.costPerRun === "number" && maxCost > 0 ? Math.max(0, variant.costPerRun / maxCost) : 0;
    svg.appendChild(svgElement("text", { x: 0, y: y + 13, class: "chart-label" }, variant.name));
    svg.appendChild(svgElement("rect", { x: 150, y: y, width: 500, height: 16, rx: 3, class: "chart-bg" }));
    svg.appendChild(svgElement("rect", { x: 150, y: y, width: resolvedValue * 500, height: 16, rx: 3, class: "bar-resolved" }));
    svg.appendChild(svgElement("text", { x: 660, y: y + 12, class: "chart-value" }, formatPercent(variant.resolvedRate)));
    svg.appendChild(svgElement("rect", { x: 150, y: y + 22, width: 500, height: 12, rx: 3, class: "chart-bg" }));
    svg.appendChild(svgElement("rect", { x: 150, y: y + 22, width: costValue * 500, height: 12, rx: 3, class: "bar-cost" }));
    svg.appendChild(svgElement("text", { x: 660, y: y + 32, class: "chart-value" }, formatMoney(variant.costPerRun)));
  });
  wrap.appendChild(svg);
  return wrap;
}

async function showEvaluation(evaluationId, target) {
  const data = await api("/api/evaluations/" + encodeURIComponent(evaluationId));
  append(target, link("#evaluations", "back", "← All evaluations"), pageHeading("Evaluation", data.id, "Variant metrics and rendered local reports."));
  const overall = element("section", "panel");
  const tokenMeans = element("div", "usage");
  append(tokenMeans,
    metric("Mean input tokens", formatNumber(data.meanInputTokens)),
    metric("Mean output tokens", formatNumber(data.meanOutputTokens))
  );
  append(overall, element("h2", "", "Overall completeness"), badge(data.completenessLabel || "Completeness unrecorded"), tokenMeans);
  target.appendChild(overall);
  const variants = Array.isArray(data.variants) ? data.variants : [];
  const metrics = element("section", "panel");
  append(metrics, element("h2", "", "Variant summary"), element("p", "muted", "A dash means the value was not recorded."));
  if (variants.length) append(metrics, variantTable(variants), comparisonChart(variants));
  else metrics.appendChild(element("p", "muted", "No variant metrics found."));
  target.appendChild(metrics);
  (Array.isArray(data.reports) ? data.reports : []).forEach(function (report) {
    const panel = element("section", "panel");
    append(panel, element("h2", "", report.name));
    const markdown = element("div", "markdown");
    // The server supplies HTML produced only by the escaping Markdown renderer.
    markdown.innerHTML = typeof report.html === "string" ? report.html : "";
    panel.appendChild(markdown);
    target.appendChild(panel);
  });
}

function updateNavigation(section) {
  document.querySelectorAll("[data-nav]").forEach(function (node) {
    if (node.getAttribute("data-nav") === section) node.classList.add("active");
    else node.classList.remove("active");
  });
}

async function route() {
  const generation = ++routeGeneration;
  const target = element("div", "route-view");
  view.replaceChildren(target);
  setStatus("Loading…", generation);
  let raw = location.hash.startsWith("#") ? location.hash.slice(1) : location.hash;
  if (raw.startsWith("/")) raw = raw.slice(1);
  if (!raw) raw = "runs";
  const parts = raw.split("/");
  const section = parts[0] === "evaluations" ? "evaluations" : "runs";
  updateNavigation(section);
  try {
    if (section === "evaluations" && parts[1]) await showEvaluation(decodeURIComponent(parts[1]), target);
    else if (section === "evaluations") await showEvaluations(target);
    else if (parts[1]) await showRun(decodeURIComponent(parts[1]), target);
    else await showRuns(target);
    setStatus("", generation);
  } catch (error) {
    setStatus("", generation);
    if (generation === routeGeneration) target.appendChild(element("p", "error", error instanceof Error ? error.message : "Unable to load this page."));
  }
}

window.addEventListener("hashchange", route);
route();`;
