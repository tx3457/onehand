# Trace diagnostics: `baseline` on swebench

> This is a DIAGNOSTIC of one configuration, not a comparative claim: it shows where tokens and time go in these runs, not that any change would help. Use eval:compare on paired A/B runs for that.

- Results: `eval/results/final-2026-09-26-holdout`; model `deepseek-flash`
- Runs analyzed: 46; rows excluded: none

## Bottleneck ranking

| rank | source of cumulative input tokens | share |
|---:|---|---:|
| 1 | tool:read_file | 32.9% |
| 2 | assistant_output | 29.3% |
| 3 | tool:search_code | 14.0% |
| 4 | tool:run_command | 8.9% |
| 5 | initial_prompt | 5.0% |

| rank | time consumer | time | share |
|---:|---|---:|---:|
| 1 | model | 5650.2s | 58.8% |
| 2 | tool:run_tests | 2103.1s | 21.9% |
| 3 | runtime_overhead | 1605.4s | 16.7% |
| 4 | tool:run_command | 234.3s | 2.4% |
| 5 | tool:search_code | 13.1s | 0.1% |

## Context growth

Each round re-sends the whole prompt, so a token added at round j of R counts R − j + 1 times toward cumulative input.

| source | tokens added | cumulative input tokens | share | observations | tokens per observation |
|---|---:|---:|---:|---:|---:|
| tool:read_file | 829,592 | 24,952,732 | 32.9% | 307 | 2,702 |
| assistant_output | 1,117,908 | 22,178,302 | 29.3% | - | - |
| tool:search_code | 398,373 | 10,589,550 | 14.0% | 670 | 595 |
| tool:run_command | 258,274 | 6,717,333 | 8.9% | 574 | 450 |
| initial_prompt | 99,396 | 3,819,237 | 5.0% | - | - |
| tool:run_tests | 437,856 | 3,543,811 | 4.7% | 129 | 3,394 |
| tool:list_files | 68,447 | 2,180,353 | 2.9% | 109 | 628 |
| tool:update_plan | 84,618 | 898,491 | 1.2% | 227 | 373 |
| tool:set_plan | 11,361 | 397,487 | 0.5% | 54 | 210 |
| tool:write_file | 9,903 | 215,792 | 0.3% | 228 | 43 |
| tool:git_diff | 20,970 | 167,302 | 0.2% | 44 | 477 |
| tool:replace_text | 5,993 | 103,690 | 0.1% | 129 | 46 |
| tool:git_status | 3,203 | 26,920 | 0.0% | 50 | 64 |
| tool:finish_task | 516 | 1,204 | 0.0% | 12 | 43 |
| other | 30 | 300 | 0.0% | - | - |
| tool:run_code | 38 | 266 | 0.0% | 1 | 38 |

Cumulative input over the traced rounds: 75,792,770 tokens; the rows report 75,792,770.

- Round k's growth goes first to round k−1's output tokens (reasoning included), then to round k−1's tool observations in proportion to their bytes; what neither explains, including nudges, goes to other, which is negative when a prompt shrank.
- Tokens per observation divide a tool's added tokens by its observations that a later round re-sent; the last round's observations are never re-sent.

## Prompt size by round

| round | runs | P50 prompt tokens | P95 prompt tokens |
|---:|---:|---:|---:|
| 1 | 46 | 2,032 | 2,916 |
| 2 | 46 | 3,474 | 11,994 |
| 3 | 46 | 7,616 | 18,228 |
| 4 | 46 | 10,971 | 21,642 |
| 5 | 46 | 13,387 | 24,697 |
| 6 | 46 | 15,793 | 29,181 |
| 7 | 46 | 16,760 | 32,075 |
| 8 | 46 | 17,433 | 33,156 |
| 9 | 46 | 18,947 | 36,480 |
| 10 | 46 | 19,240 | 38,599 |
| 11 | 46 | 19,955 | 40,183 |
| 12 | 46 | 21,572 | 42,575 |
| 13 | 45 | 26,975 | 46,100 |
| 14 | 45 | 28,359 | 50,821 |
| 15 | 45 | 29,086 | 52,039 |
| 16 | 45 | 31,109 | 56,693 |
| 17 | 45 | 31,797 | 58,352 |
| 18 | 44 | 33,114 | 60,454 |
| 19 | 43 | 34,563 | 66,498 |
| 20 | 43 | 37,796 | 70,137 |
| 21 | 43 | 38,775 | 73,752 |
| 22 | 43 | 39,607 | 74,172 |
| 23 | 41 | 40,520 | 76,330 |
| 24 | 39 | 40,725 | 93,139 |
| 25 | 39 | 41,079 | 102,809 |
| 26 | 38 | 42,814 | 105,980 |
| 27 | 37 | 44,562 | 108,835 |
| 28 | 34 | 43,702 | 109,296 |
| 29 | 31 | 45,971 | 110,386 |
| 30 | 30 | 48,184 | 111,525 |
| 31 | 28 | 51,151 | 119,543 |
| 32 | 26 | 53,525 | 121,153 |
| 33 | 25 | 54,193 | 121,773 |
| 34 | 24 | 55,745 | 123,059 |
| 35 | 22 | 56,689 | 131,373 |
| 36 | 22 | 58,599 | 132,529 |
| 37 | 21 | 64,586 | 132,869 |
| 38 | 20 | 62,513 | 134,352 |
| 39 | 17 | 64,026 | 136,711 |
| 40 | 16 | 64,775 | 142,654 |
| 41 | 16 | 65,012 | 144,388 |
| 42 | 16 | 68,405 | 145,709 |
| 43 | 16 | 69,029 | 148,134 |
| 44 | 15 | 70,629 | 118,618 |
| 45 | 14 | 71,352 | 98,185 |
| 46 | 13 | 71,682 | 99,052 |
| 47 | 13 | 73,655 | 100,486 |
| 48 | 13 | 74,754 | 101,548 |
| 49 | 13 | 79,496 | 102,049 |
| 50 | 13 | 81,432 | 103,282 |
| 51 | 13 | 83,111 | 103,854 |
| 52 | 12 | 77,086 | 102,930 |
| 53 | 11 | 93,975 | 104,165 |
| 54 | 11 | 95,090 | 108,087 |
| 55 | 11 | 97,376 | 112,536 |
| 56 | 9 | 82,461 | 113,190 |
| 57 | 8 | 73,736 | 117,998 |
| 58 | 8 | 75,968 | 120,859 |
| 59 | 8 | 76,555 | 125,524 |
| 60 | 7 | 77,618 | 126,092 |
| 61 | 6 | 72,492 | 112,199 |
| 62 | 5 | 77,605 | 112,435 |
| 63 | 4 | 72,497 | 87,979 |
| 64 | 4 | 73,898 | 89,854 |
| 65 | 3 | 76,308 | 79,485 |
| 66 | 2 | 62,797 | 76,853 |
| 67 | 2 | 63,507 | 79,756 |
| 68 | 2 | 63,692 | 87,038 |
| 69 | 2 | 64,205 | 87,239 |
| 70 | 2 | 64,368 | 88,673 |
| 71 | 2 | 64,612 | 94,531 |
| 72 | 2 | 65,338 | 95,680 |
| 73 | 2 | 65,556 | 100,561 |
| 74 | 2 | 67,606 | 104,013 |
| 75 | 1 | 71,895 | 71,895 |
| 76 | 1 | 72,105 | 72,105 |

