// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Fixtures that reach every branch of the remote-agent cards and lines that has words (test_remote_cards_zh), and every card and
 * line rendered from them in one language.
 */
import { type Lang, remoteView } from "@primusclaw/personal-agent";

import { SETUP, agent, connector, session } from "../../../../test-support/card-catalog/remote.js";
import {
  agentsCard,
  decidedCard,
  disconnectCard,
  machineChoiceCard,
  modeCard,
  permissionCard,
  remoteAskCard,
  sessionsCard,
  statusCard,
  takeoverCard,
} from "../../src/views/remote/index.js";
import { decisionAction } from "../../src/views/remote/elements.js";

export const NOW = 1_794_000_000.0; // 2026-11-07
export const TZ = "Asia/Shanghai";
export const PAGE = "https://claw.example.com/primus-claw/agent-sessions";
const BASE = 1_793_990_000;

export function entries(): Record<string, unknown>[] {
  return [
    { ref: "r-idle", title: "修复登录", cwd: "/srv/proj", updated_at: BASE, state: "idle" },
    {
      ref: "r-typed",
      title: "重构",
      cwd: "/srv/proj",
      updated_at: BASE - 10,
      state: "live",
      input: "terminal",
      activity: "waiting",
      waiting_for: "确认",
    },
    { ref: "r-watch", title: "", cwd: "/srv/proj", updated_at: BASE - 20, state: "live", activity: "working" },
    { ref: "r-unknown", title: "旧的", cwd: "/srv/proj", updated_at: BASE - 30, state: "unknown" },
    { ref: "r-att", title: "接着", cwd: "/srv/proj", updated_at: BASE - 40, state: "attached" },
    { ref: "r-old", title: "很旧", cwd: "/srv/proj", updated_at: BASE - 50, state: "idle" },
  ];
}

export function health(): Record<string, unknown> {
  return {
    checked_at: "2026-11-07T00:00:00Z",
    problems: [
      { code: "agent_not_signed_in", severity: "fail", scope: "agent", fix: "codex login" },
      { code: "root_missing", severity: "fail", scope: "agent", fix: "在 agents.toml 里换一个目录" },
      { code: "no_service", severity: "warn", scope: "machine" },
      { code: "linger_off", severity: "warn", scope: "machine", fix: "loginctl enable-linger" },
      { code: "node_too_old", severity: "warn", scope: "machine" },
    ],
  };
}

export function connectors() {
  const caps = (extra: Record<string, unknown>) => ({
    roots: ["/srv/proj"],
    unattended_allowed: true,
    unattended: true,
    ...extra,
  });
  const full = agent({
    agentId: "cx",
    kind: "codex",
    name: "cx-main",
    capabilities: caps({
      watch_live: true,
      terminal_input: true,
      takeover: true,
      resumable: entries(),
      health: health(),
    }),
  });
  const one = entries().slice(2, 3);
  return [
    connector({
      connectorId: "c-on",
      name: "devbox-7",
      online: true,
      version: "0.1.9",
      versionStatus: "current",
      agents: [
        full,
        agent({ agentId: "ag-l", kind: "claude", name: "cl-main", capabilities: { watch_live: true, resumable: one } }),
        agent({ agentId: "ag-k", kind: "claude", name: "tk-main", capabilities: { takeover: true, resumable: one } }),
        agent({ agentId: "ag-n", kind: "claude", name: "nv-main", capabilities: { resumable: one } }),
        agent({ agentId: "ag-t", kind: "attach", name: "at-main" }),
        agent({ agentId: "ag-b", kind: "cursor" }),
        ...[0, 1, 2].map((n) => agent({ agentId: `x${String(n)}`, kind: "codex", name: `x${String(n)}-main` })),
      ],
    }),
    connector({
      connectorId: "c-off",
      name: "lab-3",
      lastSeenAt: "2026-11-06T08:00:00Z",
      version: "0.1.9",
      versionStatus: "current",
      agents: [
        agent({ agentId: "ag-f", kind: "codex", name: "of-main", capabilities: { unattended: true } }),
        agent({ agentId: "ag-2", kind: "codex", name: "o2-main" }),
      ],
    }),
    connector({ connectorId: "c-gone", name: "box-9", version: "0.1.2", versionStatus: "unsupported" }),
  ];
}

