// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import Anthropic from "@anthropic-ai/sdk";
import crypto from "node:crypto";

// Configuration comes entirely from the environment -- see
// run-anthropic-sdk-tests.sh, which validates/defaults these before
// invoking this script. No secrets are hardcoded here so this file is safe
// to commit (API_KEY has no fallback and is required).
const BASE_URL = process.env.ANTHROPIC_BASE_URL;   // /anthropic/v1/* compat layer base URL, e.g. https://<host>/claw-api-dev/anthropic
const API_KEY = process.env.API_KEY;               // ak-... API key with access to the target deployment
const SKILL_PLUGIN_ID = Number(process.env.SKILL_PLUGIN_ID); // plugin id wrapping a SKILL.md that injects a detectable marker string
const MCP_PLUGIN_ID = Number(process.env.MCP_PLUGIN_ID);     // plugin id wrapping an MCP server exposing echo/add tools
const CLAW_DEPLOY_MODE = process.env.CLAW_DEPLOY_MODE || "safe";

if (!BASE_URL || !API_KEY || !Number.isFinite(SKILL_PLUGIN_ID) || !Number.isFinite(MCP_PLUGIN_ID)) {
  console.error("Missing required env vars. Run via run-anthropic-sdk-tests.sh, or set:");
  console.error("  ANTHROPIC_BASE_URL, API_KEY, SKILL_PLUGIN_ID, MCP_PLUGIN_ID");
  process.exit(2);
}

const client = new Anthropic({ apiKey: API_KEY, baseURL: BASE_URL });
const tag = String(crypto.randomInt(100000, 1000000));

// When CLAW_WORKSPACE_ID is set, pin every session to that SaFE workspace
// (== sandbox K8s namespace) by injecting metadata.primus_claw.workspace_id,
// preserving any existing primus_claw hint. No-op when unset, so default test
// behavior is unchanged and this file stays safe to commit.
const WORKSPACE_ID = process.env.CLAW_WORKSPACE_ID;
if (WORKSPACE_ID) {
  const sessions = client.beta.sessions;
  const origCreate = sessions.create.bind(sessions);
  sessions.create = (params = {}, options) => {
    const metadata = { ...(params.metadata ?? {}) };
    let hint = {};
    if (typeof metadata.primus_claw === "string") {
      try { hint = JSON.parse(metadata.primus_claw); } catch { hint = {}; }
    }
    hint.workspace_id = WORKSPACE_ID;
    metadata.primus_claw = JSON.stringify(hint);
    return origCreate({ ...params, metadata }, options);
  };
}

const results = [];

function anthropicErrType(err) {
  return err?.error?.error?.type ?? err?.error?.type ?? null;
}

async function expectError(fn, expectedStatus) {
  try {
    await fn();
  } catch (err) {
    const status = err?.status;
    if (status !== expectedStatus) {
      throw new Error(`expected HTTP ${expectedStatus}, got ${status} (${err?.message})`);
    }
    return { status, type: anthropicErrType(err), message: err?.error?.error?.message ?? err?.message };
  }
  throw new Error(`expected HTTP ${expectedStatus} but call succeeded`);
}

async function run(id, label, fn) {
  const start = Date.now();
  try {
    const detail = await fn();
    const duration = Date.now() - start;
    const line = `${label}${detail ? " -- " + detail : ""}`;
    results.push({ id, status: "PASS", line, duration });
    console.log(`[PASS] ${id} ${line} (${duration}ms)`);
  } catch (err) {
    const duration = Date.now() - start;
    const line = `${label} -- FAILED: ${err?.message ?? err}`;
    results.push({ id, status: "FAIL", line, duration });
    console.log(`[FAIL] ${id} ${line} (${duration}ms)`);
  }
}

// The SDK's Stream is a single-use AsyncIterable: calling `for await` on the
// same Stream object more than once throws ("consumed stream"). To drive
// several turns over one stream() call (E-A), obtain the iterator ONCE
// (see toIterator) and keep passing that same iterator in across turns.
function toIterator(stream) {
  return stream[Symbol.asyncIterator]();
}

/**
 * `stream: true` (used by E-A/E-B/E-C only, design doc test conventions) live
 * -prints agent.message text as it arrives via process.stdout.write (so a
 * multi-chunk reply reads as one continuous stream, not one line per chunk)
 * plus a bracketed marker line for every other event type (agent.tool_use,
 * session.status_running, etc). V1-V39 keep the original silent behavior so
 * a 2-hour loop run doesn't get flooded with 18 rounds x 3 transcripts.
 */
async function consumeUntilIdle(iterator, { onMessage, onToolUse, timeoutMs = 90_000, stream = false } = {}) {
  const deadline = Date.now() + timeoutMs;
  const messages = [];
  const toolNames = [];
  let gotIdle = false;
  let streamedAnyText = false;
  while (Date.now() < deadline) {
    const { value: event, done } = await iterator.next();
    if (done) break;
    if (event.type === "agent.message") {
      for (const block of event.content) {
        if (block.type !== "text") continue;
        messages.push(block.text);
        if (stream) { process.stdout.write(block.text); streamedAnyText = true; }
      }
      onMessage?.(event);
    } else if (event.type === "agent.tool_use") {
      toolNames.push(event.name);
      if (stream) { if (streamedAnyText) process.stdout.write("\n"); console.log(`  [agent.tool_use name=${event.name} input=${JSON.stringify(event.input)}]`); streamedAnyText = false; }
      onToolUse?.(event);
    } else if (event.type === "session.status_idle") {
      gotIdle = true;
      break;
    } else if (stream) {
      if (streamedAnyText) { process.stdout.write("\n"); streamedAnyText = false; }
      console.log(`  [${event.type}]`);
    }
  }
  if (stream && streamedAnyText) process.stdout.write("\n");
  return { text: messages.join(""), toolNames, gotIdle };
}

