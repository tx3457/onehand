# SWE-bench self-check

- Split: dev; gold gradings per instance: 2; run: selfcheck-2026-09-25T12-53-52-625Z-8818fd; images: epoch
- Dataset revision: 78f471bf655a3137b2e8a75af1501690ec009ec3; data file sha256: faf8fab974e851c5065a84d2a46e6c77ab99143d2f3d0a9922c81105514403dd
- Harness: swebench 5.0.2; started 2026-09-25T12:53:52.625Z
- Result: 26 pass, 0 fail, 0 error, of 26

Gold: the gold patch, extracted like an agent patch, must be resolved every time. No-op: a comment appended to a
source file must stay unresolved. Tests: the agent's run_tests in the container with the official targets, after the
test patch alone (expected to fail) and after the gold patch too (expected to pass).

| Instance | Gold resolved | No-op | Tests before gold | Tests after gold | Status |
| --- | --- | --- | --- | --- | --- |
| django__django-9296 | 2/2 | unresolved | exit 1, 0.7s | exit 0, 0.7s | pass |
| sphinx-doc__sphinx-10323 | 2/2 | unresolved | exit 1, 2.3s | exit 0, 2.3s | pass |
| sphinx-doc__sphinx-10435 | 2/2 | unresolved | exit 1, 5.8s | exit 1, 5.7s | pass |
| sphinx-doc__sphinx-10466 | 2/2 | unresolved | exit 1, 2.7s | exit 0, 2.6s | pass |
| sphinx-doc__sphinx-10673 | 2/2 | unresolved | exit 1, 1.3s | exit 0, 1.2s | pass |
| sphinx-doc__sphinx-11510 | 2/2 | unresolved | exit 1, 1.2s | exit 0, 1.2s | pass |
| sphinx-doc__sphinx-7590 | 2/2 | unresolved | exit 1, 4.1s | exit 0, 4.4s | pass |
| sphinx-doc__sphinx-7748 | 2/2 | unresolved | exit 1, 1.3s | exit 0, 1.3s | pass |
| sphinx-doc__sphinx-7757 | 2/2 | unresolved | exit 1, 1.1s | exit 0, 1.1s | pass |
| sphinx-doc__sphinx-7985 | 2/2 | unresolved | exit 1, 1.1s | exit 1, 1.1s | pass |
| sphinx-doc__sphinx-8035 | 2/2 | unresolved | exit 1, 1.1s | exit 0, 1.1s | pass |
| sphinx-doc__sphinx-8056 | 2/2 | unresolved | exit 1, 1.0s | exit 1, 1.0s | pass |
| sphinx-doc__sphinx-8265 | 2/2 | unresolved | exit 1, 0.8s | exit 0, 0.7s | pass |
| sphinx-doc__sphinx-8269 | 2/2 | unresolved | exit 1, 1.1s | exit 1, 1.1s | pass |
| sphinx-doc__sphinx-8475 | 2/2 | unresolved | exit 1, 1.7s | exit 1, 1.7s | pass |
| sphinx-doc__sphinx-8548 | 2/2 | unresolved | exit 1, 1.4s | exit 0, 1.3s | pass |
| sphinx-doc__sphinx-8551 | 2/2 | unresolved | exit 1, 1.8s | exit 0, 1.7s | pass |
| sphinx-doc__sphinx-8638 | 2/2 | unresolved | exit 1, 1.9s | exit 0, 1.8s | pass |
| sphinx-doc__sphinx-8721 | 2/2 | unresolved | exit 1, 1.9s | exit 1, 1.9s | pass |
| sphinx-doc__sphinx-9229 | 2/2 | unresolved | exit 1, 1.5s | exit 0, 1.4s | pass |
| sphinx-doc__sphinx-9230 | 2/2 | unresolved | exit 1, 2.5s | exit 0, 2.4s | pass |
| sphinx-doc__sphinx-9281 | 2/2 | unresolved | exit 1, 1.3s | exit 0, 1.2s | pass |
| sphinx-doc__sphinx-9320 | 2/2 | unresolved | exit 1, 1.3s | exit 0, 1.2s | pass |
| sphinx-doc__sphinx-9367 | 2/2 | unresolved | exit 1, 0.8s | exit 0, 0.8s | pass |
| sphinx-doc__sphinx-9461 | 2/2 | unresolved | exit 1, 3.1s | exit 0, 2.9s | pass |
| sphinx-doc__sphinx-9698 | 2/2 | unresolved | exit 1, 2.5s | exit 0, 2.6s | pass |

## Findings

- sphinx-doc__sphinx-10435 (warning): tests did not pass after the gold patch (exit 1)
- sphinx-doc__sphinx-7985 (warning): tests did not pass after the gold patch (exit 1)
- sphinx-doc__sphinx-8056 (warning): tests did not pass after the gold patch (exit 1)
- sphinx-doc__sphinx-8269 (warning): tests did not pass after the gold patch (exit 1)
- sphinx-doc__sphinx-8475 (warning): tests did not pass after the gold patch (exit 1)
- sphinx-doc__sphinx-8721 (warning): tests did not pass after the gold patch (exit 1)

## Suggested exclusions

None.
