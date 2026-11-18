// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** The remote-agent cards (Python `card_catalog`, the `remote_*` entries; W6b). */
import { remoteDomain, remoteView } from "../../packages/core/src/index.js";
import { ConnectorSetup, setupFrom } from "../../packages/core/src/remote/connector/setup.js";
import type { Agent, Connector, Session } from "../../packages/core/src/remote/model.js";
import { WindowView } from "../../packages/core/src/remote/window/view.js";
import {
  agentsCard,
  permissionCard,
  sessionsCard,
  statusCard,
  windowCard,
} from "../../packages/teams/src/views/remote/index.js";
import { disconnectCard } from "../../packages/teams/src/views/remote/small-cards.js";
import { type CatalogEntry, NOW, TZ, entriesWithEmoji } from "./catalog.js";

/** What the worker's tests configure: the address it reaches Claw at. */
export const SETUP = new ConnectorSetup(setupFrom(null, "https://claw.example.com/claw-api"));

export function agent(fields: Partial<Agent> & Pick<Agent, "agentId">): Agent {
  return { kind: "", name: "", capabilities: {}, ...fields };
}

export function connector(fields: Partial<Connector> & Pick<Connector, "connectorId">): Connector {
  return {
    name: "",
    online: false,
    version: "",
    versionStatus: "",
    lastSeenAt: "",
    heartbeatAt: "",
    paired: false,
    agents: [],
    ...fields,
  };
}

export function session(fields: Partial<Session> & Pick<Session, "sessionId">): Session {
  return { connectorId: "", agentId: "", cwd: "", status: "", readOnly: null, updatedAt: "", ...fields };
}

export const CONNECTORS: readonly Connector[] = [
  connector({
    connectorId: "c1",
    name: "robin-dev",
    online: true,
    agents: [agent({ agentId: "a1", kind: "claude", name: "Claude Code" })],
  }),
  connector({ connectorId: "c2", name: "laptop", agents: [agent({ agentId: "a2", kind: "codex", name: "Codex" })] }),
];

export const SESSIONS: readonly Session[] = [
  session({
    sessionId: "rs-1",
    connectorId: "c1",
    agentId: "a1",
    cwd: "/root/ws/active",
    status: "active",
    updatedAt: "2026-11-06T07:55:00Z",
  }),
];

const CLAUDE_SESSIONS = (capabilities: Record<string, unknown>): Connector => ({
  ...(CONNECTORS[0] as Connector),
  agents: [agent({ agentId: "a1-sessions", kind: "attach", name: "Claude Code (existing sessions)", capabilities })],
});

const sessions = (
  connectors: readonly Connector[],
  list: readonly Session[],
  attached: string | null,
  waiting: ReadonlySet<string> = new Set(),
) =>
  sessionsCard(
    remoteView.sessionsView({ connectors, sessions: list, attached, now: NOW, lang: "zh", setup: SETUP, waiting }),
  );

/** A window's view of session rs-1 as the Python tests build it (`WindowView(session_id="rs-1", ...)`). */
export function windowState(
  fields: Partial<Pick<WindowView, "text" | "step" | "sent" | "queued" | "note">> = {},
): WindowView {
  const view = new WindowView();
  view.reset("rs-1");
  view.setText(fields.text ?? "");
  view.step = fields.step ?? "";
  view.sent = fields.sent ?? "";
  view.queued = fields.queued ?? "";
  view.note = fields.note ?? "";
  return view;
}