export function sessions() {
  const rows = Array.from({ length: 7 }, (_, n) =>
    session({
      sessionId: `5e55${String(n).padStart(4, "0")}-0000-4000-8000-000000000000`,
      connectorId: "c-on",
      agentId: "cx",
      cwd: `/srv/proj/m${String(n)}`,
      status: "active",
      updatedAt: `2026-11-0${String(1 + n)}T06:00:00Z`,
    }),
  );
  rows.push(
    session({
      sessionId: "5e55aaaa-0000-4000-8000-000000000000",
      connectorId: "c-on",
      agentId: "zz",
      cwd: "/srv/proj/q",
      status: "pending",
      updatedAt: "2026-11-07T04:00:00Z",
    }),
  );
  rows.push(
    session({
      sessionId: "5e55bbbb-0000-4000-8000-000000000000",
      connectorId: "c-none",
      agentId: "cx",
      cwd: "/srv/proj/r",
      status: "closed",
      updatedAt: "2026-11-07T05:00:00Z",
    }),
  );
  return rows;
}

export const ATTACHED = "5e550006-0000-4000-8000-000000000000";
export const WAITING = new Set(["5e550002-0000-4000-8000-000000000000"]);
export const OPTIONS = [
  { optionId: "o1", kind: "allow_once", name: "" },
  { optionId: "o2", kind: "allow_always", name: "好的" },
  { optionId: "o3", kind: "reject_once", name: "" },
  { optionId: "o4", kind: "reject_always", name: "" },
];
export const REQUEST = { actionId: "act-1", tool: "", kind: "edit", input: { path: "/srv/proj/a" } };
export const ASK = { action_id: "act-2", tool: "" };

const STATUS_PHASES: remoteView.StatusPhase[] = [
  "idle",
  "working",
  "starting",
  "offline",
  "detached",
  "ended",
  "watching",
];

type Rendered = Record<string, unknown>;

function liveView(lang: Lang): string {
  const view = new remoteView.RemoteLiveView("cx-main", lang);
  view.apply(remoteView.remoteStep({ tool: { id: "t1", title: "", status: "in_progress" } }));
  view.apply(remoteView.remoteStep({ tool: { id: "t1", title: "", status: "failed" } }));
  view.apply(remoteView.remoteStep({ tool: { id: "t2", title: "", status: "in_progress" } }));
  return [view.render(), ...view.statusLines()].join("\n");
}

function lines(lang: Lang): string {
  const words = remoteView.remoteText.in(lang);
  const ago = (seconds: number): string => {
    const at = new Date((NOW - seconds) * 1000).toISOString();
    return remoteView.sessionsText([session({ sessionId: "x", status: "active", updatedAt: at })], [], null, NOW, lang)
      .text;
  };
  return [
    remoteView.switchedLine("cx-main", "devbox-7", lang),
    remoteView.backLine(lang),
    remoteView.terminalClosedLine(lang),
    remoteView.readOnlyRefused(lang),
    remoteView.readOnlyRefused(lang, true),
    remoteView.clawyLine(lang, "Clawy"),
    remoteView.typedLine("修复一下", lang),
    ...remoteView.unsolicitedParts("cx-main", "做完了。", lang),
    ...remoteView.unsolicitedParts("cx-main", "做完了。", lang, true),
    ...remoteView.answerParts(Array.from({ length: 12 }, () => "做".repeat(1500)).join("\n\n"), lang),
    ...remoteView.answerParts("", lang),
    remoteView.recoveredLine("cx-main", "devbox-7", lang, true, true),
    remoteView.recoveredLine("cx-main", "devbox-7", lang, true, false),
    remoteView.recoveredLine("cx-main", "devbox-7", lang, false, false),
    ...["terminal_working", "terminal_waiting", "terminal_typing", "terminal_scrolled", "other"].map((r) =>
      remoteView.queuedLine(r, lang),
    ),
    words.unattendedNote,
    ...Object.values(remoteView.remoteOffText.in(lang)),
    remoteView.noAskLine("bypassPermissions", lang) ?? "",
    remoteView.pairText("cmd", 10, lang),
    ...[10, 600, 7200, 200_000].map(ago),
  ].join("\n");
}

