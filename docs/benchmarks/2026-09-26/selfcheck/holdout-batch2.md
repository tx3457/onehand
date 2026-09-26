# SWE-bench self-check

- Split: holdout; gold gradings per instance: 2; run: selfcheck-2026-09-26T04-37-28-638Z-b2d944; images: epoch
- Dataset revision: 78f471bf655a3137b2e8a75af1501690ec009ec3; data file sha256: faf8fab974e851c5065a84d2a46e6c77ab99143d2f3d0a9922c81105514403dd
- Harness: swebench 5.0.2; started 2026-09-26T04:37:28.638Z
- Result: 18 pass, 0 fail, 0 error, of 18

Gold: the gold patch, extracted like an agent patch, must be resolved every time. No-op: a comment appended to a
source file must stay unresolved. Tests: the agent's run_tests in the container with the official targets, after the
test patch alone (expected to fail) and after the gold patch too (expected to pass).

| Instance | Gold resolved | No-op | Tests before gold | Tests after gold | Status |
| --- | --- | --- | --- | --- | --- |
| pydata__xarray-6461 | 2/2 | unresolved | exit 1, 6.2s | exit 0, 6.0s | pass |
| pydata__xarray-6992 | 2/2 | unresolved | exit 1, 19.5s | exit 0, 18.0s | pass |
| pylint-dev__pylint-6528 | 2/2 | unresolved | exit 1, 14.8s | exit 1, 14.6s | pass |
| pytest-dev__pytest-5809 | 2/2 | unresolved | exit 1, 0.5s | exit 0, 0.4s | pass |
| pytest-dev__pytest-5840 | 2/2 | unresolved | exit 1, 1.2s | exit 0, 1.3s | pass |
| scikit-learn__scikit-learn-25931 | 2/2 | unresolved | exit 1, 3.8s | exit 0, 3.6s | pass |
| scikit-learn__scikit-learn-25973 | 2/2 | unresolved | exit 1, 4.2s | exit 0, 4.2s | pass |
| scikit-learn__scikit-learn-9288 | 2/2 | unresolved | exit 1, 32.8s | exit 0, 35.9s | pass |
| sphinx-doc__sphinx-10449 | 2/2 | unresolved | exit 1, 2.2s | exit 0, 2.1s | pass |
| sphinx-doc__sphinx-11445 | 2/2 | unresolved | exit 1, 1.2s | exit 0, 1.1s | pass |
| sympy__sympy-13647 | 2/2 | unresolved | exit 1, 6.1s | exit 1, 5.9s | pass |
| sympy__sympy-14531 | 2/2 | unresolved | exit 1, 2.3s | exit 0, 2.3s | pass |
| sympy__sympy-15345 | 2/2 | unresolved | exit 1, 1.7s | exit 0, 1.7s | pass |
| sympy__sympy-17630 | 2/2 | unresolved | exit 1, 2.0s | exit 0, 2.1s | pass |
| sympy__sympy-20916 | 2/2 | unresolved | exit 1, 1.8s | exit 0, 1.8s | pass |
| sympy__sympy-21847 | 2/2 | unresolved | exit 1, 1.8s | exit 0, 1.9s | pass |
| sympy__sympy-24539 | 2/2 | unresolved | exit 1, 2.0s | exit 0, 2.0s | pass |
| sympy__sympy-24562 | 2/2 | unresolved | exit 1, 5.0s | exit 0, 5.0s | pass |

## Findings

- pylint-dev__pylint-6528 (warning): tests did not pass after the gold patch (exit 1)
- sympy__sympy-13647 (warning): tests did not pass after the gold patch (exit 1)

## Suggested exclusions

None.
