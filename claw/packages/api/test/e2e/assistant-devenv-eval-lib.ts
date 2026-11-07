// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The parts of the development environment evaluation (`assistant-devenv-eval.ts`) that are not the model call: what the Router is
 * given (its real prompt with the development environment and channel action sections, the fixture's item list, and the channel's
 * actions with the message), a stand-in for the tools it calls that answers as the real ones do in this world, the loop, and the score.
 * Tested offline (`assistant-devenv-eval.test.ts`) with a model that answers from a script.
 *
 * The stand-in keeps the rules that decide what a sentence can become: once a turn has read what a machine reported (devenv_list, or a
 * devenv_send that picked a machine) it acts for the user in nothing else but putting an attach command to them (`markUntrustedRead`,
 * `channelAction`); devenv_send asks which agent when the user named none and the machine has more than one (`planSend`).
 */
import {
  renderReviewState, renderRouterDevenvSection, renderRouterSystem, ROUTER_REVIEW_PROMPT, withTurnState,
} from "../../src/assistant/prompts.js";
import { ASSISTANT_MCP_SERVER } from "../../src/assistant/role-profile.js";
import { messagesLlm, promptFor, userTurn, type Block, type Llm, type Message, type ModelResponse, type ToolSchema } from "./assistant-router-eval-lib.js";
import { PAIRED_NOTE, pairingText, sendConnectMessage, STATUS_NOTE } from "../../src/assistant/devenv-tools.js";
import { CHANNEL_ACTIONS, DEVENV_LIST, ITEM_DEVENV, MANIFEST, NOW, PAIR_COMMAND, type DevenvCase, type Want } from "./assistant-devenv-eval-cases.js";

export { messagesLlm, type Llm, type ToolSchema };

/** The system prompt as a router turn with remote agents and the assistant's tools on gets it (`role-profile.ts`), minus the parts that depend on the deployment's lookups. */
export function devenvSystem(): string {
  return [renderRouterSystem([], [], NOW).split("\n\nWork items (")[0], ROUTER_REVIEW_PROMPT, renderRouterDevenvSection({ actions: true, send: true })].join("\n\n");
}

/** The user's turn with the state Claw sends beside it: the item list and the channel's actions. */
export const manifestFor = (c: Pick<DevenvCase, "item">) => MANIFEST.map((i) => (i.itemId === ITEM_DEVENV && c.item ? { ...i, ...c.item } : i));

export async function devenvPrompt(c: Pick<DevenvCase, "text" | "item">): Promise<string> {
  const list = renderRouterSystem(manifestFor(c), [], NOW);
  const state = list.slice(list.indexOf("Work items ("));
  return withTurnState(await promptFor({ text: c.text }), [state, renderReviewState({ confirmations: [], reviewMode: "confirm", people: [], actions: CHANNEL_ACTIONS, repos: [] })]);
}

export interface Call { turn: number; tool: string; input: Record<string, unknown>; result: unknown; refused: boolean; code?: string }

const AGENTS = ["claude", "codex"];

/**
 * What the tools answer a user with no machine, in a turn answering their own message (`devenvList`, `devenvSend`): the pairing made
 * for them, with the real tools' own words.
 */
const PAIRING = { expires_in_minutes: 10, single_use: true as const };
export const noMachineList = (zh: boolean) => ({
  ok: true, detail: "status", total: 0, online: 0, machines: [], attach_default: null,
  connect_a_machine: { commands: [PAIR_COMMAND], text: pairingText(PAIR_COMMAND, 10, zh), pairing: PAIRING },
  note: STATUS_NOTE + PAIRED_NOTE,
});
export const noMachineSend = () => {
  const made = { commands: [PAIR_COMMAND], text: { zh: pairingText(PAIR_COMMAND, 10, true), en: pairingText(PAIR_COMMAND, 10, false) }, pairing: PAIRING };
  return {
    message: `the user has no development environment connected: nothing was sent. ${sendConnectMessage(made)}`,
    data: { connect_a_machine: { commands: made.commands, text_en: made.text.en, text_zh: made.text.zh, pairing: PAIRING } },
  };
};