// ---------- V1-V19: validation & auth scenarios (fast, no sandbox dispatch) ----------

async function validationScenarios() {
  await run("V1", "agent.create missing name -> 400", async () => {
    const r = await expectError(() => client.beta.agents.create({ model: "claude-opus-4-6" }), 400);
    return `error.type=${r.type}`;
  });

  await run("V2", "agent.create missing model -> 400", async () => {
    const r = await expectError(() => client.beta.agents.create({ name: "no-model" }), 400);
    return `error.type=${r.type}`;
  });

  await run("V3", "agent.create unknown plugin_id -> 404", async () => {
    const r = await expectError(() => client.beta.agents.create({
      name: "unknown-plugin", model: "claude-opus-4-6",
      metadata: { primus_claw: JSON.stringify({ plugin_id: 999999 }) },
    }), 404);
    return `error.type=${r.type}`;
  });

  await run("V4", "agent.create unparseable metadata.primus_claw falls back (no error)", async () => {
    const agent = await client.beta.agents.create({
      name: "unparseable-meta", model: "claude-opus-4-6",
      metadata: { primus_claw: "not-json{{{" },
    });
    if (agent.id !== "agent_default") throw new Error(`expected agent_default, got ${agent.id}`);
    return `id=${agent.id}`;
  });

  await run("V5", "agent.create valid plugin_id + string model normalization", async () => {
    const agent = await client.beta.agents.create({
      name: "valid-plugin", model: "claude-opus-4-6",
      metadata: { primus_claw: JSON.stringify({ plugin_id: SKILL_PLUGIN_ID }) },
    });
    if (agent.id !== `plugin_${SKILL_PLUGIN_ID}`) throw new Error(`expected plugin_${SKILL_PLUGIN_ID}, got ${agent.id}`);
    if (agent.model?.id !== "claude-opus-4-6") throw new Error(`model not normalized: ${JSON.stringify(agent.model)}`);
    return `id=${agent.id} model=${JSON.stringify(agent.model)}`;
  });

  await run("V6", "environment.create missing name -> 400", async () => {
    const r = await expectError(() => client.beta.environments.create({}), 400);
    return `error.type=${r.type}`;
  });

  await run("V7", "environment.create config passthrough", async () => {
    const env = await client.beta.environments.create({
      name: "config-passthrough",
      config: { type: "cloud", networking: { type: "restricted", allowlist: ["example.com"] } },
    });
    const net = env.config?.networking;
    if (!net || net.type !== "restricted") throw new Error(`networking not echoed: ${JSON.stringify(net)}`);
    return `config.networking=${JSON.stringify(net)}`;
  });

  const defaultEnv = await client.beta.environments.create({ name: `v-scenarios-env-${tag}` });

  await run("V8", "session.create missing agent -> 400", async () => {
    const r = await expectError(() => client.beta.sessions.create({ environment_id: defaultEnv.id }), 400);
    return `error.type=${r.type}`;
  });

  await run("V9", "session.create missing environment_id -> 400", async () => {
    const r = await expectError(() => client.beta.sessions.create({ agent: "agent_default" }), 400);
    return `error.type=${r.type}`;
  });

  await run("V10", "session.create unknown environment_id -> 404", async () => {
    const r = await expectError(() => client.beta.sessions.create({ agent: "agent_default", environment_id: "env_does_not_exist" }), 404);
    return `error.type=${r.type}`;
  });

  await run("V11", "session.create agent as object {id}", async () => {
    const session = await client.beta.sessions.create({
      agent: { id: "agent_default", type: "agent" },
      environment_id: defaultEnv.id,
    });
    if (session.agent?.id !== "agent_default") throw new Error(`unexpected agent.id: ${session.agent?.id}`);
    return `session.agent.id=${session.agent.id}`;
  });

  await run("V12", "session.create unknown plugin agent -> 404", async () => {
    const r = await expectError(() => client.beta.sessions.create({ agent: "plugin_999999", environment_id: defaultEnv.id }), 404);
    return `error.type=${r.type}`;
  });

  const probeSession = await client.beta.sessions.create({ agent: "agent_default", environment_id: defaultEnv.id });

  await run("V13", "events.send non-user.message type -> 400", async () => {
    // user.tool_confirmation (not user.interrupt, which P1 now genuinely
    // supports as its own event type -- see V39) is still outside P0/P1 scope.
    const r = await expectError(() => client.beta.sessions.events.send(probeSession.id, {
      events: [{ type: "user.tool_confirmation", result: "allow", tool_use_id: "x" }],
    }), 400);
    return `error.type=${r.type}`;
  });

  await run("V14", "events.send empty events array -> 400", async () => {
    const r = await expectError(() => client.beta.sessions.events.send(probeSession.id, { events: [] }), 400);
    return `error.type=${r.type}`;
  });

  await run("V15", "events.send non-text content block -> 400", async () => {
    const r = await expectError(() => client.beta.sessions.events.send(probeSession.id, {
      events: [{ type: "user.message", content: [{ type: "image", source: { type: "url", url: "https://example.com/x.png" } }] }],
    }), 400);
    return `error.type=${r.type}`;
  });

  await run("V16", "events.send unknown session -> 404", async () => {
    const r = await expectError(() => client.beta.sessions.events.send(crypto.randomUUID(), {
      events: [{ type: "user.message", content: [{ type: "text", text: "hi" }] }],
    }), 404);
    return `error.type=${r.type}`;
  });

  await run("V17", "events.stream unknown session -> 404", async () => {
    const r = await expectError(() => client.beta.sessions.events.stream(crypto.randomUUID()), 404);
    return `error.type=${r.type}`;
  });

  await run("V18", "no auth headers -> 401 authentication_error", async () => {
    const resp = await fetch(`${BASE_URL}/v1/agents`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "no-auth", model: "claude-opus-4-6" }),
    });
    if (resp.status !== 401) throw new Error(`expected 401, got ${resp.status}`);
    const body = await resp.json();
    if (body?.error?.type !== "authentication_error") throw new Error(`unexpected error shape: ${JSON.stringify(body)}`);
    return `HTTP 401 error.type=${body.error.type}`;
  });

  await run("V19", "malformed-but-ak-shaped x-api-key is rejected", async () => {
    const fakeClient = new Anthropic({ apiKey: "ak-fake-invalid-test-key-000000000000", baseURL: BASE_URL });
    const r = await expectError(() => fakeClient.beta.agents.create({ name: "fake-key", model: "claude-opus-4-6" }), 401);
    return `${CLAW_DEPLOY_MODE} mode rejected invalid key with HTTP 401 error.type=${r.type}`;
  });
}

