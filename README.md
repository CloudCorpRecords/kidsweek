# kidsweek

A family week, planned city by city. kidsweek is a local forwarding client for the hosted Littles Weekly MCP service: it answers `tools/list` on your own machine from the captured tool definitions and forwards every lookup to Littles Weekly, returning the results exactly as the service sends them back.

The surface is read-only editorial data for families with children aged 0–6: the cities the catalogue covers, the pages each city carries, the full contents of a page, dated outings, and keyword search across cards, outings and FAQs. Nothing is cached, stored or computed locally — the package is a pipe, not a catalogue.

## The tools

- **`list_cities`** — Every city Littles Weekly covers, with its slug, current week, last-checked date and the pages it has. Call this first if you are not sure of a slug. No arguments.
- **`list_pages`** — The pages for one city (or `"site"` for site-wide pages), with each page's URL, last-checked date, section headings and counts of FAQs and cards. `city` is required.
- **`get_page`** — Everything on one page, in reading order: sections, every card's official link and checked date, and the page FAQ. `city` is required; `page` defaults to `"this-week"`, `section` narrows to one heading, and `format` chooses `"structured"` (default) or `"markdown"`.
- **`get_events`** — Dated outings for kids 0–6 in one city, from this week's list plus dated listings on the seasonal and free pages. `city` is required; `start_date` / `end_date` bound the range, `free_only` and `indoor_only` filter, `age` keeps outings whose age range includes the child, and `limit` caps the results (1–100, default 40).
- **`search`** — Keyword search across every card, outing and FAQ, in one city or all of them. `query` is required (2–200 characters); `city` narrows the search and `limit` caps the results (1–50, default 15).

## Install and run

As an MCP server via npm:

```bash
npx -y @reneturcios/kidsweek mcp
```

MCP client configuration:

```json
{
  "mcpServers": {
    "kidsweek": {
      "command": "npx",
      "args": ["-y", "@reneturcios/kidsweek", "mcp"]
    }
  }
}
```

As a container:

```bash
docker run -i ghcr.io/cloudcorprecords/kidsweek
docker run --rm ghcr.io/cloudcorprecords/kidsweek list_cities '{}'
```

## CLI

One binary serves both the command line and the MCP server. Each tool is a subcommand taking a single JSON string with that tool's arguments:

```bash
kidsweek list_cities '{}'
kidsweek list_pages '{"city":"omaha"}'
kidsweek get_page '{"city":"omaha","page":"this-week"}'
kidsweek get_events '{"city":"omaha","free_only":true}'
kidsweek search '{"query":"Santa breakfast"}'
kidsweek --version
```

Exit codes: `0` when the forwarded call succeeds, `1` when the upstream result is an error, and `2` for usage problems such as an unknown subcommand or a malformed JSON argument.

## Configuration

- `LITTLESWEEKLY_MCP_URL` — Overrides the upstream endpoint. The default is the pinned hosted endpoint, `https://littlesweekly.com/mcp`. (The override variable is a reconstruction added by this rebuild.)

The Littles Weekly registry record declares no headers on its remote, so kidsweek sends no authentication header of any kind — lookups are keyless.

Upstream failures — a JSON-RPC error from the service, a non-2xx response, an unreadable body, or a request that fails outright — are reported to the caller as an error result whose text starts with `kidsweek error:`.

## How forwarding works

The first forwarded call opens a session: an `initialize` request (protocol version `2025-03-26`), followed by a `notifications/initialized` notification, then the `tools/call` itself. If the service answers the initialize request with an `Mcp-Session-Id` header, that value is carried on every later request, and the open session is reused for the rest of the process. Replies are accepted either as plain JSON or as server-sent events. Successful results pass through verbatim, including any `isError` flag and any extra fields the service includes.

## Development

```bash
npm install
npm run build   # tsc -> dist/ (dist/cli.js is the bin)
npm test        # tsx --test test/*.test.ts — stubbed upstream, no network
npm run dev     # run the CLI from source
```

The test suite checks the served tool list against the captured surface, exercises the session handshake and its reuse, asserts that no `Authorization` header is sent under any environment, and verifies that arguments go upstream untouched and results come back untouched.

## License

MIT — see `LICENSE`. Copyright (c) 2026 Rene Turcios.
