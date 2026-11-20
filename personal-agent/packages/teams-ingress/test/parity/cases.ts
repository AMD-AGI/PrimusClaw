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

// A failed send (the fake's error is a connection error) throws the whole client away, not only its sender, and a send
// has three attempts, not two: a client whose connection is stuck closing hangs every sender opened on it.
const SEND = "a failed send is retried on a new Service Bus client, up to three attempts";

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
  "send fails once, retried": {
    fields: ["built", "logs"],
    why: `${SEND}; the one retry is on a new client, so a second one is built, and the warning names it`,
  },
  "send fails twice: 500": {
    fields: ["built", "logs", "sent", "status"],
    why: `${SEND}; the third attempt, on a third client, gets the message through: a 200 where Python gave up`,
  },
  "card action, send fails twice: unavailable card": {
    fields: ["body", "built", "logs", "sent"],
    why: `${SEND}; the third attempt gets the action through: the placeholder card where Python had the unavailable one`,
  },
  "card action, nothing set: unavailable card": {
    fields: ["body", "json", "status"],
    why:
      "a card action that cannot be queued is an empty 500, which the Bot Framework retries, as any other activity is: " +
      "Python's unavailable card in a 200 ended the invoke, so the click never reached the worker",
  },
  "feedback, send fails twice: 500": {
    fields: ["built", "logs", "sent", "status"],
    why: `${SEND}; the third attempt gets the feedback through: a 200 where Python gave up`,
  },
  "outbound: ack, the bus fails": {
    fields: ["built", "logs", "sent"],
    why: `${SEND}; the third attempt gets the delivery ack through where Python dropped it`,
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
