# Changelog

## 0.1.0 (2026-10-28)

- First release: a forwarding client for the hosted Littles Weekly MCP server. All five captured tools are answered locally for tools/list, and every tools/call is forwarded upstream over a streamable-HTTP JSON-RPC session (initialize, notifications/initialized, tools/call, honouring the Mcp-Session-Id header when the upstream issues one).
- Tools: `list_cities`, `list_pages`, `get_page`, `get_events`, `search` — the complete captured 5-tool surface, no omissions.
- Upstream results pass through verbatim, including the isError flag; upstream failures surface as `kidsweek error:` text results.
- One bin serves the CLI (one subcommand per tool, plus `--version`) and the stdio MCP server (`mcp` subcommand). The upstream endpoint can be overridden via `LITTLESWEEKLY_MCP_URL`. The registry record declares no headers on the remote, so no auth header is ever sent.
