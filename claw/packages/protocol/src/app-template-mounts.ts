// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Host directories a sandbox template mounts read-only (`sandbox_templates[].host_mounts`).
 *
 *   "host_mounts": [{ "hostPath": "/shared/team/cache", "readOnly": true }]
 *
 * A mount is a hostPath volume of the Agent Sandbox template, mounted at the
 * same path in the container. It lets a template see a directory of its
 * workspace's storage read-only while every other pod of the workspace (the
 * application's among them) keeps the workspace's own, read-write, mount of
 * the parent.
 *
 * What a mount may name, and why:
 *
 *  - Only `readOnly: true`. The workspace already mounts its storage into every
 *    sandbox it runs, read-write where the workspace says so, so a read-write
 *    template mount would add nothing a sandbox lacks; and the sandbox workload
 *    mounts every host path it is given read-only anyway, so `readOnly: false`
 *    would be a promise the platform does not keep.
 *  - `mountPath` is the `hostPath` itself (it may be left out). The sandbox
 *    workload mounts a host path at the same path in the container and has no
 *    field for another one, so a different `mountPath` would be ignored.
 *  - An absolute, normalised path: no `.` or `..` segment, no empty segment or
 *    trailing `/`, and none of `:` `,` or a blank or control character, which
 *    the container runtimes' bind syntax (`src:dst:ro`) cannot carry. Not `/`,
 *    and not a system directory, one below it, or one above it (`/etc`,
 *    `/usr`, `/var` because of `/var/run`, ...).
 *  - At run time, the path must lie under a directory the sandbox's workspace
 *    already mounts for sandboxes ({@link templateMountRefusals}): a plugin
 *    never reaches a host path the workspace does not grant. The rule mirrors
 *    the one the sandbox platform applies to a workload's host paths: a
 *    hostpath volume of the workspace that applies to the Sandbox scope and
 *    does not require the privileged grant declares its `hostPath` joined with
 *    its `subPath`; one with `enableUserDir` declares only the directories
 *    under it other than `users` (the per-user directories).
 *
 * A template's own Agent Sandbox `volumes` may only be `emptyDir` ones, and
 * Agent Sandbox's keys must be spelt exactly (its JSON decoder matches them
 * case-insensitively): `host_mounts` is the only way a plugin template reaches
 * a host path, so the checks above cannot be stepped around.
 *
 * Mount order. A template mount is usually nested inside a workspace mount
 * (workspace `/shared` read-write, template `/shared/team/cache` read-only),
 * and the nested mount only wins when it is applied after its parent. No
 * layer here relies on the order the mounts are listed in: the sandbox
 * platform sorts a pod's host-path mounts by depth (parents first) before the
 * pod is made, Kubernetes' CRI runtimes (containerd, CRI-O) sort a
 * container's mounts by the number of path components, the Docker daemon
 * sorts them by destination depth (`SortMounts`), and Apptainer sorts user
 * binds (`--bind`) by destination depth and applies `ro` with a read-only
 * remount of the bind. The kubelet itself passes `volumeMounts` in list order.
 */
import type { AppManifestIssue } from "./app-manifest.js";

/** The most mounts one template may declare. */
export const TEMPLATE_MOUNTS_MAX = 8;

/** One entry of `sandbox_templates[].host_mounts`. */
export interface AppTemplateMount {
  hostPath: string;
  /** The path in the container; when given, it must be `hostPath`. */
  mountPath?: string;
  /** Must be `true`. */
  readOnly: true;
}

/** Agent Sandbox's own volume keys of a template; its `volumes` may only be `emptyDir` ones. */
export const TEMPLATE_RAW_VOLUME_KEYS = ["volumes", "volumeMounts"] as const;

/** The name prefix of the volumes `host_mounts` renders, which a template's own volumes may not take. */
export const TEMPLATE_MOUNT_VOLUME_PREFIX = "template-mount-";

/**
 * Keys Agent Sandbox reads that a template must spell exactly: its JSON decoder
 * matches field names case-insensitively, so `Volumes` would reach it as
 * `volumes` past every check here.
 */
const EXACT_KEYS = ["template", ...TEMPLATE_RAW_VOLUME_KEYS] as const;

/**
 * Directories a mount may not be, be under, or be above. `/var` and `/` are
 * refused as the parents of `/var/run`, `/var/lib` and everything else.
 */
const SYSTEM_PATHS = [
  "/bin", "/boot", "/dev", "/etc", "/lib", "/lib32", "/lib64", "/libx32", "/proc", "/root", "/run",
  "/sbin", "/sys", "/tmp", "/usr", "/var/lib", "/var/run", "/var/tmp",
] as const;

const MOUNT_KEYS = new Set(["hostPath", "mountPath", "readOnly"]);
const PATH_MAX = 1024;

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Whether `path` is `root` or lies under it; both are normalised absolute paths. */
export function pathWithin(root: string, path: string): boolean {
  return path === root || root === "/" || path.startsWith(`${root}/`);
}

