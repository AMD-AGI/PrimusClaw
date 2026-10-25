// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  APP_MANIFEST_JSON_SCHEMA as S,
  APP_MANIFEST_SCHEMA,
  APP_PLATFORM_ENV,
  isReservedAppEnv,
  validateAppManifest,
  type AppManifestV1,
} from "../src/app-manifest.js";

const B64 = Buffer.from("#!/bin/sh\nexec true\n").toString("base64");

/** A generic app, modelled on the design's example; nothing here names a real application. */
const EXAMPLE = {
  schema: APP_MANIFEST_SCHEMA,
  name: "example-app",
  version: "1.0.0",
  container: {
    image: "registry.example.invalid/app:default",
    resources: { cpu: "32", memory: "128Gi", "ephemeral-storage": "500Gi" },
  },
  state_dir: "${USER_DATA_PATH}/.claw-apps/${run_id}",
  command: ["sh", "-c", 'exec "$APP_STATE_DIR/bootstrap.sh" run'],
  bootstrap: { file: "bootstrap.sh", content_b64: B64 },
  env: { APP_SOURCE_REPO: "https://example.invalid/app.git", APP_SOURCE_SHA: "pinned-by-the-plugin" },
  env_map: {
    run_id: "APP_RUN_ID",
    run_created_at: "APP_RUN_CREATED_AT",
    state_dir: "APP_STATE_DIR",
    input_file: "APP_INPUT_FILE",
    events_dir: "APP_EVENTS_DIR",
    mcp_port: "APP_MCP_PORT",
    mcp_token: "APP_MCP_TOKEN",
    sandbox_templates: "APP_SANDBOX_TEMPLATES",
    sandbox_keys: {
      measurement: "APP_SANDBOX_KEY_MEASUREMENT",
      subrun: "APP_SANDBOX_KEY_SUBRUN",
      dev: "APP_SANDBOX_KEY_DEV",
    },
    result_archive: "APP_RESULT_ARCHIVE",
    grant_limits: "APP_GRANT_LIMITS",
  },
  events: { dir: "events", format: "cloudevents/v1" },
  mcp: { port: 8765, path: "/mcp", token_header: "X-App-Token" },
  sandbox_templates: [
    {
      name: "runner",
      per_gpu_count: [1, 2, 4, 8],
      provider: "safe-pytorchjob",
      image: "registry.example.invalid/runner:1",
      workspace: "gpu-ws",
      resources: { cpu: "32", memory: "256Gi", "ephemeral-storage": "500Gi" },
      mounts: { shared: "rw" },
      egress: ["git", "pypi-mirror"],
      start: { script_b64: B64 },
      data_plane: { mode: "sealed", inputs: ["/in"], outputs: ["/out"] },
      signing_identity: { key_file_env: "APP_SIGNING_KEY_FILE" },
      pending_timeout_sec: 3600,
      max_timeout_sec: 14400,
      preheat: true,
    },
    {
      name: "specialist_gpu", provider: "safe-pytorchjob", gpus: 1,
      mounts: { shared: "ro" },
      egress: ["model-gateway", "pypi-mirror"], data_plane: { mode: "open" }, max_timeout_sec: 86400,
    },
    { name: "builder", provider: "safe-pytorchjob", gpus: 0, data_plane: { mode: "open" } },
    { name: "dev", provider: "safe-pytorchjob", gpus: 1, data_plane: { mode: "open" } },
  ],
  sandbox_roles: { measurement: ["runner"], subrun: ["specialist_gpu", "builder"], dev: ["dev"] },
  restart: { max_restarts: 5, backoff_sec: [30, 120, 600] },
  stop_grace_sec: 900,
  limits: {
    max_sandboxes: 16,
    max_runtime_sec: 172800,
    input_max_bytes: 262144,
  },
} satisfies AppManifestV1;

/** Every field the type has, set, on a document that is also a valid one. */
const FULL = {
  ...EXAMPLE,
  env_map: { ...EXAMPLE.env_map, mcp_public_url: "APP_MCP_PUBLIC_URL" },
  mcp: { ...EXAMPLE.mcp, public: true },
} satisfies AppManifestV1;

