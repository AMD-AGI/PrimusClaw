// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Where the bot's token may be sent: the Bot Connector host rule (Microsoft's hosts, a deployment may tighten or extend
 * the list), and the release gate's rule (one recording connector's origin and nothing else). Both are a
 * `ServiceUrlPolicy`, injected into the request builder and the outbox; nothing here is module state.
 *
 * The default allow-list: `smba.trafficmanager.net` as an exact host (trafficmanager.net is Azure Traffic Manager, where
 * any tenant can create `attacker.trafficmanager.net`), and suffixes only for domains in which only Microsoft can create
 * names.
 */
import { pyStrip, silentLogger, type Logger } from "@primusclaw/personal-agent";
import { UnaddressableError } from "./errors.js";

export const DEFAULT_HOSTS: readonly string[] = ["smba.trafficmanager.net"];
export const DEFAULT_SUFFIXES: readonly string[] = [
  ".botframework.com",
  ".botframework.us",
  ".teams.microsoft.com",
  ".teams.microsoft.us",
];

const LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
/** At least two labels: "net" or "com" alone is never an entry. */
const NAME = new RegExp(`^${LABEL}(?:\\.${LABEL})+$`);
/** What WHATWG URL parsing would silently drop or reinterpret, and Python's `urlsplit` would not: controls, space, backslash. */
function ambiguous(text: string): boolean {
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (code <= 0x20 || code === 0x7f || code === 0x5c) return true;
  }
  return false;
}

/** Decides whether the bot's token may go to a serviceUrl. Throws UnaddressableError when it may not. */
export interface ServiceUrlPolicy {
  check(serviceUrl: unknown): void;
}

function parse(serviceUrl: unknown): URL | undefined {
  if (typeof serviceUrl !== "string" || ambiguous(serviceUrl)) return undefined;
  try {
    return new URL(serviceUrl);
  } catch {
    return undefined; // not a URL at all: the caller refuses it
  }
}

/** Microsoft's Bot Connector hosts: an https address on an allowed host, port 443, without user info. */
export class ConnectorHosts implements ServiceUrlPolicy {
  /** `hosts`: exact host names. `suffixes`: ".example.com" allows any name under example.com, not example.com itself. */
  constructor(
    readonly hosts: readonly string[] = DEFAULT_HOSTS,
    readonly suffixes: readonly string[] = DEFAULT_SUFFIXES,
  ) {}

  /** The lower-cased host of `serviceUrl` when it is an https Bot Connector address on an allowed host; throws otherwise. */
  host(serviceUrl: unknown): string {
    if (typeof serviceUrl !== "string") throw new UnaddressableError("the serviceUrl is not a string");
    const url = parse(serviceUrl);
    const host = url?.hostname.toLowerCase() ?? "";
    const allowed =
      url !== undefined &&
      url.protocol === "https:" &&
      url.username === "" &&
      url.password === "" &&
      (url.port === "" || url.port === "443") &&
      (this.hosts.includes(host) || this.suffixes.some((suffix) => host.endsWith(suffix)));
    if (!allowed) throw new UnaddressableError(`the serviceUrl host ${host || "?"} is not a Bot Connector host`);
    return host;
  }

  check(serviceUrl: unknown): void {
    this.host(serviceUrl);
  }

  /**
   * The allow-list from two ";"- or ","-separated settings. An unset setting (undefined) keeps its default; a set one
   * replaces it, so an empty value allows nothing of that kind. Suffixes are written `.example.com` or `*.example.com`.
   * An entry that is not a host name of at least two labels is ignored with an error in the log, so a typo narrows the
   * list instead of widening it.
   */
  static fromSettings(
    hosts: string | undefined,
    suffixes: string | undefined,
    logger: Logger = silentLogger,
  ): ConnectorHosts {
    return new ConnectorHosts(
      hosts === undefined ? DEFAULT_HOSTS : entries(hosts, false, logger),
      suffixes === undefined ? DEFAULT_SUFFIXES : entries(suffixes, true, logger),
    );
  }
}

function entries(value: string, suffix: boolean, logger: Logger): string[] {
  const out: string[] = [];
  for (const raw of value.split(/[;,]/)) {
    const entry = asciiLower(pyStrip(raw));
    if (!entry) continue;
    const name = suffix ? removePrefix(removePrefix(entry, "*."), ".") : entry;
    if (!NAME.test(name)) {
      logger.error("ignoring Bot Connector entry: not a host name of at least two labels", {
        kind: suffix ? "suffix" : "host",
        entry,
      });
      continue;
    }
    out.push(suffix ? `.${name}` : name);
  }
  return out;
}

/** ASCII lower case only: a host name has no other letters (anything else then fails NAME and is dropped). */
function asciiLower(text: string): string {
  return text.replace(/[A-Z]/g, (ch) => ch.toLowerCase());
}

function removePrefix(text: string, prefix: string): string {
  return text.startsWith(prefix) ? text.slice(prefix.length) : text;
}

/** The production rule with the default lists. */
export const DEFAULT_CONNECTOR_HOSTS = new ConnectorHosts();

/** `scheme://host:port` of a URL without user info, or "" for anything else. */
function origin(url: unknown): string {
  const parsed = parse(url);
  if (parsed === undefined || parsed.username || parsed.password || !parsed.hostname) return "";
  return `${parsed.protocol}//${parsed.hostname}:${parsed.port}`;
}

/**
 * The release gate's rule (its test entry, never production): `connectorUrl` (http://127.0.0.1:<port>, the gate's
 * recording connector) is the only origin the bot's (made-up) token is sent to, and no Microsoft host is.
 */
export function onlyConnector(connectorUrl: string): ServiceUrlPolicy {
  const allowed = origin(connectorUrl);
  if (!allowed) throw new UnaddressableError("the release gate's connector is not a URL");
  return {
    check(serviceUrl: unknown): void {
      if (origin(serviceUrl) !== allowed) {
        throw new UnaddressableError("the serviceUrl is not the release gate's recording connector");
      }
    },
  };
}