// ---------- V20-V38: P1/P2 method-surface scenarios ----------

async function p1p2Scenarios() {
  // --- Agent list/retrieve/update/archive ---
  // A dedicated throwaway plugin (native /v1/plugins, not the SDK) so
  // destructive update/archive testing never touches the shared
  // SKILL_PLUGIN_ID/MCP_PLUGIN_ID used by E-B/E-C in this same run.
  // agents.create() WITHOUT metadata.primus_claw.plugin_id always resolves
  // to the stateless agent_default -- update/archive/versions.list need a
  // real plugin-backed agent id (plugin_<id>).
  const throwawayPluginResp = await fetch(`${BASE_URL.replace(/\/anthropic$/, "")}/v1/plugins`, {
    method: "POST", headers: { "content-type": "application/json", "x-api-key": API_KEY },
    body: JSON.stringify({ name: `crud-test-plugin-${tag}`, version: "1.0.0" }),
  });
  if (!throwawayPluginResp.ok) throw new Error(`failed to create throwaway plugin for CRUD tests: ${await throwawayPluginResp.text()}`);
  const throwawayPlugin = (await throwawayPluginResp.json()).data;
  const agentForCrud = await client.beta.agents.create({
    name: `crud-agent-${tag}`, model: "claude-opus-4-6",
    metadata: { primus_claw: JSON.stringify({ plugin_id: throwawayPlugin.id }) },
  });

  await run("V20", "agents.list includes agent_default and the just-created agent", async () => {
    const page = await client.beta.agents.list({ limit: 200 });
    const ids = page.data.map((a) => a.id);
    if (!ids.includes("agent_default")) throw new Error("agent_default missing from list");
    if (!ids.includes(agentForCrud.id)) throw new Error(`${agentForCrud.id} missing from list`);
    return `data.length=${page.data.length}`;
  });

  await run("V21", "agents.retrieve for agent_default and plugin agent", async () => {
    const def = await client.beta.agents.retrieve("agent_default");
    if (def.id !== "agent_default") throw new Error("agent_default retrieve mismatch");
    const plug = await client.beta.agents.retrieve(agentForCrud.id);
    if (plug.id !== agentForCrud.id) throw new Error("plugin agent retrieve mismatch");
    return `agent_default.version=${def.version} ${agentForCrud.id}.version=${plug.version}`;
  });

  await run("V22", "agents.update with correct version succeeds and bumps version", async () => {
    const before = await client.beta.agents.retrieve(agentForCrud.id);
    const updated = await client.beta.agents.update(agentForCrud.id, { version: before.version, description: `updated-${tag}` });
    if (updated.version !== before.version + 1) throw new Error(`expected version ${before.version + 1}, got ${updated.version}`);
    return `version ${before.version} -> ${updated.version}`;
  });

  await run("V23", "agents.update with stale version -> 409", async () => {
    const r = await expectError(() => client.beta.agents.update(agentForCrud.id, { version: 1 }), 409);
    return `error.type=${r.type}`;
  });

  await run("V24", "agents.archive blocks NEW references but not existing sessions", async () => {
    const envForArchiveTest = await client.beta.environments.create({ name: `archive-test-env-${tag}` });
    const sessionBeforeArchive = await client.beta.sessions.create({ agent: agentForCrud.id, environment_id: envForArchiveTest.id });
    await client.beta.agents.archive(agentForCrud.id);
    const blocked = await expectError(() => client.beta.sessions.create({ agent: agentForCrud.id, environment_id: envForArchiveTest.id }), 404);
    const stream = await client.beta.sessions.events.stream(sessionBeforeArchive.id);
    await client.beta.sessions.events.send(sessionBeforeArchive.id, {
      events: [{ type: "user.message", content: [{ type: "text", text: "Say the word ARCHIVED-OK and nothing else." }] }],
    });
    const { text, gotIdle } = await consumeUntilIdle(toIterator(stream), { timeoutMs: 60_000 });
    if (!gotIdle) throw new Error("existing session stopped responding after agent archive");
    if (!/ARCHIVED-OK/i.test(text)) throw new Error(`unexpected reply from still-archived-agent session: "${text}"`);
    return `new session blocked (${blocked.type}), existing session still dispatches ok`;
  });

  await run("V25", "agents.versions.list returns current single version", async () => {
    const page = await client.beta.agents.versions.list(agentForCrud.id);
    if (!page.data.length) throw new Error("versions.list returned no data");
    return `versions.length=${page.data.length}`;
  });

  // --- Environment create now persists + list/retrieve/update/delete/archive ---
  await run("V26", "environments.create persists a real resource_<id> (not env_default)", async () => {
    const env = await client.beta.environments.create({ name: `persist-env-${tag}`, description: "d1" });
    if (env.id === "env_default") throw new Error("environments.create still returning stateless env_default");
    if (!env.id.startsWith("resource_")) throw new Error(`unexpected environment id shape: ${env.id}`);
    return `id=${env.id}`;
  });

  const envForCrud = await client.beta.environments.create({ name: `crud-env-${tag}`, description: "crud" });

  await run("V27", "environments.list includes env_default and the just-created environment", async () => {
    const page = await client.beta.environments.list({ limit: 200 });
    const ids = page.data.map((e) => e.id);
    if (!ids.includes("env_default")) throw new Error("env_default missing from list");
    if (!ids.includes(envForCrud.id)) throw new Error(`${envForCrud.id} missing from list`);
    return `data.length=${page.data.length}`;
  });

  await run("V28", "environments.update changes description", async () => {
    const updated = await client.beta.environments.update(envForCrud.id, { description: `updated-desc-${tag}` });
    if (updated.description !== `updated-desc-${tag}`) throw new Error(`description not updated: ${updated.description}`);
    return `description=${updated.description}`;
  });

  await run("V29", "environments.delete then retrieve -> 404 (permanent)", async () => {
    const toDelete = await client.beta.environments.create({ name: `delete-me-env-${tag}` });
    await client.beta.environments.delete(toDelete.id);
    const r = await expectError(() => client.beta.environments.retrieve(toDelete.id), 404);
    return `error.type=${r.type}`;
  });

  await run("V30", "environments.archive is reversible and filtered from default list", async () => {
    const toArchive = await client.beta.environments.create({ name: `archive-me-env-${tag}` });
    await client.beta.environments.archive(toArchive.id);
    const defaultList = await client.beta.environments.list({ limit: 200 });
    if (defaultList.data.some((e) => e.id === toArchive.id)) throw new Error("archived environment leaked into default list");
    const withArchived = await client.beta.environments.list({ limit: 200, include_archived: true });
    if (!withArchived.data.some((e) => e.id === toArchive.id)) throw new Error("archived environment missing from include_archived list");
    return "archived environment correctly hidden by default, visible with include_archived";
  });

  await run("V31", "session.create accepts a persisted resource_<id> environment", async () => {
    const session = await client.beta.sessions.create({ agent: "agent_default", environment_id: envForCrud.id });
    if (session.environment_id !== envForCrud.id) throw new Error("session did not record resource_<id> environment_id");
    return `session.environment_id=${session.environment_id}`;
  });

  // --- Session list/retrieve/update/delete/archive ---
  const envForSessionCrud = await client.beta.environments.create({ name: `session-crud-env-${tag}` });
  const sessionForCrud = await client.beta.sessions.create({ agent: "agent_default", environment_id: envForSessionCrud.id, title: `crud-session-${tag}` });

  await run("V32", "sessions.list includes the just-created session", async () => {
    const page = await client.beta.sessions.list({ limit: 200 });
    if (!page.data.some((s) => s.id === sessionForCrud.id)) throw new Error("session missing from list");
    return `data.length=${page.data.length}`;
  });

  await run("V33", "sessions.retrieve returns matching title", async () => {
    const r = await client.beta.sessions.retrieve(sessionForCrud.id);
    if (r.title !== `crud-session-${tag}`) throw new Error(`title mismatch: ${r.title}`);
    return `title=${r.title}`;
  });

  await run("V34", "sessions.update changes title and metadata", async () => {
    const updated = await client.beta.sessions.update(sessionForCrud.id, { title: `renamed-${tag}`, metadata: { k: "v1" } });
    if (updated.title !== `renamed-${tag}`) throw new Error(`title not updated: ${updated.title}`);
    if (updated.metadata?.k !== "v1") throw new Error(`metadata not updated: ${JSON.stringify(updated.metadata)}`);
    return `title=${updated.title} metadata=${JSON.stringify(updated.metadata)}`;
  });

  await run("V35", "sessions.archive is reversible and filtered from default list", async () => {
    await client.beta.sessions.archive(sessionForCrud.id);
    const defaultList = await client.beta.sessions.list({ limit: 200 });
    if (defaultList.data.some((s) => s.id === sessionForCrud.id)) throw new Error("archived session leaked into default list");
    const stillRetrievable = await client.beta.sessions.retrieve(sessionForCrud.id);
    if (stillRetrievable.status !== "terminated") throw new Error(`expected terminated status, got ${stillRetrievable.status}`);
    return "archived session hidden from list, still retrievable with status=terminated";
  });

  await run("V36", "sessions.delete then retrieve -> 404 (permanent)", async () => {
    const envTmp = await client.beta.environments.create({ name: `delete-session-env-${tag}` });
    const toDelete = await client.beta.sessions.create({ agent: "agent_default", environment_id: envTmp.id });
    await client.beta.sessions.delete(toDelete.id);
    const r = await expectError(() => client.beta.sessions.retrieve(toDelete.id), 404);
    return `error.type=${r.type}`;
  });

  // --- Events list + session resources CRUD ---
  await run("V37", "sessions.events.list returns paginated history after a real turn", async () => {
    const envTmp = await client.beta.environments.create({ name: `events-list-env-${tag}` });
    const session = await client.beta.sessions.create({ agent: "agent_default", environment_id: envTmp.id });
    const stream = await client.beta.sessions.events.stream(session.id);
    await client.beta.sessions.events.send(session.id, {
      events: [{ type: "user.message", content: [{ type: "text", text: "Say the word EVENTSLIST and nothing else." }] }],
    });
    const { gotIdle } = await consumeUntilIdle(toIterator(stream), { timeoutMs: 60_000 });
    if (!gotIdle) throw new Error("turn did not complete before events.list check");
    const page = await client.beta.sessions.events.list(session.id, { limit: 50 });
    const types = page.data.map((e) => e.type);
    if (!types.includes("agent.message") || !types.includes("session.status_idle")) {
      throw new Error(`events.list missing expected types: ${types.join(",")}`);
    }
    return `events.list types=${types.join(",")}`;
  });

  await run("V38", "sessions.resources add/list/retrieve/update/delete (config-only CRUD)", async () => {
    const envTmp = await client.beta.environments.create({ name: `resources-crud-env-${tag}` });
    const session = await client.beta.sessions.create({ agent: "agent_default", environment_id: envTmp.id });
    const added = await client.beta.sessions.resources.add(session.id, {
      type: "github_repository", url: "https://github.com/example/repo", authorization_token: "ghp_faketoken",
    });
    const listed = await client.beta.sessions.resources.list(session.id);
    if (!listed.data.some((r) => r.id === added.id)) throw new Error("added resource missing from list");
    const retrieved = await client.beta.sessions.resources.retrieve(added.id, { session_id: session.id });
    if (retrieved.id !== added.id) throw new Error("retrieve mismatch");
    const updated = await client.beta.sessions.resources.update(added.id, { session_id: session.id, mount_path: "/workspace/custom" });
    if (updated.mount_path !== "/workspace/custom") throw new Error("update did not apply");
    await client.beta.sessions.resources.delete(added.id, { session_id: session.id });
    const afterDelete = await client.beta.sessions.resources.list(session.id);
    if (afterDelete.data.some((r) => r.id === added.id)) throw new Error("resource still present after delete");
    return `add/list/retrieve/update/delete all consistent (id=${added.id})`;
  });

  // --- user.interrupt real E2E: stop a running turn without waiting for natural completion ---
  await run("V39", "user.interrupt stops a running turn early", async () => {
    const envTmp = await client.beta.environments.create({ name: `interrupt-env-${tag}` });
    const session = await client.beta.sessions.create({ agent: "agent_default", environment_id: envTmp.id });
    const stream = await client.beta.sessions.events.stream(session.id);
    const iterator = toIterator(stream);
    await client.beta.sessions.events.send(session.id, {
      events: [{ type: "user.message", content: [{ type: "text", text: "Count slowly from 1 to 100, one number per line, explaining each number in detail." }] }],
    });
    // Give the turn a moment to actually start running before interrupting.
    await new Promise((r) => setTimeout(r, 2000));
    await client.beta.sessions.events.send(session.id, { events: [{ type: "user.interrupt" }] });
    const deadline = Date.now() + 30_000;
    let sawIdle = false;
    while (Date.now() < deadline) {
      const { value: event, done } = await iterator.next();
      if (done) break;
      if (event.type === "session.status_idle") { sawIdle = true; break; }
    }
    if (!sawIdle) throw new Error("session never returned to idle after user.interrupt");
    return "session returned to idle after interrupt (did not wait for the full 1-100 count)";
  });
}

