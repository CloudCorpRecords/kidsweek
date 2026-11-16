import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import {
  KidsweekClient,
  callTool,
  createClient,
  DEFAULT_ENDPOINT_URL,
  isKnownTool,
  parseRpcBody,
  PROTOCOL_VERSION,
  TOOL_DEFS,
  TOOL_NAMES,
  VERSION,
} from "../src/forward.js";
import { handleCallTool } from "../src/mcp.js";
import type {
  FetchFn,
  FetchResponseLike,
  ToolDef,
  ToolResult,
} from "../src/types.js";

/**
 * Every test runs against a stubbed JSON-RPC upstream that
 * implements the streamable-HTTP session flow
 * (initialize -> notifications/initialized -> tools/call):
 * no live network, and the real Littles Weekly endpoint is
 * never contacted.
 */

const FIXTURE_URL = new URL(
  "../../../harness/fixtures/littlesweekly-tools-original.json",
  import.meta.url,
);
const FIXTURE_AVAILABLE = existsSync(FIXTURE_URL);
const fixture = (
  FIXTURE_AVAILABLE
    ? JSON.parse(readFileSync(FIXTURE_URL, "utf-8"))
    : { tools: [] }
) as {
  tools: ToolDef[];
};
/** Recursively strip `description` fields (tool- and parameter-level).
 * Ruling 1 (2026-11-04): the served tools carry parameter descriptions
 * added over the original capture; everything else must match exactly. */
function stripDescriptions(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripDescriptions);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k !== "description") out[k] = stripDescriptions(v);
    }
    return out;
  }
  return value;
}
/**
 * Publish-survival guard (Wave 25 preflight, proven Wave 24 pattern):
 * the parity fixture lives in the build harness, outside the published
 * repo tree, so fixture-dependent tests skip cleanly when it is absent;
 * with the fixture present they run in full, with no skips.
 */
function skipWithoutFixture(t: {
  skip: (message: string) => void;
}): boolean {
  if (FIXTURE_AVAILABLE) return false;
  t.skip("parity fixture lives in the build harness, not the repo tree");
  return true;
}


const CITIES = "list_cities";
const PAGES = "list_pages";
const PAGE = "get_page";
const EVENTS = "get_events";
const SEARCH = "search";
const ALL_TOOLS = [CITIES, PAGES, PAGE, EVENTS, SEARCH];

const SAMPLE_RESULT = {
  content: [{ type: "text", text: "{\"cities\":[\"omaha\"]}" }],
  structuredContent: { cities: ["omaha"] },
};

const SAMPLE_ARGS = { city: "omaha" };

interface Captured {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

interface FakeOptions {
  callResult?: Record<string, unknown>;
  callBodyText?: string;
  callError?: Record<string, unknown>;
  callStatus?: number;
  initError?: Record<string, unknown>;
  throwOn?: "initialize" | "tools/call";
  sessionId?: string | null;
  hangOnCall?: boolean;
  sse?: boolean;
}

function makeResponse(
  status: number,
  bodyText: string,
  headers: Record<string, string> = {},
): FetchResponseLike {
  const lowered = new Map(
    Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]),
  );
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => lowered.get(name.toLowerCase()) ?? null },
    text: async () => bodyText,
  };
}

function jsonResponse(
  status: number,
  payload: unknown,
  headers: Record<string, string> = {},
) {
  return makeResponse(status, JSON.stringify(payload), headers);
}