function statuses(lang: Lang): Record<string, Rendered> {
  const out: Record<string, Rendered> = {};
  for (const phase of STATUS_PHASES) {
    for (const named of ["", "修复登录"]) {
      out[`status ${phase} ${named || "unnamed"}`] = statusCard(
        remoteView.statusView({
          label: "cx-main",
          host: "devbox-7",
          cwd: "/srv/proj",
          mode: "m-b",
          sessionId: ATTACHED,
          phase,
          at: NOW,
          lang,
          hasModes: true,
          unattended: true,
          lead: "说明",
          conversation: named,
          page: PAGE,
          takeover: { connector_id: "c-on", agent_id: "cx", resume: "r-watch" },
          bot: "Clawy",
        }),
      );
    }
  }
  out["status, typed into a terminal"] = statusCard(
    remoteView.statusView({
      label: "cx-main",
      host: "devbox-7",
      cwd: "/srv/proj",
      mode: "m-b",
      sessionId: ATTACHED,
      phase: "idle",
      at: NOW,
      lang,
      terminal: true,
      bot: "Clawy",
    }),
  );
  return out;
}

function agentsCards(lang: Lang): Record<string, Rendered> {
  const cs = connectors();
  const ss = sessions();
  const view = (input: Omit<remoteView.AgentsInput, "setup">) =>
    agentsCard(remoteView.agentsView({ ...input, setup: SETUP }));
  const first = cs[0] ?? connector({ connectorId: "x" });
  const many = connector({
    connectorId: "c-many",
    name: "devbox-9",
    online: true,
    agents: [
      agent({
        agentId: "at",
        kind: "attach",
        name: "at-main",
        capabilities: {
          resumable: Array.from({ length: 6 }, (_, n) => ({
            ref: `r${String(n)}`,
            title: `t${String(n)}`,
            cwd: "/srv/proj",
            updated_at: NOW - n,
            state: "idle",
          })),
        },
      }),
    ],
  });
  const shown = remoteView.shownSessions(ss)[0]?.sessionId ?? "";
  return {
    "agents card": view({ connectors: cs, sessions: ss, attached: ATTACHED, now: NOW, lang }),
    "agents card, sessions only": view({
      connectors: cs,
      sessions: ss,
      attached: ATTACHED,
      now: NOW,
      machines: false,
      lang,
    }),
    "agents card, no session": view({ connectors: cs, sessions: [], attached: null, now: NOW, machines: false, lang }),
    "agents card, one more agent": view({
      connectors: [{ ...first, agents: first.agents.slice(0, remoteView.AGENT_BLOCKS_MAX + 1) }],
      sessions: [],
      attached: null,
      now: NOW,
      lang,
    }),
    "agents card, named and connected": view({
      connectors: cs,
      sessions: ss,
      attached: ATTACHED,
      now: NOW,
      lang,
      names: new Map([[shown, { title: "修复测试", ref: "r-typed" }]]),
    }),
    "agents card, many earlier": view({ connectors: [many], sessions: [], attached: null, now: NOW, lang }),
  };
}

