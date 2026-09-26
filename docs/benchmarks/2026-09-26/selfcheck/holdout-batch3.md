# SWE-bench self-check

- Split: holdout; gold gradings per instance: 2; run: selfcheck-2026-09-26T07-25-15-669Z-c501c0; images: epoch
- Dataset revision: 78f471bf655a3137b2e8a75af1501690ec009ec3; data file sha256: faf8fab974e851c5065a84d2a46e6c77ab99143d2f3d0a9922c81105514403dd
- Harness: swebench 5.0.2; started 2026-09-26T07:25:15.669Z
- Result: 1 pass, 0 fail, 0 error, of 1

Gold: the gold patch, extracted like an agent patch, must be resolved every time. No-op: a comment appended to a
source file must stay unresolved. Tests: the agent's run_tests in the container with the official targets, after the
test patch alone (expected to fail) and after the gold patch too (expected to pass).

| Instance | Gold resolved | No-op | Tests before gold | Tests after gold | Status |
| --- | --- | --- | --- | --- | --- |
| django__django-15382 | 2/2 | unresolved | exit 1, 0.9s | exit 0, 0.9s | pass |

## Findings

None.

## Suggested exclusions

None.
