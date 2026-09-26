# Trace diagnostics: `baseline` on swebench

> This is a DIAGNOSTIC of one configuration, not a comparative claim: it shows where tokens and time go in these runs, not that any change would help. Use eval:compare on paired A/B runs for that.

- Results: `eval/results/final-2026-09-26-mini`; model `deepseek-flash`
- Runs analyzed: 150; rows excluded: none

## Bottleneck ranking

| rank | source of cumulative input tokens | share |
|---:|---|---:|
| 1 | tool:read_file | 39.1% |
| 2 | assistant_output | 25.6% |
| 3 | tool:search_code | 12.8% |
| 4 | tool:run_command | 6.2% |
| 5 | tool:run_tests | 5.1% |

| rank | time consumer | time | share |
|---:|---|---:|---:|
| 1 | model | 19392.8s | 75.0% |
| 2 | runtime_overhead | 4023.0s | 15.6% |
| 3 | tool:run_tests | 1771.9s | 6.9% |
| 4 | tool:run_command | 588.2s | 2.3% |
| 5 | tool:search_code | 56.7s | 0.2% |

## Context growth

Each round re-sends the whole prompt, so a token added at round j of R counts R − j + 1 times toward cumulative input.

| source | tokens added | cumulative input tokens | share | observations | tokens per observation |
|---|---:|---:|---:|---:|---:|
| tool:read_file | 3,858,030 | 117,083,374 | 39.1% | 1259 | 3,064 |
| assistant_output | 3,876,540 | 76,774,471 | 25.6% | - | - |
| tool:search_code | 1,324,569 | 38,364,785 | 12.8% | 2631 | 503 |
| tool:run_command | 844,863 | 18,543,742 | 6.2% | 1845 | 458 |
| tool:run_tests | 1,724,246 | 15,291,132 | 5.1% | 428 | 4,029 |
| tool:list_files | 516,117 | 14,913,889 | 5.0% | 512 | 1,008 |
| initial_prompt | 311,355 | 13,220,315 | 4.4% | - | - |
| tool:update_plan | 238,117 | 2,939,147 | 1.0% | 659 | 361 |
| tool:set_plan | 36,932 | 1,358,527 | 0.5% | 171 | 216 |
| tool:write_file | 29,625 | 543,868 | 0.2% | 659 | 45 |
| tool:git_diff | 51,590 | 330,633 | 0.1% | 144 | 358 |
| tool:replace_text | 19,402 | 251,925 | 0.1% | 415 | 47 |
| tool:git_status | 9,065 | 91,182 | 0.0% | 159 | 57 |
| tool:finish_task | 1,288 | 3,995 | 0.0% | 30 | 43 |

Cumulative input over the traced rounds: 299,710,985 tokens; the rows report 299,710,985.

- Round k's growth goes first to round k−1's output tokens (reasoning included), then to round k−1's tool observations in proportion to their bytes; what neither explains, including nudges, goes to other, which is negative when a prompt shrank.
- Tokens per observation divide a tool's added tokens by its observations that a later round re-sent; the last round's observations are never re-sent.

## Prompt size by round

| round | runs | P50 prompt tokens | P95 prompt tokens |
|---:|---:|---:|---:|
| 1 | 150 | 1,952 | 2,794 |
| 2 | 150 | 3,244 | 12,200 |
| 3 | 150 | 6,169 | 22,738 |
| 4 | 150 | 8,704 | 28,047 |
| 5 | 150 | 11,668 | 31,005 |
| 6 | 150 | 14,324 | 36,809 |
| 7 | 150 | 15,353 | 37,785 |
| 8 | 150 | 17,201 | 38,953 |
| 9 | 150 | 18,142 | 40,137 |
| 10 | 150 | 20,246 | 44,222 |
| 11 | 150 | 22,139 | 49,689 |
| 12 | 150 | 23,182 | 51,275 |
| 13 | 148 | 25,046 | 54,040 |
| 14 | 147 | 27,085 | 54,373 |
| 15 | 147 | 29,578 | 62,042 |
| 16 | 146 | 31,074 | 64,759 |
| 17 | 146 | 33,782 | 67,899 |
| 18 | 145 | 35,794 | 71,429 |
| 19 | 145 | 36,860 | 71,711 |
| 20 | 145 | 38,594 | 73,666 |
| 21 | 143 | 41,052 | 77,600 |
| 22 | 140 | 43,479 | 79,207 |
| 23 | 138 | 44,821 | 88,069 |
| 24 | 136 | 46,767 | 90,028 |
| 25 | 133 | 47,247 | 92,508 |
| 26 | 131 | 50,874 | 93,970 |
| 27 | 129 | 52,610 | 97,060 |
| 28 | 128 | 53,753 | 99,260 |
| 29 | 126 | 56,247 | 101,941 |
| 30 | 123 | 57,723 | 107,231 |
| 31 | 119 | 59,606 | 116,955 |
| 32 | 113 | 61,631 | 124,386 |
| 33 | 108 | 62,376 | 131,869 |
| 34 | 104 | 65,278 | 132,047 |
| 35 | 101 | 68,487 | 124,553 |
| 36 | 98 | 72,047 | 132,816 |
| 37 | 97 | 73,299 | 137,392 |
| 38 | 94 | 73,860 | 138,113 |
| 39 | 88 | 75,729 | 130,666 |
| 40 | 86 | 76,789 | 131,500 |
| 41 | 80 | 79,111 | 138,218 |
| 42 | 78 | 81,970 | 140,976 |
| 43 | 70 | 83,223 | 126,694 |
| 44 | 69 | 84,620 | 127,012 |
| 45 | 66 | 85,771 | 127,855 |
| 46 | 61 | 86,850 | 128,068 |
| 47 | 57 | 87,353 | 129,365 |
| 48 | 52 | 88,523 | 129,489 |
| 49 | 47 | 87,615 | 122,317 |
| 50 | 46 | 89,675 | 123,972 |
| 51 | 42 | 91,344 | 113,578 |
| 52 | 37 | 93,516 | 114,726 |
| 53 | 35 | 94,471 | 111,473 |
| 54 | 32 | 93,648 | 115,675 |
| 55 | 30 | 93,761 | 113,595 |
| 56 | 26 | 93,333 | 112,574 |
| 57 | 26 | 94,827 | 113,006 |
| 58 | 22 | 88,532 | 112,797 |
| 59 | 17 | 88,718 | 119,060 |
| 60 | 13 | 86,890 | 119,827 |
| 61 | 7 | 83,253 | 123,140 |
| 62 | 7 | 83,815 | 123,525 |
| 63 | 6 | 85,254 | 94,706 |
| 64 | 4 | 85,502 | 94,046 |
| 65 | 3 | 89,094 | 97,375 |
| 66 | 2 | 86,769 | 105,029 |

