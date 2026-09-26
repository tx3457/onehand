# Trace diagnostics: `ctx-sandbox` on swebench

> This is a DIAGNOSTIC of one configuration, not a comparative claim: it shows where tokens and time go in these runs, not that any change would help. Use eval:compare on paired A/B runs for that.

- Results: `eval/results/final-2026-09-26-mini`; model `deepseek-flash`
- Runs analyzed: 150; rows excluded: none

## Bottleneck ranking

| rank | source of cumulative input tokens | share |
|---:|---|---:|
| 1 | assistant_output | 40.0% |
| 2 | tool:read_file | 30.2% |
| 3 | tool:run_command | 8.2% |
| 4 | tool:search_code | 6.3% |
| 5 | tool:run_tests | 6.3% |

| rank | time consumer | time | share |
|---:|---|---:|---:|
| 1 | model | 19888.5s | 59.1% |
| 2 | tool:run_command | 6341.3s | 18.9% |
| 3 | runtime_overhead | 4116.0s | 12.2% |
| 4 | tool:run_tests | 3208.1s | 9.5% |
| 5 | tool:search_code | 34.6s | 0.1% |

## Context growth

Each round re-sends the whole prompt, so a token added at round j of R counts R − j + 1 times toward cumulative input.

| source | tokens added | cumulative input tokens | share | observations | tokens per observation |
|---|---:|---:|---:|---:|---:|
| assistant_output | 4,105,764 | 94,861,318 | 40.0% | - | - |
| tool:read_file | 2,075,648 | 71,499,074 | 30.2% | 1963 | 1,057 |
| tool:run_command | 725,813 | 19,460,750 | 8.2% | 2683 | 271 |
| tool:search_code | 382,716 | 15,017,442 | 6.3% | 1654 | 231 |
| tool:run_tests | 1,695,498 | 14,949,486 | 6.3% | 456 | 3,718 |
| initial_prompt | 329,947 | 14,668,878 | 6.2% | - | - |
| tool:list_files | 78,174 | 2,783,632 | 1.2% | 423 | 185 |
| tool:update_plan | 185,447 | 1,997,387 | 0.8% | 681 | 272 |
| tool:set_plan | 24,566 | 964,267 | 0.4% | 173 | 142 |
| tool:git_diff | 44,705 | 264,842 | 0.1% | 124 | 361 |
| tool:write_file | 12,707 | 260,438 | 0.1% | 390 | 33 |
| tool:replace_text | 13,168 | 193,203 | 0.1% | 397 | 33 |
| tool:git_status | 5,517 | 46,165 | 0.0% | 130 | 42 |
| tool:finish_task | 1,142 | 2,992 | 0.0% | 48 | 24 |
| tool:bash | 8 | 484 | 0.0% | 1 | 8 |
| tool:grep | 8 | 335 | 0.0% | 1 | 8 |
| other | 76 | 76 | 0.0% | - | - |

Cumulative input over the traced rounds: 236,970,770 tokens; the rows report 236,970,770.

- Round k's growth goes first to round k−1's output tokens (reasoning included), then to round k−1's tool observations in proportion to their bytes; what neither explains, including nudges, goes to other, which is negative when a prompt shrank.
- Tokens per observation divide a tool's added tokens by its observations that a later round re-sent; the last round's observations are never re-sent.

## Prompt size by round

