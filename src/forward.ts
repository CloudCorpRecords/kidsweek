/**
 * kidsweek core: a forwarding client for the hosted
 * Littles Weekly MCP server.
 *
 * No catalogue lives on this machine. tools/list
 * is answered from the literal definitions below, which
 * reproduce a live capture of the upstream server word
 * for word (name, title, description and inputSchema
 * exactly as captured, including the `$schema` marker
 * each captured inputSchema carries). A tools/call
 * travels upstream over a streamable-HTTP JSON-RPC
 * session: an initialize POST, a
 * notifications/initialized POST, then the tools/call
 * POST, carrying the Mcp-Session-Id response header on
 * later requests when the upstream issues one. The
 * session opens lazily on the first forwarded call and
 * is reused for the client's lifetime.
 *
 * The endpoint is pinned to
 * https://littlesweekly.com/mcp and may be replaced
 * with the LITTLESWEEKLY_MCP_URL environment variable
 * (that override is a labelled reconstruction). The
 * registry record declares NO headers on the remote:
 * no auth header is ever sent, under any environment.
 *
 * A successful upstream result is returned exactly as
 * received, isError flag and extra fields included.
 * Failures — an upstream JSON-RPC error, a non-2xx
 * status, a body that cannot be parsed, or a fetch
 * that throws or times out — become an isError result
 * whose text begins with `kidsweek error:` (that
 * rendering is a labelled reconstruction). Replies may
 * be plain JSON or SSE (`data:` lines); the JSON-RPC
 * message whose id matches the request wins.
 */
import type {
  FetchFn,
  FetchResponseLike,
  ForwardDeps,
  ToolArgs,
  ToolDef,
  ToolResult,
} from "./types.js";

export const VERSION = "0.1.0";

export const DEFAULT_ENDPOINT_URL = "https://littlesweekly.com/mcp";

export const DEFAULT_TIMEOUT_MS = 30000;

export const PROTOCOL_VERSION = "2025-03-26";

/* ------------------------------------------------------------------ */
/* Tool definitions (tools/list literals, verbatim from the live       */
/* capture in harness/fixtures/littlesweekly-tools-original.json;      */
/* generated programmatically by parsing and re-serialising the        */
/* fixture JSON, never retyped)                                        */
/* ------------------------------------------------------------------ */

