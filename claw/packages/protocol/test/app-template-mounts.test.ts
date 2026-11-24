// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Read-only host directories a sandbox template mounts (`sandbox_templates[].host_mounts`):
 * what the manifest accepts, what the grant hands Agent Sandbox, and which
 * mounts a workspace grants.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  APP_MANIFEST_SCHEMA, appGrantTemplates, renderTemplateMounts, sandboxHostPathRoots, templateMountRefusals,
  validateAppManifest, TEMPLATE_MOUNTS_MAX, type AppManifestV1,
} from "../src/index.js";

const CACHE = "/shared/team/cache";

const manifest = (template: Record<string, unknown>): AppManifestV1 => ({
  schema: APP_MANIFEST_SCHEMA, name: "example-app", version: "1.0.0", container: {},
  state_dir: "/state/${run_id}", command: ["run"],
  sandbox_templates: [{ name: "measurement", fromImage: "registry.example.invalid/m:1", per_gpu_count: [1, 8], ...template }],
  sandbox_roles: { measurement: ["measurement"] },
} as AppManifestV1);

const issuesOf = (template: Record<string, unknown>) => validateAppManifest(manifest(template));
const paths = (template: Record<string, unknown>) => issuesOf(template).map((i) => i.path);

test("a read-only mount of an absolute, normalised path is accepted, with or without its mountPath", () => {
  assert.deepEqual(issuesOf({ host_mounts: [{ hostPath: CACHE, readOnly: true }] }), []);
  assert.deepEqual(issuesOf({ host_mounts: [{ hostPath: CACHE, mountPath: CACHE, readOnly: true }] }), []);
  assert.deepEqual(issuesOf({ host_mounts: [{ hostPath: CACHE, readOnly: true }, { hostPath: "/shared/team/models", readOnly: true }] }), []);
  assert.deepEqual(issuesOf({}), [], "a template without mounts is unchanged");
});

test("readOnly must be true: a read-write or unspecified mount is refused", () => {
  for (const readOnly of [false, undefined, "true", 1]) {
    const issues = issuesOf({ host_mounts: [{ hostPath: CACHE, ...(readOnly === undefined ? {} : { readOnly }) }] });
    assert.deepEqual(issues.map((i) => i.path), ["sandbox_templates[0].host_mounts[0].readOnly"], String(readOnly));
    assert.match(issues[0]!.reason, /must be true/);
  }
});