| round | runs | P50 prompt tokens | P95 prompt tokens |
|---:|---:|---:|---:|
| 1 | 150 | 2,076 | 2,917 |
| 2 | 150 | 2,573 | 4,654 |
| 3 | 150 | 3,763 | 6,879 |
| 4 | 150 | 5,607 | 9,835 |
| 5 | 150 | 7,216 | 12,436 |
| 6 | 150 | 8,024 | 13,735 |
| 7 | 150 | 9,168 | 15,862 |
| 8 | 150 | 10,753 | 17,874 |
| 9 | 150 | 11,894 | 20,221 |
| 10 | 150 | 13,282 | 21,401 |
| 11 | 150 | 14,462 | 21,994 |
| 12 | 149 | 15,115 | 23,350 |
| 13 | 149 | 16,165 | 24,081 |
| 14 | 148 | 17,493 | 26,775 |
| 15 | 147 | 19,136 | 29,698 |
| 16 | 145 | 20,335 | 29,979 |
| 17 | 143 | 21,545 | 30,917 |
| 18 | 141 | 22,704 | 34,121 |
| 19 | 137 | 24,058 | 36,564 |
| 20 | 134 | 25,472 | 39,053 |
| 21 | 131 | 26,504 | 38,112 |
| 22 | 124 | 27,922 | 40,456 |
| 23 | 118 | 29,574 | 42,464 |
| 24 | 116 | 30,975 | 44,648 |
| 25 | 112 | 32,142 | 48,741 |
| 26 | 108 | 34,296 | 51,083 |
| 27 | 106 | 34,904 | 50,824 |
| 28 | 103 | 36,277 | 53,220 |
| 29 | 101 | 37,972 | 53,941 |
| 30 | 101 | 39,746 | 55,408 |
| 31 | 100 | 41,170 | 56,969 |
| 32 | 96 | 42,079 | 58,184 |
| 33 | 93 | 45,428 | 63,161 |
| 34 | 90 | 46,123 | 64,227 |
| 35 | 85 | 46,984 | 66,609 |
| 36 | 83 | 48,757 | 66,973 |
| 37 | 83 | 50,255 | 69,286 |
| 38 | 83 | 51,515 | 75,498 |
| 39 | 80 | 53,316 | 75,984 |
| 40 | 80 | 54,975 | 78,066 |
| 41 | 76 | 56,587 | 87,372 |
| 42 | 75 | 57,660 | 88,878 |
| 43 | 74 | 58,429 | 90,412 |
| 44 | 71 | 60,820 | 90,711 |
| 45 | 69 | 61,872 | 92,721 |
| 46 | 68 | 64,420 | 95,365 |
| 47 | 66 | 64,895 | 94,932 |
| 48 | 63 | 67,871 | 100,231 |
| 49 | 62 | 69,282 | 106,161 |
| 50 | 62 | 70,796 | 108,285 |
| 51 | 60 | 72,523 | 110,901 |
| 52 | 60 | 73,994 | 112,006 |
| 53 | 58 | 75,038 | 116,642 |
| 54 | 57 | 76,339 | 117,195 |
| 55 | 55 | 77,336 | 110,941 |
| 56 | 52 | 77,342 | 103,128 |
| 57 | 52 | 79,062 | 104,170 |
| 58 | 51 | 80,887 | 112,711 |
| 59 | 49 | 82,604 | 110,258 |
| 60 | 46 | 82,095 | 112,638 |
| 61 | 45 | 83,674 | 117,070 |
| 62 | 41 | 84,087 | 111,722 |
| 63 | 37 | 85,720 | 104,697 |
| 64 | 34 | 86,698 | 102,000 |
| 65 | 31 | 88,666 | 105,453 |
| 66 | 26 | 88,506 | 103,605 |
| 67 | 22 | 90,092 | 105,159 |
| 68 | 18 | 89,888 | 108,878 |
| 69 | 15 | 88,287 | 110,165 |
| 70 | 12 | 89,660 | 111,789 |
| 71 | 10 | 91,120 | 112,167 |
| 72 | 6 | 74,403 | 114,572 |
| 73 | 3 | 74,929 | 99,287 |
| 74 | 3 | 76,791 | 99,461 |
| 75 | 2 | 69,699 | 78,080 |
| 76 | 2 | 71,341 | 79,862 |
| 77 | 1 | 75,160 | 75,160 |
| 78 | 1 | 76,078 | 76,078 |
| 79 | 1 | 77,597 | 77,597 |
| 80 | 1 | 78,354 | 78,354 |

Peak context per run: max 126,926, P50 63,189, P95 115,479, mean 64,539 tokens.

## Governance overhead