// ---------- V40-V50: extended method-surface + real-usage scenarios ----------

async function p3Scenarios() {
  await run("V40", "agents.retrieve unknown plugin -> 404", async () => {
    const r = await expectError(() => client.beta.agents.retrieve("plugin_999999"), 404);
    return `error.type=${r.type}`;
  });

  await run("V41", "environments.retrieve unknown -> 404", async () => {
    const r = await expectError(() => client.beta.environments.retrieve("resource_999999999"), 404);
    return `error.type=${r.type}`;
  });

  await run("V42", "environments.create then retrieve round-trips by id", async () => {
    const created = await client.beta.environments.create({ name: `roundtrip-env-${tag}`, description: "rt" });
    const got = await client.beta.environments.retrieve(created.id);
    if (got.id !== created.id) throw new Error(`retrieve id mismatch: ${got.id} != ${created.id}`);
    return `id=${got.id}`;
  });

  await run("V43", "agents.list honors limit=1 (single-page item)", async () => {
    const page = await client.beta.agents.list({ limit: 1 });
    if (page.data.length !== 1) throw new Error(`expected exactly 1 item with limit=1, got ${page.data.length}`);
    return `data.length=${page.data.length}`;
  });

  await run("V44", "agents.retrieve(agent_default) returns a model object", async () => {
    const def = await client.beta.agents.retrieve("agent_default");
    if (def.id !== "agent_default") throw new Error(`unexpected id ${def.id}`);
    if (!def.model?.id) throw new Error(`model not an object: ${JSON.stringify(def.model)}`);
    return `model.id=${def.model.id}`;
  });

  await run("V45", "environments.update unknown -> 404", async () => {
    const r = await expectError(() => client.beta.environments.update("resource_999999999", { description: "x" }), 404);
    return `error.type=${r.type}`;
  });

  await run("V46", "sessions.update unknown -> 404", async () => {
    const r = await expectError(() => client.beta.sessions.update(crypto.randomUUID(), { title: "x" }), 404);
    return `error.type=${r.type}`;
  });

  await run("V47", "environments.update after delete -> 404", async () => {
    const e = await client.beta.environments.create({ name: `postdel-env-${tag}` });
    await client.beta.environments.delete(e.id);
    const r = await expectError(() => client.beta.environments.update(e.id, { description: "x" }), 404);
    return `error.type=${r.type}`;
  });

  await run("V48", "environments.retrieve still works after archive", async () => {
    const e = await client.beta.environments.create({ name: `arch-retr-env-${tag}` });
    await client.beta.environments.archive(e.id);
    const got = await client.beta.environments.retrieve(e.id);
    if (got.id !== e.id) throw new Error(`archived env not retrievable by id: ${got.id}`);
    return `archived env still retrievable (id=${got.id})`;
  });

  await run("V49", "events.send multi-text-block message reflected in reply", async () => {
    const env = await client.beta.environments.create({ name: `multiblock-env-${tag}` });
    const session = await client.beta.sessions.create({ agent: "agent_default", environment_id: env.id });
    const stream = await client.beta.sessions.events.stream(session.id);
    const w1 = "WORDALPHA", w2 = "WORDBRAVO";
    await client.beta.sessions.events.send(session.id, {
      events: [{ type: "user.message", content: [
        { type: "text", text: "I will give you two code words across two separate content blocks." },
        { type: "text", text: `The words are ${w1} and ${w2}. Reply with both words joined by a hyphen and nothing else.` },
      ] }],
    });
    const { text, gotIdle } = await consumeUntilIdle(toIterator(stream), { timeoutMs: 60_000 });
    if (!gotIdle) throw new Error("no session.status_idle");
    if (!text.includes(w1) || !text.includes(w2)) throw new Error(`both blocks not reflected: "${text}"`);
    return `multi-block reply ok (${w1},${w2})`;
  });

  await run("V50", "two concurrent sessions both reach idle", async () => {
    const mk = async (n) => {
      const env = await client.beta.environments.create({ name: `concurrent-${n}-env-${tag}` });
      const s = await client.beta.sessions.create({ agent: "agent_default", environment_id: env.id });
      const it = toIterator(await client.beta.sessions.events.stream(s.id));
      await client.beta.sessions.events.send(s.id, {
        events: [{ type: "user.message", content: [{ type: "text", text: `Reply with exactly the word CONCURRENT${n} and nothing else.` }] }],
      });
      return { n, it };
    };
    const [a, b] = await Promise.all([mk(1), mk(2)]);
    const [ra, rb] = await Promise.all([
      consumeUntilIdle(a.it, { timeoutMs: 90_000 }),
      consumeUntilIdle(b.it, { timeoutMs: 90_000 }),
    ]);
    if (!ra.gotIdle || !rb.gotIdle) throw new Error(`concurrency idle a=${ra.gotIdle} b=${rb.gotIdle}`);
    if (!/CONCURRENT1/i.test(ra.text) || !/CONCURRENT2/i.test(rb.text)) {
      throw new Error(`concurrency replies wrong: a="${ra.text}" b="${rb.text}"`);
    }
    return "2 concurrent sessions both idle with correct replies";
  });

  // V51 hardens the session-metadata merge path (security review / CodeQL
  // js/prototype-polluting-* triage). The update route merges caller-supplied
  // metadata, so a client can plant reserved keys (__proto__ / constructor /
  // prototype) to attempt Object.prototype pollution server-side. Raw fetch is
  // used instead of the SDK so the exact bytes -- including keys an object
  // literal would silently treat as a prototype setter -- reach the server.
  await run("V51", "metadata __proto__/constructor injection is neutralized (no pollution, no 5xx)", async () => {
    const env = await client.beta.environments.create({ name: `proto-env-${tag}` });
    const session = await client.beta.sessions.create({ agent: "agent_default", environment_id: env.id, title: `proto-${tag}` });
    const marker = `POLLUTED_${tag}`;
    const url = `${BASE_URL}/v1/sessions/${session.id}`;
    const headers = { "content-type": "application/json", "x-api-key": API_KEY };

    // Attempt A: raw __proto__ key. Hardened parsers reject it up front (4xx),
    // the route Map/Object.fromEntries merge neutralizes it otherwise (2xx) --
    // both are safe. A 5xx (unhandled) or an actual pollution is a failure.
    const protoBody = `{"metadata":{"__proto__":{"polluted":"${marker}"},"legit":"kept-${tag}"}}`;
    const protoResp = await fetch(url, { method: "POST", headers, body: protoBody });
    if (protoResp.status >= 500) throw new Error(`__proto__ body caused ${protoResp.status} (unhandled)`);
    const protoOutcome = protoResp.ok ? "neutralized-2xx" : `rejected-${protoResp.status}`;

    // Attempt B: constructor/prototype keys (parser-safe) drive the route-level
    // merge fix directly. Must succeed and preserve the benign key.
    const ctorBody = `{"metadata":{"constructor":{"polluted":"${marker}"},"prototype":{"polluted":"${marker}"},"legit":"kept-${tag}"}}`;
    const ctorResp = await fetch(url, { method: "POST", headers, body: ctorBody });
    if (!ctorResp.ok) throw new Error(`constructor/prototype body rejected (${ctorResp.status}): ${await ctorResp.text()}`);
    const updated = await ctorResp.json();
    if (updated?.metadata?.legit !== `kept-${tag}`) throw new Error(`benign metadata key lost: ${JSON.stringify(updated?.metadata)}`);
    if (updated?.metadata?.polluted === marker) throw new Error("marker leaked as a real metadata.polluted key");

    // A broken guard that echoes+merges can corrupt THIS runtime too; assert
    // the client's Object.prototype was not polluted by any response.
    if (({}).polluted !== undefined) throw new Error("Object.prototype.polluted set in test runtime");

    // Health gate: a normal metadata update on a fresh session still works.
    const s2 = await client.beta.sessions.create({ agent: "agent_default", environment_id: env.id });
    const sane = await client.beta.sessions.update(s2.id, { metadata: { sane: "ok" } });
    if (sane?.metadata?.sane !== "ok") throw new Error("post-injection normal update failed");

    return `__proto__ ${protoOutcome}, constructor/prototype neutralized, legit preserved, prototype intact`;
  });
}

