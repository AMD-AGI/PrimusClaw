// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Which pull requests of a review request are already merged, read on GitHub as the person who asks (`assistant/pr-state.ts`), with
 * GitHub and the database stood in for.
 *
 *   P1 a merged pull request is returned with when it merged, by whom and its merge commit; an open or closed one is not
 *   P2 a read with a binding is written to the audit log before GitHub is asked, and finished after; one that cannot be written asks nothing
 *   P3 no GitHub (none kept, none bound, the GitHub tools off) asks nothing and finds nothing merged; a failed read finds that one not merged
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { mergedPulls, PR_STATE_TOOL } from "../src/assistant/pr-state.js";

const API = "https://github.api.test";
const TOKEN = "ghu_bound0123456789abcdefghijklmnopqrstu";
const prs = [306, 307, 308, 309].map((number) => ({ owner: "AMD-AGI", repo: "PrimusClaw", number }));

type Row = Record<string, unknown>;
function world(o: { auditFails?: boolean } = {}) {
  const log: string[] = [];
  const audit: Row[] = [];
  const db = {
    query: async (text: string, params: unknown[] = []) => {
      if (/FROM claw_user_env_vars/.test(text)) return { rows: [] as Row[] };
      if (/INSERT INTO claw_github_audit/.test(text)) {
        if (o.auditFails) throw Object.assign(new Error("down"), { code: "57P01" });
        log.push("audit_start");
        audit.push({ tool: params[3], args: JSON.parse(String(params[4])) });
        return { rows: [{ id: 7 }] };
      }
      if (/UPDATE claw_github_audit/.test(text)) {
        log.push("audit_finish");
        Object.assign(audit[0], { requests: params[4], write: params[10], result: params[11], detail: params[12] });
        return { rows: [] as Row[] };
      }
      throw new Error(`unexpected query: ${text}`);
    },
  };
  const fetchImpl = (async (input: URL | string, init: RequestInit = {}) => {
    const url = new URL(String(input));
    log.push(`GET ${url.pathname}`);
    assert.equal(new Headers(init.headers).get("authorization"), `Bearer ${TOKEN}`);
    const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
    switch (url.pathname) {
      case "/repos/AMD-AGI/PrimusClaw/pulls/306": return json({ number: 306, state: "closed", merged: true, merged_at: "2026-11-05T09:12:44Z", merge_commit_sha: "a1b2c3d", merged_by: { login: "zoroyihan7" } });
      case "/repos/AMD-AGI/PrimusClaw/pulls/307": return json({ number: 307, state: "closed", merged: false, merged_at: null, merge_commit_sha: "eee" });
      case "/repos/AMD-AGI/PrimusClaw/pulls/308": return json({ number: 308, state: "open", merged: false, merged_at: null });
      default: return json({ message: "boom" }, 502);
    }
  }) as typeof fetch;
  const settings = (over: Row = {}) => () => ({ enabled: true, binding: true, secret: "s".repeat(40), mcpUrl: "http://api.test/mcp", apiUrl: API, ...over }) as never;
  const resolveBinding = async () => ({ token: TOKEN, providerLogin: "zoroyihan7", expiresAt: null }) as never;
  return { log, audit, deps: { db: db as never, fetchImpl, settings: settings(), resolveBinding }, settings };
}

describe("merged pull requests of a review request", () => {
  test("P1 + P2 a merged one comes back with its time, merger and commit; the read is audited first", async () => {
    const w = world();
    const merged = await mergedPulls("u-alice", "sess-1", prs, w.deps);
    assert.deepEqual(merged, [{ pr: "AMD-AGI/PrimusClaw#306", merged_at: "2026-11-05T09:12:44Z", merge_commit: "a1b2c3d", merged_by: "zoroyihan7" }]);
    assert.equal(w.log[0], "audit_start", "written down before GitHub is asked");
    assert.equal(w.log.at(-1), "audit_finish");
    assert.deepEqual(w.log.filter((l) => l.startsWith("GET")).sort(), prs.map((p) => `GET /repos/AMD-AGI/PrimusClaw/pulls/${p.number}`));
    assert.deepEqual(w.audit[0], {
      tool: `github_mcp.${PR_STATE_TOOL}`, args: { prs: prs.map((p) => `AMD-AGI/PrimusClaw#${p.number}`) },
      requests: 4, write: false, result: "refused", detail: "1 of 4 reads failed",
    });
  });

  test("P2 an audit row that cannot be written asks GitHub nothing", async () => {
    const w = world({ auditFails: true });
    assert.deepEqual(await mergedPulls("u-alice", "sess-1", prs, w.deps), []);
    assert.deepEqual(w.log, []);
  });

  test("P3 without GitHub nothing is asked and nothing is merged", async () => {
    const off = world();
    assert.deepEqual(await mergedPulls("u-alice", "sess-1", prs, { ...off.deps, settings: off.settings({ enabled: false }) }), []);
    const unbound = world();
    assert.deepEqual(await mergedPulls("u-alice", "sess-1", prs, { ...unbound.deps, settings: unbound.settings({ binding: false }) }), []);
    assert.deepEqual([...off.log, ...unbound.log], []);
    assert.deepEqual(await mergedPulls("u-alice", "sess-1", [], world().deps), []);
  });
});