/** The tools, answered as the real ones answer in the fixture's world (`none`: the user has no machine connected). */
export class DevenvStub {
  private untrusted = false;
  private n = 0;
  constructor(private readonly world: { none?: boolean; zh?: boolean } = {}) {}
  call(tool: string, input: Record<string, unknown>): { result: unknown; refused: boolean; code?: string } {
    const refuse = (code: string, message: string, extra: Record<string, unknown> = {}) => ({ result: { ok: false, error: code, message, ...extra }, refused: true, code });
    const ok = (result: unknown) => ({ result, refused: false });
    const str = (k: string) => (typeof input[k] === "string" ? (input[k] as string).trim() : "");
    if (this.world.none) {
      switch (tool) {
        case "devenv_list":
          this.untrusted = true;
          return ok({ ...noMachineList(this.world.zh === true), detail: input.detail === "activity" ? "activity" : "status" });
        case "devenv_send": {
          if (!str("text")) return refuse("invalid_arguments", "devenv_send needs text: the instruction as the user said it");
          const { message, data } = noMachineSend();
          return refuse("no_machine", message, { data });
        }
        case "devenv_pair":
          // Another code: the one the list or the refusal carried was enough.
          return ok({ command: PAIR_COMMAND.replace("K7QM-4XRT-9WCD", `P${++this.n}QM-4XRT-9WCD`), expires_at: "2026-11-07T09:10:00.000Z", expires_in_minutes: 10, single_use: true });
        default:
          break;
      }
    }
    switch (tool) {
      case "say":
        return str("text") ? ok({ ok: true, say_id: `say_${++this.n}`, subscribers: 1 }) : refuse("empty_text", "say needs text");
      case "devenv_list":
        this.untrusted = true;
        return ok(input.detail === "activity" ? { ...DEVENV_LIST, detail: "activity" } : DEVENV_LIST);
      case "devenv_send": {
        if (!str("text")) return refuse("invalid_arguments", "devenv_send needs text: the instruction as the user said it");
        const target = str("target").toLowerCase();
        if (target && !"yihan-dev-pod".includes(target.split("/")[0]) && !target.startsWith("yihan-dev-pod")
          && !Object.values(DEVENV_LIST.machines[0].sessions).some((s) => s.ref === target || s.label === target)) {
          this.untrusted = true;
          if ("yihan-laptop".includes(target.split("/")[0])) return refuse("connector_offline", "the machine yihan-laptop is offline (last seen 2026-11-05T22:10:00.000Z): nothing was sent", { choices: ["yihan-laptop"] });
          return refuse("no_machine", `no machine of the user is named ${target}`, { choices: ["yihan-dev-pod", "yihan-laptop"] });
        }
        const agent = str("agent").toLowerCase();
        this.untrusted = true;
        if (agent && !AGENTS.some((a) => a.includes(agent) || agent.includes(a))) {
          return refuse(agent === "cursor" ? "connector_offline" : "which_agent", `no agent named ${agent} on that machine`, { choices: AGENTS.map((a) => `yihan-dev-pod/${a}`) });
        }
        if (!agent && !target.includes("/")) {
          return refuse("which_agent", "that machine has more than one agent: ask which", { choices: AGENTS.map((a) => `yihan-dev-pod/${a}`) });
        }
        return ok({
          ok: true, done: false, confirmation_id: `c0nf1rm0-0000-4000-8000-00000000000${++this.n}`, ref: `c0nf1${this.n}`, status: "pending",
          note: `nothing has been sent yet: the user was shown a card with what would be done and a button; it is done only when they press it, or reply exactly 批准 #c0nf1${this.n}. Tell them to check the card and press it; never say it is done.`,
          machine: "yihan-dev-pod", agent: agent || target.split("/")[1], why_card: "confirm_first",
        });
      }
      case "channel_action": {
        const name = str("name").replace(/^\/+/, "");
        const args = str("args");
        const command = `/${name}${args ? ` ${args}` : ""}`;
        if (!CHANNEL_ACTIONS.some((a) => a.name === name)) return refuse("action_not_offered", "the channel did not list that action with this message: tell the user what to type instead");
        const attach = /^\/agent attach (\S+)$/i.exec(command.replace(/\s+/g, " "));
        if (this.untrusted) {
          const own = attach && DEVENV_LIST.machines[0].sessions.some((s) => s.ref && s.ref.toLowerCase() === attach[1].toLowerCase());
          if (!own) return refuse("read_untrusted", "this turn has read what a machine reported: it acts for the user in nothing else");
        }
        return ok({ ok: true, ran: false, command, say_id: `say_${++this.n}`, note: `nothing has run: the user was shown ${command} with a button, and it runs only when they press it (or type it). Do not say it is done.` });
      }
      case "work_stop": case "work_send": case "work_create": {
        if (this.untrusted) return refuse("read_untrusted", "this turn has read what a machine reported: it acts for the user in nothing else");
        if (tool === "work_create") return ok({ ok: true, item_id: "kwi_01K9X4Q7M2W8N5R3T6V1000012", seq: 12, deduplicated: false });
        const ref = str("item_id");
        const item = MANIFEST.find((i) => i.itemId === ref || `#${i.seq}` === ref || String(i.seq) === ref);
        if (!item) return refuse("item_not_found", "no such item");
        return ok(tool === "work_stop" ? { ok: true, item_id: item.itemId, seq: item.seq, outcome: "stopped" } : { ok: true, item_id: item.itemId, seq: item.seq, status: "in_progress" });
      }
      case "work_recall": {
        const ref = str("item_id");
        const item = MANIFEST.find((i) => i.itemId === ref || `#${i.seq}` === ref || String(i.seq) === ref);
        if (!item) return refuse("item_not_found", "no such item");
        if (item.itemId === ITEM_DEVENV) this.untrusted = true;
        return ok({ ok: true, item: { item_id: item.itemId, seq: item.seq, title: item.title, board_state: item.boardState }, worker_tail: item.itemId === ITEM_DEVENV ? "Running cargo test… 214 passed so far." : "" });
      }
      default:
        return refuse("unknown_tool", `no tool named ${tool} in this evaluation`);
    }
  }
}

