# OneHand Coding Agent
[![CI](https://github.com/tx3457/onehand/actions/workflows/ci.yml/badge.svg)](https://github.com/tx3457/onehand/actions/workflows/ci.yml) [![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

OneHand is a local coding-agent CLI for repository-scoped maintenance tasks. It implements an explicit **inspect → plan → act → observe → revise → verify → finish** loop. Editing runs succeed only after every plan step is complete and a passing verification follows the latest write; ask-mode chat can finish with a plain answer.

## Highlights

- **Verified completion:** the latest write must have passing verification, all plan steps must be complete, and the model must call `finish_task`.
- **Runtime-enforced tool governance:** schema validation, a plan gate, path guards, command policy, and step/token/time/retry budgets.
- **Recovery:** persisted run state and resume, redacted traces, and shadow-Git checkpoints with undo/rewind.
- **Extensions:** MCP tools with permissions, plus read-only explore and review sub-agents with separate histories and shared budgets.
- **Measured evaluation:** a pre-registered SWE-bench Verified window with explicit profiles, matched model and budgets, and dev/holdout splits.

## Results (SWE-bench Verified, pre-registered)

Measured with the same model (`deepseek-flash`) and budgets in one pre-registered final window, graded by the official harness.

| dataset | resolved: baseline → `ctx-sandbox` | cost per run (95% CI) |
|---|---|---|
| Verified Mini (dev set), 50 tasks × 3 runs | 72.0% → 72.0% (non-inferior at a 10 pp margin) | **−20.7%** (−28.0% to −13.1%) |
| Holdout (never used in development), 46 tasks × 1 run | 73.9% → 78.3% (non-inferior at a 10 pp margin) | **−16.1%** (−28.1% to −2.5%) |

Descriptive bundled shifts (component effects not isolated): with windowed reads and grouped search, tokens per `read_file` fall from about 2.7–3.1k to about 1.0k; observations become compact text; policy rejections roughly halve (Mini 31.8% → 16.5%, holdout 25.4% → 13.9%).
The resolved rate did not detectably change; CIs allow small losses. Negative development results are also reported.
[Full report, deviations, and limitations](docs/benchmarks/2026-09-26/README.md) · [Where the agent fails](docs/benchmarks/2026-09-26/failure-analysis.md).

For reference, mini-swe-agent 2.4.6, with the same model, the same 80-step ceiling and a $1.08 cost cap matched to OneHand's worst-case run cost, resolved 72% on Mini at $0.059 per run; this is descriptive only, not a controlled comparison.

## How it works

```text
task
  ↓
model chooses inspection / planning / action tool
  ↓
runtime validates schema, plan gate, path, command, and budgets
  ↓
tool executes and returns a structured observation
  ↓
model updates the plan or chooses the next tool
  ↓
latest write verified + all steps complete + finish_task
```

See [architecture](docs/architecture.md) for the implementation.

## Quick start

Requirements: Node.js 20 or newer. From this checkout:

```bash
npm ci
npm run build

export OPENAI_API_KEY=...
node dist/cli.js run "fix the failing test" \
  --repo /path/to/trusted/repo \
  --test "npm test"
node dist/cli.js chat --repo /path/to/trusted/repo --mode edit
```

To see the loop without an API key, `npm run demo` runs the real planning gate, tools, edit, test runner and finish condition with scripted model decisions (regression evidence, not a model-quality result).

OneHand is a tool-using agent, not a general-purpose sandbox. Running tests or build programs can execute code from the target repository, so use it only with repositories you trust. See [SECURITY.md](SECURITY.md).

## Documentation

- [Usage](docs/usage.md): provider setup, interactive commands, Web UI, and agent profiles.
- [Extensions](docs/extensions.md): MCP configuration, permissions, and read-only sub-agents.
- [Safety](docs/safety.md): verified completion, resume, and the tool safety boundary.
- [Evaluation](docs/evaluation.md): offline verification, protocols, and detailed result caveats.
- [Architecture](docs/architecture.md): agent loop and implementation structure.
- [Benchmark report](docs/benchmarks/2026-09-26/README.md): pre-registered results, deviations, and limitations.
- [Where the agent fails](docs/benchmarks/2026-09-26/failure-analysis.md): failure analysis.
- [Changelog](CHANGELOG.md): release history.
- [Security](SECURITY.md): trust assumptions and security policy.
- [Evaluation harness](eval/README.md): running and grading evaluations.

## Project status

The final evaluation window is complete (see Results above). Local use defaults to `ctx` (E4+E3). `ctx-sandbox` adds the Docker-only E8. E5, E1 and E9 remain explicit experiment flags that were not adopted. Checkpoints, project instructions, MCP, sub-agents, the Web UI, and the SWE-bench harness are implemented. The local CLI does not isolate repository programs, and there is no distributed execution or long-term semantic memory.

## License

[MIT](LICENSE)