export const TOOL_DEFS: ToolDef[] = [
  {
    "name": "list_cities",
    "title": "List cities",
    "description": "Every city Littles Weekly covers, with its slug, current week, last-checked date and the pages it has (this-week, guide, visiting, free, free-museum-days, indoor-play, storytime, ice-skating, santa, christmas-lights, thanksgiving, christmas-parades, christmas-break, noon-years-eve, playgrounds, splash-pads, birthday-parties, summer-camps, easter-egg-hunts, weekend-getaways). Call this first if you are not sure of a slug.",
    "inputSchema": {
      "$schema": "http://json-schema.org/draft-07/schema#",
      "type": "object",
      "properties": {}
    }
  },
  {
    "name": "list_pages",
    "title": "List a city’s pages",
    "description": "The pages for one city (or city \"site\" for site-wide pages like regional weekend getaways), with each page’s URL, last-checked date, section headings and how many FAQs and cards it has.",
    "inputSchema": {
      "$schema": "http://json-schema.org/draft-07/schema#",
      "type": "object",
      "properties": {
        "city": {
          "description": "City to list pages for, or \"site\" for site-wide pages",
          "anyOf": [
            {
              "type": "string",
              "minLength": 2,
              "maxLength": 60,
              "description": "City slug from list_cities (e.g. \"omaha\", \"kansas-city\", \"twin-cities\"). A plain city name like \"Kansas City\" also works."
            },
            {
              "type": "string",
              "const": "site"
            }
          ]
        }
      },
      "required": [
        "city"
      ]
    }
  },
  {
    "name": "get_page",
    "title": "Get a page",
    "description": "Everything on one Littles Weekly page, in reading order: each section (Top 5 picks, Saturday and Sunday plans, every outing, Around town favorites, free days with who gets in free, always-free places, storytimes, indoor play with ages, prices, toddler times and sock rules, weekly library storytimes by day and branch, ice rinks with season dates, prices, skate rental and skate aids, Santa and lights listings, Christmas parades and tree lightings, what’s open on Dec 24, Dec 25 and Jan 1, getaway trips, tips), every card’s official link and \"Checked\" date, and the page FAQ. page is a key from list_pages, like \"this-week\", \"guide\", \"visiting\", \"free\", \"indoor-play\", \"storytime\", \"ice-skating\", \"santa\", \"christmas-lights\", \"thanksgiving\", \"christmas-parades\", \"christmas-break\", \"noon-years-eve\" or \"weekend-getaways\". Long pages come back in parts: pass section to get one heading. format \"markdown\" returns the page’s Markdown version instead.",
    "inputSchema": {
      "$schema": "http://json-schema.org/draft-07/schema#",
      "type": "object",
      "properties": {
        "city": {
          "description": "City whose page to return",
          "anyOf": [
            {
              "type": "string",
              "minLength": 2,
              "maxLength": 60,
              "description": "City slug from list_cities (e.g. \"omaha\", \"kansas-city\", \"twin-cities\"). A plain city name like \"Kansas City\" also works."
            },
            {
              "type": "string",
              "const": "site"
            }
          ]
        },
        "page": {
          "default": "this-week",
          "description": "Page key from list_pages. Defaults to \"this-week\".",
          "type": "string",
          "minLength": 1,
          "maxLength": 80
        },
        "section": {
          "description": "Only the section whose heading contains this text, e.g. \"Top 5\", \"Sunday\", \"always free\", \"FAQ\".",
          "type": "string",
          "minLength": 1,
          "maxLength": 120
        },
        "format": {
          "description": "structured (default) or markdown",
          "type": "string",
          "enum": [
            "structured",
            "markdown"
          ]
        }
      },
      "required": [
        "city"
      ]
    }
  },
  {
    "name": "get_events",
    "title": "Find dated outings",
    "description": "Dated outings for kids 0–6 in one city: this week’s list plus dated listings from the seasonal and free pages (Santa visits, light displays, Thanksgiving, Noon Year’s Eve, free museum days). Each has dates, time, venue, address, price, free flag, soldOut flag (sold-out events stay listed, after the available ones), ages, description, the official link we checked, the date we checked it, the littlesweekly.com page URL and eventUrl (the event’s own shareable page; hand this link out when someone wants to send or save it). Defaults to everything from today on.",
    "inputSchema": {
      "$schema": "http://json-schema.org/draft-07/schema#",
      "type": "object",
      "properties": {
        "city": {
          "type": "string",
          "minLength": 2,
          "maxLength": 60,
          "description": "City slug from list_cities (e.g. \"omaha\", \"kansas-city\", \"twin-cities\"). A plain city name like \"Kansas City\" also works."
        },
        "start_date": {
          "description": "First day, YYYY-MM-DD (defaults to today in the city)",
          "type": "string",
          "pattern": "^\\d{4}-\\d{2}-\\d{2}$"
        },
        "end_date": {
          "description": "Last day, YYYY-MM-DD",
          "type": "string",
          "pattern": "^\\d{4}-\\d{2}-\\d{2}$"
        },
        "free_only": {
          "description": "Only outings a family can do without paying",
          "type": "boolean"
        },
        "indoor_only": {
          "description": "Only outings marked indoor (weekly list only)",
          "type": "boolean"
        },
        "age": {
          "description": "Child’s age in years; keeps outings whose age range includes it",
          "type": "integer",
          "minimum": 0,
          "maximum": 12
        },
        "page": {
          "description": "Limit to one page, e.g. \"santa\" or \"this-week\"",
          "type": "string",
          "maxLength": 80
        },
        "limit": {
          "description": "Max results (default 40)",
          "type": "integer",
          "minimum": 1,
          "maximum": 100
        }
      },
      "required": [
        "city"
      ]
    }
  },
  {
    "name": "search",
    "title": "Search listings",
    "description": "Keyword search across every card, outing and FAQ on Littles Weekly, in one city or all of them. Good for \"Santa breakfast\", \"toddler time\", \"free museum day\", \"splash pad\" or a venue name. Results carry the page URL (the event’s own shareable page for dated events, also as eventUrl; otherwise the card’s anchor), the official link and the checked date.",
    "inputSchema": {
      "$schema": "http://json-schema.org/draft-07/schema#",
      "type": "object",
      "properties": {
        "query": {
          "description": "Keywords to search for across cards, outings, and FAQs",
          "type": "string",
          "minLength": 2,
          "maxLength": 200
        },
        "city": {
          "description": "Limit to one city",
          "type": "string",
          "minLength": 2,
          "maxLength": 60
        },
        "limit": {
          "description": "Max results (default 15)",
          "type": "integer",
          "minimum": 1,
          "maximum": 50
        }
      },
      "required": [
        "query"
      ]
    }
  }
];

