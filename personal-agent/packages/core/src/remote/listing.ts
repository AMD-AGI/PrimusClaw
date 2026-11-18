// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** The machines, agents and sessions of a user as lists: `/agents` and `/agent sessions` as text, and the facts a card shows. */
import { pyRstrip } from "../text/py-text.js";
import type { Lang } from "../locales/lang.js";
import { remoteText } from "../locales/remote.js";
import { kindLabel } from "./agents.js";
import { type Conversation, needsYou } from "./conversations.js";
import { healthLines } from "./health.js";
import { lit, neutral } from "./inert.js";
import { MARKS } from "./marks.js";
import { SESSION_CARD_MAX, SESSIONS_SHOWN, WAITING_FOR_MAX } from "./limits.js";
import type { Connector, Session } from "./model.js";
import type { ConnectorSetupWords } from "./setup.js";
import { ago, agoEpoch, parseIsoSeconds, utcStamp } from "./time.js";

/** How an offline machine is shown: when it was last seen, in UTC (`last_seen_at`, else its last heartbeat). */
export function offlineSince(connector: Connector, lang: Lang = "en"): string {
  const at = parseIsoSeconds(connector.lastSeenAt || connector.heartbeatAt);
  const words = remoteText.in(lang);
  return at === null ? words.offline : words.offlineSince({ stamp: utcStamp(at) });
}

/** Sessions newest first (by `updated_at` as Claw wrote it), the order kept among equals. */
export function newestFirst(sessions: readonly Session[]): Session[] {
  const key = (s: Session): string => s.updatedAt;
  return [...sessions].sort((a, b) => (key(a) < key(b) ? 1 : key(a) > key(b) ? -1 : 0));
}

/** The active sessions (a closed one can be neither attached nor closed). */
export function activeSessions(sessions: readonly Session[]): Session[] {
  return sessions.filter((s) => s.status === "active" && s.sessionId !== "");
}

/** The sessions the agents card lists: the active ones, newest first, at most SESSION_CARD_MAX. */
export function shownSessions(sessions: readonly Session[]): Session[] {
  return newestFirst(activeSessions(sessions)).slice(0, SESSION_CARD_MAX);
}

/** The connectors by id. */
export function byConnector(connectors: readonly Connector[]): Map<string, Connector> {
  return new Map(connectors.map((c) => [c.connectorId, c]));
}

export interface SessionFacts {
  /** `icon name` of its agent. */
  readonly who: string;
  /** The machine's name. */
  readonly host: string;
  /** `attached, active, 2 h ago`. */
  readonly facts: string;
}

const SESSION_STATUS = { active: "statusActive", closed: "statusClosed" } as const;

/** Who, where and how one session of a listing is. A status Claw has no words for here is shown as it came, made inert. */
export function sessionFacts(
  session: Session,
  connectors: ReadonlyMap<string, Connector>,
  attached: string | null,
  now: number,
  lang: Lang = "en",
): SessionFacts {
  const words = remoteText.in(lang);
  const connector = connectors.get(session.connectorId);
  const agent = connector?.agents.find((a) => a.agentId === session.agentId);
  const { icon, label } = kindLabel(agent?.kind);
  const status = session.status;
  const facts = [
    Object.hasOwn(SESSION_STATUS, status)
      ? words[SESSION_STATUS[status as keyof typeof SESSION_STATUS]]
      : neutral(status, 40),
    ago(now, session.updatedAt, lang),
  ];
  if (session.sessionId === attached) facts.unshift(words.attached);
  return {
    who: `${icon} ${neutral(agent?.name, 40) || label}`,
    host: neutral(connector?.name, 40) || words.aMachine,
    facts: facts.filter((f) => f).join(words.factsSep),
  };
}

/** `/agents` as text. With no machine: the exact commands that connect one (markdown, for a rich message). */
export function agentsText(connectors: readonly Connector[], setup: ConnectorSetupWords, lang: Lang = "en"): string {
  if (connectors.length === 0) return setup.connectMarkdown(lang);
  const words = remoteText.in(lang);
  const blocks = [`**${words.yourAgents}**`];
  for (const connector of connectors) {
    const state = connector.online ? `\u{1f7e2} ${words.online}` : offlineSince(connector, lang);
    const lines = [`**${neutral(connector.name, 80)}** (${state})`];
    const note = setup.versionNote(connector, lang);
    if (note) lines.push(note);
    for (const agent of connector.agents) {
      const { icon, label } = kindLabel(agent.kind);
      lines.push(`- ${icon} ${neutral(agent.name, 60) || label} (\`${neutral(agent.agentId, 64)}\`)`);
    }
    if (lines.length === 1) lines.push(`- ${words.noAgentReported}`);
    lines.push(...healthLines(connector, lang).map((line) => `- ${line}`));
    blocks.push(lines.join("\n"));
  }
  blocks.push(words.startOneText + setup.offlineHint(lang));
  return blocks.join("\n\n");
}

/** The message, and the session ids in the order shown: the newest sessions first, numbered for `/agent attach N`. */
export function sessionsText(
  sessions: readonly Session[],
  connectors: readonly Connector[],
  attached: string | null,
  now: number,
  lang: Lang = "en",
): { text: string; listing: string[] } {
  const words = remoteText.in(lang);
  const shown = newestFirst(sessions).slice(0, SESSIONS_SHOWN);
  if (shown.length === 0) return { text: words.noSessionsText, listing: [] };
  const index = byConnector(connectors);
  const lines = [`**${words.yourSessions}**`];
  shown.forEach((session, i) => {
    const { who, host, facts } = sessionFacts(session, index, attached, now, lang);
    lines.push(words.sessionLineText({ n: i + 1, who, host, cwd: neutral(session.cwd, 80), facts }));
  });
  lines.push(words.goBackText);
  return { text: lines.join("\n\n"), listing: shown.map((s) => s.sessionId) };
}

/** One conversation of the machine's own: what its terminal is doing first (waiting for you, with what for; working), then its
 * title, folder and last activity. */
export function conversationLine(entry: Conversation, now: number, lang: Lang): string {
  const words = remoteText.in(lang);
  const when = agoEpoch(now, entry.updatedAt, lang);
  const text = `${lit(entry.title, 80) || words.untitled} · ${lit(entry.cwd, 60)}` + (when ? ` · ${when}` : "");
  if (needsYou(entry)) {
    const why = lit(entry.waitingFor, WAITING_FOR_MAX);
    return words.waitingForYouMark({ mark: MARKS.needsYou }) + (why ? words.waitingWhy({ why }) : "") + ` · ${text}`;
  }
  if (entry.activity === "working") return words.workingMark({ mark: MARKS.working }) + text;
  return text;
}

/** The console has a page per remote session, and the list of them, under this path. */
export const SESSION_PAGE_PATH = "/primus-claw/agent-sessions";

/** The console page of one session (or of the list, with no id); "" with no base (the worker was not told where it is). */
export function sessionPageUrl(base: string, sessionId = ""): string {
  if (!base) return "";
  const sid = /^[0-9a-fA-F-]{8,64}$/.test(sessionId) ? sessionId : "";
  return `${pyRstrip(base, "/")}${SESSION_PAGE_PATH}` + (sid ? `/${sid}` : "");
}