const clone = <T>(v: T): T => structuredClone(v);
const mutate = (f: (m: any) => void): unknown => {
  const m = clone(FULL);
  f(m);
  return m;
};
const paths = (v: unknown): string[] => validateAppManifest(v).map((i) => i.path);
/** The one issue expected at `path`; its reason must contain `reason`. */
function refused(v: unknown, path: string, reason: string): void {
  const hit = validateAppManifest(v).filter((i) => i.path === path);
  assert.ok(hit.length > 0, `expected an issue at ${path}, got ${JSON.stringify(validateAppManifest(v))}`);
  assert.ok(hit.some((i) => i.reason.includes(reason)), `${path}: ${JSON.stringify(hit)} lacks "${reason}"`);
}

// ---- schema and type agree -------------------------------------------------

type Node = Record<string, any>;
const isObj = (v: unknown): v is Node => typeof v === "object" && v !== null && !Array.isArray(v);

/** Walk the schema and the documents that exercise it together; keys must match at every object. */
function checkKeys(schema: Node, docs: unknown[], at: string, seen: { objects: number }): void {
  if (schema.$ref) return checkKeys((S as Node).$defs[schema.$ref.split("/").pop()!], docs, at, seen);
  if (schema.oneOf) {
    for (const b of schema.oneOf as Node[]) {
      const t = b.$ref ? (S as Node).$defs[b.$ref.split("/").pop()!].type : b.type;
      const part = docs.filter((d) => (t === "array" ? Array.isArray(d) : typeof d === t));
      if (part.length) checkKeys(b, part, at, seen);
    }
    return;
  }
  if (schema.type === "array") {
    checkKeys(schema.items, docs.flatMap((d) => d as unknown[]), `${at}[]`, seen);
    return;
  }
  if (schema.type !== "object") return;
  const objs = docs.filter(isObj);
  if (schema.properties) {
    seen.objects++;
    const have = new Set(objs.flatMap((o) => Object.keys(o)));
    if (schema.additionalProperties === false) {
      assert.deepEqual([...have].sort(), Object.keys(schema.properties).sort(), `keys at ${at || "(root)"}`);
    } else {
      // An open object (a sandbox template): the schema names what Claw reads, the rest passes through.
      for (const k of Object.keys(schema.properties)) assert.ok(have.has(k), `${at}: ${k} is not exercised`);
    }
    for (const [k, sub] of Object.entries(schema.properties as Node)) {
      checkKeys(sub, objs.filter((o) => k in o).map((o) => o[k]), at ? `${at}.${k}` : k, seen);
    }
  }
  if (isObj(schema.additionalProperties)) {
    checkKeys(schema.additionalProperties, objs.flatMap((o) => Object.values(o)), `${at}.*`, seen);
  }
}

test("JSON schema keys equal the type's keys at every object", () => {
  const seen = { objects: 0 };
  checkKeys(S as Node, [FULL], "", seen);
  assert.equal(seen.objects, 11, "the walk must reach every fixed-key object in the schema");
});

test("the schema's closed sets equal the exported constants", () => {
  const p = S.properties;
  assert.deepEqual(Object.keys(p.sandbox_roles.properties), ["measurement", "subrun", "dev"]);
});

// ---- the valid cases ---------------------------------------------------------

test("the design example, adapted, validates", () => {
  assert.deepEqual(validateAppManifest(EXAMPLE), []);
});

test("a document with every field set validates", () => {
  assert.deepEqual(validateAppManifest(FULL), []);
});

test("the smallest manifest validates", () => {
  const min = {
    schema: APP_MANIFEST_SCHEMA, name: "a", version: "0.1.0",
    container: {}, state_dir: "/state/${run_id}", command: ["run"],
  };
  assert.deepEqual(validateAppManifest(min), []);
});

test("the documented defaults are in the schema", () => {
  assert.equal(S.properties.stop_grace_sec.default, 900);
});