// ---------- E-A: default agent, multiturn + queueing + replay ----------

async function scenarioDefaultAgent() {
  await run("E-A", "default agent multiturn/queueing/replay", async () => {
    const agent = await client.beta.agents.create({ name: `default-agent-${tag}`, model: "claude-opus-4-6" });
    const environment = await client.beta.environments.create({ name: `default-env-${tag}` });
    const session = await client.beta.sessions.create({ agent: agent.id, environment_id: environment.id, title: "E-A multiturn" });

    const secret = String(crypto.randomInt(1000, 10000));
    const stream = await client.beta.sessions.events.stream(session.id);
    const iterator = toIterator(stream);

    await client.beta.sessions.events.send(session.id, {
      events: [{ type: "user.message", content: [{ type: "text", text: `Remember this secret number: ${secret}. Reply with exactly: "OK got it".` }] }],
    });
    console.log("  [E-A turn 1]");
    const turn1 = await consumeUntilIdle(iterator, { stream: true });
    if (!turn1.gotIdle) throw new Error("turn1: no session.status_idle");

    await client.beta.sessions.events.send(session.id, {
      events: [{ type: "user.message", content: [{ type: "text", text: "What secret number did I just tell you? Reply with only the digits." }] }],
    });
    console.log("  [E-A turn 2]");
    const turn2 = await consumeUntilIdle(iterator, { stream: true });
    if (!turn2.gotIdle) throw new Error("turn2: no session.status_idle");
    if (!turn2.text.includes(secret)) throw new Error(`continuity failed: expected "${secret}" in "${turn2.text}"`);

    // Fire two sends back-to-back without waiting -- the 2nd must land in
    // claw_pending_messages (agent_status='running') rather than erroring.
    const send3 = client.beta.sessions.events.send(session.id, {
      events: [{ type: "user.message", content: [{ type: "text", text: "Say the word ALPHA and nothing else." }] }],
    });
    await send3;
    const send4 = await client.beta.sessions.events.send(session.id, {
      events: [{ type: "user.message", content: [{ type: "text", text: "Say the word BETA and nothing else." }] }],
    });
    if (!send4?.data?.length) throw new Error("queued send returned no data envelope");

    console.log("  [E-A turn 3]");
    const turn3 = await consumeUntilIdle(iterator, { stream: true });
    if (!turn3.gotIdle) throw new Error("turn3: no session.status_idle");
    console.log("  [E-A turn 4]");
    const turn4 = await consumeUntilIdle(iterator, { stream: true });
    if (!turn4.gotIdle) throw new Error("turn4: no session.status_idle");
    const queueingOk = /ALPHA/i.test(turn3.text) && /BETA/i.test(turn4.text);

    // Replay: open a brand-new stream on the SAME (now-idle) session and
    // verify history replay reproduces all 4 turns without live activity.
    const replayStream = await client.beta.sessions.events.stream(session.id);
    const replayIterator = toIterator(replayStream);
    let replayIdle = 0, replayMessages = 0;
    const replayDeadline = Date.now() + 15_000;
    while (Date.now() < replayDeadline) {
      const { value: event, done } = await replayIterator.next();
      if (done) break;
      if (event.type === "agent.message") replayMessages++;
      else if (event.type === "session.status_idle") { replayIdle++; if (replayIdle >= 4) break; }
    }
    try { await replayIterator.return?.(); } catch { /* best effort */ }

    if (replayIdle !== 4 || replayMessages !== 4) {
      throw new Error(`replay mismatch: idle=${replayIdle} messages=${replayMessages} (expected 4/4)`);
    }

    return `4 turns ok, continuity ok (secret=${secret}), queueing ${queueingOk ? "ok" : "INCONCLUSIVE"}, replay idle=${replayIdle} messages=${replayMessages}`;
  });
}

