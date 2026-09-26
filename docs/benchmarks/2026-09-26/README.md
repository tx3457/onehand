# OneHand on SWE-bench Verified: final evaluation, 2026-09-26

This is the pre-registered final window. Hypotheses, arms, metrics and tests were committed in [preregistration.md](preregistration.md) (commit `e30b568`) before any baseline or ctx-sandbox run of this window. Every number below comes from this window, with these exceptions, each labeled where it appears: development-stage findings (their artifacts are in [dev/](dev/)), the external reference, and the project-wide spend.

## Result

With the same model and budgets, the context-engineering and sandbox-policy profile (`ctx-sandbox`) lowered the cost per run on both the development set and the untouched holdout. It was non-inferior in resolved rate at the pre-specified 10 pp margin. The resolved-rate CIs still allow losses of up to 4.7 pp (Mini) and 6.5 pp (holdout).

| dataset | runs | resolved: baseline → ctx-sandbox | resolved Δ (95% CI) | cost per run: baseline → ctx-sandbox | cost change (95% CI) |
|---|---:|---|---|---|---|
| Mini (dev), 50 tasks × 3 reps | 300 | 72.0% → 72.0% | +0.0 pp (−4.7, +4.7): **non-inferior** | $0.0624 → $0.0551 | **−20.7% (−28.0%, −13.1%)**, Holm p = 2e-4 |
| Holdout, 46 tasks × 1 rep | 92 | 73.9% → 78.3% | +4.3 pp (−6.5, +15.2): **non-inferior** | $0.0551 → $0.0488 | **−16.1% (−28.1%, −2.5%)**, p = 0.020 (below 0.025, so it passes at either position of the pre-registered two-test Holm family) |
| Pooled, 96 tasks (secondary) | 392 | | +2.1 pp (−3.5, +7.6) | | |

Both pre-registered primary tests pass on both datasets. The resolved rate did **not** detectably improve, so no accuracy gain is claimed.

**Reading the numbers**
- Costs are list-price estimates at DeepSeek's peak rates, for comparing arms. Every run was made off-peak, so the account was billed less; see [Spend](#spend).
- The cost change is the change in the geometric mean of per-task costs, from a paired, task-clustered bootstrap with 10,000 resamples (seed 20260925).
- The holdout was never used during development. It is the confirmatory result.
- Mini is the set on which design choices were made (its 25-task subset), so Mini results carry optimization bias.

## Setup

- **Model:** `deepseek-flash` (every response reported `deepseek-flash`), thinking enabled, reasoning effort `high`.
- **Budgets per run,** identical for both arms: 80 rounds, 150 tool calls, 3M cumulative input tokens, 150k output tokens, 30 minutes.
- **Isolation:**
  - Epoch AI instance images, pinned by local image ID.
  - The workspace `.git` is rebuilt as a single commit and mounted read-only, so no future history can leak.
  - Containers run with no network and as a non-root user.
- **Grading:** the official harness (`swebench` 5.0.2).
- **Scheduling:** both arms interleaved within each window, with the arm order randomized per task and repetition. Each run gets a cache-isolation nonce.
  - The Mini window ran 2026-09-25 22:25 → 2026-09-26 02:44 UTC.
  - The holdout window ran 2026-09-26 11:54 → 13:29 UTC.
- **Code:** both windows ran on the frozen, clean commit `e30b568` (source fingerprint `55b7442f…`).

**Arms**

| arm | profile | what it changes |
|---|---|---|
| A | `baseline` | OneHand v0.2 plus the pre-registered baseline fixes. Agent fingerprint `674793f8…` |
| B | `ctx-sandbox` | E4 on-demand retrieval, E3 compact observations, E8 sandbox-aware command policy. Agent fingerprint `e7797b1a…` |

The three changes in B:
- **E4:** line-numbered, byte-bounded `read_file` windows, with a Python outline for long files; search results grouped by file, with glob and context; a gitignore-aware file listing.
- **E3:** tool results as plain text instead of indented JSON, keeping test failure lines even when output is truncated.
- **E8:** inside the network-less container, inline Python, grep/sed and read-only git are allowed.

## Secondary and mechanism metrics

**Secondary metrics.** Each change is B vs A, with its 95% CI; exploratory, not corrected.

| metric | Mini | Holdout |
|---|---|---|
| Cumulative input tokens | −35.0% (−44.0, −25.3) | −22.7% (−38.6, −3.2) |
| Output tokens | −6.0% (−15.0, +3.4) | −5.1% (−21.6, +13.3) |
| Model rounds | −2.2% (−9.9, +5.5) | +8.9% (−5.0, +24.0) |
| Tool-failure rate | −2.6 pp (−3.7, −1.6) | −1.1 pp (−2.4, +0.2) |
| False success | +2.7 pp (−0.7, +6.7) | +2.2 pp (−4.3, +10.9) |
| Wall time | +9.2% (−3.7, +24.5) | +14.5% (−3.7, +36.5) |
| Tool time | +109% (+43, +214) | +82% (+22, +175) |

**Mechanism metrics.** These are descriptive shifts for the bundled profile. Individual component effects are not isolated: E4 and E3 share the read metric. Figures are baseline → ctx-sandbox.

| mechanism | Mini | Holdout |
|---|---|---|
| read_file tokens per read (E4/E3) | 3,064 → 1,057 | 2,702 → 1,003 |
| read_file share of cumulative input | 39.1% → 30.2% | 32.9% → 25.5% |
| run_command policy-rejection rate, as pre-registered (E8) | 31.8% → 16.5% | 25.4% → 13.9% |
| run_command failure rate, all causes | 45.4% → 23.6% | 34.8% → 20.6% |

