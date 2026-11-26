// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Which ends of a terminal's turns are pushed to its owner, and the summary of a conversation that keeps working on its own.
 *
 * The connector says who started each turn whose end it tells (`origin` on `terminal_turn_end`, read from Claude Code's transcript:
 * a person typing at that terminal, or another session's message, a schedule, a hook; connector/src/turn-origin.ts). The owner is
 * told at once only of what is theirs to hear:
 *  - the end of a turn a person started (or one whose connector is too old to say, as before);
 *  - the end of a turn that asks the person something or waits for their decision ({@link asksPerson}), or that failed.
 * Every other end (a turn driven by another agent or a schedule that just finished) is gathered on the conversation's item
 * (`params.digest`), as is an end held back by the gap between two pushes of one conversation (`TERMINAL_END_GAP_MS`), so nothing
 * is lost and nothing is said twice. A sweep then says, at most once per conversation every `/approvals summary` minutes (an hour
 * unless the owner set otherwise), what that conversation did since: how many turns, how they ended, the latest result in a few
 * whole sentences (the same trimming as an end's message, `terminalEndSummary`), and whether anything waits for the person. A conversation with nothing
 * gathered is never summed up; nothing is gathered or said while the owner has these pushes off (`/approvals off`) or muted the
 * conversation, and the owner's chat holds a summary through quiet hours or a pause as it holds every push.
 */
import pino from "pino";
import { TERMINAL_SUMMARY, turnAsksPerson } from "@claw/protocol";
import { CLAW_ASSISTANT_ENABLED } from "../config.js";
import { db, inTransaction, type Querier } from "../infra/db.js";
import { approvalsEnabled, terminalMuted, terminalSummaryMinutes } from "../remote-agents/store.js";
import { inertMd } from "./inert-md.js";
import { recordSystemNotice } from "./outbound.js";
import { cwdTail, terminalAttachCommand, terminalEndName, terminalToolOf, type RemoteParams } from "./remote-items.js";

const logger = pino({ name: "assistant-terminal-digest" });

/** Whether what the agent last said asks the person something or waits for their decision (protocol `turnAsksPerson`). */
export const asksPerson = turnAsksPerson;

/** What a conversation did since it was last summed up, kept on its item (`params.digest`). */
export interface TerminalDigest {
  /** When (ms) the first of these ends came; the summary is due `/approvals summary` minutes after it. */
  first_at: number;
  last_at: number;
  turns: number;
  failed: number;
  /** Ends among them that asked the person something (held back by the gap between pushes). */
  asks: number;
  /** The newest ends' results ({@link terminalEndSummary}), oldest first, at most {@link DIGEST_SAID_MAX}. */
  said: string[];
}

const DIGEST_SAID_MAX = 3;

/** One end (and the earlier ends the connector folded into it) gathered for the next summary. */
export function gather(
  p: Pick<RemoteParams, "digest">, now: number, e: { turns: number; failed: number; asks: boolean; said: string[] },
): void {
  const d: TerminalDigest = p.digest ?? { first_at: now, last_at: now, turns: 0, failed: 0, asks: 0, said: [] };
  d.last_at = now;
  d.turns += Math.max(1, e.turns);
  d.failed += Math.max(0, e.failed);
  if (e.asks) d.asks += 1;
  d.said = [...d.said, ...e.said.filter(Boolean)].slice(-DIGEST_SAID_MAX);
  p.digest = d;
}

/** A span of time as the summary says it: minutes under two hours, else hours. */
function span(ms: number, zh: boolean): string {
  const min = Math.max(1, Math.round(ms / 60_000));
  if (min < 120) return zh ? `${min} 分钟` : `${min} min`;
  const h = Math.round(min / 60);
  return zh ? `${h} 小时` : `${h} h`;
}

/** What ends a sentence: a full stop, an exclamation or question mark or an ellipsis (CJK or Latin), then any closing quote or bracket. */
const SENTENCE_STOP = /[。！？.!?…][”’"'）)」』】\]]*$/u;
/** What a result that was cut mid-sentence may be left ending with: spaces and the marks that join clauses. */
const CLAUSE_TAIL = /[\s，、：；,:;]+$/u;

/** Chinese or Japanese text: its sentences end with the CJK full stop, whatever language the notice around it is in. */
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;

/**
 * `text` ending in a sentence's end: unchanged when it has one, else with a full stop in place of the clause mark it was left ending
 * with (the CJK one when the text is Chinese or Japanese, the plain one otherwise). The agent's last words often stop without one
 * ("S21A-35791359", "测试全部通过，已推送"), and the system's own sentence that follows them must not run into them.
 */
export function closeSentence(text: string): string {
  const t = text.trim();
  if (!t || SENTENCE_STOP.test(t)) return t;
  const bare = t.replace(CLAUSE_TAIL, "");
  return bare ? `${bare}${CJK.test(bare) ? "。" : "."}` : "";
}

/**
 * The summary, in the shape of an end's message: one line that says which conversation (its name, still working, the machine, the
 * folder, the item), then at most three sentences (how many turns and how they ended, the latest result, whether anything waits for
 * the person), then the commands for it (attach, mute, how often). The agent's words are quoted text, never instructions: the latest
 * result always ends in a sentence's end, and the system's sentence after it starts a new line in Chinese (which has no space to part
 * them) and follows after a space in English, so the two never read as one.
 */
export function terminalDigestNotice(
  p: Pick<RemoteParams, "machine" | "agent_id" | "tool" | "lang" | "title" | "cwd" | "name">, seq: number, d: TerminalDigest, now: number,
  attach: string | null,
): string {
  const zh = p.lang === "zh";
  // Every word the machine or the agent wrote is made inert: a channel reads this text as markdown.
  const name = inertMd(terminalEndName(p));
  const where = [inertMd(p.machine), inertMd(cwdTail(String(p.cwd ?? ""))), `#${seq}`].filter(Boolean).join(" · ");
  const head = zh ? `【${name}】持续工作中 · ${where}` : `[${name}] still working · ${where}`;
  const during = span(now - d.first_at, zh);
  const count = zh
    ? `过去 ${during}里又跑了 ${d.turns} 轮${d.failed ? `，其中 ${d.failed} 轮出错` : ""}。`
    : `In the last ${during} it ran ${d.turns} more turn${d.turns === 1 ? "" : "s"}${d.failed ? `, ${d.failed} of them failed` : ""}.`;
  const latest = inertMd(closeSentence(d.said[d.said.length - 1] ?? ""));
  const result = latest ? (zh ? `最近：${latest.replace(/\s*\n\s*/gu, "；")}` : `Latest: ${latest.replace(/\s*\n\s*/gu, "; ")}`) : "";
  const need = d.asks
    ? (zh ? `有 ${d.asks} 轮在问你，详情见终端。` : `${d.asks} of them asked you something; see the terminal.`)
    : (zh ? "不需要你处理。" : "Nothing needs you.");
  const commands = zh
    ? [attach ? `接入：${attach}` : "", `静音：/approvals mute #${seq}`, "间隔：/approvals summary <分钟>|off"]
    : [attach ? `Attach: ${attach}` : "", `Mute: /approvals mute #${seq}`, "How often: /approvals summary <minutes>|off"];
  // (the system's own sentences join as before; only the agent's quoted result is set apart from what follows it)
  const counted = [count, result].filter(Boolean).join(zh ? "" : " ");
  const said = [counted, need].filter(Boolean).join(zh ? (result ? "\n" : "") : " ");
  return [head, said, commands.filter(Boolean).join(zh ? "　" : "  ·  ")].join("\n");
}

/** The conversation's connector, its ref, whether the connector lists it (it can then be attached) and its own name there. */
async function conversationOf(q: Querier, sessionId: string): Promise<{ connector_id: string; ref: string | null; listed: boolean; name: string | null } | undefined> {
  return (await q(
    `SELECT s.connector_id::text AS connector_id, s.ref,
            EXISTS (SELECT 1 FROM claw_remote_agents a
               CROSS JOIN LATERAL jsonb_array_elements(
                 CASE WHEN jsonb_typeof(a.capabilities->'resumable') = 'array' THEN a.capabilities->'resumable' ELSE '[]'::jsonb END) r(value)
              WHERE a.connector_id = s.connector_id AND jsonb_typeof(r.value) = 'object' AND r.value->>'ref' = s.ref) AS listed,
            (SELECT r.value->>'title' FROM claw_remote_agents a
               CROSS JOIN LATERAL jsonb_array_elements(
                 CASE WHEN jsonb_typeof(a.capabilities->'resumable') = 'array' THEN a.capabilities->'resumable' ELSE '[]'::jsonb END) r(value)
              WHERE a.connector_id = s.connector_id AND jsonb_typeof(r.value) = 'object' AND r.value->>'ref' = s.ref
              LIMIT 1) AS name
       FROM claw_remote_sessions s WHERE s.session_id::text = $1`,
    [sessionId],
  )).rows[0] as { connector_id: string; ref: string | null; listed: boolean; name: string | null } | undefined;
}

/** How many items one pass looks at. */
const PER_PASS = 200;

/**
 * One pass: every terminal item with something gathered whose summary is due is summed up once. The item's row is taken (`FOR UPDATE
 * SKIP LOCKED`, so a replica or a pass of the item's own events going on meanwhile is not waited for) and its digest cleared in the same
 * transaction that decides, so two replicas never say one summary twice; the summary's key (the item and its first end) makes a second
 * store of the same one say nothing. Gathered ends of an owner who turned these pushes off, muted the conversation or turned summaries
 * off are dropped, not kept for later.
 */
export async function runTerminalDigestSweep(now: number = Date.now()): Promise<{ told: number; dropped: number }> {
  const out = { told: 0, dropped: 0 };
  if (!CLAW_ASSISTANT_ENABLED) return out;
  const due = (await db.query(
    `SELECT item_id FROM claw_work_items
      WHERE kind = 'remote' AND params->>'origin' = 'terminal' AND params ? 'digest'
        AND (params->'digest'->>'first_at')::float8 <= $1::float8 - $2::float8
      ORDER BY (params->'digest'->>'first_at')::float8 LIMIT $3`,
    [now, TERMINAL_SUMMARY.minMinutes * 60_000, PER_PASS],
  )).rows as Array<{ item_id: string }>;
  for (const { item_id } of due) {
    try {
      const said = await inTransaction(async (q) => {
        const r = (await q(
          `SELECT w.item_id, w.user_id, w.seq, w.params, a.session_id AS router_sid
             FROM claw_work_items w JOIN claw_assistants a ON a.user_id = w.user_id
            WHERE w.item_id = $1 AND w.params ? 'digest' FOR UPDATE OF w SKIP LOCKED`,
          [item_id],
        )).rows[0] as { item_id: string; user_id: string; seq: number; params: RemoteParams; router_sid: string } | undefined;
        if (!r?.params.digest) return null;
        const p = r.params;
        const d = p.digest as TerminalDigest;
        const owner = r.user_id;
        const minutes = await terminalSummaryMinutes(owner, q);
        const where = await conversationOf(q, String(p.session_id ?? ""));
        const off = minutes === 0 || !await approvalsEnabled(owner, q) || (!!where?.ref && await terminalMuted(owner, where.connector_id, where.ref, q));
        if (!off && now - Number(d.first_at) < minutes * 60_000) return null;
        await q(
          `UPDATE claw_work_items SET params = (params - 'digest') || $2::jsonb, updated_at = NOW() WHERE item_id = $1`,
          [r.item_id, JSON.stringify(off ? {} : { summary_told_at: now })],
        );
        if (off) return { dropped: true as const };
        const name = where?.name ? where.name.replace(/\s+/gu, " ").trim().slice(0, 80) : "";
        const attach = where?.listed ? terminalAttachCommand(where.ref) : null;
        const tool = terminalToolOf(p.tool);
        return {
          userId: owner, sessionId: String(r.router_sid), key: `remote:${r.item_id}:summary:${Number(d.first_at)}`,
          text: terminalDigestNotice({ ...p, ...(name ? { name } : {}) }, Number(r.seq), d, now, attach),
          remote: {
            kind: "progress" as const, session_id: String(p.session_id ?? ""), machine: String(p.machine ?? ""), agent: String(p.agent_id ?? ""),
            ...(tool ? { tool } : {}), item_seq: Number(r.seq),
          },
        };
      });
      if (!said) continue;
      if ("dropped" in said) { out.dropped += 1; continue; }
      await recordSystemNotice(said);
      out.told += 1;
    } catch (err) {
      logger.warn({ err: (err as Error)?.message, itemId: item_id }, "assistant.terminal_digest_failed");
    }
  }
  return out;
}

/** The sweep every `sweepMs` (a minute) on this replica, until the returned stop is called; a failed pass is logged and the next tries again. */
export function startTerminalDigestSweep(opts: { sweepMs?: number } = {}): () => void {
  const sweepMs = opts.sweepMs ?? 60_000;
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  const tick = async () => {
    try {
      const out = await runTerminalDigestSweep();
      if (out.told || out.dropped) logger.info(out, "assistant.terminal_digest_swept");
    } catch (err) {
      logger.warn({ err: (err as Error)?.message }, "assistant.terminal_digest_sweep_failed");
    }
    if (stopped) return;
    timer = setTimeout(tick, sweepMs);
    timer.unref();
  };
  timer = setTimeout(tick, sweepMs);
  timer.unref();
  return () => { stopped = true; clearTimeout(timer); };
}
