// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  APP_MANIFEST_JSON_SCHEMA as S,
  APP_MANIFEST_SCHEMA,
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
    image_from_input: "/framework/image",
    gpus_from_input: "/placement/container_gpus",
    workspace_from_input: ["/placement/app_workspace", "/placement/gpu_workspace"],
    resources_from_input: { cpu: "/placement/container_cpu", memory_gi: "/placement/container_memory_gi" },
    resources: { cpu: "32", memory: "128Gi", "ephemeral-storage": "500Gi" },
  },
  state_dir: "${USER_DATA_PATH}/.claw-apps/${run_id}",
  command: ["sh", "-c", 'exec "$APP_STATE_DIR/bootstrap.sh" run'],
  bootstrap: { file: "bootstrap.sh", content_b64: B64 },
  env: { APP_SOURCE_REPO: "https://example.invalid/app.git", APP_SOURCE_SHA: "pinned-by-the-plugin" },
  env_from_input: { APP_SOURCE_REPO: "/source/repo", APP_SOURCE_SHA: "/source/sha" },
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
      image_from_input: "/framework/image",
      workspace_from_input: "/placement/gpu_workspace",
      resources: { cpu: "32", memory: "256Gi", "ephemeral-storage": "500Gi" },
      mounts: { shared: "rw" },
      egress: ["git", "pypi-mirror"],
      start: { script_b64: B64, env_from_input: { APP_SOURCE_REPO: "/source/repo" } },
      data_plane: { mode: "sealed", inputs: ["/in"], outputs: ["/out"] },
      signing_identity: { key_file_env: "APP_SIGNING_KEY_FILE" },
      pending_timeout_sec: 3600,
      max_timeout_sec: 14400,
      preheat: true,
    },
    {
      name: "specialist_gpu", provider: "safe-pytorchjob", gpus: 1, image_from_input: "/framework/image",
      workspace_from_input: "/placement/subrun_gpu_workspace", mounts: { shared: "ro" },
      egress: ["model-gateway", "pypi-mirror"], data_plane: { mode: "open" }, max_timeout_sec: 86400,
    },
    { name: "builder", provider: "safe-pytorchjob", gpus: 0, data_plane: { mode: "open" } },
    { name: "dev", provider: "safe-pytorchjob", gpus: 1, data_plane: { mode: "open" } },
  ],
  sandbox_roles: { measurement: ["runner"], subrun: ["specialist_gpu", "builder"], dev: ["dev"] },
  grant_from_input: {
    "measurement.max_sandboxes": "/placement/max_parallel_tests",
    "measurement.gpus_per_sandbox": "/hardware/tp",
    gpu_hours_budget: "/budget/max_gpu_hours",
    max_hours: "/budget/max_hours",
    "subrun.max_sandboxes": "/multibranch/max_branches",
  },
  grant_extra: { "subrun.max_sandboxes": 1 },
  restart: { max_restarts: 5, backoff_sec: [30, 120, 600] },
  stop_grace_sec: 900,
  limits: {
    max_sandboxes: { measurement: 8, subrun: 16, dev: 4 },
    max_runtime_sec: 172800,
    input_max_bytes: 262144,
    gpu_hours_headroom: 1.3,
  },
} satisfies AppManifestV1;

/** Every field the type has, set, on a document that is also a valid one. */
const FULL = {
  ...EXAMPLE,
  env_map: { ...EXAMPLE.env_map, mcp_public_url: "APP_MCP_PUBLIC_URL" },
  mcp: { ...EXAMPLE.mcp, public: true },
  grant_extra: {
    "measurement.max_sandboxes": 0, "measurement.gpus_per_sandbox": 0,
    gpu_hours_budget: 0, max_hours: 0.5, "subrun.max_sandboxes": 1,
  },
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
    assert.deepEqual([...have].sort(), Object.keys(schema.properties).sort(), `keys at ${at || "(root)"}`);
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
  assert.equal(seen.objects, 18, "the walk must reach every fixed-key object in the schema");
});

test("the schema's closed sets equal the exported constants", () => {
  const p = S.properties;
  assert.deepEqual(Object.keys(p.sandbox_roles.properties), ["measurement", "subrun", "dev"]);
  assert.deepEqual(Object.keys(p.grant_from_input.properties), Object.keys(p.grant_extra.properties));
  assert.deepEqual(Object.keys(p.limits.properties.max_sandboxes.properties), Object.keys(p.env_map.properties.sandbox_keys.properties));
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
    container: { image_from_input: "/image" }, state_dir: "/state", command: ["run"],
  };
  assert.deepEqual(validateAppManifest(min), []);
});

test("grant constants and pointers can name the same limit; the headroom default is documented", () => {
  assert.equal(S.properties.limits.properties.gpu_hours_headroom.default, 1.3);
  assert.equal(S.properties.stop_grace_sec.default, 900);
  assert.deepEqual(paths(mutate((m) => { m.grant_extra = { "subrun.max_sandboxes": 1, max_hours: 0.5 }; })), []);
});

// ---- the refusals, one each --------------------------------------------------

test("not an object, wrong schema string, unknown field, missing required", () => {
  refused("nope", "(root)", "must be an object");
  refused(mutate((m) => { m.schema = "claw.app-manifest/v2"; }), "schema", "must be");
  refused(mutate((m) => { m.extra = 1; }), "extra", "unknown field");
  for (const k of S.required) refused(mutate((m) => { delete m[k]; }), k, "required");
  refused(mutate((m) => { delete m.container.image_from_input; }), "container.image_from_input", "required");
});