B runs more commands, such as inline Python checks, so tool time goes up. The model spends less time per turn, so the overall wall-time change is not significant.

## External reference (descriptive, not a controlled comparison)

mini-swe-agent 2.4.6 was run with the same model on Mini × 1, and graded by the same harness path ([external/](external/)):
- It used derived images with the same `.git` rebuild, no network, a step limit of 80, and a cost limit of $1.08.
- It resolved **36/50 (72.0%, CI 60–84)** at $0.0592 per run and 49.5 rounds per run on average.
- 12 runs hit its limits without a patch.

The two agents differ in their tool interfaces and control flow, so this places OneHand in context but does not isolate a framework effect. The run started 19 minutes before the pre-registration commit, which the pre-registration discloses.

## Development-stage findings

These came from single runs on the 25-task dev subset. They informed which changes to keep, and they are **not** claims.

| change | dev result | kept? |
|---|---|---|
| E5 observation masking | cost +31.7% (+3.8, +70.6); rounds +24.8% (70 of 75 runs; the evaluation process crashed, a bug fixed before the final window) | no. Our interpretation: with about 96% prompt-cache hits, masking removed context that was cheap to keep, and the model spent extra rounds re-exploring. |
| E1 lean planning | plan-bookkeeping share −6.0 pp, but cost +5.4% (−14.3, +32.9); rounds not reduced | no |
| E9 explore sub-agent | the model never called it | no; kept as an interactive feature |

## Deviations from the pre-registration

1. **Four holdout instances were excluded.**
   - `psf__requests-2317` failed the pipeline self-check: its gold patch was unresolved on 2 of 2 gradings, because the image's `requests` is not an editable install. This exclusion follows the pre-registered rule.
   - `matplotlib__matplotlib-22719`, `-23412` and `-26113` were excluded because their images could not be downloaded: every pull failed with `unexpected EOF` from ghcr.io, over several hours of retries. This was not anticipated by the pre-registration.
   - The holdout therefore has 46 tasks, with matplotlib reduced from 4 tasks to 1. The download failures come from the operator's pull logs, which are not published.
2. **Holm correction set.** `eval:compare`'s built-in Holm family is {cost, rounds}. The pre-registered family is {cost, resolved non-inferiority}, and the results above are read against the pre-registered one.
   - In the built-in family, cost passes (Holm p 2e-4 on Mini, 0.039 on the holdout) and rounds does not (0.58 and 0.22).
   - Resolved non-inferiority is judged by the pre-registered CI criterion: the lower bound must lie above −10 pp.
3. **Timing.** The holdout window started 9 hours 10 minutes after the Mini window ended, both inside the same weekend off-peak period. The response model was identical throughout.
4. **Holdout cost cap.** At the account owner's direction, the cap was raised from the pre-registered $15 to $30. Actual holdout spend was $4.78, so the cap never bound.

## Limitations

- **One model** (deepseek-flash). The gains are not shown to transfer to other models.
- **Sample size.** 50 + 46 tasks give wide resolved-rate intervals: the study can rule out a loss of 10 pp but cannot detect small gains.
- **Cost is an estimate.** It is computed from token usage at list prices. Actual billing is off-peak and in CNY.
- **Mini's optimization bias,** as noted above. The holdout mitigates it.
- **Not comparable to published scores.** DeepSeek's published SWE-bench Verified scores for V4-Flash ([model card](https://huggingface.co/deepseek-ai/DeepSeek-V4-Flash)) name no harness and cover all 500 tasks. They may also be for a different model version: DeepSeek's pricing page listed the `deepseek-flash` alias as V4.1-Flash when checked on 2026-09-25.

## Spend

API spend for the whole project was about **¥123**. DeepSeek bills in CNY, and this figure comes from the account balance, not from these artifacts. The peak-basis estimates in the table come from the evaluation rows; the development total is in the development artifacts, partly unpublished.

| part | runs | peak-basis estimate |
|---|---:|---:|
| Development (smoke tests, baseline diagnosis, three dev A/B windows) | 272 | $14.75 |
| Final window, Mini | 300 | $17.64 |
| External reference | 50 | $2.96 |
| Final window, holdout | 92 | $4.78 |

The holdout window alone was billed ¥15.90.

## Reproduce

```bash
npm run eval:swebench -- selfcheck --split holdout --repeat 2 --image-source epoch --output <dir>
npm run eval:swebench -- run --split dev --variants baseline,ctx-sandbox --repetitions 3 --concurrency 4 \
  --cost-cap-usd 25 --reservation-usd 0.3 --model deepseek-flash --env-file <private.env> --output <dir>
npm run eval:swebench -- run --split holdout --confirm-holdout --variants baseline,ctx-sandbox --repetitions 1 \
  --task-ids <46 ids from holdout/manifest.json> --cost-cap-usd 30 --reservation-usd 0.3 --model deepseek-flash \
  --env-file <private.env> --output <dir>
npm run eval:compare -- --results <dir> --a baseline --b ctx-sandbox --output <dir>/compare
npm run eval:analyze -- --results <dir> --variant ctx-sandbox --output <dir>/analysis-ctx-sandbox
```

Raw traces and per-run rows are not published. The manifests record the dataset revision and file hash, the image IDs, the harness version, every agent setting and fingerprint, and the price snapshot.