function makeUpstream(options: FakeOptions = {}): {
  fetchFn: FetchFn;
  calls: Captured[];
} {
  const calls: Captured[] = [];
  const fetchFn: FetchFn = async (url, init) => {
    const body = JSON.parse(init?.body ?? "{}") as Record<string, unknown>;
    calls.push({ url, headers: init?.headers ?? {}, body });
    const method = body.method as string;
    if (options.throwOn === method) throw new Error("socket hang up");
    if (method === "initialize") {
      if (options.initError !== undefined) {
        return jsonResponse(200, {
          jsonrpc: "2.0",
          id: body.id,
          error: options.initError,
        });
      }
      const headers: Record<string, string> = {};
      const sessionId =
        options.sessionId === undefined ? "sess-abc" : options.sessionId;
      if (sessionId !== null) headers["mcp-session-id"] = sessionId;
      return jsonResponse(
        200,
        {
          jsonrpc: "2.0",
          id: body.id,
          result: {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: {},
            serverInfo: { name: "littles-weekly", version: "1.0.0" },
          },
        },
        headers,
      );
    }
    if (method === "notifications/initialized") {
      return makeResponse(202, "");
    }
    if (method === "tools/call") {
      if (options.hangOnCall) {
        return new Promise<FetchResponseLike>((_resolve, reject) => {
          const signal = init?.signal;
          if (signal) {
            if (signal.aborted) {
              reject(new Error("aborted"));
              return;
            }
            signal.addEventListener("abort", () => reject(new Error("aborted")));
          }
        });
      }
      if (options.callBodyText !== undefined) {
        return makeResponse(options.callStatus ?? 200, options.callBodyText);
      }
      if (options.callError !== undefined) {
        return jsonResponse(200, {
          jsonrpc: "2.0",
          id: body.id,
          error: options.callError,
        });
      }
      const result = options.callResult ?? SAMPLE_RESULT;
      const payload = { jsonrpc: "2.0", id: body.id, result };
      if (options.sse) {
        return makeResponse(
          200,
          `event: message\ndata: ${JSON.stringify(payload)}\n\n`,
        );
      }
      return jsonResponse(options.callStatus ?? 200, payload);
    }
    return jsonResponse(200, {});
  };
  return { fetchFn, calls };
}

function stubClient(options: FakeOptions = {}, extra: Record<string, unknown> = {}) {
  const upstream = makeUpstream(options);
  const c = new KidsweekClient({
    fetchFn: upstream.fetchFn,
    env: {},
    ...extra,
  });
  return { client: c, calls: upstream.calls };
}

function textOf(result: ToolResult): string {
  const content = result.content as Array<{ type: string; text: string }>;
  return content[0].text;
}

function methods(calls: Captured[]): string[] {
  return calls.map((c) => c.body.method as string);
}

function schemaOf(tool: ToolDef): Record<string, any> {
  return tool.inputSchema as Record<string, any>;
}

/* ------------------------------------------------------------------ */