test("a pointer that is not an RFC 6901 pointer is refused wherever one is read", () => {
  const where: Array<[string, (m: any) => void]> = [
    ["container.image_from_input", (m) => { m.container.image_from_input = "framework/image"; }],
    ["container.gpus_from_input", (m) => { m.container.gpus_from_input = ""; }],
    ["container.workspace_from_input[1]", (m) => { m.container.workspace_from_input[1] = "gpu_workspace"; }],
    ["container.resources_from_input.cpu", (m) => { m.container.resources_from_input.cpu = "/a~2b"; }],
    ["env_from_input.APP_SOURCE_SHA", (m) => { m.env_from_input.APP_SOURCE_SHA = "/source/~"; }],
    ["grant_from_input.max_hours", (m) => { m.grant_from_input.max_hours = "budget.max_hours"; }],
    ["grant_from_input.subrun.max_sandboxes", (m) => { m.grant_from_input["subrun.max_sandboxes"] = "multibranch"; }],
    ["sandbox_templates[0].image_from_input", (m) => { m.sandbox_templates[0].image_from_input = "x"; }],
    ["sandbox_templates[0].start.env_from_input.APP_SOURCE_REPO", (m) => { m.sandbox_templates[0].start.env_from_input.APP_SOURCE_REPO = "no-slash"; }],
  ];
  for (const [path, f] of where) {
    // The dotted key `subrun.max_sandboxes` is one key; its path prints with the dot.
    refused(mutate(f), path, "JSON Pointer");
  }
});

test("valid pointers are accepted, including escapes and the empty key", () => {
  for (const ok of ["/a", "/a/b", "/a~0b", "/a~1b", "/", "//", "/a/0"]) {
    assert.deepEqual(paths(mutate((m) => { m.container.image_from_input = ok; })), [], ok);
  }
});

test("an unknown role in sandbox_roles is refused", () => {
  refused(mutate((m) => { m.sandbox_roles.qa = ["runner"]; }), "sandbox_roles.qa", "unknown field");
});

test("a template a role names but nothing defines is refused", () => {
  refused(mutate((m) => { m.sandbox_roles.subrun.push("ghost"); }), "sandbox_roles.subrun[2]", 'template "ghost" is not defined');
  refused(mutate((m) => { delete m.sandbox_templates; delete m.env_map.sandbox_templates; }), "sandbox_roles.measurement[0]", "is not defined");
});

test("a template defined twice, or with gpus and per_gpu_count, or timeouts out of order, is refused", () => {
  refused(mutate((m) => { m.sandbox_templates[3].name = "runner"; }), "sandbox_templates[3].name", "defined twice");
  refused(mutate((m) => { m.sandbox_templates[0].gpus = 1; }), "sandbox_templates[0].per_gpu_count", "cannot be combined");
  refused(mutate((m) => { m.sandbox_templates[0].pending_timeout_sec = 99999; }), "sandbox_templates[0].pending_timeout_sec", "max_timeout_sec");
});

test("anything keyed by a role needs that role declared", () => {
  const noDev = (m: any) => { delete m.sandbox_roles.dev; };
  refused(mutate(noDev), "env_map.sandbox_keys.dev", "not declared in sandbox_roles");
  refused(mutate(noDev), "limits.max_sandboxes.dev", "not declared in sandbox_roles");
  const noSub = (m: any) => { delete m.sandbox_roles.subrun; };
  refused(mutate(noSub), "grant_from_input.subrun.max_sandboxes", "not declared in sandbox_roles");
  refused(mutate(noSub), "grant_extra.subrun.max_sandboxes", "not declared in sandbox_roles");
});

test("a grant key Claw does not know, and a bad grant constant, are refused", () => {
  refused(mutate((m) => { m.grant_from_input.max_gpus = "/x"; }), "grant_from_input.max_gpus", "unknown field");
  refused(mutate((m) => { m.grant_extra.bogus = 1; }), "grant_extra.bogus", "unknown field");
  refused(mutate((m) => { m.grant_extra["subrun.max_sandboxes"] = 1.5; }), "grant_extra.subrun.max_sandboxes", "must be an integer");
  refused(mutate((m) => { m.grant_extra["subrun.max_sandboxes"] = -1; }), "grant_extra.subrun.max_sandboxes", ">= 0");
});

test("the headroom is a number of at least 1", () => {
  refused(mutate((m) => { m.limits.gpu_hours_headroom = 0.9; }), "limits.gpu_hours_headroom", ">= 1");
  refused(mutate((m) => { m.limits.gpu_hours_headroom = "1.3"; }), "limits.gpu_hours_headroom", "must be a number");
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
  const none = (m: any) => { delete m.sandbox_templates; m.sandbox_roles = {}; m.env_map.sandbox_keys = {}; m.limits.max_sandboxes = {}; m.grant_from_input = {}; m.grant_extra = {}; };
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
    m.container.image_from_input = "bad";
    m.sandbox_roles.subrun.push("ghost");
    m.limits.gpu_hours_headroom = 0.5;
  }));
  assert.deepEqual(found.sort(), ["container.image_from_input", "limits.gpu_hours_headroom", "sandbox_roles.subrun[2]"]);
});
