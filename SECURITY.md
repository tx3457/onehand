# Security policy

## Supported version

Security fixes target the latest commit on `main`.

## Trust boundary

OneHand limits model-selected file and command operations to a configured repository, but it is **not an operating-system sandbox**. An allowed test, compiler, package script, or repository program can itself execute arbitrary code with the permissions of the current user.

Use OneHand only on repositories you trust. For third-party or adversarial code, place the repository and OneHand process in a disposable container or virtual machine with no secrets, no host mounts, and restricted network access.

## Default controls

- Canonical-path containment checks reject `..`, absolute-path, and symlink escapes.
- `.env`, key/certificate files, `.git`, package credential files, and `.onehand` are protected from model file tools.
- Model-selected commands use direct process spawning rather than a shell.
- Network clients, package/environment mutation, inline interpreter snippets, and mutating/network Git operations are refused.
- Child processes receive an environment-variable allowlist rather than the complete parent environment.
- Run state and traces:
  - are owner-only where the platform supports permissions;
  - use atomic writes;
  - redact model reasoning content and common credential patterns on disk.
- DeepSeek reasoning is kept in memory for the duration of a run. Thinking mode requires the previous `reasoning_content` to be sent back with every later tool-carrying request, so it is returned only to the configured provider.
- A resumed run sends a `[REDACTED]` placeholder instead of the original reasoning.

Redaction is defense in depth, not a guarantee that arbitrary secret formats will be detected. Do not place secrets in model-visible source files or share raw run state without inspection.

## Reporting a vulnerability

Open a GitHub security advisory for vulnerabilities. Do not include live credentials, private repository contents, or unredacted run traces in a public issue.
