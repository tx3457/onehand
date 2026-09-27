# Extensions

[Back to README](../README.md)

Configure MCP servers and use the read-only explore and review sub-agents.

## MCP servers

Chat loads `mcpServers` from `~/.onehand/config.json` and the repository's `.onehand/config.json`. Project entries replace user entries with the same name. Servers start once per chat session and close when it exits. For example:

```json
{
  "mcpServers": {
    "docs": {
      "command": "node",
      "args": ["/absolute/path/to/docs-server.mjs"],
      "env": { "DOCS_ROOT": "/absolute/path/to/docs" },
      "cwd": "/absolute/path/to/docs",
      "enabled": true
    }
  },
  "permissions": {
    "allow": ["mcp__docs__search"],
    "deny": ["mcp__docs__delete"]
  }
}
```

`enabled` defaults to true; use false to disable an entry. The child inherits the SDK's safe environment plus the entry's explicit `env`, without inheriting OneHand's provider API keys. Only configure server commands you trust: the command starts at session startup, before tool-call approvals.

`/mcp` lists connected servers and their tools. Names use `mcp__<server>__<tool>`, sanitize unsupported characters, and fit within 64 characters; duplicate exposed names are warned about and dropped. Startup/discovery has a 10-second timeout per server; a failed server is skipped. Calls have a 60-second timeout and receive Ctrl+C cancellation, text output uses the normal output limit, and non-text blocks appear as omission notices.

In chat, MCP calls bypass planning but require permission. Their defaults are **deny in ask**, **ask in edit**, and **deny in auto**. Allow a single tool with `mcp__docs__search` or a server's tools with `mcp__docs__*`; deny rules still win. The library accepts an opt-in `extraTools: { definitions, execute }` adapter, which `McpManager` implements; supply `authorize` to enforce library-call permissions. Existing runs do not load MCP configuration automatically.

## Sub-agents

Chat exposes `explore({ question })` with every local profile. It runs a separate, read-only agent instructed to return at most 300 words with file paths and line numbers. Its history stays separate; the parent receives only its report. In evaluations, the `exploreSubagent` flag enables this tool only for the `ctx-sandbox-plan-explore` E9 arm.

Chat also exposes `review_changes({})`, and `/review` runs it directly using the latest task, tracked diff against `HEAD` (including staged changes), a status list for inspecting untracked files, and last plan. The diff/status context is capped at 30 KB. The reviewer reports concrete defects with file and line references or says `no blocking issues`. Chat enables these tools through `interactiveTools: ["explore", "review_changes"]`, separately from evaluation profiles.

Both presets can list, search and read files, inspect Git status/diff, and use only read-only inspection commands when the parent enables `sandboxCommands`. They cannot write, run tests, manage plans, call MCP tools or start another sub-agent. They share the parent's remaining steps, tool calls, input/output tokens and wall time, capped further at 20 steps, 30 tool calls and 400,000 input tokens per child. Token and tool usage is included in parent totals; child rounds are reported separately as `subagentRounds` and consume the shared step budget. They inherit provider/model settings and use the parent's cache-isolation nonce with a `-sub<n>` suffix. Trace and REPL events mark when each child starts and finishes.
