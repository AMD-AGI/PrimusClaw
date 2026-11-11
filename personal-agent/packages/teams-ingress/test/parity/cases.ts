// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The parity cases: the input surface of every Python test of the Function the ingress replaces, and the edges around
 * it (token shapes, claim types, serviceUrl forms, body encodings, activity shapes, Service Bus settings and failures,
 * the outbound envelope, the Connector's answers and the identity endpoint's).
 *
 * `{base}` in a setting is the local server. Header values are given as the Functions host hands them to the code,
 * without leading or trailing spaces (the host trims them, as any HTTP server does).
 */
import { part1, part2, part3, part4, part5, part6 } from "./cases-a.js";
import { part7, part8, part9, part10, part11, part12 } from "./cases-b.js";
import { type Case } from "./driver.js";
import { Kit, type Keys } from "./kit.js";

export type { Keys } from "./kit.js";

const RULE =
  "the Bot Connector host rule is the worker's (@primusclaw/personal-agent-teams/connector-hosts), which reads a " +
  "serviceUrl as fetch() does (WHATWG URL), not as Python's urlsplit";

/**
 * The cases whose answer differs from the Python Function's, the fields that differ, and why. Every other case answers
 * exactly as it did.
 */
export const EXPECTED: Readonly<Record<string, { fields: readonly string[]; why: string }>> = {
  'token: serviceUrl "https://[v1.x.botframework.com]/"': {
    fields: ["built", "logs", "sent", "status"],
    why: `${RULE}: a bracketed name is no host, so the activity is refused (Python took it)`,
  },
  'token: serviceUrl "https://smba.trafficmanager.net\\t/teams/"': {
    fields: ["built", "logs", "sent", "status"],
    why: `${RULE}: a control character anywhere is refused (Python dropped the tab)`,
  },
  'token: serviceUrl " https://smba.trafficmanager.net/teams/"': {
    fields: ["built", "logs", "sent", "status"],
    why: `${RULE}: a leading space is refused (Python stripped it)`,
  },
  'token: serviceUrl "https://smba.trafficmanager.net/teams/ "': {
    fields: ["built", "logs", "sent", "status"],
    why: `${RULE}: a trailing space is refused (Python kept it in the path)`,
  },
  [`token: serviceUrl "https://${String.fromCodePoint(0xff53, 0xff4d, 0xff42, 0xff41)}.trafficmanager.net/"`]: {
    fields: ["built", "logs", "sent", "status"],
    why: `${RULE}: full-width letters are the host fetch() reaches, smba.trafficmanager.net (Python refused the text)`,
  },
  'token: serviceUrl "https:smba.trafficmanager.net/teams/"': {
    fields: ["built", "logs", "sent", "status"],
    why: `${RULE}: an https URL without "//" names the host fetch() reaches (Python saw none)`,
  },
  "token: malformed allow-list entries": {
    fields: ["logs"],
    why: "the worker's rule logs an ignored entry as one line with its fields as JSON",
  },
  "outbound: outbound serviceUrl https://[v1.x.botframework.com]/": {
    fields: ["logs", "raised", "server"],
    why: `${RULE}: refused before a token is asked for (Python asked for one, then could not connect)`,
  },
};

/** Every parity case, in order. */
export function buildCases(keys: Keys): Case[] {
  const k = new Kit(keys);
  for (const part of [part1, part2, part3, part4, part5, part6, part7, part8, part9, part10, part11, part12]) part(k);
  return k.cases;
}