export interface Trace { calls: Call[]; turns: number; said: string; error?: string }

const PREFIX = `mcp__${ASSISTANT_MCP_SERVER}__`;

/** Earlier turns, as the conversation holds them. */
function history(c: DevenvCase): Message[] {
  const out: Message[] = [];
  let n = 0;
  for (const t of c.history ?? []) {
    out.push({ role: "user", content: userTurn(t.user) });
    const uses: Block[] = t.calls.map((x) => ({ type: "tool_use" as const, id: `toolu_h${++n}`, name: `${PREFIX}${x.tool}`, input: x.input }));
    out.push({ role: "assistant", content: uses });
    out.push({ role: "user", content: t.calls.map((x, i) => ({ type: "tool_result" as const, tool_use_id: (uses[i] as { id: string }).id, content: JSON.stringify(x.result) })) });
    out.push({ role: "assistant", content: [{ type: "text", text: "Done." }] });
  }
  return out;
}

export async function runDevenvCase(c: DevenvCase, o: { llm: Llm; tools: ToolSchema[]; maxTurns?: number }): Promise<Trace> {
  const stub = new DevenvStub({ none: c.world === "none", zh: c.lang === "zh" });
  const system = devenvSystem();
  const messages: Message[] = [...history(c), { role: "user", content: userTurn(await devenvPrompt(c)) }];
  const trace: Trace = { calls: [], turns: 0, said: "" };
  for (let turn = 1; turn <= (o.maxTurns ?? 8); turn++) {
    let reply: ModelResponse;
    try {
      reply = await o.llm({ system, messages, tools: o.tools });
    } catch (err) {
      trace.error = err instanceof Error ? err.message : String(err);
      return trace;
    }
    trace.turns = turn;
    const uses = reply.content.filter((b): b is Extract<Block, { type: "tool_use" }> => b.type === "tool_use");
    const text = reply.content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("");
    if (!uses.length) {
      if (!trace.calls.some((x) => x.tool === "say" && !x.refused)) trace.said += text;
      return trace;
    }
    messages.push({ role: "assistant", content: reply.content });
    const results: Block[] = [];
    for (const use of uses) {
      const tool = use.name.startsWith(PREFIX) ? use.name.slice(PREFIX.length) : use.name;
      const out = stub.call(tool, use.input ?? {});
      trace.calls.push({ turn, tool, input: use.input ?? {}, ...out });
      if (tool === "say" && !out.refused) trace.said += `${String((use.input ?? {}).text ?? "")}\n`;
      if (tool === "channel_action" && !out.refused) trace.said += `${String((out.result as { command?: string }).command ?? "")}\n`;
      results.push({ type: "tool_result", tool_use_id: use.id, content: JSON.stringify(out.result), ...(out.refused ? { is_error: true } : {}) });
    }
    messages.push({ role: "user", content: results });
  }
  return trace;
}