export const REMOTE: readonly CatalogEntry[] = entriesWithEmoji(
  remoteDomain.KIND_ICONS,
  [
    "remote_permission",
    () =>
      permissionCard(
        remoteView.permissionView(
          { actionId: "ac-1", tool: "Bash", kind: "execute", input: { command: "npm test" } },
          [
            { optionId: "o1", kind: "allow_once", name: "Allow" },
            { optionId: "o2", kind: "allow_always", name: "Always" },
            { optionId: "o3", kind: "reject_once", name: "Reject" },
          ],
          "rs-1",
          "Claude Code on robin-dev",
          NOW + 600,
          TZ,
        ),
      ),
  ],
  [
    "remote_agents",
    () =>
      agentsCard(
        remoteView.agentsView({ connectors: CONNECTORS, sessions: SESSIONS, attached: null, now: NOW, setup: SETUP }),
      ),
  ],
  [
    "remote_status",
    () =>
      statusCard(
        remoteView.statusView({
          label: "Claude Code",
          host: "robin-dev",
          cwd: "/root/ws/active",
          mode: "default",
          sessionId: "rs-1",
          phase: "working",
          at: NOW,
          lang: "zh",
          hasModes: true,
          bot: "PrimusClaw Assistant",
        }),
      ),
  ],
  ["remote_sessions", () => sessions(CONNECTORS, SESSIONS, "rs-1")],
  ["remote_disconnect", () => disconnectCard(remoteView.disconnectView("robin-dev", "c1", SETUP))],
  [
    "remote_sessions_waiting",
    () =>
      sessions(
        [
          {
            ...(CONNECTORS[0] as Connector),
            agents: [
              ...(CONNECTORS[0] as Connector).agents,
              agent({
                agentId: "a1-sessions",
                kind: "attach",
                name: "Claude Code (existing sessions)",
                capabilities: {
                  resumable: [
                    {
                      ref: "r-1",
                      title: "修 flaky 测试",
                      cwd: "/root/ws/active",
                      updated_at: NOW - 120,
                      state: "live",
                      activity: "waiting",
                      waiting_for: "permission prompt",
                    },
                    {
                      ref: "r-2",
                      title: "重构连接器",
                      cwd: "/root/ws/conn",
                      updated_at: NOW - 30,
                      state: "live",
                      activity: "working",
                    },
                    { ref: "r-3", title: "写文档", cwd: "/root/ws/docs", updated_at: NOW - 3600, state: "idle" },
                  ],
                },
              }),
            ],
          },
          CONNECTORS[1] as Connector,
        ],
        SESSIONS,
        null,
        new Set(["rs-1"]),
      ),
  ],
  [
    "remote_sessions_watch",
    () =>
      sessions(
        [
          CLAUDE_SESSIONS({
            watch_live: true,
            resumable: [
              {
                ref: "r-1",
                title: "修 flaky 测试",
                cwd: "/root/ws/active",
                updated_at: NOW - 120,
                state: "live",
                activity: "waiting",
                waiting_for: "permission prompt",
              },
              {
                ref: "r-2",
                title: "重构连接器",
                cwd: "/root/ws/conn",
                updated_at: NOW - 30,
                state: "live",
                activity: "working",
              },
              { ref: "r-3", title: "写文档", cwd: "/root/ws/docs", updated_at: NOW - 3600, state: "live" },
            ],
          }),
        ],
        [],
        null,
      ),
  ],
  [
    "remote_sessions_shared",
    () =>
      sessions(
        [
          CLAUDE_SESSIONS({
            watch_live: true,
            terminal_input: true,
            takeover: true,
            resumable: [
              {
                ref: "r-1",
                title: "hosting",
                cwd: "/root/ws/active",
                updated_at: NOW - 120,
                state: "live",
                input: "terminal",
              },
              { ref: "r-2", title: "不在 tmux 里", cwd: "/root/ws/conn", updated_at: NOW - 30, state: "live" },
            ],
          }),
        ],
        [],
        null,
      ),
  ],
  [
    "remote_window", // (the session card as the window: output, an approval waiting, the text box and Send)
    () =>
      windowCard(
        remoteView.windowView({
          label: "🟠 Claude Code",
          host: "robin-dev",
          cwd: "/root/ws/active",
          mode: "default",
          sessionId: "rs-1",
          phase: "working",
          at: NOW,
          lang: "zh",
          zone: TZ,
          hasModes: true,
          bot: "PrimusClaw Assistant",
          view: windowState({
            text: Array.from({ length: 40 }, (_, i) => `collected ${String(i)} items`).join("\n") + "\nAll 40 passed.",
            step: "Run pytest",
            sent: "run the tests",
          }),
          approvals: [
            {
              actionId: "ac-1",
              tool: "Bash: npm test",
              expiresAt: NOW + 600,
              buttons: remoteView
                .optionButtons(
                  [
                    { optionId: "o1", kind: "allow_once", name: "Allow" },
                    { optionId: "o3", kind: "reject_once", name: "Reject" },
                  ],
                  "rs-1",
                  "ac-1",
                )
                .map((b) => ({ ...b, inWindow: true })),
            },
          ],
        }),
      ),
  ],
  [
    "remote_window_en",
    () =>
      windowCard(
        remoteView.windowView({
          label: "⬛ Codex",
          host: "robin-dev",
          cwd: "/root/ws/active",
          mode: null,
          sessionId: "rs-1",
          phase: "idle",
          at: NOW,
          lang: "en",
          zone: TZ,
          bot: "PrimusClaw Assistant",
          view: windowState({ text: "Done: the build is green.", queued: "a turn is running in the terminal" }),
          approvals: [],
        }),
      ),
  ],
);