test("the container image is only a default and may be absent", () => {
  assert.deepEqual(paths(mutate((m) => { delete m.container.image; })), []);
  refused(mutate((m) => { m.container.image = ""; }), "container.image", "must not be empty");
  refused(mutate((m) => { m.container.image = 3; }), "container.image", "must be a string");
});

test("the fields that read the run input are gone: each is an unknown field", () => {
  refused(mutate((m) => { m.container.image_from_input = "/a"; }), "container.image_from_input", "unknown field");
  refused(mutate((m) => { m.container.gpus_from_input = "/a"; }), "container.gpus_from_input", "unknown field");
  refused(mutate((m) => { m.container.workspace_from_input = "/a"; }), "container.workspace_from_input", "unknown field");
  refused(mutate((m) => { m.container.resources_from_input = {}; }), "container.resources_from_input", "unknown field");
  refused(mutate((m) => { m.env_from_input = {}; }), "env_from_input", "unknown field");
  refused(mutate((m) => { m.grant_from_input = {}; }), "grant_from_input", "unknown field");
  refused(mutate((m) => { m.grant_extra = {}; }), "grant_extra", "unknown field");
  refused(mutate((m) => { m.limits.gpu_hours_headroom = 1.3; }), "limits.gpu_hours_headroom", "unknown field");
});

// ---- the refusals, one each --------------------------------------------------

test("not an object, wrong schema string, unknown field, missing required", () => {
  refused("nope", "(root)", "must be an object");
  refused(mutate((m) => { m.schema = "claw.app-manifest/v2"; }), "schema", "must be");
  refused(mutate((m) => { m.extra = 1; }), "extra", "unknown field");
  for (const k of S.required) refused(mutate((m) => { delete m[k]; }), k, "required");
});

test("an unknown role in sandbox_roles is refused", () => {
  refused(mutate((m) => { m.sandbox_roles.qa = ["runner"]; }), "sandbox_roles.qa", "unknown field");
});

test("a template a role names but nothing defines is refused", () => {
  refused(mutate((m) => { m.sandbox_roles.subrun.push("ghost"); }), "sandbox_roles.subrun[2]", 'template "ghost" is not defined');
  refused(mutate((m) => { delete m.sandbox_templates; delete m.env_map.sandbox_templates; }), "sandbox_roles.measurement[0]", "is not defined");
});

test("a template defined twice, or without a valid name, is refused", () => {
  refused(mutate((m) => { m.sandbox_templates[3].name = "runner"; }), "sandbox_templates[3].name", "defined twice");
  refused(mutate((m) => { delete m.sandbox_templates[3].name; }), "sandbox_templates[3].name", "required");
  refused(mutate((m) => { m.sandbox_templates[3].name = "Bad Name"; }), "sandbox_templates[3].name", "must match");
});

test("template fields Claw does not read pass through unvalidated and unchanged", () => {
  const odd = {
    name: "future", made_up: { nested: [1, "x", null] }, gpus: -3, per_gpu_count: [1, 2], provider: 7,
    start: "not-even-an-object", pending_timeout_sec: 99999, max_timeout_sec: 1,
  };
  const m = mutate((x) => { x.sandbox_templates.push(odd); x.sandbox_roles.dev.push("future"); });
  assert.deepEqual(validateAppManifest(m), []);
  assert.deepEqual((m as any).sandbox_templates[4], odd);
  // A template with only a name is enough.
  assert.deepEqual(paths(mutate((x) => { x.sandbox_templates.push({ name: "bare" }); })), []);
});

test("limits.max_sandboxes is one number, not a map by role", () => {
  refused(mutate((m) => { m.limits.max_sandboxes = { measurement: 2 }; }), "limits.max_sandboxes", "must be");
});