describe("registration integrity (captured surface)", () => {
  it("serves exactly the fixture's 5 tools, deep-equal, in order", (t) => {
    if (skipWithoutFixture(t)) return;
    assert.equal(fixture.tools.length, 5);
    assert.deepEqual(stripDescriptions(TOOL_DEFS), stripDescriptions(fixture.tools));
  });

  it("serves the 5 tool names in fixture order", () => {
    assert.deepEqual(TOOL_NAMES, ALL_TOOLS);
  });

  it("carries exactly the fixture's keys on every tool", () => {
    for (const tool of TOOL_DEFS) {
      assert.deepEqual(Object.keys(tool).sort(), [
        "description",
        "inputSchema",
        "name",
        "title",
      ]);
    }
  });

  it("carries the fixture's titles verbatim", (t) => {
    if (skipWithoutFixture(t)) return;
    for (let i = 0; i < TOOL_DEFS.length; i++) {
      assert.equal(TOOL_DEFS[i].title, fixture.tools[i].title);
    }
    assert.equal(TOOL_DEFS[0].title, "List cities");
    assert.equal(TOOL_DEFS[2].title, "Get a page");
    assert.equal(TOOL_DEFS[3].title, "Find dated outings");
    assert.equal(TOOL_DEFS[4].title, "Search listings");
  });

  it("carries the fixture's descriptions verbatim", (t) => {
    if (skipWithoutFixture(t)) return;
    for (let i = 0; i < TOOL_DEFS.length; i++) {
      assert.equal(TOOL_DEFS[i].description, fixture.tools[i].description);
    }
    assert.match(TOOL_DEFS[0].description, /Every city Littles Weekly covers/);
    assert.match(TOOL_DEFS[4].description, /Keyword search across every card/);
  });

  it("list_cities requires nothing; the others require exactly city or query", () => {
    assert.equal(schemaOf(TOOL_DEFS[0]).required, undefined);
    assert.deepEqual(schemaOf(TOOL_DEFS[1]).required, ["city"]);
    assert.deepEqual(schemaOf(TOOL_DEFS[2]).required, ["city"]);
    assert.deepEqual(schemaOf(TOOL_DEFS[3]).required, ["city"]);
    assert.deepEqual(schemaOf(TOOL_DEFS[4]).required, ["query"]);
  });

  it("carries the $schema marker and object type on every inputSchema", () => {
    for (const tool of TOOL_DEFS) {
      assert.equal(schemaOf(tool).type, "object");
      assert.equal(
        schemaOf(tool)["$schema"],
        "http://json-schema.org/draft-07/schema#",
      );
    }
  });

  it("carries every fixture property, in order, for every tool", (t) => {
    if (skipWithoutFixture(t)) return;
    for (let i = 0; i < TOOL_DEFS.length; i++) {
      const served = Object.keys(schemaOf(TOOL_DEFS[i]).properties);
      const expected = Object.keys(schemaOf(fixture.tools[i]).properties);
      assert.deepEqual(served, expected);
    }
  });

  it("list_cities carries no properties", () => {
    assert.deepEqual(Object.keys(schemaOf(TOOL_DEFS[0]).properties), []);
  });

  it("list_pages carries only city", () => {
    assert.deepEqual(Object.keys(schemaOf(TOOL_DEFS[1]).properties), ["city"]);
  });

  it("get_page carries city, page, section and format", () => {
    assert.deepEqual(Object.keys(schemaOf(TOOL_DEFS[2]).properties), [
      "city",
      "page",
      "section",
      "format",
    ]);
  });

  it("get_events carries city, dates, filters, age, page and limit", () => {
    assert.deepEqual(Object.keys(schemaOf(TOOL_DEFS[3]).properties), [
      "city",
      "start_date",
      "end_date",
      "free_only",
      "indoor_only",
      "age",
      "page",
      "limit",
    ]);
  });

  it("search carries query, city and limit", () => {
    assert.deepEqual(Object.keys(schemaOf(TOOL_DEFS[4]).properties), [
      "query",
      "city",
      "limit",
    ]);
  });

  it("get_page format enumerates structured and markdown; page defaults to this-week", () => {
    const props = schemaOf(TOOL_DEFS[2]).properties;
    assert.deepEqual(props.format.enum, ["structured", "markdown"]);
    assert.equal(props.page.default, "this-week");
  });

  it("get_events age is an integer 0..12 and limit is 1..100", () => {
    const props = schemaOf(TOOL_DEFS[3]).properties;
    assert.equal(props.age.type, "integer");
    assert.equal(props.age.minimum, 0);
    assert.equal(props.age.maximum, 12);
    assert.equal(props.limit.minimum, 1);
    assert.equal(props.limit.maximum, 100);
  });

  it("search query is a 2..200 char string and limit is 1..50", () => {
    const props = schemaOf(TOOL_DEFS[4]).properties;
    assert.equal(props.query.type, "string");
    assert.equal(props.query.minLength, 2);
    assert.equal(props.query.maxLength, 200);
    assert.equal(props.limit.minimum, 1);
    assert.equal(props.limit.maximum, 50);
  });

  it("isKnownTool recognises the captured tools and rejects others", () => {
    for (const name of ALL_TOOLS) assert.equal(isKnownTool(name), true);
    assert.equal(isKnownTool("list_city"), false);
    assert.equal(isKnownTool("events"), false);
    assert.equal(isKnownTool(""), false);
  });
});

/* ------------------------------------------------------------------ */

