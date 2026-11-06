// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * `ExecuteRequest.cite` (`tools/citations.ts`): a citing call may name only sources the run's own lookups returned.
 *
 *   C1 addresses compare by their normalized form; what cannot be a source has none
 *   C2 sources are kept only from a producer the run believes: Brain's web tools and a trusted server; never a plugin's server
 *   C3 a citing call gets the kept entry for each address it names, numbered by its place; the rest is dropped and counted
 *   C4 a source server is trusted only when the run's entry of that name is the API's own (name and path)
 *   C5 `route()`: a lookup's sources are kept only when it answered; a citing call's `_meta` reaches its server; the read taint
 *      still refuses what it refused; no `cite`, no `_meta`
 *   C6 web_search lists its hits as sources (third-party and native), web_fetch the page it read whole, and nothing on a failure,
 *      a redirect to another host or content it would not read
 *   C7 the MCP client sends a request's `_meta` and reads a result's `claw/sources`, over the real transport
 *   C8 the say's text streams whatever follows it: `sources` after `text` does not hold the text back
 */
import test, { after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import axios, { type AxiosAdapter, type InternalAxiosRequestConfig } from "axios";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { CITE_DROPPED_META, CITE_SOURCES_META, GITHUB_MCP_PATH } from "@claw/protocol";

Object.assign(process.env, { WEB_SEARCH_PROVIDER: "brave", WEB_SEARCH_FALLBACK: "", BRAVE_API_KEY: "brave-key" });
const { citeKey, parseCite, RunCitations, webSource } = await import("../src/tools/citations.js");
const { ToolRouter } = await import("../src/tools/router.js");
const { parseReadTaint } = await import("../src/tools/allowlist.js");
const { WebSearchService, SimpleSessionCostTracker } = await import("../src/tools/web/index.js");
const { nativeSearchHits, searchSources } = await import("../src/tools/web/search.js");
const { WebFetchService } = await import("../src/tools/web/fetch.js");
const { connectPlatformMcp } = await import("../src/clients/mcp.js");
const { partialStringField } = await import("../src/llm/partial-json.js");

const PR = "https://github.com/AMD-AGI/PrimusClaw/pull/309";
const SAY = "mcp__assistant__say";
const github = (url = "http://api.internal:8200") => ({ github: { type: "http", url: `${url}${GITHUB_MCP_PATH}`, token: "t" } });

test("C1 addresses compare by their normalized form; what cannot be a source has none", () => {
  assert.equal(citeKey("HTTPS://GitHub.com/a/b/#frag"), "https://github.com/a/b");
  assert.equal(citeKey("https://github.com:443/a/b"), "https://github.com/a/b");
  assert.equal(citeKey("https://example.com/"), "https://example.com");
  assert.equal(citeKey("https://example.com/p?q=1#x"), "https://example.com/p?q=1", "the query is kept");
  assert.notEqual(citeKey("https://example.com/p?q=1"), citeKey("https://example.com/p?q=2"));
  for (const bad of [
    "javascript:alert(1)", "ftp://example.com/x", "https://user:pw@example.com/", "https://example.com/a b", "https://ex\u202eample.com/", "https://example.com/a\u206ab", "https://example.com/a\u200bb",
    "/relative", "", 42, null, `https://example.com/${"a".repeat(1100)}`,
  ]) assert.equal(citeKey(bad), null, String(bad));
  // An address that carries a credential is never a source, whichever lookup returned it.
  for (const secret of [
    "https://bucket.example/r?X-Amz-Signature=abc", "https://bucket.example/r?X-Amz-Credential=a%2Fb", "https://b.example/r?X-Amz-Security-Token=t",
    "https://acct.blob.core.windows.net/c/b?sv=2024&sig=abc", "https://x.example/cb?code=abc&state=s", "https://x.example/?access_token=abc",
    "https://x.example/?accessToken=abc", "https://x.example/?api_key=abc", "https://x.example/?apiKey=abc", "https://x.example/?key=abc",
    "https://s3.example/o?AWSAccessKeyId=AKIA&Expires=1", "https://x.example/cb#access_token=abc&token_type=bearer",
    "https://x.example/?client_secret=abc", "https://x.example/?password=abc", "https://x.example/r?q=1;sig=opaque-secret-value",
    "https://x.example/r#a=1;access_token=abc", "https://x.example/r?%73ig=abc",
  ]) assert.equal(citeKey(secret), null, secret);
  // Nor an address with a character that could close an attribute or open a tag where it is shown.
  for (const markup of ["https://example.com/<b>title</b>", 'https://example.com/a"onmouseover="x', "https://example.com/a'b",
    "https://example.com/a`b", "https://example.com/{x}", "https://example.com/a|b", "https://example.com/a\\b"]) assert.equal(citeKey(markup), null, markup);
  for (const ok of ["https://example.com/search?q=primus+claw&page=2", "https://docs.example/guide#section-2",
    "https://github.com/o/r/pull/1#issuecomment-123", "https://example.com/a?design=1&keyboard=us&signal=on"]) assert.ok(citeKey(ok), ok);
});

test("C2 sources are kept only from a producer the run believes: Brain's web tools and a trusted server", () => {
  const cite = new RunCitations(new Set([SAY]), new Set(["github"]));
  cite.keep("mcp__autopilot__get_nodes", [{ url: "https://evil.example/a", title: "x", kind: "web" }]);
  cite.keep("bash", [{ url: "https://evil.example/b", title: "x", kind: "web" }]);
  cite.keep(SAY, [{ url: "https://evil.example/c", title: "x", kind: "web" }]);
  assert.equal(cite.size, 0, "a plugin's server, a sandbox tool and the citing tool itself are never believed");
  cite.keep("mcp__github__pr_get", [
    { url: PR, title: "AMD-AGI/PrimusClaw#309 perf", kind: "github_pr" },
    { url: "javascript:alert(1)", title: "x", kind: "github_pr" },
    { url: "https://github.com/x", title: "x", kind: "not_a_kind" },
    "https://github.com/y",
  ]);
  cite.keep("web_search", [webSource("https://example.com/news#top", "News")]);
  cite.keep("web_fetch", [webSource("https://docs.example.com/page")]);
  assert.equal(cite.size, 3, "malformed entries are skipped");
});

test("C3 a citing call gets the kept entry for each address it names, numbered by its place; the rest is dropped", () => {
  const cite = new RunCitations(new Set([SAY]), new Set(["github"]));
  cite.keep("mcp__github__pr_get", [{ url: PR, title: "AMD-AGI/PrimusClaw#309 perf", kind: "github_pr" }]);
  cite.keep("web_search", [webSource("https://example.com/news#top", "News")]);
  assert.equal(cite.metaFor("mcp__assistant__work_create", { sources: [PR] }), undefined, "only a citing tool");
  assert.equal(cite.metaFor(SAY, { text: "no sources" }), undefined, "only a call that names sources");
  const meta = cite.metaFor(SAY, {
    text: "a [1] b [2] c [3] d [4]",
    sources: ["https://GITHUB.com/AMD-AGI/PrimusClaw/pull/309/", "https://made-up.example/x", "not a url", "https://example.com/news"],
  })!;
  assert.deepEqual(meta[CITE_SOURCES_META], [
    { n: 1, url: PR, title: "AMD-AGI/PrimusClaw#309 perf", kind: "github_pr" },
    { n: 4, url: "https://example.com/news", title: "News", kind: "web" },
  ], "the tool's own address, not the model's copy, and the numbers the model gave");
  assert.deepEqual(meta[CITE_DROPPED_META], { not_in_turn: 1, invalid: 1, over_cap: 0 });
  const many = cite.metaFor(SAY, { sources: Array.from({ length: 10 }, () => PR) })!;
  assert.equal((many[CITE_SOURCES_META] as unknown[]).length, 8);
  assert.deepEqual(many[CITE_DROPPED_META], { not_in_turn: 0, invalid: 0, over_cap: 2 });
});

test("C4 a source server is trusted only when the run's entry of that name is the API's own", () => {
  assert.equal(parseCite(undefined, {}), null);
  assert.equal(parseCite({ tools: [] }, {}), null);
  const trusted = parseCite({ tools: [SAY], source_servers: ["github"] }, github())!;
  assert.ok(trusted.producedBy("mcp__github__pr_get"));
  const elsewhere = parseCite({ tools: [SAY], source_servers: ["github"] }, { github: { type: "http", url: "https://evil.example/mcp" } })!;
  assert.equal(elsewhere.producedBy("mcp__github__pr_get"), false, "a server named github at another path is not the API's");
  const plugin = parseCite({ tools: [SAY], source_servers: ["autopilot"] }, { autopilot: { type: "http", url: `http://x${GITHUB_MCP_PATH}` } })!;
  assert.equal(plugin.producedBy("mcp__autopilot__get_nodes"), false, "only a name the API adds itself");
  assert.ok(trusted.producedBy("web_search") && trusted.producedBy("web_fetch"));
});

/** A router whose MCP servers answer from `answers`, and every call they got with its `_meta`. */
function routerWith(answers: Record<string, (tool: string) => { text: string; isError?: boolean; sources?: unknown[] }>) {
  const calls: Array<{ server: string; tool: string; meta?: Record<string, unknown> }> = [];
  const clients = new Map(Object.entries(answers).map(([server, answer]) => [server, {
    callTool: async (tool: string, _args: Record<string, unknown>, outcome?: { isError: boolean; sources?: unknown[] }, meta?: Record<string, unknown>) => {
      calls.push({ server, tool, meta });
      const a = answer(tool);
      if (outcome && a.isError) outcome.isError = true;
      if (outcome && a.sources) outcome.sources = a.sources;
      return a.text;
    },
  }]));
  return { router: new ToolRouter(null, clients), calls };
}

test("C5 route(): sources are kept from a lookup that answered, and a citing call's _meta reaches its server", async () => {
  const { router, calls } = routerWith({
    github: (tool) => tool === "pr_get"
      ? { text: "{}", sources: [{ url: PR, title: "AMD-AGI/PrimusClaw#309 perf", kind: "github_pr" }] }
      : { text: "GitHub answered 404", isError: true, sources: [{ url: "https://github.com/AMD-AGI/PrimusClaw/pull/1", title: "x", kind: "github_pr" }] },
    autopilot: () => ({ text: "12 nodes", sources: [{ url: "https://evil.example/", title: "plugin", kind: "web" }] }),
    assistant: () => ({ text: "{\"ok\":true}" }),
  });
  router.citations = parseCite({ tools: [SAY], source_servers: ["github"] }, github());
  router.readTaint = parseReadTaint({ sources: ["mcp__github__*", "mcp__autopilot__get_*"], allow_after: [SAY], clean_failures: ["mcp__github__*"] });
  await router.route("mcp__github__pr_get", {}, undefined, { isError: false });
  await router.route("mcp__github__issue_get", {}, undefined, { isError: false });
  await router.route("mcp__autopilot__get_nodes", {});
  assert.equal(router.citations!.size, 1, "the failed read and the plugin's server added nothing");
  const refused = await router.route("mcp__assistant__work_create", { sources: [PR] }, undefined, { isError: false });
  assert.match(refused, /was not run/, "the read taint refuses as before");
  await router.route(SAY, { text: "#309 [1]; [2]; [3]", sources: [PR, "https://github.com/AMD-AGI/PrimusClaw/pull/1", "https://evil.example/"] });
  const said = calls.at(-1)!;
  assert.equal(said.tool, "say");
  assert.deepEqual(said.meta, {
    [CITE_SOURCES_META]: [{ n: 1, url: PR, title: "AMD-AGI/PrimusClaw#309 perf", kind: "github_pr" }],
    [CITE_DROPPED_META]: { not_in_turn: 2, invalid: 0, over_cap: 0 },
  });
  assert.equal(calls.find((c) => c.tool === "get_nodes")?.meta, undefined, "a lookup is sent no _meta");

  const plain = routerWith({ assistant: () => ({ text: "{}" }) });
  await plain.router.route(SAY, { text: "a [1]", sources: [PR] });
  assert.equal(plain.calls[0].meta, undefined, "without cite, nothing is sent beside the arguments");
});

type Answer = (config: InternalAxiosRequestConfig) => Promise<unknown>;
const pages = new Map<string, Answer>();
const previous = axios.defaults.adapter;
axios.defaults.adapter = ((config: InternalAxiosRequestConfig) => {
  const page = pages.get(String(config.url)) ?? pages.get(new URL(String(config.url)).hostname);
  return page ? page(config) : Promise.reject(new Error(`unexpected request to ${config.url}`));
}) as AxiosAdapter;
after(() => { axios.defaults.adapter = previous; });
const respond = (config: InternalAxiosRequestConfig, status: number, headers: Record<string, string>, body: unknown = "") =>
  ({ data: typeof body === "string" ? Buffer.from(body) : body, status, statusText: "OK", headers, config, request: {} });
const publicResolve = ((_name: string, _o: unknown, cb: (e: null, a: Array<{ address: string; family: number }>) => void) =>
  cb(null, [{ address: "93.184.216.34", family: 4 }])) as never;

test("C6 web_search lists its hits as sources; web_fetch the page it read whole; nothing when either did not read", async () => {
  const search = new WebSearchService({
    sessionId: "s", apiKey: "k", apiUrl: "http://gateway.invalid", model: "m", anthropic: {} as never, sessionCost: new SimpleSessionCostTracker(),
  });
  pages.set("api.search.brave.com", async (config) => respond(config, 200, {}, {
    web: { results: [
      { title: "Release notes", url: "https://example.com/notes#v2", description: "s" },
      { title: "Bad", url: "javascript:alert(1)", description: "s" },
      { title: "", url: "https://example.org/a/b", description: "s" },
    ] },
  }));
  const found: { isError: boolean; sources?: unknown[] } = { isError: false };
  await search.execute({ query: "release notes" }, found);
  assert.deepEqual(found.sources, [
    { url: "https://example.com/notes", title: "Release notes", kind: "web" },
    { url: "https://example.org/a/b", title: "example.org/a/b", kind: "web" },
  ]);
  const failed: { isError: boolean; sources?: unknown[] } = { isError: false };
  await search.execute({ query: "x" }, failed);
  assert.equal(failed.isError, true);
  assert.equal(failed.sources, undefined);

  assert.deepEqual(searchSources(nativeSearchHits([
    { type: "server_tool_use" },
    { type: "web_search_tool_result", content: [{ type: "web_search_result", url: "https://news.example/a", title: "A" }] },
    { type: "web_search_tool_result", content: { type: "web_search_tool_result_error", error_code: "unavailable" } },
    { type: "text", text: "see https://not-a-result.example/" },
  ])), [{ url: "https://news.example/a", title: "A", kind: "web" }], "only the search tool's results, never the text around them");

  const fetch = new WebFetchService({} as never, publicResolve);
  pages.set("https://page.example/doc", async (config) => respond(config, 200, { "content-type": "text/plain" }, "the page"));
  const read: { isError: boolean; sources?: unknown[] } = { isError: false };
  await fetch.execute({ url: "https://page.example/doc" }, read);
  assert.deepEqual(read.sources, [{ url: "https://page.example/doc", title: "page.example/doc", kind: "web" }]);
  const again: { isError: boolean; sources?: unknown[] } = { isError: false };
  await fetch.execute({ url: "https://page.example/doc" }, again);
  assert.deepEqual(again.sources, read.sources, "a page read from the cache is a page read");
  pages.set("https://page.example/away", async (config) => respond(config, 302, { location: "https://elsewhere.example/" }));
  pages.set("https://page.example/bin", async (config) => respond(config, 200, { "content-type": "application/octet-stream" }, "\u0000"));
  pages.set("https://page.example/gone", async (config) => {
    const { AxiosError } = await import("axios");
    throw new AxiosError("404", AxiosError.ERR_BAD_REQUEST, config, {}, respond(config, 404, {}) as never);
  });
  for (const url of ["https://page.example/away", "https://page.example/bin", "https://page.example/gone"]) {
    const o: { isError: boolean; sources?: unknown[] } = { isError: false };
    await fetch.execute({ url }, o);
    assert.equal(o.sources, undefined, url);
  }
});

test("C7 the MCP client sends a request's _meta and reads a result's claw/sources, over the real transport", async () => {
  const seen: unknown[] = [];
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined;
    const mcp = new McpServer({ name: "fixture", version: "1.0.0" });
    mcp.tool("say", "say", { text: z.string() }, async (_args, extra) => {
      seen.push(extra._meta);
      return { content: [{ type: "text" as const, text: "ok" }] };
    });
    mcp.tool("pr_get", "a pull request", async () => ({
      content: [{ type: "text" as const, text: "{}" }], _meta: { [CITE_SOURCES_META]: [{ url: PR, title: "t", kind: "github_pr" }] },
    }));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined as never });
    res.on("close", () => { void transport.close(); void mcp.close(); });
    await mcp.connect(transport);
    await transport.handleRequest(req, res, body);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  let closeAll = async (): Promise<void> => {};
  try {
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
    const connected = await connectPlatformMcp({ fixture: { type: "http", url, token: "t" } });
    const { clients } = connected;
    closeAll = connected.closeAll;
    const client = clients.get("fixture")!;
    const outcome: { isError: boolean; sources?: unknown[] } = { isError: false };
    assert.equal(await client.callTool("pr_get", {}, outcome), "{}", "the model reads the text alone");
    assert.deepEqual(outcome.sources, [{ url: PR, title: "t", kind: "github_pr" }]);
    await client.callTool("say", { text: "a [1]" }, undefined, { [CITE_SOURCES_META]: [{ n: 1, url: PR, title: "t", kind: "github_pr" }] });
    await client.callTool("say", { text: "plain" });
    assert.deepEqual((seen[0] as Record<string, unknown>)[CITE_SOURCES_META], [{ n: 1, url: PR, title: "t", kind: "github_pr" }]);
    assert.equal((seen[1] as Record<string, unknown> | undefined)?.[CITE_SOURCES_META], undefined);
    // A server whose tools are filtered (`enabled_tools`) passes the _meta on as well.
    const filtered = await connectPlatformMcp({ fixture: { type: "http", url, token: "t", enabled_tools: ["say"] } });
    const close = closeAll;
    closeAll = async () => { await close(); await filtered.closeAll(); };
    await filtered.clients.get("fixture")!.callTool("say", { text: "b [2]" }, undefined, { [CITE_SOURCES_META]: [{ n: 2, url: PR, title: "t", kind: "github_pr" }] });
    assert.deepEqual((seen[2] as Record<string, unknown>)[CITE_SOURCES_META], [{ n: 2, url: PR, title: "t", kind: "github_pr" }]);
  } finally {
    // Also when an assertion failed: an open client keeps the server, and the test, from ending.
    await closeAll();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("C8 the say's text streams whatever follows it: sources after text do not hold it back", () => {
  assert.equal(partialStringField(`{"text": "#309 merged [1]", "sources": ["https://github.com/AMD-AGI/Prim`, "text"), "#309 merged [1]");
  assert.equal(partialStringField(`{"text": "#309 mer`, "text"), "#309 mer");
});