test("a path that is not absolute and normalised is refused", () => {
  const cases: Array<[string, RegExp]> = [
    ["shared/team/cache", /absolute/],
    ["/shared/../etc", /\.\. segment/],
    ["/shared/team/..", /\.\. segment/],
    ["/shared/./team", /\. segment/],
    ["/shared//team", /empty segment/],
    ["/shared/team/", /end with \//],
    ["/", /must not be \//],
    ["/shared/a:b", /':'/],
    ["/shared/a,b", /','/],
    ["/shared/a b", /blank/],
    ["/shared/a\nb", /control/],
    ["", /empty/],
  ];
  for (const [hostPath, reason] of cases) {
    const issues = issuesOf({ host_mounts: [{ hostPath, readOnly: true }] });
    assert.deepEqual(issues.map((i) => i.path), ["sandbox_templates[0].host_mounts[0].hostPath"], JSON.stringify(hostPath));
    assert.match(issues[0]!.reason, reason, JSON.stringify(hostPath));
  }
});

test("a system directory, one under it, or one above it is refused", () => {
  for (const hostPath of ["/etc", "/etc/ssl", "/usr/lib", "/proc/1", "/dev/shm", "/var", "/var/run/secrets", "/var/lib/kubelet", "/tmp/x", "/sys"]) {
    const issues = issuesOf({ host_mounts: [{ hostPath, readOnly: true }] });
    assert.deepEqual(issues.map((i) => i.path), ["sandbox_templates[0].host_mounts[0].hostPath"], hostPath);
    assert.match(issues[0]!.reason, /system directory/, hostPath);
  }
  assert.deepEqual(issuesOf({ host_mounts: [{ hostPath: "/var/cache-share", readOnly: true }] }), [], "a sibling of a system directory is not one");
});

test("mountPath other than the hostPath, an unknown key, a duplicate, too many mounts and a non-array are refused", () => {
  assert.deepEqual(paths({ host_mounts: [{ hostPath: CACHE, mountPath: "/cache", readOnly: true }] }), ["sandbox_templates[0].host_mounts[0].mountPath"]);
  assert.deepEqual(paths({ host_mounts: [{ hostPath: CACHE, readOnly: true, subPath: "x" }] }), ["sandbox_templates[0].host_mounts[0].subPath"]);
  assert.deepEqual(paths({ host_mounts: [{ hostPath: CACHE, readOnly: true }, { hostPath: CACHE, readOnly: true }] }), ["sandbox_templates[0].host_mounts[1].hostPath"]);
  const many = Array.from({ length: TEMPLATE_MOUNTS_MAX + 1 }, (_, i) => ({ hostPath: `/shared/d${i}`, readOnly: true }));
  assert.deepEqual(paths({ host_mounts: many }), ["sandbox_templates[0].host_mounts"]);
  assert.deepEqual(paths({ host_mounts: { hostPath: CACHE, readOnly: true } }), ["sandbox_templates[0].host_mounts"]);
  assert.deepEqual(paths({ host_mounts: ["/shared"] }), ["sandbox_templates[0].host_mounts[0]"]);
});

test("Agent Sandbox's own volumes and volumeMounts are refused, flat or nested: host paths come only through host_mounts", () => {
  assert.deepEqual(paths({ volumes: [{ name: "v", hostPath: { path: "/" } }] }), ["sandbox_templates[0].volumes"]);
  assert.deepEqual(paths({ volumeMounts: [{ name: "v", mountPath: "/host" }] }), ["sandbox_templates[0].volumeMounts"]);
  assert.deepEqual(paths({ template: { fromImage: "x", volumes: [], volumeMounts: [] } }), [
    "sandbox_templates[0].template.volumes", "sandbox_templates[0].template.volumeMounts",
  ]);
});

test("the grant carries each mount as a hostPath volume and a read-only mount at the same path, and drops mounts", () => {
  const m = manifest({ host_mounts: [{ hostPath: CACHE, readOnly: true }, { hostPath: "/shared/team/models", mountPath: "/shared/team/models", readOnly: true }] });
  const [t] = appGrantTemplates(m, { image: "registry.example.invalid/app:1", sandboxWorkspace: "ws-a" });
  assert.equal(Object.hasOwn(t!, "host_mounts"), false);
  assert.deepEqual(t!.volumes, [
    { name: "template-mount-0", hostPath: { path: CACHE, type: "Directory" } },
    { name: "template-mount-1", hostPath: { path: "/shared/team/models", type: "Directory" } },
  ]);
  assert.deepEqual(t!.volumeMounts, [
    { name: "template-mount-0", mountPath: CACHE, readOnly: true },
    { name: "template-mount-1", mountPath: "/shared/team/models", readOnly: true },
  ]);
  assert.equal(t!.fromImage, "registry.example.invalid/m:1");
  assert.deepEqual(t!.per_gpu_count, [1, 8]);
  assert.equal(t!.workspace, "ws-a");
});

test("a template in the nested form gets its volumes inside the template Agent Sandbox reads; one without mounts is unchanged", () => {
  const nested = renderTemplateMounts({ name: "m", template: { fromImage: "img:1" }, host_mounts: [{ hostPath: CACHE, readOnly: true }] });
  assert.equal(Object.hasOwn(nested, "volumes"), false);
  assert.deepEqual((nested.template as Record<string, unknown>).volumeMounts, [{ name: "template-mount-0", mountPath: CACHE, readOnly: true }]);
  const plain = { name: "m", fromImage: "img:1" };
  assert.equal(renderTemplateMounts(plain), plain);
});

const VOLUME = { id: 1, type: "hostpath", hostPath: "/shared", mountPath: "/shared" };

test("a mount under a hostpath volume of the workspace is granted; one outside every volume is not", () => {
  assert.deepEqual(templateMountRefusals("measurement", [{ hostPath: CACHE, readOnly: true }], "ws-a", [VOLUME]), []);
  assert.deepEqual(templateMountRefusals("measurement", [{ hostPath: "/shared", readOnly: true }], "ws-a", [VOLUME]), [], "the root itself");
  const out = templateMountRefusals("measurement", [{ hostPath: CACHE, readOnly: true }, { hostPath: "/other/cache", readOnly: true }, { hostPath: "/shared-x/c", readOnly: true }], "ws-a", [VOLUME]);
  assert.deepEqual(out.map((r) => r.field), ["sandbox_templates.measurement.host_mounts[1].hostPath", "sandbox_templates.measurement.host_mounts[2].hostPath"]);
  assert.match(out[0]!.reason, /not under a directory workspace ws-a mounts for sandboxes/);
  assert.equal(templateMountRefusals("measurement", [{ hostPath: CACHE, readOnly: true }], "ws-a", []).length, 1, "a workspace with no volumes grants nothing");
  assert.equal(templateMountRefusals("measurement", [{ hostPath: CACHE, readOnly: true }], "ws-a", undefined).length, 1);
});

test("what a volume declares follows the sandbox platform: subPath, scopes, the privileged grant, user directories, pvc", () => {
  const granted = (volume: Record<string, unknown>, hostPath = CACHE) =>
    templateMountRefusals("t", [{ hostPath, readOnly: true }], "ws", [volume]).length === 0;
  assert.equal(granted({ ...VOLUME, subPath: "team" }), true, "hostPath joined with subPath");
  assert.equal(granted({ ...VOLUME, subPath: "other" }), false);
  assert.equal(granted({ ...VOLUME, scopes: ["Sandbox", "Train"] }), true);
  assert.equal(granted({ ...VOLUME, scopes: ["Train"] }), false, "a volume not mounted into sandboxes");
  assert.equal(granted({ ...VOLUME, requiresPrivilegedGrant: true }), false);
  assert.equal(granted({ ...VOLUME, accessMode: "ReadOnlyMany" }), true, "a read-only mount under a read-only volume");
  assert.equal(granted({ ...VOLUME, enableUserDir: true }), true, "a shared directory beside the user directories");
  assert.equal(granted({ ...VOLUME, enableUserDir: true }, "/shared/users/u1"), false, "another user's directory");
  assert.equal(granted({ ...VOLUME, enableUserDir: true }, "/shared"), false, "the root of a volume with user directories");
  assert.equal(granted({ ...VOLUME, type: "pfs" }), false);
  assert.equal(granted({ ...VOLUME, hostPath: "/shared/../" }), false, "a volume path with .. declares nothing");
  assert.equal(granted({ ...VOLUME, hostPath: "/" }), true, "a volume of the whole host declares everything under it");
  assert.deepEqual(sandboxHostPathRoots([{ ...VOLUME, hostPath: "/shared/", subPath: "./team" }]), [{ path: "/shared/team", userDirs: false }]);
});