describe("session establishment and reuse", () => {
  it("runs initialize, notifications/initialized, then tools/call in order", async () => {
    const { client: c, calls } = stubClient();
    const out = await c.callTool(CITIES, {});
    assert.equal(out.isError, undefined);
    assert.deepEqual(methods(calls), [
      "initialize",
      "notifications/initialized",
      "tools/call",
    ]);
    assert.ok(calls.every((call) => call.url === DEFAULT_ENDPOINT_URL));
    assert.equal(DEFAULT_ENDPOINT_URL, "https://littlesweekly.com/mcp");
    for (const call of calls) {
      assert.equal(call.headers["Content-Type"], "application/json");
      assert.equal(call.headers["Accept"], "application/json, text/event-stream");
    }
    assert.equal(calls[0].headers["Mcp-Session-Id"], undefined);
    assert.equal(calls[1].headers["Mcp-Session-Id"], "sess-abc");
    assert.equal(calls[2].headers["Mcp-Session-Id"], "sess-abc");
  });

  it("sends clientInfo name kidsweek and the pinned protocol version on initialize", async () => {
    const { client: c, calls } = stubClient();
    await c.callTool(CITIES, {});
    const initParams = calls[0].body.params as Record<string, unknown>;
    assert.equal(initParams.protocolVersion, PROTOCOL_VERSION);
    assert.equal(PROTOCOL_VERSION, "2025-03-26");
    assert.deepEqual(initParams.capabilities, {});
    assert.deepEqual(initParams.clientInfo, { name: "kidsweek", version: VERSION });
  });

  it("establishes the session lazily once and reuses it on later calls", async () => {
    const { client: c, calls } = stubClient();
    await c.callTool(CITIES, {});
    await c.callTool(SEARCH, { query: "Santa breakfast" });
    assert.deepEqual(methods(calls), [
      "initialize",
      "notifications/initialized",
      "tools/call",
      "tools/call",
    ]);
    assert.equal(calls[3].headers["Mcp-Session-Id"], "sess-abc");
    assert.notEqual(calls[2].body.id, calls[3].body.id);
  });

  it("sends no session header when the upstream issues none", async () => {
    const { client: c, calls } = stubClient({ sessionId: null });
    const out = await c.callTool(CITIES, {});
    assert.equal(out.isError, undefined);
    assert.ok(calls.every((call) => call.headers["Mcp-Session-Id"] === undefined));
  });

  it("honours the LITTLESWEEKLY_MCP_URL env override", async () => {
    const upstream = makeUpstream();
    const c = new KidsweekClient({
      fetchFn: upstream.fetchFn,
      env: { LITTLESWEEKLY_MCP_URL: "https://staging.example.com/mcp" },
    });
    await c.callTool(CITIES, {});
    assert.ok(
      upstream.calls.every((call) => call.url === "https://staging.example.com/mcp"),
    );
  });

  it("honours an explicit url override over the default endpoint", async () => {
    const upstream = makeUpstream();
    const c = createClient({
      fetchFn: upstream.fetchFn,
      env: {},
      url: "https://alt.example.com/mcp",
    });
    await c.callTool(CITIES, {});
    assert.ok(upstream.calls.every((call) => call.url === "https://alt.example.com/mcp"));
  });

  it("prefers an explicit url override over the env override", async () => {
    const upstream = makeUpstream();
    const c = createClient({
      fetchFn: upstream.fetchFn,
      env: { LITTLESWEEKLY_MCP_URL: "https://env.example.com/mcp" },
      url: "https://explicit.example.com/mcp",
    });
    await c.callTool(CITIES, {});
    assert.ok(
      upstream.calls.every((call) => call.url === "https://explicit.example.com/mcp"),
    );
  });

  it("falls back to the pinned endpoint when the env override is blank", async () => {
    const upstream = makeUpstream();
    const c = new KidsweekClient({
      fetchFn: upstream.fetchFn,
      env: { LITTLESWEEKLY_MCP_URL: "   " },
    });
    await c.callTool(CITIES, {});
    assert.ok(upstream.calls.every((call) => call.url === DEFAULT_ENDPOINT_URL));
  });
});

/* ------------------------------------------------------------------ */

describe("no auth header is ever sent (record declares NO headers)", () => {
  it("sends no Authorization header when the environment is empty", async () => {
    const { client: c, calls } = stubClient();
    await c.callTool(CITIES, {});
    assert.equal(calls.length, 3);
    assert.ok(calls.every((call) => call.headers["Authorization"] === undefined));
  });

  it("sends no Authorization header even when a LITTLESWEEKLY_API_KEY-style env var is present", async () => {
    const upstream = makeUpstream();
    const c = new KidsweekClient({
      fetchFn: upstream.fetchFn,
      env: { LITTLESWEEKLY_API_KEY: "some-key-42" },
    });
    await c.callTool(CITIES, {});
    assert.ok(
      upstream.calls.every((call) => call.headers["Authorization"] === undefined),
    );
  });

  it("sends no Authorization header even when AUTHORIZATION / API_KEY env vars are present", async () => {
    const upstream = makeUpstream();
    const c = new KidsweekClient({
      fetchFn: upstream.fetchFn,
      env: { AUTHORIZATION: "Bearer x", API_KEY: "y", LITTLESWEEKLY_TOKEN: "z" },
    });
    await c.callTool(SEARCH, { query: "splash pad" });
    assert.ok(
      upstream.calls.every((call) => call.headers["Authorization"] === undefined),
    );
  });

  it("never sends an X-API-Key header either", async () => {
    const upstream = makeUpstream();
    const c = new KidsweekClient({
      fetchFn: upstream.fetchFn,
      env: { LITTLESWEEKLY_API_KEY: "some-key-42" },
    });
    await c.callTool(CITIES, {});
    assert.ok(upstream.calls.every((call) => call.headers["X-API-Key"] === undefined));
  });

  it("sends only Content-Type, Accept and (when issued) Mcp-Session-Id headers", async () => {
    const { client: c, calls } = stubClient();
    await c.callTool(CITIES, {});
    assert.deepEqual(Object.keys(calls[0].headers).sort(), [
      "Accept",
      "Content-Type",
    ]);
    assert.deepEqual(Object.keys(calls[2].headers).sort(), [
      "Accept",
      "Content-Type",
      "Mcp-Session-Id",
    ]);
  });
});