/** Why `p` is not an absolute, normalised path a bind can carry, or undefined when it is. */
function pathProblem(p: string): string | undefined {
  if (p.length === 0) return "must not be empty";
  if (p.length > PATH_MAX) return `must be at most ${PATH_MAX} characters`;
  if (!p.startsWith("/")) return "must be an absolute path";
  // Blank and control characters, and the separators of a bind spec (src:dst:ro, CSV --mount).
  if (/[\s\u0000-\u001f\u007f:,]/.test(p)) return "must not contain a blank or control character, ':' or ','";
  if (p === "/") return "must not be /";
  if (p.endsWith("/")) return "must not end with /";
  const segments = p.slice(1).split("/");
  if (segments.includes("..")) return "must not contain a .. segment";
  if (segments.includes(".")) return "must not contain a . segment";
  if (segments.includes("")) return "must not contain an empty segment (//)";
  return undefined;
}

/** The system directory `p` is, is under, or is above, or undefined. */
function systemOverlap(p: string): string | undefined {
  return SYSTEM_PATHS.find((s) => pathWithin(s, p) || pathWithin(p, s));
}

/**
 * The problems of one template's `host_mounts` and raw volume keys, each with its
 * path (`at` is the template's, e.g. `sandbox_templates[0]`). The shape the
 * schema checks (an array of objects) is assumed only as far as it is there.
 */
export function templateMountIssues(template: Record<string, unknown>, at: string): AppManifestIssue[] {
  const issues: AppManifestIssue[] = [];
  const bad = (path: string, reason: string): void => void issues.push({ path, reason });
  const nested = isObj(template.template) ? template.template : undefined;
  rawVolumeIssues(template, at, bad);
  if (nested) rawVolumeIssues(nested, `${at}.template`, bad);
  const mounts = template.host_mounts;
  if (mounts === undefined) return issues;
  if (!Array.isArray(mounts)) {
    bad(`${at}.host_mounts`, "must be an array");
    return issues;
  }
  if (mounts.length > TEMPLATE_MOUNTS_MAX) bad(`${at}.host_mounts`, `must have at most ${TEMPLATE_MOUNTS_MAX} items`);
  const seen = new Set<string>();
  mounts.forEach((m, i) => {
    const mat = `${at}.host_mounts[${i}]`;
    if (!isObj(m)) {
      bad(mat, "must be an object");
      return;
    }
    for (const k of Object.keys(m)) if (!MOUNT_KEYS.has(k)) bad(`${mat}.${k}`, "unknown key (expected hostPath, mountPath or readOnly)");
    if (m.readOnly !== true) {
      bad(`${mat}.readOnly`, "must be true: the workspace already mounts its storage read-write where it allows writes, and a sandbox's host paths are mounted read-only");
    }
    if (typeof m.hostPath !== "string") {
      bad(`${mat}.hostPath`, "must be a string");
      return;
    }
    const problem = pathProblem(m.hostPath);
    if (problem) {
      bad(`${mat}.hostPath`, problem);
      return;
    }
    const system = systemOverlap(m.hostPath);
    if (system) bad(`${mat}.hostPath`, `must not be, be under, or contain the system directory ${system}`);
    if (m.mountPath !== undefined && m.mountPath !== m.hostPath) {
      bad(`${mat}.mountPath`, "must be the hostPath (or be left out): a sandbox mounts a host path at the same path");
    }
    if (seen.has(m.hostPath)) bad(`${mat}.hostPath`, `${m.hostPath} is mounted twice`);
    seen.add(m.hostPath);
  });
  return issues;
}

/**
 * Agent Sandbox's own volume keys of one template object: spelt exactly, its
 * `volumes` only `emptyDir` ones (`{ name, emptyDir }`), and no volume or mount
 * named like those `host_mounts` renders. A host directory is reached only
 * through `host_mounts`.
 */
function rawVolumeIssues(obj: Record<string, unknown>, at: string, bad: (path: string, reason: string) => void): void {
  for (const key of Object.keys(obj)) {
    const exact = EXACT_KEYS.find((k) => k.toLowerCase() === key.toLowerCase());
    if (exact && exact !== key) bad(`${at}.${key}`, `must be spelt ${exact}`);
  }
  const reserved = (name: unknown): boolean => typeof name === "string" && name.startsWith(TEMPLATE_MOUNT_VOLUME_PREFIX);
  if (Object.hasOwn(obj, "volumes")) {
    if (!Array.isArray(obj.volumes)) bad(`${at}.volumes`, "must be an array");
    else obj.volumes.forEach((v, i) => {
      const keys = isObj(v) ? Object.keys(v).sort().join(",") : "";
      if (!isObj(v) || keys !== "emptyDir,name" || !isObj(v.emptyDir) || typeof v.name !== "string") {
        bad(`${at}.volumes[${i}]`, "a template's own volumes may only be { name, emptyDir }; a host directory goes in host_mounts");
      } else if (reserved(v.name)) {
        bad(`${at}.volumes[${i}].name`, `must not start with ${TEMPLATE_MOUNT_VOLUME_PREFIX}`);
      }
    });
  }
  if (Object.hasOwn(obj, "volumeMounts")) {
    if (!Array.isArray(obj.volumeMounts)) bad(`${at}.volumeMounts`, "must be an array");
    else obj.volumeMounts.forEach((m, i) => {
      if (!isObj(m)) bad(`${at}.volumeMounts[${i}]`, "must be an object");
      else if (reserved(m.name)) bad(`${at}.volumeMounts[${i}].name`, `must not start with ${TEMPLATE_MOUNT_VOLUME_PREFIX}`);
    });
  }
}