test("per_gpu_count, which Claw reads, must be a list of positive integers", () => {
  refused(mutate((m) => { m.sandbox_templates[0].per_gpu_count = [0]; }), "sandbox_templates[0].per_gpu_count[0]", "must be >= 1");
  refused(mutate((m) => { m.sandbox_templates[0].per_gpu_count = "8"; }), "sandbox_templates[0].per_gpu_count", "must be an array");
  refused(mutate((m) => { m.sandbox_templates[0].per_gpu_count = [1, 1]; }), "sandbox_templates[0].per_gpu_count[1]", "duplicates");
});

test("anything keyed by a role needs that role declared", () => {
  const noDev = (m: any) => { delete m.sandbox_roles.dev; };
  refused(mutate(noDev), "env_map.sandbox_keys.dev", "not declared in sandbox_roles");
});

test("two things writing one variable, and platform-owned names, are refused", () => {
  refused(mutate((m) => { m.env_map.input_file = m.env_map.state_dir; }), "env_map.input_file", "already the target");
  refused(mutate((m) => { m.env_map.grant_limits = m.env_map.sandbox_keys.dev; }), "env_map.grant_limits", "already the target");
  refused(mutate((m) => { m.env.APP_RUN_ID = "x"; }), "env.APP_RUN_ID", "also the target");
  refused(mutate((m) => { m.env.AWS_SECRET_ACCESS_KEY = "x"; }), "env.AWS_SECRET_ACCESS_KEY", "reserved");
  refused(mutate((m) => { m.env_map.run_id = "E2B_API_URL"; }), "env_map.run_id", "reserved");
  refused(mutate((m) => { m.env_map.state_dir = "USER_DATA_PATH"; }), "env_map.state_dir", "reserved");
  refused(mutate((m) => { m.env_map.run_id = "1BAD"; }), "env_map.run_id", "must match");
});

test("mcp facilities need mcp, and the public url needs mcp.public", () => {
  refused(mutate((m) => { delete m.mcp; }), "env_map.mcp_port", "needs mcp");
  refused(mutate((m) => { delete m.mcp; }), "env_map.mcp_public_url", "needs mcp");
  refused(mutate((m) => { m.mcp.public = false; }), "env_map.mcp_public_url", "mcp.public");
});

test("mapping the template list needs templates to declare", () => {
  const none = (m: any) => { delete m.sandbox_templates; m.sandbox_roles = {}; m.env_map.sandbox_keys = {}; };
  refused(mutate(none), "env_map.sandbox_templates", "needs sandbox_templates");
});

test("env_map.grant_limits is accepted as a facility, and an unknown facility is not", () => {
  assert.deepEqual(paths(mutate(() => {})), []);
  refused(mutate((m) => { m.env_map.grants = "X"; }), "env_map.grants", "unknown field");
});

test("paths and placeholders stay inside their directory", () => {
  refused(mutate((m) => { m.state_dir = "${HOME}/x"; }), "state_dir", "unknown placeholder");
  refused(mutate((m) => { m.bootstrap.file = "../x.sh"; }), "bootstrap.file", "not contain ..");
  refused(mutate((m) => { m.bootstrap.file = "/etc/x"; }), "bootstrap.file", "relative");
  refused(mutate((m) => { m.events.dir = "a/../../b"; }), "events.dir", "not contain ..");
  refused(mutate((m) => { m.mcp.path = "mcp"; }), "mcp.path", 'start with "/"');
  refused(mutate((m) => { m.bootstrap.content_b64 = "not base64!"; }), "bootstrap.content_b64", "must match");
});

test("state_dir placeholder scan is linear on hostile input", () => {
  const time = (dir: string): number => {
    const t0 = performance.now();
    validateAppManifest(mutate((m) => { m.state_dir = dir; }));
    return performance.now() - t0;
  };
  for (const unit of ["${", "${{", "${{|", "}${", "$", "$a", "${run_id"]) {
    const ms = time(unit.repeat(Math.ceil(100_000 / unit.length)));
    assert.ok(ms < 50, `${JSON.stringify(unit)} x1e5 took ${ms.toFixed(1)}ms`);
  }
  refused(mutate((m) => { m.state_dir = "${USER_DATA_PATH}/${run_id}/${x}"; }), "state_dir", "${x}");
});