/* ------------------------------------------------------------------ */

describe("tools/call forwarding", () => {
  it("forwards a list_cities call verbatim", async () => {
    const { client: c, calls } = stubClient();
    await c.callTool(CITIES, {});
    const params = calls[2].body.params as Record<string, unknown>;
    assert.equal(params.name, CITIES);
    assert.deepEqual(params.arguments, {});
  });

  it("forwards a list_pages call verbatim", async () => {
    const { client: c, calls } = stubClient();
    await c.callTool(PAGES, SAMPLE_ARGS);
    const params = calls[2].body.params as Record<string, unknown>;
    assert.equal(params.name, PAGES);
    assert.deepEqual(params.arguments, SAMPLE_ARGS);
  });

  it("forwards a get_page call with every option verbatim", async () => {
    const args = { city: "omaha", page: "free", section: "Top 5", format: "markdown" };
    const { client: c, calls } = stubClient();
    await c.callTool(PAGE, args);
    const params = calls[2].body.params as Record<string, unknown>;
    assert.equal(params.name, PAGE);
    assert.deepEqual(params.arguments, args);
  });

  it("forwards a get_events call with every filter verbatim", async () => {
    const args = {
      city: "kansas-city",
      start_date: "2026-10-28",
      end_date: "2026-11-04",
      free_only: true,
      indoor_only: false,
      age: 3,
      page: "this-week",
      limit: 10,
    };
    const { client: c, calls } = stubClient();
    await c.callTool(EVENTS, args);
    const params = calls[2].body.params as Record<string, unknown>;
    assert.equal(params.name, EVENTS);
    assert.deepEqual(params.arguments, args);
  });

  it("forwards a search call under its own name", async () => {
    const upstream = makeUpstream();
    const c = createClient({ fetchFn: upstream.fetchFn, env: {} });
    await c.callTool(SEARCH, { query: "toddler time", city: "omaha", limit: 5 });
    const params = upstream.calls[2].body.params as Record<string, unknown>;
    assert.equal(params.name, SEARCH);
    assert.deepEqual(params.arguments, { query: "toddler time", city: "omaha", limit: 5 });
  });

  it("passes the upstream result through verbatim, including extra fields", async () => {
    const { client: c } = stubClient();
    const out = await c.callTool(CITIES, {});
    assert.deepEqual(out, SAMPLE_RESULT);
  });

  it("passes an upstream isError result through untouched", async () => {
    const upstreamResult = {
      content: [{ type: "text", text: "no such city upstream" }],
      isError: true,
    };
    const { client: c } = stubClient({ callResult: upstreamResult });
    const out = await c.callTool(PAGES, SAMPLE_ARGS);
    assert.deepEqual(out, upstreamResult);
  });

  it("reads an SSE-framed tools/call response", async () => {
    const { client: c } = stubClient({ sse: true });
    const out = await c.callTool(CITIES, {});
    assert.equal(out.isError, undefined);
    assert.deepEqual(out, SAMPLE_RESULT);
  });

  it("the one-shot callTool helper forwards under the right tool name", async () => {
    const upstream = makeUpstream();
    const out = await callTool(
      SEARCH,
      { query: "free museum day" },
      { fetchFn: upstream.fetchFn, env: {} },
    );
    assert.equal(out.isError, undefined);
    const params = upstream.calls[2].body.params as Record<string, unknown>;
    assert.equal(params.name, SEARCH);
    assert.deepEqual(params.arguments, { query: "free museum day" });
  });
});

/* ------------------------------------------------------------------ */

