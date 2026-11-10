// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * How to connect a machine to PrimusClaw and how to upgrade its connector, as the exact commands a person copies.
 *
 * Claw says what to run (`GET /v1/remote-agents/setup`): the npm package, `claw-connector init`, `claw-connector login` with Claw's
 * public API URL and the identity service it signs in with, and `claw-connector service install`. When that route cannot be read
 * (an older Claw), the same commands are made from the address this worker reaches Claw at, and its host's identity service.
 *
 * Nothing here talks to Claw or to a chat.
 */
import type { ConnectSteps, ConnectorSetupWords } from "../setup.js";
import type { Connector } from "../model.js";
import { recordOf, textOf } from "../fields.js";
import { connectorSetupText } from "../../locales/connector-setup.js";
import type { Lang } from "../../locales/lang.js";

export const CONNECTOR_PACKAGE_NAME = "@primusclaw/connector";
/**
 * Upgrades the connector and restarts it on the new version: a running connector keeps the old code until it is restarted, and
 * `service install` starts it again under whichever supervisor the machine has. The same as Claw's `upgrade_command`.
 */
export const UPGRADE_COMMAND = `npm install -g ${CONNECTOR_PACKAGE_NAME}@latest && claw-connector stop && claw-connector service install`;

// An address put into a command a person pastes into a shell: a plain host (and port) and plain path segments, nothing a shell
// reads as anything but a word (no `;`, `$`, quotes, `&`, `|`, spaces or backticks).
const SAFE_URL = /^https?:\/\/[A-Za-z0-9.-]{1,253}(?::\d{1,5})?(?:\/[A-Za-z0-9._~-]{1,100}){0,8}$/;
// A pairing code as Claw issues it (`POST /v1/remote-agents/pairings`): 12 characters of Crockford base32 in three groups.
const PAIR_CODE = /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/;

/** `value` as an address fit for a shell command, without a trailing slash; null when it is anything else. */
export function safeUrl(value: unknown): string | null {
  const text = textOf(value).trim().replace(/\/+$/u, "");
  return SAFE_URL.test(text) ? text : null;
}

/** The scheme and host (with port) of a safe address. */
function originOf(url: string): string {
  const match = /^(https?):\/\/([^/]+)/u.exec(url);
  return match ? `${match[1] ?? ""}://${match[2] ?? ""}` : "";
}

/** The origin compared without case: an address on the same host over plain http is another place. */
function sameHost(a: string, b: string): boolean {
  return originOf(a).toLowerCase() === originOf(b).toLowerCase();
}

/** The commands that connect a machine: the server it signs in to and the identity service it signs in with. */
export class Setup {
  constructor(
    readonly server: string,
    readonly identityUrl: string | null,
  ) {}

  login(): string {
    return (
      "claw-connector login" +
      (this.server ? ` --server ${this.server}` : "") +
      (this.identityUrl ? ` --identity-url ${this.identityUrl}` : "")
    );
  }

  commands(): string[] {
    return [
      `npm install -g ${CONNECTOR_PACKAGE_NAME}`,
      "claw-connector init",
      this.login(),
      "claw-connector service install",
    ];
  }
}

/**
 * The commands Claw gave (`data`, the route's answer), else the ones made from `baseUrl` (the address this worker reaches Claw at)
 * and its host's identity service. What Claw gave is taken only when its server is on that host over the same scheme, and its
 * identity service too (a different one is replaced by that host's): a person is never sent to sign in somewhere else, nor over
 * plain http.
 */
export function setupFrom(data: unknown, baseUrl: string): Setup {
  const base = safeUrl(baseUrl);
  if (!base) return new Setup("", null); // (not configured: nothing to check Claw's answer against, and no address to give)
  const origin = originOf(base);
  const given = recordOf(data);
  const server = given ? safeUrl(given.server) : null;
  if (given && server && sameHost(server, base)) {
    const identity = safeUrl(given.identity_url);
    return new Setup(server, identity && sameHost(identity, base) ? identity : origin);
  }
  return new Setup(base, origin);
}

/**
 * The one line that pairs a machine, from Claw's answer: rebuilt from its code (only of the shape Claw issues) and its server (only
 * on the host this worker reaches Claw at, as `setupFrom` takes one), so nothing else reaches a shell. Null when either is not so.
 */
export function pairCommand(data: unknown, baseUrl: string): string | null {
  const given = recordOf(data);
  if (!given) return null;
  const code = textOf(given.code).trim();
  const server = safeUrl(given.server);
  const base = safeUrl(baseUrl) ?? "";
  if (!PAIR_CODE.test(code) || !server || !sameHost(server, base)) return null;
  // --no-update-notifier: npm's "New major version of npm available" notice read as an error in the middle of the output.
  return `npm install -g --no-update-notifier ${CONNECTOR_PACKAGE_NAME}@latest && claw-connector pair ${code} --server ${server}`;
}

/** The connect steps, in the order they are shown: what a message or a card is made from. */
export function connectSteps(setup: Setup, lang: Lang, lead = ""): ConnectSteps {
  const text = connectorSetupText.in(lang);
  return {
    lead: (lead || text.noMachine) + text.sep + text.runOn,
    commands: setup.commands(),
    after: text.after,
    notes: text.notes,
  };
}

/** The connect steps as markdown for a rich message: the commands in one code block a person copies whole. */
export function connectMarkdown(setup: Setup, lang: Lang, lead = ""): string {
  const steps = connectSteps(setup, lang, lead);
  const block = "```\n" + steps.commands.join("\n") + "\n```";
  return [steps.lead, block, steps.after, steps.notes].join("\n\n");
}

export function upgradeText(lang: Lang, command: string = UPGRADE_COMMAND): string {
  return connectorSetupText.in(lang).upgrade({ command });
}

/**
 * One line under a machine whose connector Claw says is old (`version_status`), with the command that upgrades it; else null. The
 * command is this module's, never text from the connector list.
 */
export function versionNote(connector: Pick<Connector, "version" | "versionStatus">, lang: Lang = "en"): string | null {
  const status = connector.versionStatus;
  if (status !== "outdated" && status !== "unsupported") return null;
  const version = connector.version.replace(/[^0-9A-Za-z.+-]/gu, "").slice(0, 40) || "?"; // (the connector named it)
  const text = connectorSetupText.in(lang);
  const head = status === "unsupported" ? text.versionUnsupported({ version }) : text.versionOutdated({ version });
  return head + text.sep + upgradeText(lang);
}

/** What brings an offline machine back. */
export function offlineHint(lang: Lang = "en"): string {
  return connectorSetupText.in(lang).offlineHint;
}

/** What the remote-agent views say about connecting a machine, from the commands of the address this worker reaches Claw at. */
export class ConnectorSetup implements ConnectorSetupWords {
  constructor(readonly setup: Setup) {}

  connectMarkdown(lang: Lang, lead = ""): string {
    return connectMarkdown(this.setup, lang, lead);
  }

  connectSteps(lang: Lang, lead = ""): ConnectSteps {
    return connectSteps(this.setup, lang, lead);
  }

  versionNote(connector: Connector, lang: Lang): string | null {
    return versionNote(connector, lang);
  }

  offlineHint(lang: Lang): string {
    return offlineHint(lang);
  }

  login(): string {
    return this.setup.login();
  }
}
