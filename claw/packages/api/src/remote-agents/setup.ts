// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What a person types to connect a machine, and which connector versions this server takes.
 *
 * Every client that tells someone how to connect a machine (a chat client's "no machine yet" card, the assistant) reads it
 * here, so the package name, the command and the two addresses are the ones this deployment has, never a guess: the API's
 * public URL (`CLAW_PUBLIC_URL`) and the identity service the connector signs in with (`CLAW_CONNECTOR_IDENTITY_URL`, else
 * `IDENTITY_ISSUER_URL`, whose `/oauth/device_authorization` the connector calls). Nothing here is secret.
 */
import { CONNECTOR_PACKAGE, CONNECTOR_VERSIONS, compareConnectorVersions, connectorVersionStatus, type ConnectorVersionStatus } from "@claw/protocol";

export interface ConnectorVersionPolicy { minimum: string; recommended: string }

type Env = Record<string, string | undefined>;

const isVersion = (v: string): boolean => compareConnectorVersions(v, v) === 0;

/**
 * The versions this server takes: `CLAW_REMOTE_AGENTS_MIN_CONNECTOR_VERSION` and `..._RECOMMENDED_CONNECTOR_VERSION` when they
 * are `x.y.z`, else the protocol's. A recommended version below the minimum is raised to it.
 */
export function connectorVersionPolicy(env: Env = process.env): ConnectorVersionPolicy {
  const pick = (key: string, fallback: string) => {
    const v = (env[key] ?? "").trim();
    return v && isVersion(v) ? v.replace(/^v/, "") : fallback;
  };
  const minimum = pick("CLAW_REMOTE_AGENTS_MIN_CONNECTOR_VERSION", CONNECTOR_VERSIONS.minimum);
  const recommended = pick("CLAW_REMOTE_AGENTS_RECOMMENDED_CONNECTOR_VERSION", CONNECTOR_VERSIONS.recommended);
  return { minimum, recommended: (compareConnectorVersions(recommended, minimum) ?? 0) < 0 ? minimum : recommended };
}

/**
 * Upgrades the connector and restarts it on the new version. `stop` first: a running connector (and the script supervisor) keeps
 * the old code until it is restarted, and `service install` starts it again under whichever supervisor the machine has. `stop`
 * exits 0 when nothing runs, so a failed install stops the chain and nothing restarts on the old version.
 */
export const UPGRADE_COMMAND = `npm install -g ${CONNECTOR_PACKAGE}@latest && claw-connector stop && claw-connector service install`;

export interface ConnectorVersionVerdict {
  version_status: ConnectorVersionStatus;
  /** What to run on that machine, when it is below the recommended version. */
  upgrade_command?: string;
  minimum_version?: string;
  recommended_version?: string;
}

/** What a client shows beside a connector's version. */
export function versionVerdict(version: string | null | undefined, policy: ConnectorVersionPolicy = connectorVersionPolicy()): ConnectorVersionVerdict {
  const status = connectorVersionStatus(version, policy);
  if (status !== "outdated" && status !== "unsupported") return { version_status: status };
  return { version_status: status, upgrade_command: UPGRADE_COMMAND, minimum_version: policy.minimum, recommended_version: policy.recommended };
}

/** The sentence a refusal of an unsupported connector carries. */
export function outdatedMessage(machine: string, version: string | null, policy: ConnectorVersionPolicy = connectorVersionPolicy()): string {
  return `the connector on ${machine} is version ${version ?? "unknown"}, older than ${policy.minimum}, the oldest this server works with: `
    + `nothing was sent. On that machine run: ${UPGRADE_COMMAND}`;
}

const trimUrl = (v: string | undefined): string | null => {
  const t = (v ?? "").trim().replace(/\/+$/, "");
  return /^https?:\/\/[^\s]+$/.test(t) ? t : null;
};

export interface ConnectorSetup {
  package: string;
  /** The API URL `login --server` takes, or null when this server does not know its public URL. */
  server: string | null;
  /** The identity service `login --identity-url` takes, or null when this server signs nobody in with one. */
  identity_url: string | null;
  minimum_version: string;
  recommended_version: string;
  node: string;
  /** One command per step, in order, for Linux, macOS and Windows under WSL. */
  steps: Array<{ step: string; command: string }>;
  upgrade_command: string;
  /** The same as a short text a person reads, in English and in Chinese. */
  text: { en: string; zh: string };
}

/** How to connect a machine to this server: the exact commands, with this deployment's addresses. */
export function connectorSetup(env: Env = process.env, policy: ConnectorVersionPolicy = connectorVersionPolicy(env)): ConnectorSetup {
  const server = trimUrl(env.CLAW_PUBLIC_URL);
  const identity = trimUrl(env.CLAW_CONNECTOR_IDENTITY_URL) ?? trimUrl(env.IDENTITY_ISSUER_URL);
  const login = server
    ? `claw-connector login --server ${server}${identity ? ` --identity-url ${identity}` : ""}`
    : "claw-connector login --server <this Claw's API URL> --identity-url <its identity service URL>";
  const steps = [
    { step: "install", command: `npm install -g ${CONNECTOR_PACKAGE}` },
    { step: "init", command: "claw-connector init" },
    { step: "sign_in", command: login },
    { step: "keep_running", command: "claw-connector service install" },
  ];
  const block = steps.map((s) => s.command).join("\n");
  const en = [
    "On the machine you want to use (Linux, macOS, or Windows under WSL; Node.js 22 or newer), run:",
    block,
    "init writes agents.toml and prints where: set roots there to the folders an agent may work in (the sample uses ~/work). "
      + "login prints a link and a code: open the link where you are signed in, confirm, and the machine appears under /agents.",
  ].join("\n");
  const zh = [
    "在要使用的机器上（Linux、macOS，或 Windows 的 WSL；需要 Node.js 22 及以上）依次运行：",
    block,
    "init 会生成 agents.toml 并打印它的位置：把其中的 roots 改成允许 agent 工作的目录（示例是 ~/work）。"
      + "login 会打印一个链接和一个验证码：在已登录的浏览器里打开链接并确认，这台机器就会出现在 /agents 里。",
  ].join("\n");
  return {
    package: CONNECTOR_PACKAGE, server, identity_url: identity, minimum_version: policy.minimum, recommended_version: policy.recommended,
    node: ">=22", steps, upgrade_command: UPGRADE_COMMAND, text: { en, zh },
  };
}