export const TOOL_NAMES = TOOL_DEFS.map((t) => t.name);

/** Whether `name` belongs to the captured surface. */
export function isKnownTool(name: string): boolean {
  return TOOL_NAMES.includes(name);
}

/* ------------------------------------------------------------------ */
/* Forwarding client                                                   */
/* ------------------------------------------------------------------ */

function errorResult(detail: string): ToolResult {
  return {
    content: [{ type: "text", text: `kidsweek error: ${detail}` }],
    isError: true,
  };
}

function rpcErrorMessage(error: unknown): string {
  if (error !== null && typeof error === "object") {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message !== "") return message;
    return JSON.stringify(error);
  }
  return String(error);
}

/**
 * Read a JSON-RPC response body, tolerating SSE framing.
 * Returns the message whose id matches `expectedId` when
 * present, otherwise the last parseable message, otherwise
 * null when nothing in the body parses.
 */
export function parseRpcBody(
  text: string,
  expectedId?: number,
): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  const candidates: Record<string, unknown>[] = [];
  const tryPush = (payload: string): void => {
    try {
      const parsed: unknown = JSON.parse(payload);
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        candidates.push(parsed as Record<string, unknown>);
      }
    } catch {
      // Not a JSON payload; skip this candidate.
    }
  };
  if (trimmed.includes("data:")) {
    for (const line of trimmed.split("\n")) {
      const t = line.trim();
      if (!t.startsWith("data:")) continue;
      const payload = t.slice("data:".length).trim();
      if (payload !== "" && payload !== "[DONE]") tryPush(payload);
    }
  } else {
    tryPush(trimmed);
  }
  if (candidates.length === 0) return null;
  if (expectedId !== undefined) {
    const match = candidates.find((c) => c.id === expectedId);
    if (match !== undefined) return match;
  }
  return candidates[candidates.length - 1];
}

async function defaultFetch(
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
): Promise<FetchResponseLike> {
  return fetch(url, init) as unknown as FetchResponseLike;
}

/**
 * A forwarding client holding a single upstream session,
 * opened lazily on first use and reused from then on
 * (for the process lifetime in the MCP server, or for a
 * single invocation in the CLI).
 */
export class KidsweekClient {
  private readonly deps: ForwardDeps;
  private sessionId: string | null = null;
  private ready = false;
  private sessionPromise: Promise<void> | null = null;
  private idCounter = 0;

  constructor(deps: ForwardDeps = {}) {
    this.deps = deps;
  }

  private fetchFn(): FetchFn {
    return this.deps.fetchFn ?? defaultFetch;
  }