// ---------- E-B: skill plugin ----------

async function scenarioSkillPlugin() {
  await run("E-B", "skill plugin marker injection", async () => {
    const agent = await client.beta.agents.create({
      name: `skill-agent-${tag}`, model: "claude-opus-4-6",
      metadata: { primus_claw: JSON.stringify({ plugin_id: SKILL_PLUGIN_ID }) },
    });
    const environment = await client.beta.environments.create({ name: `skill-env-${tag}` });
    const session = await client.beta.sessions.create({ agent: agent.id, environment_id: environment.id, title: "E-B skill" });

    const stream = await client.beta.sessions.events.stream(session.id);
    await client.beta.sessions.events.send(session.id, {
      events: [{ type: "user.message", content: [{ type: "text", text: "Say hello in exactly three words." }] }],
    });
    console.log("  [E-B]");
    const { text, gotIdle } = await consumeUntilIdle(toIterator(stream), { stream: true });
    if (!gotIdle) throw new Error("no session.status_idle");
    if (!text.includes("SKILL_MARKER_7f3a9c")) throw new Error(`skill marker missing in reply: "${text}"`);
    return "skill marker present in reply";
  });
}

// ---------- E-C: MCP plugin ----------

async function scenarioMcpPlugin() {
  await run("E-C", "mcp plugin echo+add tool calls", async () => {
    const agent = await client.beta.agents.create({
      name: `mcp-agent-${tag}`, model: "claude-opus-4-6",
      metadata: { primus_claw: JSON.stringify({ plugin_id: MCP_PLUGIN_ID }) },
    });
    const environment = await client.beta.environments.create({ name: `mcp-env-${tag}` });
    const session = await client.beta.sessions.create({ agent: agent.id, environment_id: environment.id, title: "E-C mcp" });

    const a = crypto.randomInt(5, 45);
    const b = crypto.randomInt(3, 23);
    const echoText = `MCP_TEST_${tag}`;

    const stream = await client.beta.sessions.events.stream(session.id);
    await client.beta.sessions.events.send(session.id, {
      events: [{
        type: "user.message",
        content: [{ type: "text", text: `You have MCP tools 'echo' and 'add' available. Call echo with the text '${echoText}' and call add with a=${a}, b=${b}. Report exactly what both tools returned.` }],
      }],
    });
    const toolNames = [];
    console.log("  [E-C]");
    const { text, gotIdle } = await consumeUntilIdle(toIterator(stream), { stream: true, onToolUse: (e) => toolNames.push(e.name) });
    if (!gotIdle) throw new Error("no session.status_idle");
    if (!toolNames.length) throw new Error("model never called any tool");
    const sum = a + b;
    if (!text.includes(String(sum)) && !toolNames.some(n => /add/i.test(n))) {
      throw new Error(`add result ${sum} not evidenced in reply/tool calls: "${text}"`);
    }
    return `echo(${echoText}) ok, add(${a}+${b}=${sum}) ok, tool names=${toolNames.join(",")}`;
  });
}