describe("upstream failures surface as kidsweek error text", () => {
  it("maps a JSON-RPC error to `kidsweek error: <message>`", async () => {
    const { client: c } = stubClient({
      callError: { code: -32000, message: "lookup failed upstream" },
    });
    const out = await c.callTool(CITIES, {});
    assert.equal(out.isError, true);
    assert.equal(textOf(out), "kidsweek error: lookup failed upstream");
  });

  it("maps an initialize JSON-RPC error to kidsweek error text", async () => {
    const { client: c } = stubClient({
      initError: { code: -32600, message: "bad initialize" },
    });
    const out = await c.callTool(CITIES, {});
    assert.equal(out.isError, true);
    assert.equal(textOf(out), "kidsweek error: bad initialize");
  });

  it("maps an unparseable upstream response to a malformed-response error", async () => {
    const { client: c } = stubClient({ callBodyText: "<html>oops</html>" });
    const out = await c.callTool(CITIES, {});
    assert.equal(out.isError, true);
    assert.equal(textOf(out), "kidsweek error: malformed response");
  });

  it("maps a response with no result object to a malformed-response error", async () => {
    const { client: c } = stubClient({
      callBodyText: '{"jsonrpc":"2.0","id":3,"result":null}',
    });
    const out = await c.callTool(CITIES, {});
    assert.equal(out.isError, true);
    assert.equal(textOf(out), "kidsweek error: malformed response");
  });

  it("maps a non-2xx upstream status to kidsweek error text", async () => {
    const { client: c } = stubClient({ callBodyText: "internal error", callStatus: 500 });
    const out = await c.callTool(CITIES, {});
    assert.equal(out.isError, true);
    assert.equal(textOf(out), "kidsweek error: HTTP 500");
  });

  it("maps a throwing fetch to kidsweek error text", async () => {
    const { client: c } = stubClient({ throwOn: "tools/call" });
    const out = await c.callTool(CITIES, {});
    assert.equal(out.isError, true);
    assert.match(textOf(out), /^kidsweek error: /);
  });

  it("maps a throwing initialize fetch to kidsweek error text", async () => {
    const { client: c } = stubClient({ throwOn: "initialize" });
    const out = await c.callTool(CITIES, {});
    assert.equal(out.isError, true);
    assert.equal(textOf(out), "kidsweek error: socket hang up");
  });

  it("maps a timed-out call to kidsweek error text", async () => {
    const { client: c } = stubClient({ hangOnCall: true }, { timeoutMs: 20 });
    const out = await c.callTool(CITIES, {});
    assert.equal(out.isError, true);
    assert.match(textOf(out), /^kidsweek error: /);
  });
});

/* ------------------------------------------------------------------ */

describe("parseRpcBody", () => {
  it("parses plain JSON and picks the message with the matching id", () => {
    const body = '{"jsonrpc":"2.0","id":7,"result":{"ok":true}}';
    assert.deepEqual(parseRpcBody(body, 7), {
      jsonrpc: "2.0",
      id: 7,
      result: { ok: true },
    });
  });

  it("parses SSE data lines", () => {
    const body =
      'event: message\ndata: {"jsonrpc":"2.0","id":2,"result":{"ok":true}}\n\n';
    assert.deepEqual(parseRpcBody(body, 2), {
      jsonrpc: "2.0",
      id: 2,
      result: { ok: true },
    });
  });

  it("picks the matching id among several SSE messages", () => {
    const body =
      'data: {"jsonrpc":"2.0","id":1,"result":{"n":1}}\n\n' +
      'data: {"jsonrpc":"2.0","id":2,"result":{"n":2}}\n\n';
    assert.deepEqual(parseRpcBody(body, 2), {
      jsonrpc: "2.0",
      id: 2,
      result: { n: 2 },
    });
  });

  it("ignores the SSE [DONE] sentinel", () => {
    const body =
      'data: {"jsonrpc":"2.0","id":4,"result":{"ok":true}}\ndata: [DONE]\n';
    assert.deepEqual(parseRpcBody(body, 4), {
      jsonrpc: "2.0",
      id: 4,
      result: { ok: true },
    });
  });

  it("returns null for empty and unparseable bodies", () => {
    assert.equal(parseRpcBody(""), null);
    assert.equal(parseRpcBody("not json at all"), null);
    assert.equal(parseRpcBody("[1,2,3]"), null);
  });
});

/* ------------------------------------------------------------------ */