test("variable names are checked in env and env_map", () => {
  refused(mutate((m) => { m.env["1BAD"] = "x"; }), "env.1BAD", "not a valid variable name");
  refused(mutate((m) => { m.env["A-B"] = "x"; }), "env.A-B", "not a valid variable name");
  refused(mutate((m) => { m.env["A=B"] = "x"; }), "env.A=B", "not a valid variable name");
  refused(mutate((m) => { m.env_map.run_id = "A B"; }), "env_map.run_id", "must match");
  refused(mutate((m) => { m.env_map.sandbox_keys.dev = "x-y"; }), "env_map.sandbox_keys.dev", "must match");
  assert.deepEqual(paths(mutate((m) => { m.env._OK_9 = "x"; })), []);
});

test("every platform-injected variable is reserved, mapped or set", () => {
  // Literal on purpose: an oracle built from the table would move with it.
  const injected = ["CLAW_SESSION_ID", "CLAW_APP_RUN_ID", "NODE_NAME", "USER_DATA_PATH", "TOPOLOGY_HANDOFF_FILE"];
  assert.deepEqual([...Object.values(APP_PLATFORM_ENV)].sort(), [...injected].sort());
  for (const name of [...injected, "E2B_API_URL", "AWS_REGION", "CLAW_ANYTHING"]) {
    assert.ok(isReservedAppEnv(name), name);
    refused(mutate((m) => { m.env[name] = "x"; }), `env.${name}`, "reserved");
    refused(mutate((m) => { m.env_map.run_id = name; }), "env_map.run_id", "reserved");
  }
  assert.ok(!isReservedAppEnv("APP_RUN_ID"));
});

test("state_dir allows only the two complete placeholders; any other $ is refused", () => {
  const dir = (d: string) => paths(mutate((m) => { m.state_dir = d; })).filter((p) => p.startsWith("state_dir"));
  assert.deepEqual(dir("${USER_DATA_PATH}/a/${run_id}"), []);
  assert.deepEqual(dir("/state/${run_id}/x"), []);
  for (const bad of ["${run_id", "/a/${run_id/b", "$run_id", "$USER_DATA_PATH/x", "/a/$", "${USER_DATA_PATH}/$run_id", "$${run_id}", "${ run_id}", "${run_id }"]) {
    assert.ok(dir(bad).length > 0, `${bad} should be refused`);
  }
  refused(mutate((m) => { m.state_dir = "${run_id"; }), "state_dir", "unterminated");
  refused(mutate((m) => { m.state_dir = "$run_id"; }), "state_dir", "bare $");
});

test("a GPU key in container.resources is refused, whichever spelling", () => {
  for (const key of ["amd.com/gpu", "gpu", "GPU", "nvidia.com/gpu"]) {
    refused(mutate((m) => { m.container.resources = { ...m.container.resources, [key]: "8" }; }), `container.resources.${key}`, "GPU key");
  }
  assert.deepEqual(paths(mutate((m) => { m.container.resources = { cpu: "8", memory: "32Gi" }; })), []);
});

test("restart needs a backoff when it allows restarts", () => {
  refused(mutate((m) => { m.restart.backoff_sec = []; }), "restart.backoff_sec", "at least 1");
  assert.deepEqual(paths(mutate((m) => { m.restart = { max_restarts: 0, backoff_sec: [] }; })), []);
  refused(mutate((m) => { m.restart.backoff_sec = [30, 0]; }), "restart.backoff_sec[1]", ">= 1");
});

test("names that Object.prototype also has are not mistaken for declared fields", () => {
  for (const k of ["constructor", "toString", "hasOwnProperty"]) {
    refused(mutate((m) => { m[k] = 1; }), k, "unknown field");
    refused(mutate((m) => { m.env[k] = 42; }), `env.${k}`, "must be a string");
    refused(mutate((m) => { m.sandbox_roles[k] = ["runner"]; }), `sandbox_roles.${k}`, "unknown field");
    const noName = mutate((m) => { delete m.name; });
    assert.ok(paths({ ...(noName as object), [k]: 1 }).includes("name"));
  }
  refused(JSON.parse('{"__proto__": 1}'), "__proto__", "unknown field");
});

