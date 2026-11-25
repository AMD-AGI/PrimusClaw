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
  APP_MANIFEST_SCHEMA, appGrantTemplates, appTemplateWorkspace, foldedValue, renderTemplateMounts, sandboxHostPathRoots, templateMountRefusals,
  validateAppManifest, TEMPLATE_MOUNTS_MAX, type AppManifestV1,
} from "../src/index.js";

const CACHE = "/shared/team/cache";

const manifest = (template: Record<string, unknown>): AppManifestV1 => ({
  schema: APP_MANIFEST_SCHEMA, name: "example-app", version: "1.0.0", container: {},
  state_dir: "/state/${run_id}", command: ["run"],
  sandbox_templates: [{ name: "measurement", fromImage: "registry.example.invalid/m:1", per_gpu_count: [1, 8], workspaceStorage: "off", ...template }],
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

test("a template's own hostPath volume is refused in any spelling, flat or nested: host paths come only through host_mounts", () => {
  assert.deepEqual(paths({ volumes: [{ name: "v", hostPath: { path: "/" } }] }), ["sandbox_templates[0].volumes[0]"]);
  assert.deepEqual(paths({ volumes: [{ name: "v", emptyDir: {}, HostPath: { path: "/" } }] }), ["sandbox_templates[0].volumes[0]"]);
  assert.deepEqual(paths({ volumes: { name: "v" } }), ["sandbox_templates[0].volumes"]);
  assert.deepEqual(paths({ volumes: ["v"] }), ["sandbox_templates[0].volumes[0]"]);
  assert.deepEqual(paths({ template: { fromImage: "x", volumes: [{ name: "v", hostpath: { path: "/etc" } }] } }), [
    "sandbox_templates[0].template.volumes[0]",
  ]);
  assert.deepEqual(issuesOf({ volumes: [{ name: "c", configMap: { name: "cfg" } }], volumeMounts: [{ name: "c", mountPath: "/config" }] }), [],
    "a volume of another source passes through as before");
});

test("Agent Sandbox's keys must be spelt exactly: its decoder matches them case-insensitively", () => {
  assert.deepEqual(paths({ Volumes: [{ name: "v", hostPath: { path: "/" } }], VolumeMounts: [{ name: "v", mountPath: "/host" }] }), [
    "sandbox_templates[0].Volumes", "sandbox_templates[0].VolumeMounts",
  ]);
  assert.deepEqual(paths({ VOLUMEMOUNTS: [] }), ["sandbox_templates[0].VOLUMEMOUNTS"]);
  assert.deepEqual(paths({ Template: { fromImage: "x" } }), ["sandbox_templates[0].Template"]);
  assert.deepEqual(paths({ template: { fromImage: "x", volumes: [], Volumes: [] } }), [
    "sandbox_templates[0].template.Volumes", "sandbox_templates[0].template.Volumes",
  ], "repeated in another case, and misspelt");
  for (const key of ["Workspace", "Image", "FromImage", "Resources", "GPU"]) {
    // The template also has fromImage, so FromImage is a repeat as well.
    const flat = key === "FromImage" ? 2 : 1;
    assert.deepEqual(paths({ [key]: "x" }), Array(flat).fill(`sandbox_templates[0].${key}`), key);
    assert.deepEqual(paths({ template: { fromImage: "x", [key]: "x" } }), Array(flat).fill(`sandbox_templates[0].template.${key}`), `nested ${key}`);
  }
  assert.deepEqual(paths({ resources: { Limits: {} }, gpu: { SharedMemory: "1Gi" } }), [
    "sandbox_templates[0].resources.Limits", "sandbox_templates[0].gpu.SharedMemory",
  ]);
});

test("two keys of one template object that fold to one are refused, at any depth: the decoder keeps the last", () => {
  // The review's probe: admission read W2, Agent Sandbox's decoder reads W1.
  const probe = { name: "measurement", workspace: "W2", Workspace: "W1", workspaceStorage: "off", host_mounts: [{ hostPath: "/mnt/x", readOnly: true }] };
  const issues = validateAppManifest({ ...manifest({}), sandbox_templates: [{ fromImage: "registry.example.invalid/m:1", ...probe }] });
  assert.deepEqual(issues.map((i) => i.path), ["sandbox_templates[0].Workspace", "sandbox_templates[0].Workspace"]);
  assert.match(issues[0]!.reason, /keeps the last/);
  // A duplicate in the nested template, and deeper, is refused the same way.
  assert.deepEqual(paths({ template: { fromImage: "x", workspace: "W2", WORKSPACE: "W1" } }), [
    "sandbox_templates[0].template.WORKSPACE", "sandbox_templates[0].template.WORKSPACE",
  ]);
  assert.deepEqual(paths({ template: { fromImage: "x", env: [{ name: "A", Name: "B" }] } }), ["sandbox_templates[0].template.env[0].Name"]);
  assert.deepEqual(paths({ labels: { app: "a", App: "b" } }), ["sandbox_templates[0].labels.App"]);
  assert.deepEqual(issuesOf({ labels: { app: "a", tier: "b" }, env: [{ name: "A" }, { name: "B" }] }), []);
});

test("the workspace a template is checked against is the one Agent Sandbox's decoder reads", () => {
  const resolved = { image: "img", sandboxWorkspace: "run-ws" };
  // Its own key in another case is what the decoder reads (were it allowed),
  // and the grant hands it over spelt exactly, once.
  const t = { name: "m", fromImage: "x", Workspace: "W1" };
  assert.equal(appTemplateWorkspace(t, resolved), "W1");
  const [granted] = appGrantTemplates({ ...manifest({}), sandbox_templates: [t] } as AppManifestV1, resolved);
  assert.equal(granted!.workspace, "W1");
  assert.equal(Object.hasOwn(granted!, "Workspace"), false);
  // Of two, the last, as the decoder reads them.
  assert.equal(appTemplateWorkspace({ name: "m", workspace: "W2", Workspace: "W1" }, resolved), "W1");
  assert.equal(foldedValue({ workspace: "W2", Workspace: "W1" }, "workspace"), "W1");
  assert.equal(appTemplateWorkspace({ name: "m" }, resolved), "run-ws");
  assert.equal(appTemplateWorkspace({ name: "m", workspace: "W3" }, resolved), "W3");
});

test("a key that Go's decoder folds onto an Agent Sandbox key (\u017f is s, \u212a is k) is refused, at any depth", () => {
  // The two probes of the review: both decode in Agent Sandbox as a hostPath volume.
  assert.deepEqual(paths({ "volume\u017f": [{ name: "a", hostPath: { path: "/etc" } }], volumeMounts: [{ name: "a", mountPath: "/etc" }] }), [
    "sandbox_templates[0].volume\u017f",
  ]);
  assert.deepEqual(paths({ volumes: [{ name: "a", "ho\u017ftPath": { path: "/root" } }], volumeMounts: [{ name: "a", mountPath: "/root" }] }), [
    "sandbox_templates[0].volumes[0].ho\u017ftPath",
  ]);
  assert.deepEqual(paths({ template: { fromImage: "x", volumes: [{ name: "a", "ho\u017ftPath": { path: "/root" } }] } }), [
    "sandbox_templates[0].template.volumes[0].ho\u017ftPath",
  ]);
  assert.deepEqual(paths({ "volumeMount\u017f": [] }), ["sandbox_templates[0].volumeMount\u017f"]);
  assert.deepEqual(paths({ volumes: [{ name: "a", emptyDir: { "\u212aey": 1 } }] }), ["sandbox_templates[0].volumes[0].emptyDir.\u212aey"]);
  assert.match(issuesOf({ "volume\u017f": [] })[0]!.reason, /ASCII/);
  assert.deepEqual(issuesOf({ volumes: [{ name: "a", emptyDir: {} }], volumeMounts: [{ name: "a", mountPath: "/w\u00e9" }] }), [],
    "a non-ASCII value is not a key");
});

test("a template with host_mounts must turn its workspace's storage off or read-only where Agent Sandbox reads it", () => {
  // A read-only mount beneath the workspace's read-write mount protects nothing.
  for (const storage of [undefined, "on"]) {
    const issues = issuesOf({ workspaceStorage: storage, host_mounts: [{ hostPath: CACHE, readOnly: true }] });
    assert.deepEqual(issues.map((i) => i.path), ["sandbox_templates[0].workspaceStorage"], String(storage));
    assert.match(issues[0]!.reason, /must be "off" or "readOnly" in a template with host_mounts/);
  }
  for (const storage of ["off", "readOnly"]) {
    assert.deepEqual(issuesOf({ workspaceStorage: storage, host_mounts: [{ hostPath: CACHE, readOnly: true }] }), [], storage);
  }
  // The nested template carries the image, so it is the one that must say so.
  assert.deepEqual(paths({ workspaceStorage: "readOnly", template: { fromImage: "x" }, host_mounts: [{ hostPath: CACHE, readOnly: true }] }), [
    "sandbox_templates[0].template.workspaceStorage",
  ]);
  assert.deepEqual(issuesOf({ template: { fromImage: "x", workspaceStorage: "readOnly" }, host_mounts: [{ hostPath: CACHE, readOnly: true }] }), []);
  // Spelt in another case it is not the key Claw reads, and is refused as such.
  const misspelt = { name: "measurement", fromImage: "registry.example.invalid/m:1", WorkspaceStorage: "off", host_mounts: [{ hostPath: CACHE, readOnly: true }] };
  assert.deepEqual(validateAppManifest({ ...manifest({}), sandbox_templates: [misspelt] }).map((i) => i.path), [
    "sandbox_templates[0].WorkspaceStorage", "sandbox_templates[0].workspaceStorage",
  ]);
  // Without mounts the storage is the template's own choice.
  for (const storage of ["on", "off", "readOnly", undefined]) assert.deepEqual(issuesOf({ workspaceStorage: storage }), [], String(storage));
  // The grant hands the setting through unchanged, beside the rendered mounts.
  const [t] = appGrantTemplates(manifest({ workspaceStorage: "readOnly", host_mounts: [{ hostPath: CACHE, readOnly: true }] }), {
    image: "i", sandboxWorkspace: "ws",
  });
  assert.equal(t!.workspaceStorage, "readOnly");
});

test("workspaceStorage is one of on, off and readOnly, at the top and in a nested template, with or without mounts", () => {
  for (const storage of [false, true, "false", "readonly", "ReadOnly", "", 0, null]) {
    assert.deepEqual(paths({ workspaceStorage: storage }), ["sandbox_templates[0].workspaceStorage"], JSON.stringify(storage));
    assert.deepEqual(paths({ template: { fromImage: "x", workspaceStorage: storage } }), ["sandbox_templates[0].template.workspaceStorage"], JSON.stringify(storage));
  }
  const issue = issuesOf({ workspaceStorage: "readonly" })[0]!;
  assert.match(issue.reason, /must be one of "on", "off", "readOnly"/);
});

test("a template's own volumes and their mounts are kept, and may not take a host mount's volume name", () => {
  const scratch = { volumes: [{ name: "scratch", emptyDir: {} }], volumeMounts: [{ name: "scratch", mountPath: "/scratch", readOnly: false }] };
  assert.deepEqual(issuesOf(scratch), []);
  assert.deepEqual(issuesOf({ ...scratch, host_mounts: [{ hostPath: CACHE, readOnly: true }] }), []);
  assert.deepEqual(paths({ volumes: [{ name: "template-mount-0", emptyDir: {} }], host_mounts: [{ hostPath: CACHE, readOnly: true }] }), [
    "sandbox_templates[0].volumes[0].name",
  ]);
  assert.deepEqual(paths({ template: { fromImage: "x", workspaceStorage: "off", volumes: [{ name: "template-mount-a", emptyDir: {} }] }, host_mounts: [{ hostPath: CACHE, readOnly: true }] }), [
    "sandbox_templates[0].template.volumes[0].name",
  ]);
  assert.deepEqual(paths({ volumeMounts: [{ name: "template-mount-0", mountPath: "/w", readOnly: false }], host_mounts: [{ hostPath: CACHE, readOnly: true }] }), [
    "sandbox_templates[0].volumeMounts[0].name",
  ]);
  const [t] = appGrantTemplates(manifest({ ...scratch, host_mounts: [{ hostPath: CACHE, readOnly: true }] }), { image: "i", sandboxWorkspace: "ws" });
  assert.deepEqual((t!.volumes as Array<{ name: string }>).map((v) => v.name), ["scratch", "template-mount-0"]);
  assert.deepEqual((t!.volumeMounts as Array<{ name: string }>).map((v) => v.name), ["scratch", "template-mount-0"]);
  const [plain] = appGrantTemplates(manifest(scratch), { image: "i", sandboxWorkspace: "ws" });
  assert.deepEqual(plain!.volumes, scratch.volumes, "a template without host_mounts keeps its volumes unchanged");
});

test("a template without host_mounts may name its own volumes template-mount-*, as it could before", () => {
  const cache = { volumes: [{ name: "template-mount-cache", emptyDir: {} }], volumeMounts: [{ name: "template-mount-cache", mountPath: "/cache", readOnly: false }] };
  assert.deepEqual(issuesOf(cache), []);
  assert.deepEqual(issuesOf({ template: { fromImage: "x", ...cache } }), []);
  const [t] = appGrantTemplates(manifest(cache), { image: "i", sandboxWorkspace: "ws" });
  assert.deepEqual(t!.volumes, cache.volumes);
  assert.deepEqual(t!.volumeMounts, cache.volumeMounts);
  assert.deepEqual(paths({ ...cache, host_mounts: [{ hostPath: CACHE, readOnly: true }] }), [
    "sandbox_templates[0].volumes[0].name", "sandbox_templates[0].volumeMounts[0].name",
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
  // The nested template is selected as Agent Sandbox's decoder selects it, whatever the case of its keys.
  const folded = renderTemplateMounts({ name: "m", template: { FromImage: "img:1" }, host_mounts: [{ hostPath: CACHE, readOnly: true }] });
  assert.equal(Object.hasOwn(folded, "volumes"), false);
  assert.equal(((folded.template as Record<string, unknown>).volumes as unknown[]).length, 1);
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