Peak context per run: max 150,165, P50 66,521, P95 135,840, mean 72,750 tokens.

## Governance overhead

- Governance tool calls (set_plan, update_plan, finish_task): 324 of 2565 tool calls (12.6%); set_plan 54, update_plan 227, finish_task 43.
- Rounds whose tool calls are all governance tools: 195 of 1785 rounds (10.9%).

## Redundant reads

- 54 of 307 read_file calls (17.6%) re-read a path already read successfully, with no successful write_file or replace_text to it in between.

## Tool failures

A failure is a call that was rejected, errored, or timed out: 255 of 2565 tool calls (9.9%). Failing test runs are observations, not failures: 31.

| tool | calls | failures | failure rate |
|---|---:|---:|---:|
| run_command | 574 | 200 | 34.8% |
| list_files | 109 | 12 | 11.0% |
| finish_task | 43 | 12 | 27.9% |
| set_plan | 54 | 7 | 13.0% |
| read_file | 307 | 6 | 2.0% |
| search_code | 670 | 5 | 0.7% |
| write_file | 228 | 5 | 2.2% |
| update_plan | 227 | 4 | 1.8% |
| run_tests | 129 | 2 | 1.6% |
| replace_text | 129 | 1 | 0.8% |
| run_code | 1 | 1 | 100.0% |
| git_status | 50 | 0 | 0.0% |
| git_diff | 44 | 0 | 0.0% |

| error category | failures |
|---|---:|
| policy | 160 |
| plan_gate | 69 |
| schema | 14 |
| not_found | 9 |
| other | 1 |
| unknown_tool | 1 |
| timeout | 1 |

| failures | error (truncated) |
|---:|---|
| 39 | Inline code execution is disabled for model tools: python -c |
| 37 | Use the dedicated repository tool instead of run_command: git |
| 36 | Call set_plan before modifying files |
| 27 | Use the dedicated repository tool instead of run_command: sed |
| 21 | Repeated failure requires update_plan before continuing |
| 12 | Run a passing verification after the most recent file change |
| 9 | Inline code execution is disabled for model tools: python3 -c |
| 8 | Use the dedicated repository tool instead of run_command: grep |
| 7 | arguments.steps[0] must be a string |
| 7 | Path escapes repository root: /tmp |

## Time

| component | time | share |
|---|---:|---:|
| model (Σ model_turn.latencyMs) | 5650.2s | 58.8% |
| tools (Σ tool_result.durationMs) | 2354.4s | 24.5% |
| runtime overhead (run duration − model − tools, at least 0) | 1605.4s | 16.7% |

Run durations total 9610.0s; 0 run(s) had model plus tool time above their duration, so their overhead was clamped to 0.

| tool | calls | total | P50 | P95 |
|---|---:|---:|---:|---:|
| run_tests | 129 | 2103.1s | 1.6s | 46.1s |
| run_command | 574 | 234.3s | 211ms | 1.1s |
| search_code | 670 | 13.1s | 16ms | 38ms |
| git_status | 50 | 1.4s | 28ms | 54ms |
| git_diff | 44 | 1.1s | 22ms | 52ms |
| list_files | 109 | 794ms | 1ms | 45ms |
| write_file | 228 | 264ms | 1ms | 2ms |
| read_file | 307 | 170ms | 1ms | 1ms |
| replace_text | 129 | 130ms | 1ms | 2ms |
| update_plan | 227 | 45ms | 0ms | 1ms |
| set_plan | 54 | 13ms | 0ms | 1ms |
| finish_task | 43 | 12ms | 0ms | 1ms |
| run_code | 1 | 1ms | 1ms | 1ms |

## Outcomes

| stop reason | runs |
|---|---:|
| explicit_finish | 31 |
| token_budget | 15 |

- Text-only turns: 1; nudges sent: 1, in 1 run(s).
- Turns that hit the output limit (finishReason length): 1; runs stopped by output_limit: 0.
- environment_failure events: 0.

P50 and P95 are nearest-rank percentiles.
