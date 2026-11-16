# BUILD REPORT — kidsweek

Clean-room rebuild of `com.littlesweekly/littles-weekly` v1.0.0
(remote-only MCP server at `https://littlesweekly.com/mcp`), built
2026-10-28 as a forwarding client. Package: `@reneturcios/kidsweek`
0.1.0, registry name `io.github.CloudCorpRecords/kidsweek`.

## Surface built

Complete surface: **5 of 5 captured tools built**, no omissions.

| Tool | Required fields as served |
|------|---------------------------|
| `list_cities` | *(none)* |
| `list_pages` | `city` |
| `get_page` | `city` |
| `get_events` | `city` |
| `search` | `query` |

Each served tool carries exactly the keys `name`, `title`,
`description`, `inputSchema`, with the `inputSchema.$schema` marker
(`http://json-schema.org/draft-07/schema#`) exactly as captured.
The tool literals were generated programmatically from
`harness/fixtures/littlesweekly-tools-original.json` by the script at
`/tmp/laneb1-kidsweek-scratch/gen.py` (parse + re-serialise, placeholder
substitution into `src/forward.ts`) — never retyped — and a
post-generation check (the registration-integrity test suite, plus the
parity harness) confirmed the served literals deep-equal the fixture's
5 tool objects, in order. Tools are registered via the MCP SDK
low-level Server API (`ListToolsRequestSchema` /
`CallToolRequestSchema` handlers), not McpServer+zod.

## Fixture conflicts

**None.** The spec and the fixture agree on the tools' names, titles,
descriptions, required fields (`list_cities` carries no `required`
key; `list_pages`, `get_page` and `get_events` require `city`;
`search` requires `query`) and property shapes.

## Labelled reconstructions (from the spec's Wire section)

- Upstream endpoint pinned: `https://littlesweekly.com/mcp`.
- Env override `LITTLESWEEKLY_MCP_URL` — labelled reconstruction.
- The registry record declares NO headers on the remote: no auth
  header is ever sent, under any environment. Tests assert that no
  `Authorization` header (and no `X-API-Key` header) is sent with an
  empty environment, with a `LITTLESWEEKLY_API_KEY`-style variable
  present, and with `AUTHORIZATION` / `API_KEY` / `LITTLESWEEKLY_TOKEN`
  variables present.
- Error rendering `kidsweek error:` text for upstream failures —
  labelled reconstruction.
- Upstream results pass through verbatim, including `isError` and
  extra fields. tools/call is forwarded as streamable-HTTP JSON-RPC:
  initialize (protocolVersion `2025-03-26`) →
  notifications/initialized → tools/call, honouring `Mcp-Session-Id`
  when issued; plain-JSON and SSE replies are both parsed. The
  forwarding core takes an injectable fetch; tests stub the
  upstream — no live network calls in tests.

## Deviations

None.

## Lockfile

- Route: generated clean from birth in the build dir with no
  `node_modules` and no pre-existing lockfile:
  `npm install --package-lock-only --ignore-scripts --offline`.
- Parses as JSON; `name` == `@reneturcios/kidsweek`.
- Package entries: **128**.
- sha256: `ad107a9326aedeb0ac10a406f90483c7800c3f15ef6836fb5079100b67e855f5`
  (re-verified unchanged after the subsequent offline `npm install`).

## server.json

- Description exactly: "Things to do with kids 0-6, city by city:
  weekly picks, free days, events." — **74 characters**.
- npm package entry carries `"version": "0.1.0"`; the OCI entry
  (`ghcr.io/cloudcorprecords/kidsweek:0.1.0`) carries **no**
  `version` field. Both entries carry packageArguments
  `[{type: positional, value: mcp}]` and transport stdio. Dockerfile
  (node:20-alpine, both stages) carries the label
  `io.modelcontextprotocol.server.name="io.github.CloudCorpRecords/kidsweek"`.
  Container workflow `IMAGE` is `ghcr.io/cloudcorprecords/kidsweek`
  and its smoke test asserts the server name `kidsweek`.

## Verification (all run 2026-10-28)

1. `npx tsc --noEmit` → exit 0.
2. `npm run build` → exit 0; real `dist/` produced (cli, forward,
   index, mcp, types — .js, .d.ts, .js.map each).
3. `node dist/cli.js --version` → `0.1.0`.
4. `npm test` → **66 tests, 66 pass, 0 fail** (registration-integrity
   suite deep-equals the served tools/list against the fixture's 5
   tools, plus session handling/reuse, env override, the
   no-Authorization-header assertions under every environment,
   verbatim argument forwarding and result pass-through including
   upstream isError, SSE parsing, error rendering, MCP-layer
   validation, and CLI behaviour).
5. Parity: `python3 /home/hatch/workspace/mcp-rebuild-100/harness/parity.py --original /home/hatch/workspace/mcp-rebuild-100/harness/fixtures/littlesweekly-tools-original.json --rebuild "stdio:node /home/hatch/workspace/mcp-rebuild-100/builds/kidsweek/dist/cli.js mcp" --out /home/hatch/workspace/mcp-rebuild-100/builds/kidsweek/parity-out` → **verdict PASS, parity 100.0**
   (5/5 identical, 0 missing, 0 extra, no schema diffs). Output in
   `parity-out/`.