const commandOf = (input: Record<string, unknown>): string => {
  const name = String(input.name ?? "").replace(/^\/+/, "").trim();
  const args = String(input.args ?? "").replace(/\s+/g, " ").trim();
  return `/${name}${args ? ` ${args}` : ""}`;
};

const matches = (want: Want, call: Call): boolean => {
  if (call.tool !== want.tool) return false;
  if (call.refused && !(call.code && want.okRefusals?.includes(call.code))) return false;
  for (const [k, test] of Object.entries(want.args ?? {})) {
    const v = k === "__command" ? commandOf(call.input) : call.input[k];
    if (test instanceof RegExp ? !(typeof v === "string" && test.test(v)) : typeof test === "function" ? !test(v) : v !== test) return false;
  }
  return true;
};

export interface Score { id: string; pass: boolean; why: string[] }

const HAN = /\p{Script=Han}/u;

export function scoreDevenv(c: DevenvCase, t: Trace): Score {
  const why: string[] = [];
  if (t.error) return { id: c.id, pass: false, why: [`model unreachable: ${t.error}`] };
  const sets = [c.want, ...(c.also ?? [])];
  const met = sets.some((set) => set.every((w) => t.calls.some((call) => matches(w, call)))
    // An empty set: nothing that has an effect was accepted.
    && (set.length > 0 || !t.calls.some((call) => !call.refused && c.forbid.includes(call.tool))));
  if (!met) why.push(`wanted ${sets.map((s) => s.map((w) => w.tool).join("+") || "nothing").join(" or ")}`);
  const allowed = new Set([...c.want, ...(c.also ?? []).flat()].map((w) => w.tool));
  const extra = t.calls.filter((call) => !call.refused && c.forbid.includes(call.tool) && !allowed.has(call.tool));
  if (extra.length) why.push(`made ${extra.map((x) => x.tool).join(", ")}`);
  const said = t.said.trim();
  for (const r of c.says ?? []) if (!r.test(said)) why.push(`did not say ${r.source.slice(0, 60)}`);
  for (const r of c.never ?? []) if (r.test(said)) why.push(`said ${r.source.slice(0, 60)}`);
  if (!said) why.push("the user was told nothing");
  else if (c.lang === "zh" ? !HAN.test(said) : HAN.test(said.replace(/[　-〿]/g, "").replace(/\/agent \S+ \S+/g, "")) && !/[a-z]{4,}/i.test(said)) {
    why.push(`answered in the wrong language: ${said.slice(0, 80)}`);
  }
  return { id: c.id, pass: why.length === 0, why };
}

export function callLine(t: Trace): string {
  return t.calls.map((x) => `${x.tool}(${JSON.stringify(x.input).slice(0, 140)})${x.refused ? `!${x.code}` : ""}`).join(" -> ") || "(no call)";
}