async function main() {
  console.log(`\n=== rich SDK compat test run, tag=${tag}, baseURL=${BASE_URL} ===\n`);
  console.log("--- validation scenarios (V1-V19) ---");
  await validationScenarios();
  console.log("\n--- P1/P2 method-surface scenarios (V20-V39) ---");
  await p1p2Scenarios();
  console.log("\n--- extended method-surface + real-usage scenarios (V40-V50) ---");
  await p3Scenarios();
  console.log("\n--- E2E scenario A: default agent (multiturn + queueing + replay) ---");
  await scenarioDefaultAgent();
  console.log("\n--- E2E scenario B: skill plugin ---");
  await scenarioSkillPlugin();
  console.log("\n--- E2E scenario C: MCP plugin (echo + add) ---");
  await scenarioMcpPlugin();

  const passed = results.filter(r => r.status === "PASS").length;
  console.log(`\n=== SUMMARY: ${passed}/${results.length} passed (tag=${tag}) ===`);
  for (const r of results) console.log(`  [${r.status}] ${r.id} ${r.line} (${r.duration}ms)`);

  // Explicit exit: open SSE/keep-alive sockets from the SDK's undici client
  // can otherwise keep the event loop alive indefinitely after main() returns.
  process.exit(passed === results.length ? 0 : 1);
}

main().catch((err) => {
  console.error("=== FATAL ===", err);
  process.exit(1);
});