test("every problem is reported, not the first", () => {
  const found = paths(mutate((m) => {
    m.container.image = "";
    m.sandbox_roles.subrun.push("ghost");
    m.limits.max_runtime_sec = 0;
  }));
  assert.deepEqual(found.sort(), ["container.image", "limits.max_runtime_sec", "sandbox_roles.subrun[2]"]);
});

test("the reserved names include everything user env refuses, from the same source", async () => {
  const { USER_ENV_DENY_LIST } = await import("../src/user-env.js");
  for (const name of USER_ENV_DENY_LIST) assert.ok(isReservedAppEnv(name), name);
  for (const name of [
    "SAFE_API_KEY", "MCP_PORT", "WORKSPACE_PATH", "USER_ID_HEX", "AUTH_CLAW_TOKEN", "LD_PRELOAD", "PATH",
    "HANDS_STATE_DIR", "HANDS_CHILD_ISOLATION", "BASH_FUNC_foo", "HYPERLOOM_MN_EXT_SSH_KEY", "INFERENCE_OPTIMIZER_NODES",
    "E2B_API_URL", "AWS_SECRET_ACCESS_KEY", "CLAW_SESSION_ID", "TOPOLOGY_HANDOFF_FILE",
  ]) {
    assert.ok(isReservedAppEnv(name), name);
    refused(mutate((m) => { m.env[name] = "x"; }), `env.${name}`, "reserved");
    refused(mutate((m) => { m.env_map.run_id = name; }), "env_map.run_id", "reserved");
  }
  // Ordinary application names are not caught.
  for (const name of ["APP_RUN_ID", "MODEL_NAME", "Mixed_Case_1"]) assert.equal(isReservedAppEnv(name), false, name);
});

test("container.resources is checked when the manifest is registered: names and quantities", () => {
  const withRes = (r: Record<string, string>) => mutate((m) => { m.container.resources = r; });
  refused(withRes({ cpu: "lots" }), "container.resources.cpu", "not a readable quantity");
  refused(withRes({ memory: "32 GB" }), "container.resources.memory", "not a readable quantity");
  refused(withRes({ "ephemeral-storage": "" }), "container.resources.ephemeral-storage", "not a readable quantity");
  refused(withRes({ "Not A Name": "1" }), "container.resources.Not A Name", "not a Kubernetes resource name");
  refused(withRes({ "a/b/c": "1" }), "container.resources.a/b/c", "not a Kubernetes resource name");
  assert.deepEqual(paths(withRes({ cpu: "500m", memory: "32Gi", "ephemeral-storage": "500Gi", "example.com/widget": "2", hugepages: "1" })), []);
});

test("state_dir: no .. segment, absolute or under ${USER_DATA_PATH}/, and per run", () => {
  const dir = (d: string) => paths(mutate((m) => { m.state_dir = d; })).filter((p) => p.startsWith("state_dir"));
  assert.ok(dir("${USER_DATA_PATH}/../other/${run_id}").length > 0, "escapes the user's data directory");
  assert.ok(dir("/state/../etc/${run_id}").length > 0);
  assert.ok(dir("${USER_DATA_PATH}/a/..").length > 0);
  assert.ok(dir("relative/${run_id}").length > 0, "neither absolute nor under USER_DATA_PATH");
  assert.ok(dir("${USER_DATA_PATH}/shared").length > 0, "no ${run_id}: concurrent runs would share it");
  assert.deepEqual(dir("${USER_DATA_PATH}/.claw-apps/${run_id}"), []);
  assert.deepEqual(dir("/state/${run_id}/x"), []);
  assert.deepEqual(dir("${USER_DATA_PATH}/a..b/${run_id}"), [], "a dotted name is not a .. segment");
});