function smallCards(lang: Lang): Record<string, Rendered> {
  const cs = connectors();
  const first = cs[0] ?? connector({ connectorId: "x" });
  const cx = first.agents[0] ?? agent({ agentId: "x" });
  const conv = remoteView.resumableOf(agent({ agentId: "a", capabilities: { resumable: entries() } }));
  const [, typed, untitled] = conv;
  if (!typed || !untitled) throw new Error("the fixtures lost a conversation");
  const options = remoteView.parseOptions(OPTIONS);
  const words = remoteView.remoteText.in(lang);
  const out: Record<string, Rendered> = {
    "takeover confirm": takeoverCard(remoteView.takeoverView(first, cx, typed, lang)),
    "takeover confirm, untitled": takeoverCard(remoteView.takeoverView(first, cx, untitled, lang)),
    "mode card": modeCard(remoteView.modeView(ATTACHED, "m-b", ["m-a", "m-b"], new Set(["m-b"]), lang)),
    "machine choice": machineChoiceCard(
      remoteView.machineChoiceView(first, [cx, cx, cx, cx, cx], "tok", "/srv/proj", lang),
    ),
    "permission card": permissionCard(
      remoteView.permissionView(
        REQUEST,
        options,
        ATTACHED,
        words.agentOnHost({ agent: "cx-main", host: "devbox-7" }),
        NOW,
        TZ,
        lang,
      ),
    ),
    "permission card, no kind": permissionCard(
      remoteView.permissionView({ ...REQUEST, kind: "" }, options.slice(0, 1), ATTACHED, words.theAgent, NOW, TZ, lang),
    ),
    "remote ask card": remoteAskCard(
      remoteView.remoteAskView(
        {
          ask: ASK,
          options,
          sessionId: ATTACHED,
          machine: "devbox-7",
          agent: "cx-main",
          about: "#3 修复",
          expiresAt: NOW,
          zone: TZ,
        },
        lang,
      ),
    ),
    "disconnect card": disconnectCard(remoteView.disconnectView("devbox-7", "c-on", SETUP, lang)),
    "disconnect card, paired": disconnectCard(remoteView.disconnectView("devbox-7", "c-on", SETUP, lang, true)),
    "option buttons, unnamed": {
      actions: remoteView
        .optionButtons(
          options.map((o) => ({ ...o, name: "" })),
          ATTACHED,
          "act-1",
          lang,
        )
        .map(decisionAction),
    },
  };
  for (const option of options)
    out[`decided ${option.kind}`] = decidedCard(remoteView.decidedView(option, NOW, TZ, lang));
  return out;
}

/** Every remote-agent card and line, in `lang`, from the fixtures above. */
export function renders(lang: Lang): Record<string, unknown> {
  const cs = connectors();
  const ss = sessions();
  const words = remoteView.remoteText.in(lang);
  return {
    ...agentsCards(lang),
    "agents text": remoteView.agentsText(cs, SETUP, lang),
    "sessions text": remoteView.sessionsText(ss, cs, ATTACHED, NOW, lang).text,
    "sessions text, none": remoteView.sessionsText([], cs, null, NOW, lang).text,
    "sessions card": sessionsCard(
      remoteView.sessionsView({
        connectors: cs,
        sessions: ss,
        attached: ATTACHED,
        now: NOW,
        lang,
        waiting: WAITING,
        page: PAGE,
        setup: SETUP,
      }),
    ),
    "sessions card, no machine": sessionsCard(
      remoteView.sessionsView({ connectors: [], sessions: [], attached: null, now: NOW, lang, setup: SETUP }),
    ),
    ...smallCards(lang),
    disconnected: remoteView.disconnectedText("devbox-7", "claw-connector login", lang),
    "disconnected, paired": remoteView.disconnectedText("devbox-7", "", lang, true),
    "live view": liveView(lang),
    lines: lines(lang),
    "left a running turn": [words.leftRunning, words.leftRunningTerminal, words.leftQueued, words.leftWithdrawn].join(
      "\n",
    ),
    "approval needed": words.approvalNeeded({ tool: "写文件" }),
    "no session yet": words.noSessionYet({ ref: "devbox-7/cx" }),
    "queued other": remoteView.remoteQueuedText.in(lang).other,
    ...statuses(lang),
  };
}

/** Every string the fixtures supplied (not ours to translate). */
export function fixtureStrings(): Set<string> {
  const found = new Set<string>();
  const walk = (value: unknown): void => {
    if (typeof value === "string") found.add(value);
    else if (Array.isArray(value)) value.forEach(walk);
    else if (value instanceof Set) [...(value as Set<unknown>)].forEach(walk);
    else if (value && typeof value === "object") Object.values(value).forEach(walk);
  };
  walk([connectors(), sessions(), OPTIONS, REQUEST, ASK, entries(), health(), PAGE, "m-a", "m-b", "#3 修复"]);
  for (const kind of ["claude", "codex", "cursor"]) found.add(remoteView.kindLabel(kind).label);
  found.add("Agent");
  return found;
}