/** The mounts of a template that passed {@link templateMountIssues}; empty when it declares none. */
export function templateMountsOf(template: Record<string, unknown>): AppTemplateMount[] {
  return Array.isArray(template.host_mounts) ? (template.host_mounts as AppTemplateMount[]) : [];
}

/**
 * The template as Agent Sandbox reads it: `host_mounts` becomes a hostPath volume
 * and a read-only volume mount at the same path, in the template object
 * Agent Sandbox takes the container from (the nested `template` when it
 * carries the image, else the template itself). A template without `host_mounts`
 * is returned unchanged.
 */
export function renderTemplateMounts(template: Record<string, unknown>): Record<string, unknown> {
  if (!Object.hasOwn(template, "host_mounts")) return template;
  const { host_mounts: _mounts, ...rest } = template;
  const mounts = templateMountsOf(template);
  if (mounts.length === 0) return rest;
  const volumes = mounts.map((m, i) => ({ name: `${TEMPLATE_MOUNT_VOLUME_PREFIX}${i}`, hostPath: { path: m.hostPath, type: "Directory" } }));
  const volumeMounts = mounts.map((m, i) => ({ name: `${TEMPLATE_MOUNT_VOLUME_PREFIX}${i}`, mountPath: m.hostPath, readOnly: true }));
  // Added to the template's own (emptyDir) volumes and mounts, never in place of them.
  const merged = (target: Record<string, unknown>): Record<string, unknown> => ({
    ...target,
    volumes: [...(Array.isArray(target.volumes) ? target.volumes : []), ...volumes],
    volumeMounts: [...(Array.isArray(target.volumeMounts) ? target.volumeMounts : []), ...volumeMounts],
  });
  const nested = isObj(rest.template) && typeof rest.template.fromImage === "string" && rest.template.fromImage !== "";
  if (nested) return { ...rest, template: merged(rest.template as Record<string, unknown>) };
  return merged(rest);
}

/** A directory a workspace volume declares for sandboxes, as the sandbox platform reads it. */
interface DeclaredRoot {
  path: string;
  userDirs: boolean;
}

/** The roots the workspace's volumes (`volumes` of the workspace detail) declare for the Sandbox scope. */
export function sandboxHostPathRoots(volumes: unknown): DeclaredRoot[] {
  if (!Array.isArray(volumes)) return [];
  const roots: DeclaredRoot[] = [];
  for (const v of volumes) {
    if (!isObj(v) || v.type !== "hostpath" || v.requiresPrivilegedGrant === true) continue;
    if (Array.isArray(v.scopes) && v.scopes.length > 0 && !v.scopes.includes("Sandbox")) continue;
    const hostPath = typeof v.hostPath === "string" ? v.hostPath : "";
    const subPath = typeof v.subPath === "string" ? v.subPath : "";
    if (!hostPath.startsWith("/") || hostPath.split("/").includes("..")) continue;
    if (subPath.startsWith("/") || subPath.split("/").includes("..")) continue;
    const joined = cleanAbsolute(subPath ? `${hostPath}/${subPath}` : hostPath);
    roots.push({ path: joined, userDirs: v.enableUserDir === true });
  }
  return roots;
}

/** Lexical clean of an absolute path with no `..`: drops empty and `.` segments. */
function cleanAbsolute(p: string): string {
  const parts = p.split("/").filter((s) => s !== "" && s !== ".");
  return `/${parts.join("/")}`;
}

/** Whether a root declares `path`. A root with user directories declares only what is under it, outside `users`. */
function declares(root: DeclaredRoot, path: string): boolean {
  if (!pathWithin(root.path, path)) return false;
  if (!root.userDirs) return true;
  const below = root.path === "/" ? path.slice(1) : path.slice(root.path.length + 1);
  const first = below.split("/")[0] ?? "";
  return first !== "" && first !== "users";
}

/**
 * The mounts the workspace does not grant, as refusals (empty when every one
 * lies under a directory the workspace's volumes declare for sandboxes).
 * `volumes` is the `volumes` of the workspace detail.
 */
export function templateMountRefusals(
  templateName: string,
  mounts: readonly AppTemplateMount[],
  workspace: string,
  volumes: unknown,
): Array<{ field: string; reason: string }> {
  const roots = sandboxHostPathRoots(volumes);
  const out: Array<{ field: string; reason: string }> = [];
  mounts.forEach((m, i) => {
    if (!roots.some((r) => declares(r, m.hostPath))) {
      out.push({
        field: `sandbox_templates.${templateName}.host_mounts[${i}].hostPath`,
        reason: `${m.hostPath} is not under a directory workspace ${workspace} mounts for sandboxes`,
      });
    }
  });
  return out;
}