describe("MCP layer validation", () => {
  it("rejects an unknown tool with MethodNotFound before any network hop", async () => {
    const upstream = makeUpstream();
    const c = createClient({ fetchFn: upstream.fetchFn, env: {} });
    await assert.rejects(
      () => handleCallTool(c, "not_a_tool", {}),
      (err: unknown) =>
        err instanceof McpError && err.code === ErrorCode.MethodNotFound,
    );
    assert.equal(upstream.calls.length, 0);
  });

  it("rejects array arguments with InvalidParams before any network hop", async () => {
    const upstream = makeUpstream();
    const c = createClient({ fetchFn: upstream.fetchFn, env: {} });
    await assert.rejects(
      () => handleCallTool(c, PAGES, ["nope"]),
      (err: unknown) =>
        err instanceof McpError && err.code === ErrorCode.InvalidParams,
    );
    assert.equal(upstream.calls.length, 0);
  });

  it("rejects string arguments with InvalidParams before any network hop", async () => {
    const upstream = makeUpstream();
    const c = createClient({ fetchFn: upstream.fetchFn, env: {} });
    await assert.rejects(
      () => handleCallTool(c, PAGES, "city=omaha"),
      (err: unknown) =>
        err instanceof McpError && err.code === ErrorCode.InvalidParams,
    );
    assert.equal(upstream.calls.length, 0);
  });

  it("forwards a valid list_pages call through the MCP layer unchanged", async () => {
    const upstream = makeUpstream();
    const c = createClient({ fetchFn: upstream.fetchFn, env: {} });
    const out = await handleCallTool(c, PAGES, SAMPLE_ARGS);
    assert.deepEqual(out, SAMPLE_RESULT);
    const params = upstream.calls[2].body.params as Record<string, unknown>;
    assert.deepEqual(params.arguments, SAMPLE_ARGS);
  });

  it("forwards a valid search call through the MCP layer unchanged", async () => {
    const upstream = makeUpstream();
    const c = createClient({ fetchFn: upstream.fetchFn, env: {} });
    const out = await handleCallTool(c, SEARCH, { query: "splash pad" });
    assert.deepEqual(out, SAMPLE_RESULT);
    const params = upstream.calls[2].body.params as Record<string, unknown>;
    assert.equal(params.name, SEARCH);
    assert.deepEqual(params.arguments, { query: "splash pad" });
  });

  it("treats omitted arguments as an empty object", async () => {
    const upstream = makeUpstream();
    const c = createClient({ fetchFn: upstream.fetchFn, env: {} });
    const out = await handleCallTool(c, CITIES, undefined);
    assert.deepEqual(out, SAMPLE_RESULT);
    const params = upstream.calls[2].body.params as Record<string, unknown>;
    assert.deepEqual(params.arguments, {});
  });
});

/* ------------------------------------------------------------------ */

describe("CLI", () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const cliPath = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

  function runCli(args: string[]) {
    return spawnSync(process.execPath, ["--import", "tsx", cliPath, ...args], {
      cwd: root,
      encoding: "utf8",
      timeout: 30000,
    });
  }

  it("--version prints 0.1.0 and exits 0", () => {
    const res = runCli(["--version"]);
    assert.equal(res.status, 0);
    assert.equal(res.stdout.trim(), "0.1.0");
    assert.equal(res.stdout.trim(), VERSION);
  });

  it("-v prints 0.1.0 and exits 0", () => {
    const res = runCli(["-v"]);
    assert.equal(res.status, 0);
    assert.equal(res.stdout.trim(), "0.1.0");
  });

  it("an unknown command prints usage on stderr and exits 2", () => {
    const res = runCli(["not-a-tool"]);
    assert.equal(res.status, 2);
    assert.match(res.stderr, /Usage:/);
  });

  it("no command at all prints usage on stderr and exits 2", () => {
    const res = runCli([]);
    assert.equal(res.status, 2);
    assert.match(res.stderr, /Usage:/);
  });

  it("a non-JSON argument exits 2", () => {
    const res = runCli([PAGES, "not json"]);
    assert.equal(res.status, 2);
  });

  it("a JSON array argument exits 2", () => {
    const res = runCli([PAGES, "[]"]);
    assert.equal(res.status, 2);
  });

  it("extra arguments after a tool exit 2", () => {
    const res = runCli([PAGES, "{}", "extra"]);
    assert.equal(res.status, 2);
  });

  it("extra arguments after mcp exit 2", () => {
    const res = runCli(["mcp", "extra"]);
    assert.equal(res.status, 2);
  });
});