  private endpointUrl(): string {
    if (this.deps.url && this.deps.url.trim() !== "") return this.deps.url.trim();
    const raw = (this.deps.env ?? process.env).LITTLESWEEKLY_MCP_URL;
    if (raw && raw.trim() !== "") return raw.trim();
    return DEFAULT_ENDPOINT_URL;
  }

  private timeoutMs(): number {
    if (typeof this.deps.timeoutMs === "number" && this.deps.timeoutMs > 0) {
      return this.deps.timeoutMs;
    }
    return DEFAULT_TIMEOUT_MS;
  }

  private nextId(): number {
    this.idCounter += 1;
    return this.idCounter;
  }

  private async post(
    body: unknown,
    withSession: boolean,
  ): Promise<FetchResponseLike> {
    // The registry record declares NO headers on the remote:
    // no Authorization (or any other auth) header is ever sent.
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    };
    if (withSession && this.sessionId !== null) {
      headers["Mcp-Session-Id"] = this.sessionId;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs());
    try {
      return await this.fetchFn()(this.endpointUrl(), {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  private async ensureSession(): Promise<void> {
    if (this.ready) return;
    if (this.sessionPromise === null) {
      this.sessionPromise = (async () => {
        const initId = this.nextId();
        const initRes = await this.post(
          {
            jsonrpc: "2.0",
            id: initId,
            method: "initialize",
            params: {
              protocolVersion: PROTOCOL_VERSION,
              capabilities: {},
              clientInfo: { name: "kidsweek", version: VERSION },
            },
          },
          false,
        );
        const sessionId = initRes.headers.get("mcp-session-id");
        if (sessionId) this.sessionId = sessionId;
        const initText = await initRes.text();
        const initParsed = parseRpcBody(initText, initId);
        if (initParsed !== null && initParsed.error) {
          throw new Error(rpcErrorMessage(initParsed.error));
        }
        if (initRes.status < 200 || initRes.status >= 300) {
          throw new Error(`HTTP ${initRes.status}`);
        }
        if (initParsed === null && initText.trim() !== "") {
          throw new Error("malformed response");
        }
        const initializedRes = await this.post(
          { jsonrpc: "2.0", method: "notifications/initialized" },
          true,
        );
        try {
          await initializedRes.text();
        } catch {
          // Nothing needed from the notification response body.
        }
        this.ready = true;
      })();
    }
    try {
      await this.sessionPromise;
    } catch (err) {
      this.sessionPromise = null;
      this.sessionId = null;
      throw err;
    }
  }

  /** Forward one tool call; upstream failures come back as isError results. */
  async callTool(name: string, args: ToolArgs): Promise<ToolResult> {
    try {
      await this.ensureSession();
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : String(err));
    }

    const callId = this.nextId();
    let callRes: FetchResponseLike;
    try {
      callRes = await this.post(
        {
          jsonrpc: "2.0",
          id: callId,
          method: "tools/call",
          params: { name, arguments: args ?? {} },
        },
        true,
      );
    } catch (err) {
      return errorResult(
        `request failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const parsed = parseRpcBody(await callRes.text(), callId);
    if (parsed !== null && parsed.error) {
      return errorResult(rpcErrorMessage(parsed.error));
    }
    if (callRes.status < 200 || callRes.status >= 300) {
      return errorResult(`HTTP ${callRes.status}`);
    }
    if (parsed === null) return errorResult("malformed response");
    const result = parsed.result as ToolResult | undefined;
    if (result === undefined || result === null || typeof result !== "object") {
      return errorResult("malformed response");
    }
    // Hand the upstream result back exactly as received.
    return result;
  }
}

/** Build a forwarding client; tests inject a fake fetch and env through deps. */
export function createClient(deps: ForwardDeps = {}): KidsweekClient {
  return new KidsweekClient(deps);
}

/** One-shot helper: a fresh client for a single call (the CLI path). */
export async function callTool(
  name: string,
  args: ToolArgs,
  deps: ForwardDeps = {},
): Promise<ToolResult> {
  return new KidsweekClient(deps).callTool(name, args);
}
