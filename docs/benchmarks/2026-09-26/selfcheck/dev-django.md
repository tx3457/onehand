# SWE-bench self-check

- Split: dev; gold gradings per instance: 2; run: selfcheck-2026-09-25T12-18-55-938Z-21a1e0; images: epoch
- Dataset revision: 78f471bf655a3137b2e8a75af1501690ec009ec3; data file sha256: faf8fab974e851c5065a84d2a46e6c77ab99143d2f3d0a9922c81105514403dd
- Harness: swebench 5.0.2; started 2026-09-25T12:18:55.938Z
- Result: 24 pass, 0 fail, 0 error, of 24

Gold: the gold patch, extracted like an agent patch, must be resolved every time. No-op: a comment appended to a
source file must stay unresolved. Tests: the agent's run_tests in the container with the official targets, after the
test patch alone (expected to fail) and after the gold patch too (expected to pass).

| Instance | Gold resolved | No-op | Tests before gold | Tests after gold | Status |
| --- | --- | --- | --- | --- | --- |
| django__django-11790 | 2/2 | unresolved | exit 1, 1.0s | exit 0, 0.9s | pass |
| django__django-11815 | 2/2 | unresolved | exit 1, 0.7s | exit 0, 0.7s | pass |
| django__django-11848 | 2/2 | unresolved | exit 1, 0.6s | exit 0, 0.6s | pass |
| django__django-11880 | 2/2 | unresolved | exit 1, 0.8s | exit 0, 0.8s | pass |
| django__django-11885 | 2/2 | unresolved | exit 1, 1.3s | exit 0, 1.3s | pass |
| django__django-11951 | 2/2 | unresolved | exit 1, 0.8s | exit 0, 0.8s | pass |
| django__django-11964 | 2/2 | unresolved | exit 1, 0.7s | exit 0, 0.6s | pass |
| django__django-11999 | 2/2 | unresolved | exit 1, 0.8s | exit 0, 0.8s | pass |
| django__django-12039 | 2/2 | unresolved | exit 1, 0.8s | exit 0, 0.8s | pass |
| django__django-12050 | 2/2 | unresolved | exit 1, 0.7s | exit 0, 0.7s | pass |
| django__django-12143 | 2/2 | unresolved | exit 1, 1.2s | exit 0, 1.1s | pass |
| django__django-12155 | 2/2 | unresolved | exit 1, 0.7s | exit 0, 0.7s | pass |
| django__django-12193 | 2/2 | unresolved | exit 1, 0.8s | exit 0, 0.8s | pass |
| django__django-12209 | 2/2 | unresolved | exit 1, 1.2s | exit 0, 1.3s | pass |
| django__django-12262 | 2/2 | unresolved | exit 1, 0.6s | exit 0, 0.6s | pass |
| django__django-12273 | 2/2 | unresolved | exit 1, 0.8s | exit 0, 0.8s | pass |
| django__django-12276 | 2/2 | unresolved | exit 1, 0.8s | exit 0, 0.8s | pass |
| django__django-12304 | 2/2 | unresolved | exit 1, 0.6s | exit 0, 0.6s | pass |
| django__django-12308 | 2/2 | unresolved | exit 1, 0.7s | exit 0, 0.7s | pass |
| django__django-12325 | 2/2 | unresolved | exit 1, 0.9s | exit 0, 0.8s | pass |
| django__django-12406 | 2/2 | unresolved | exit 1, 1.1s | exit 0, 1.1s | pass |
| django__django-12708 | 2/2 | unresolved | exit 1, 1.3s | exit 0, 1.3s | pass |
| django__django-12713 | 2/2 | unresolved | exit 1, 1.0s | exit 0, 1.0s | pass |
| django__django-12774 | 2/2 | unresolved | exit 1, 0.8s | exit 0, 0.8s | pass |

## Findings

None.

## Suggested exclusions

None.