- Governance tool calls (set_plan, update_plan, finish_task): 1000 of 9224 tool calls (10.8%); set_plan 173, update_plan 682, finish_task 145.
- Rounds whose tool calls are all governance tools: 576 of 6473 rounds (8.9%).

## Redundant reads

- 774 of 1963 read_file calls (39.4%) re-read a path already read successfully, with no successful write_file or replace_text to it in between.

## Tool failures

A failure is a call that was rejected, errored, or timed out: 859 of 9224 tool calls (9.3%). Failing test runs are observations, not failures: 135.

| tool | calls | failures | failure rate |
|---|---:|---:|---:|
| run_command | 2685 | 633 | 23.6% |
| search_code | 1654 | 72 | 4.4% |
| finish_task | 145 | 48 | 33.1% |
| update_plan | 682 | 31 | 4.5% |
| list_files | 423 | 27 | 6.4% |
| set_plan | 173 | 19 | 11.0% |
| read_file | 1963 | 12 | 0.6% |
| replace_text | 397 | 8 | 2.0% |
| run_tests | 456 | 6 | 1.3% |
| write_file | 390 | 1 | 0.3% |
| grep | 1 | 1 | 100.0% |
| bash | 1 | 1 | 100.0% |
| git_status | 130 | 0 | 0.0% |
| git_diff | 124 | 0 | 0.0% |

| error category | failures |
|---|---:|
| policy | 462 |
| plan_gate | 220 |
| schema | 127 |
| not_found | 25 |
| timeout | 12 |
| other | 10 |
| unknown_tool | 2 |
| environment | 1 |

| failures | error (truncated) |
|---:|---|
| 141 | Call set_plan before modifying files |
| 84 | Path escapes repository root: / |
| 59 | arguments.contextLines must be <= 5 |
| 46 | Run a passing verification after the most recent file change |
| 41 | Git mutation or network operation is disabled: git branch |
| 31 | Repeated failure requires update_plan before continuing |
| 28 | Git mutation or network operation is disabled: git tag |
| 26 | arguments.stepId must be a number |
| 26 | Git mutation or network operation is disabled: git count-objects |
| 21 | Program is outside the local execution allowlist: bash |

## Time

| component | time | share |
|---|---:|---:|
| model (Σ model_turn.latencyMs) | 19888.5s | 59.1% |
| tools (Σ tool_result.durationMs) | 9627.3s | 28.6% |
| runtime overhead (run duration − model − tools, at least 0) | 4116.0s | 12.2% |

Run durations total 33631.7s; 0 run(s) had model plus tool time above their duration, so their overhead was clamped to 0.

| tool | calls | total | P50 | P95 |
|---|---:|---:|---:|---:|
| run_command | 2685 | 6341.3s | 215ms | 672ms |
| run_tests | 456 | 3208.1s | 1.2s | 14.9s |
| search_code | 1654 | 34.6s | 18ms | 40ms |
| list_files | 423 | 33.6s | 58ms | 320ms |
| git_status | 130 | 3.8s | 30ms | 54ms |
| git_diff | 124 | 3.3s | 25ms | 50ms |
| read_file | 1963 | 1.5s | 1ms | 2ms |
| replace_text | 397 | 585ms | 1ms | 3ms |
| write_file | 390 | 323ms | 1ms | 2ms |
| update_plan | 682 | 78ms | 0ms | 1ms |
| finish_task | 145 | 47ms | 0ms | 1ms |
| set_plan | 173 | 39ms | 0ms | 1ms |
| grep | 1 | 0ms | 0ms | 0ms |
| bash | 1 | 0ms | 0ms | 0ms |

## Outcomes

| stop reason | runs |
|---|---:|
| explicit_finish | 97 |
| token_budget | 51 |
| runtime_error | 1 |
| step_budget | 1 |

- Text-only turns: 2; nudges sent: 2, in 2 run(s).
- Turns that hit the output limit (finishReason length): 0; runs stopped by output_limit: 0.
- environment_failure events: 1.

P50 and P95 are nearest-rank percentiles.
