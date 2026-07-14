# onehand

`onehand` is a lightweight local repository coding-agent CLI for Linux/macOS. It uses the OpenAI Responses API, exposes a small set of local repository tools to the model, and produces an execution report plus git diff.

## Usage

```bash
export OPENAI_API_KEY=...
npm run build
onehand run "fix the failing test" --repo /path/to/repo --test "npm test"
onehand diff --repo /path/to/repo
onehand doctor
```

The default model is `gpt-5.5`. Override it with `--model` or `OPENAI_MODEL`.