Peak context per run: max 180,196, P50 86,665, P95 141,389, mean 85,612 tokens.

## Governance overhead

- Governance tool calls (set_plan, update_plan, finish_task): 946 of 8998 tool calls (10.5%); set_plan 171, update_plan 659, finish_task 116.
- Rounds whose tool calls are all governance tools: 579 of 6239 rounds (9.3%).

## Redundant reads

- 212 of 1259 read_file calls (16.8%) re-read a path already read successfully, with no successful write_file or replace_text to it in between.

## Tool failures

A failure is a call that was rejected, errored, or timed out: 1024 of 8998 tool calls (11.4%). Failing test runs are observations, not failures: 107.

| tool | calls | failures | failure rate |
|---|---:|---:|---:|
| run_command | 1845 | 838 | 45.4% |
| list_files | 512 | 56 | 10.9% |
| finish_task | 116 | 30 | 25.9% |
| search_code | 2631 | 26 | 1.0% |
| read_file | 1259 | 18 | 1.4% |
| set_plan | 171 | 18 | 10.5% |
| update_plan | 659 | 13 | 2.0% |
| replace_text | 415 | 11 | 2.7% |
| write_file | 659 | 7 | 1.1% |
| run_tests | 428 | 4 | 0.9% |
| git_diff | 144 | 2 | 1.4% |
| git_status | 159 | 1 | 0.6% |

| error category | failures |
|---|---:|
| policy | 626 |
| plan_gate | 294 |
| schema | 56 |
| not_found | 32 |
| other | 14 |
| timeout | 2 |

| failures | error (truncated) |
|---:|---|
| 141 | Call set_plan before modifying files |
| 129 | Use the dedicated repository tool instead of run_command: git |
| 123 | Repeated failure requires update_plan before continuing |
| 115 | Use the dedicated repository tool instead of run_command: sed |
| 106 | Inline code execution is disabled for model tools: python -c |
| 49 | Inline code execution is disabled for model tools: python3 -c |
| 36 | Use the dedicated repository tool instead of run_command: grep |
| 31 | Use the dedicated repository tool instead of run_command: find |
| 28 | Run a passing verification after the most recent file change |
| 26 | Program is outside the local execution allowlist: rm |

## Time

| component | time | share |
|---|---:|---:|
| model (Σ model_turn.latencyMs) | 19392.8s | 75.0% |
| tools (Σ tool_result.durationMs) | 2431.6s | 9.4% |
| runtime overhead (run duration − model − tools, at least 0) | 4023.0s | 15.6% |

Run durations total 25847.4s; 0 run(s) had model plus tool time above their duration, so their overhead was clamped to 0.

| tool | calls | total | P50 | P95 |
|---|---:|---:|---:|---:|
| run_tests | 428 | 1771.9s | 1.1s | 4.7s |
| run_command | 1845 | 588.2s | 206ms | 602ms |
| search_code | 2631 | 56.7s | 18ms | 38ms |
| git_status | 159 | 4.7s | 30ms | 54ms |
| list_files | 512 | 4.1s | 1ms | 30ms |
| git_diff | 144 | 3.9s | 24ms | 52ms |
| read_file | 1259 | 703ms | 0ms | 2ms |
| write_file | 659 | 690ms | 1ms | 2ms |
| replace_text | 415 | 576ms | 1ms | 3ms |
| update_plan | 659 | 92ms | 0ms | 1ms |
| finish_task | 116 | 41ms | 0ms | 1ms |
| set_plan | 171 | 34ms | 0ms | 1ms |

## Outcomes

| stop reason | runs |
|---|---:|
| explicit_finish | 86 |
| token_budget | 64 |

- Text-only turns: 0; nudges sent: 0, in 0 run(s).
- Turns that hit the output limit (finishReason length): 0; runs stopped by output_limit: 0.
- environment_failure events: 0.

P50 and P95 are nearest-rank percentiles.
