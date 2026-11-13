// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Runs the super-agent evaluation against a real deployment, as a user's channel would: each case's turns go to the
 * user's assistant (`POST /v1/assistant`, then `POST /v1/sessions/:id/messages`), and what the user would be shown is
 * read from the assistant session's live stream (`AssistantSay`), with the time each message arrived here. For every
 * case it records the route (answer, work item, review, confirmation), the tool calls (the Router's, and the workers'
 * of the items it started), the cards the user would be offered, the final answer and the latency of the first reply
 * and of the final answer, and grades them with the deterministic checks of `sa-eval-lib.ts` (the case format is
 * described there).
 *
 * Baseline mode sends the same turns to a new plain session with a plugin (a user of the plugin without the
 * assistant), so the two can be compared case by case on the checks that apply to both.
 *
 *   EVAL_CLAW=https://claw.example/api EVAL_KEY_FILE=/path/to/key node --import tsx test/e2e/sa-eval.ts
 *   EVAL_MODE=baseline EVAL_PLUGIN_ID=<id> EVAL_CLAW=... EVAL_KEY_FILE=... node --import tsx test/e2e/sa-eval.ts
 *
 *   EVAL_DRY_RUN=1 npx tsx test/e2e/sa-eval.ts                                  # load, check and plan: nothing is sent
 *   EVAL_STATIC=1 npx tsx test/e2e/sa-eval.ts                                   # what cases ask for against what their arm can do
 *   EVAL_OFFLINE=<dir>/assistant-recordings.jsonl npx tsx test/e2e/sa-eval.ts    # grade recorded attempts again, offline
 *
 * A live run requires EVAL_CLAW (the API root, to which `/v1/...` is appended), the key as EVAL_KEY or EVAL_KEY_FILE
 * (there is no default), and EVAL_IDENTITY_ACK=test:<the email of the key's identity>. Before anything is sent it reads
 * who the key is (`GET /v1/me`) and its notification subscriptions, and refuses to run for an identity that is not
 * acknowledged as a test one, one on EVAL_IDENTITY_DENY, or one with an enabled subscription (a chat channel would push
 * what the assistant says to a person; EVAL_ALLOW_SUBSCRIBED=1 overrides only that). Never run it with a person's key.
 * The key is read when it is used and never printed or written to the results.
 * Optional:
 *   EVAL_MODE         assistant (default) or baseline
 *   EVAL_PLUGIN_ID    the plugin a baseline session names (required for baseline)
 *   EVAL_CASES_DIR    the directory of `*.jsonl` case files, read recursively (default: `sa-eval-cases` next to this file,
 *                     a small synthetic set); cases from real users' messages belong in a directory outside the repository
 *   EVAL_PIPELINES    comma list of the subdirectories to run (e.g. catalog,real; default all)
 *   EVAL_CASES        comma list of case ids, areas or pipelines (default all)
 *   EVAL_VARIANTS     1: also run the cases that are variants of another (default: not)
 *   EVAL_K            attempts per case (default 3): the report has pass@1 (mean) and pass^k
 *   EVAL_ITEM_WAIT    seconds to wait for an item's result, unless the case sets item_wait_s (default 300)
 *   EVAL_KEEP_TEXT    1: keep the final answers in the results (they are the identity's own data, and can contain what an
 *                     oracle reads from it; default: only their length). Write such results only somewhere private. The judge's
 *                     reasons are kept either way (keys scrubbed, 300 characters each), so a FAIL can be looked into
 *   EVAL_OUT          a directory for the results: <mode>.json and <mode>.md
 *   EVAL_RECORD_DIR   a private directory (the operator's own, no access for group or others, under directories nobody else can
 *                     change; made 0700 when missing, refused otherwise before anything is sent) for <mode>-recordings.jsonl (0600): every attempt as observed, in full (what the identity was
 *                     shown included), and the judge's whole answers, for EVAL_OFFLINE and for looking into a verdict; keys
 *                     scrubbed. Written only when set; EVAL_KEEP_TEXT is not needed for it
 *   EVAL_JUDGE_URL, EVAL_JUDGE_MODEL, EVAL_JUDGE_KEY_FILE, EVAL_JUDGE_MAX_TOKENS (default 1024)
 *                     an Anthropic-compatible gateway, a model and its key: every case is also graded by that model (the
 *                     no-false-denial rule with the turn's calls, and the case's rubric and judge-only facts). Its FAIL fails
 *                     the case and it decides what the denial detectors left to it; it never passes a case a deterministic
 *                     check failed. A FAIL on a case every deterministic check passed is asked again, and a third time when the
 *                     two disagree: the majority decides (each vote is in the attempt's `judge.votes`). The judge is given the
 *                     values the facts' oracles read for the run, as the truth to grade against (they can be newer than the
 *                     judge's own knowledge: a version it does not know is not a reason to fail).
 *   EVAL_VARS_FILE    a JSON object of run variables for `{{name}}` placeholders (nested objects give `{{a.b}}`); EVAL_VAR_<NAME>
 *                     sets one too. A case whose placeholders have no value is skipped and says which.
 *   EVAL_VARS_CMD     a command (a program and its arguments separated by spaces, run without a shell) run right before
 *                     each case, whose stdout is a JSON object of run variables, over those
 *                     above: a value that moves (how many pull requests are open) is read when the case runs. One that fails
 *                     makes that case the run's error, never a grade against values from before
 *   EVAL_GITHUB_TOKEN_FILE, EVAL_GITHUB_API
 *                     the eval identity's GitHub token and API root (default https://api.github.com) for `gh:` and `ghql:` oracles
 *   EVAL_ORACLE_PLUGIN_ID, EVAL_ORACLE_MCP_HOSTS
 *                     the plugin whose MCP servers `mcp:` oracles read (default EVAL_PLUGIN_ID), and the hosts their URLs may
 *                     have (comma list, https only; default the host of EVAL_CLAW): the key is sent nowhere else. Only tools on
 *                     the router's list of reads are ever called, so an oracle cannot write
 *   EVAL_SAY_PER_HOUR, EVAL_SAY_RESERVE
 *                     the assistant mode's pace (default 100 and 10): before each attempt it waits until the identity's says of
 *                     the last hour (those stored in its assistant session before the run, and the run's own; the system's
 *                     fallbacks are not counted, as the server does not count them) plus the reserve are within the first.
 *                     Keep it below the identity's cap on the server (CLAW_ASSISTANT_SAY_MAX_PER_HOUR, 120, or for an identity in
 *                     CLAW_ASSISTANT_SAY_EVAL_USERS CLAW_ASSISTANT_SAY_EVAL_MAX_PER_HOUR): a say the server refuses for its
 *                     cap makes the attempt an error of the run (`infra: ... say_rate_limited`), not a failure of the assistant.
 *                     A server that says the cap (POST /v1/assistant `say_max_per_hour`) lowers the pace to 20 under it
 *                     (`pacedPerHour`), so a pace raised for an evaluation identity's own cap is safe where it does not have it.
 *                     0 turns the pace off. The says of an assistant session a run deleted cannot be read back and still
 *                     count: each run keeps the hour's says it saw in EVAL_SAY_LOG (default: a file per identity under
 *                     ~/.cache/sa-eval) for the next run on the same host
 *   EVAL_TURN_WAIT_S  how long a turn may take to end (default 180 for a router turn, 600 for a plain session's), counted from
 *                     its own message: a turn whose exec_complete is not stored by then makes the attempt an error, not a grade;
 *                     so does an assistant session still running that long before a case. An attempt is graded on what the
 *                     stream showed only when it showed every stored event of the case that is graded (a gap opens the stream
 *                     again at once, then 15 s grace; every reopening is logged and kept in the attempt's `reopened`); otherwise it
 *                     is an error
 *   EVAL_SAY_GRACE_S  how long, after a turn ended, its first say is waited for (default 5): a router that says nothing gets the
 *                     server's own reply a moment after its turn ends, and that reply is what the person is shown. The server's
 *                     "on it" line said while the turn worked is not that reply: the wait goes on until another say of the turn
 *   EVAL_GAP_S        seconds between the end of one case and the start of the next (default 0)
 *   EVAL_INFRA_RETRY  1 (default): an attempt that ended in an error of the run (not a grade: a missed stream, a read or a judge
 *                     that failed, a turn that did not end) is run again once, and the second try is the one reported (`retried`
 *                     names the first one's error; a recording of the first try is dropped); 0 runs each attempt once. In the
 *                     assistant mode the second try runs in the same session as the first, as further attempts of a case do,
 *                     unless EVAL_FRESH_SESSION_EVERY=attempt
 *   EVAL_FRESH_SESSION_EVERY
 *                     assistant mode: a new assistant session every that many cases (1: each case its own; default 0: one for
 *                     the run), so no case is read in the context of earlier ones. The session before is let finish, its items
 *                     closed, and it is deleted and seen gone first. An assistant session the identity already has when the run
 *                     starts is deleted (and seen gone) before anything is sent, so the first case starts in a new one too; one
 *                     in use (see EVAL_QUIET_S) refuses the run instead, and its says of the last hour still count for the pace.
 *                     `attempt`: every attempt (and the second try of one) in a new session, and before each the cards waiting for
 *                     the identity's answer (`GET /v1/assistant/confirmations`, `GET /v1/github-review/confirmations`) are closed:
 *                     the assistant is shown them in every session, and answers a case asked again with "it is already waiting"
 *                     instead of a card. Closing a card is the person's answer, so it is done with EVAL_SEND_TOKEN_CMD's token (a
 *                     `deny`; once more after the last attempt); without one they stay, and an attempt of a case that expects a card while one an earlier attempt of
 *                     the same case made still waits is the run's error, not a grade. Each attempt records `cardsWaiting`
 *   EVAL_SEND_TOKEN_CMD
 *                     assistant mode: a command (as EVAL_VARS_CMD: no shell) that prints a signed-in access token of the key's own identity (an identity
 *                     provider's, for the Claw API): the run's messages are sent with it, as a person's channel sends them, so a
 *                     turn may act for the person (`attendedTurn`: memory, settings, confirmations). Everything else uses the key.
 *                     The token must be the key's identity (`GET /v1/me`), or the run refuses; it is never printed. It may be a
 *                     service's delegated token (an evaluation runner's client acting for the identity): the key goes beside it in
 *                     `x-api-key`, so a turn runs on the identity's own keys. It is sent with nothing but the person's text message,
 *                     a card's `deny` and that check (`tokenRequestRefusal`): the run never allows or answers anything with it
 *   EVAL_QUIET_S      the assistant mode refuses to start when the identity's assistant session has a turn running, or had any
 *                     event less than this many seconds ago (default 300; 0 checks only for a running turn): another run, or a
 *                     person, is using the identity. Each run going at the same time needs an identity of its own
 *
 * A case's `setup` (`triggers`) is made before each of its attempts with the key (`POST /v1/triggers`), after its session is open, and
 * deleted after the attempt (seen gone: a GET answers 404); one the run could not delete fails the run. A trigger the identity already has
 * under a setup trigger's name makes the attempt an error. A case's `setup.forget_memories` deletes, by id, the identity's memory entries
 * that hold one of its substrings before each attempt; one that is still listed after makes the attempt an error.
 *
 * Memory entries: the ids of the identity's entries (`GET /v1/users/me/memories`) are read before each attempt (after its
 * forget_memories), and every entry listed after it that was not before, the attempt's own, is deleted by id
 * (`DELETE /v1/users/me/memories/:id`) and seen gone from the list; an entry from before the attempt is never deleted by this.
 * One the run could not delete, or a list it could not read after an attempt, fails the cleanup (cleanup_failed); a list it could
 * not read before an attempt makes the attempt an error, with nothing sent. An entry that was not there when the run first listed them,
 * and that an attempt's cleanup did not see (saved by a turn still running past its attempt), is the run's too: it is deleted before the
 * next attempt, and in a last sweep after the run's sessions are closed. A case with `expect_memory` / `expect_no_memory` is graded
 * on the entries its attempt made, read once its turns are over and before they are deleted (`memoryChecks`); a list that cannot be
 * read then makes the attempt an error, not a grade.
 *
 * EVAL_STATIC reports, without sending anything, every case that can never pass on its arm (a tools_must no tool of the arm
 * matches: the router's from `assistant/read-tools.ts`, the worker's every plugin server, given as EVAL_STATIC_SERVERS or the
 * router's servers plus github and schedules), every case that needs the assistant and still runs in baseline, and every
 * description written as a value; exit 1 when there is one. EVAL_OUT gets static.json.
 *
 * The assistant mode works in the key owner's one assistant conversation (it must be a test identity, see above). It
 * runs the cases one at a time, waits for the assistant to be idle before each, and cleans up what it started: every
 * work item its own turns' work_create / review_start answers name is accepted (a result that waits, at the version
 * shown) or stopped, then its worker's session is deleted, and an assistant session it created is deleted. It deletes
 * only sessions it made or that its own items name, never by identity (but for the identity's own assistant session with
 * EVAL_FRESH_SESSION_EVERY, before the run), and a session counts as deleted only when a GET after the DELETE answers 404. No other item is touched; a new open item it cannot tie to its calls is reported. Exit 0
 * when every attempt ran to a verdict and the cleanup is complete; the score is a measurement, not a gate.
 *
 * SIGINT or SIGTERM stops a live run between two steps: nothing more is sent (an approval decision included), the turns
 * already sent are let end (up to a minute more, or EVAL_TURN_WAIT_S if shorter) so that the items they start are known, and
 * the cleanup above runs; the run exits 1, and says so if a turn was still running at its end. A second signal exits at
 * once without it. Send it to the runner's own process: `npx` (npm exec) does not pass a signal on.
 */
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { apiClient, until } from "./assistant-p1-lib.js";
import { traceOf, type EventRow, type ToolCall } from "./agent-eval-lib.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  BUILTIN_TOOLS, assistantInUse, capRefusedSays, pacedPerHour, caseHash, caseSays, cardsOf, cleanupOf, countedSays, countedSaysOf, deleteSessionConfirmed,
  mergeSays, parseSayLog, endedTurns, storedTurnEnds, streamMissed, filledCase, filesFrom, finalSay, grade, forRecording, identityRefusal, itemsStartedBy,
  judgePrompt, loadCases, messagesOf, oracleMcpTarget, missingVars, oracleMayRun, oracleQuery, parseRecordings, planOf, renderTable, routeOf,
  ownSays, sayWaitMs, saysOf, staticFindings, turnsAnswered, verdictOf, scrub as scrubWith, select, sseFrames, totals, turnCalls, turnEnded, heldCallRan, heldRequest,
  holdAnswers, toolPattern, judgeVerdict, JUDGE_RETRY_NOTE, oracleValues, withToolFailures, flatVars, storedTurnCalls,
  freshSessionEvery, waitingCards, cardsLeftError, setupTriggerBody, tokenRequestRefusal, turnMessageBody,
  memoryRows, memoriesMatching, newMemoryIds, type MemoryEntrySeen,
  type SayMark, type WaitingCard, type Arms, type Attempt, type Check, type CaseResult, type EvalCase, type ItemSeen, type LiveEvent, type Mode, type Observed, type OracleQuery,
  type Recording, type Turn, type TurnFile, type Vars, type HoldSeen, type HoldSpec,
} from "./sa-eval-lib.js";
import * as readTools from "../../src/assistant/read-tools.js";

/**
 * `dir` as a private directory, made (0700) when missing: its real path (symlinks are followed here, once) must be a directory of this
 * process's user that group and others cannot enter, and every directory above it must be owned by root or this user and writable by
 * nobody else unless sticky, so that nobody else can move it away and put another in its place before the run writes there. Its real
 * path, or why not.
 */
function privateDir(dir: string): { path: string } | { why: string } {
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const real = realpathSync(dir);
    const uid = typeof process.getuid === "function" ? process.getuid() : null;
    const why = ownPrivate(real, uid);
    if (why) return { why };
    for (let up = dirname(real); ; up = dirname(up)) {
      const a = statSync(up);
      if ((uid !== null && a.uid !== 0 && a.uid !== uid) || ((a.mode & 0o022) && !(a.mode & 0o1000))) {
        return { why: `lies under ${up}, which someone else could change (owner ${a.uid}, mode ${(a.mode & 0o7777).toString(8)}): use a directory under the operator's own` };
      }
      if (up === dirname(up)) break;
    }
    return { path: real };
  } catch (err) {
    return { why: `cannot be made (${err instanceof Error ? err.message : String(err)})` };
  }
}

/** Null when `path` itself (not a symlink) is a directory of `uid` that group and others cannot enter; else why not. */
function ownPrivate(path: string, uid: number | null): string | null {
  const st = lstatSync(path);
  if (!st.isDirectory()) return "is not a directory";
  if (uid !== null && st.uid !== uid) return "is not the operator's own directory";
  if (st.mode & 0o077) return `is open to group or others (mode ${(st.mode & 0o777).toString(8)}; chmod 700 it)`;
  return null;
}

const need = (name: string): string => {
  const v = process.env[name];
  if (!v) { console.error(`${name} is required`); process.exit(2); }
  return v;
};
const int = (name: string, fallback: number, min: number, max: number): number => {
  const raw = process.env[name];
  const n = raw === undefined || raw === "" ? fallback : Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) { console.error(`${name} must be an integer in ${min}..${max}`); process.exit(2); }
  return n;
};
const list = (name: string): Set<string> => new Set((process.env[name] || "").split(",").map((s) => s.trim()).filter(Boolean));

const DRY_RUN = process.env.EVAL_DRY_RUN === "1";
const STATIC = process.env.EVAL_STATIC === "1";
const OFFLINE = process.env.EVAL_OFFLINE;
const LIVE = !DRY_RUN && !STATIC && !OFFLINE;
const CLAW = LIVE ? need("EVAL_CLAW").replace(/\/+$/, "") : "";
const MODE = (process.env.EVAL_MODE || "assistant") as Mode;
if (MODE !== "assistant" && MODE !== "baseline") { console.error("EVAL_MODE must be assistant or baseline"); process.exit(2); }
const PLUGIN_ID = process.env.EVAL_PLUGIN_ID ? Number(process.env.EVAL_PLUGIN_ID) : undefined;
if (LIVE && MODE === "baseline" && (PLUGIN_ID === undefined || !Number.isInteger(PLUGIN_ID))) { console.error("baseline needs EVAL_PLUGIN_ID"); process.exit(2); }
const CASES_DIR = process.env.EVAL_CASES_DIR || join(dirname(fileURLToPath(import.meta.url)), "sa-eval-cases");
const K = int("EVAL_K", 3, 1, 10);
const ITEM_WAIT_SEC = int("EVAL_ITEM_WAIT", 300, 10, 3600);
const KEEP_TEXT = process.env.EVAL_KEEP_TEXT === "1";
const OUT = process.env.EVAL_OUT;
const RECORD_DIR = process.env.EVAL_RECORD_DIR;
const SAY_PER_HOUR = int("EVAL_SAY_PER_HOUR", 100, 0, 100_000);
const SAY_RESERVE = int("EVAL_SAY_RESERVE", 10, 0, 1_000);
if (SAY_PER_HOUR && SAY_RESERVE >= SAY_PER_HOUR) { console.error("EVAL_SAY_RESERVE must be below EVAL_SAY_PER_HOUR"); process.exit(2); }
/** The pace kept: SAY_PER_HOUR, lowered under the cap the server answers POST /v1/assistant with (`pacedPerHour`). */
let sayPerHour = SAY_PER_HOUR;
const QUIET_MS = int("EVAL_QUIET_S", 300, 0, 86_400) * 1000;
const TURN_WAIT_S = process.env.EVAL_TURN_WAIT_S ? int("EVAL_TURN_WAIT_S", 180, 1, 3600) : null;
/** How long a turn may take to end: EVAL_TURN_WAIT_S, else 180 s for a router turn and 600 s for a plain session's. */
const turnWaitMs = (router: boolean): number => (TURN_WAIT_S ?? (router ? 180 : 600)) * 1000;
// A recording holds what the identity was shown (and so anything an oracle reads back from its data): it is written only
// when the operator also asks to keep the text, knowingly.
// EVAL_RECORD_DIR holds what the identity was shown, in full: only a directory nobody else can read.
let RECORD_PATH: string | null = null;   // EVAL_RECORD_DIR's real path, checked private before the run
if (RECORD_DIR && LIVE) {
  const dir = privateDir(RECORD_DIR);
  if ("why" in dir) { console.error(`refusing to run: EVAL_RECORD_DIR ${dir.why}`); process.exit(2); }
  RECORD_PATH = dir.path;
}

/** The key, from the environment or the file named there; never a default. Never printed, never written. */
function apiKey(): string {
  if (process.env.EVAL_KEY) return process.env.EVAL_KEY.trim();
  const file = process.env.EVAL_KEY_FILE;
  if (!file) { console.error("EVAL_KEY or EVAL_KEY_FILE is required"); process.exit(2); }
  return readFileSync(file, "utf8").trim();
}
const KEY = LIVE ? apiKey() : "";
const api = apiClient(CLAW, KEY);
const scrub = (s: string): string => scrubWith(s, [KEY, ...sendTokens]);
const iso = (): string => new Date().toISOString();
const log = (...a: unknown[]): void => console.log(iso(), ...a.map((x) => (typeof x === "string" ? scrub(x) : x)));
const recordings: Recording[] = [];
const sessionsLeft: string[] = [];   // sessions the run made (or its items' workers) and could not delete: they fail the run
/** Checks whose detail quotes what the identity was shown: kept only with EVAL_KEEP_TEXT. */
const TEXT_DETAIL = /^(no internal text|items named by title|no false denial)/;

/** The run's variables: the environment (`{NAME}`) and EVAL_VARS_FILE (`{{name}}`, nested objects as `{{a.b}}`). */
function runVars(): Vars {
  const file = process.env.EVAL_VARS_FILE;
  return { ...process.env, ...(file ? flatVars(JSON.parse(readFileSync(file, "utf8"))) : {}) };
}
const VARS = runVars();
const VARS_CMD = process.env.EVAL_VARS_CMD;
/**
 * The words of an EVAL_*_CMD: a program and its arguments separated by spaces, run as they are, never through a shell (no quoting,
 * no expansion; a script that needs a shell is a file the program runs).
 */
/** How a command failed: its signal, its exit status, or why it could not start (ENOENT: no such program). */
function commandFailure(err: unknown): string {
  const e = err as { status?: number | null; signal?: string | null; code?: string };
  return e.signal ?? (typeof e.status === "number" ? `exit ${e.status}` : e.code ?? "?");
}
function commandWords(cmd: string): string[] {
  const words = cmd.trim().split(/\s+/).filter(Boolean);
  if (!words.length) { console.error("an EVAL_*_CMD is empty"); process.exit(2); }
  return words;
}
const FRESH = freshSessionEvery(process.env.EVAL_FRESH_SESSION_EVERY);
if (!FRESH) { console.error("EVAL_FRESH_SESSION_EVERY must be an integer in 0..100000 or attempt"); process.exit(2); }
const FRESH_EVERY = FRESH.cases;
const FRESH_ATTEMPT = FRESH.attempt;
const SEND_TOKEN_CMD = process.env.EVAL_SEND_TOKEN_CMD;
const sendTokens: string[] = [];   // every token EVAL_SEND_TOKEN_CMD gave: scrubbed like the key
let sendTokenCached: { token: string; until: number } | null = null;
let ME_USER_ID: string | null = null;   // the identity's user id (`/v1/me`): how the server's "on it" line of a turn is known by its id

/**
 * A signed-in access token of the key's identity for the messages the run sends (EVAL_SEND_TOKEN_CMD prints it): a message sent with
 * it is one the person sent signed in (`attendedTurn`), so what only such a message allows (a memory or a setting written, a
 * confirmation answered) is graded as a person gets it. Asked for again a minute before its `exp`. Never printed or written.
 */
function sendToken(): string {
  if (sendTokenCached && Date.now() < sendTokenCached.until) return sendTokenCached.token;
  let token: string;
  try {
    const [program, ...args] = commandWords(SEND_TOKEN_CMD!);
    token = execFileSync(program!, args, { encoding: "utf8", timeout: 120_000, stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch (err) {
    throw new Error(`infra: EVAL_SEND_TOKEN_CMD failed (${commandFailure(err)})`);
  }
  if (!token || /\s/.test(token)) throw new Error("infra: EVAL_SEND_TOKEN_CMD printed no token");
  sendTokens.push(token);
  let exp = 0;
  try { exp = Number(JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")).exp) * 1000; } catch { /* not a JWT: asked for each time */ }
  sendTokenCached = { token, until: Number.isFinite(exp) && exp > 0 ? exp - 60_000 : 0 };
  return token;
}
/**
 * A request sent with the signed-in token, only one `tokenRequestRefusal` lets through (the person's message, a `deny`, whose token
 * it is): anything else throws before it is sent. The key goes beside it in `x-api-key`, as a channel that may bring the person's own
 * key sends it, so a turn started by a service's delegated token runs on the identity's own keys.
 */
function tokenApi(method: string, path: string, body?: unknown): ReturnType<typeof api> {
  const refusal = tokenRequestRefusal(method, path, body);
  if (refusal) throw new Error(`refusing to send with the signed-in token: ${refusal}`);
  return api(method, path, body, sendToken(), { "x-api-key": KEY });
}
const GAP_MS = int("EVAL_GAP_S", 0, 0, 3_600) * 1000;
const INFRA_RETRY = int("EVAL_INFRA_RETRY", 1, 0, 1) === 1;
const SAY_GRACE_MS = int("EVAL_SAY_GRACE_S", 5, 0, 120) * 1000;

/**
 * The run's variables for one case: EVAL_VARS_CMD's (a JSON object on its stdout, run now, before the case) over the run's. Values that
 * move (a count of open pull requests) are then read right before the case that names them. A command that fails, or prints no
 * JSON object, is the run's error for that case: it is never graded against values from before.
 */
function caseVars(): Vars {
  if (!VARS_CMD) return VARS;
  let out: string;
  try {
    const [program, ...args] = commandWords(VARS_CMD);
    out = execFileSync(program!, args, { encoding: "utf8", timeout: 120_000, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 4 << 20 });
  } catch (err) {
    throw new Error(`infra: EVAL_VARS_CMD failed (${commandFailure(err)}): not graded`);
  }
  let json: unknown;
  try { json = JSON.parse(out); } catch { throw new Error("infra: EVAL_VARS_CMD printed no JSON: not graded"); }
  if (json === null || typeof json !== "object" || Array.isArray(json)) throw new Error("infra: EVAL_VARS_CMD printed no JSON object: not graded");
  return { ...VARS, ...flatVars(json) };
}
/** The router's reads as allow-list entries: the only MCP tools an `mcp:` oracle may call. */
const ROUTER_READS = Object.keys(readTools.ROUTER_READ_TOOLS).flatMap((s) => readTools.readToolPatterns(s));
const RUN_ITEMS = new Set<string>();   // ids of the items the run's own turns started: the only items it ever closes
const CLEARED = new Set<string>();     // of those, the ones closed with their worker's session deleted
const RUN_MESSAGES: string[] = [];     // every message the run sent to the assistant, to tie items to it after a stop
const OWN_SESSIONS = new Set<string>(); // the only sessions the run ever deletes: made by it, or answered for its own items
const CLEANUP_ISSUES: string[] = [];   // what closing an item could not finish: it fails the run
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// --- Stopping -------------------------------------------------------------------------------------------------------

/**
 * SIGINT or SIGTERM stops the run between two steps: nothing more is sent, the attempt under way ends as interrupted, and
 * the cleanup runs as after the last case. A second signal exits at once, without it. (npm exec does not pass a signal sent to
 * it on to the runner: send it to the runner's own process, or start it with `node --import tsx`.)
 */
class Interrupted extends Error {}
let stopSignal: string | null = null;
const wakers = new Set<() => void>();
function stopOn(signal: NodeJS.Signals): void {
  if (stopSignal) { console.error(`${signal} again: exiting now, without cleaning up`); process.exit(130); }
  stopSignal = signal;
  log(`${signal}: nothing more is sent; cleaning up what the run started (${signal} again exits at once, without it)`);
  for (const wake of wakers) wake();
}
/** Throws once the run was asked to stop: before anything is sent, and in every wait of an attempt. */
const live = (): void => { if (stopSignal) throw new Interrupted(`stopped by ${stopSignal}`); };
/** A pause a stop cuts short. */
async function pause(ms: number): Promise<void> {
  live();
  await new Promise<void>((resolve) => {
    const done = (): void => { clearTimeout(timer); wakers.delete(done); resolve(); };
    const timer = setTimeout(done, ms);
    wakers.add(done);
  });
  live();
}
/** `until` for an attempt's waits: a stop ends it with Interrupted. */
const waitFor = <T>(probe: () => Promise<T | undefined> | T | undefined, deadlineAt: number, everyMs: number): Promise<T | null> =>
  until(async () => { live(); return probe(); }, deadlineAt, everyMs);

// --- The run's own sessions -------------------------------------------------------------------------------------------

/** Delete a session the run made, and see it gone (`deleteSessionConfirmed`); one it did not make is never deleted. */
async function deleteOwn(sessionId: string): Promise<boolean> {
  if (!OWN_SESSIONS.has(sessionId)) throw new Error(`session ${sessionId} is not the run's own: not deleted`);
  return deleteSessionConfirmed(api, sessionId, Date.now() + 60_000, 5_000);
}

// --- The live stream of a session ---------------------------------------------------------------------------------

/** Every time a stream of the run was opened again, and why (it dropped, or the run reopened it to fill a gap). */
const REOPENED: Array<{ at: number; why: "dropped" | "forced" }> = [];

/**
 * Every event of a session that arrives on its stream, with the time it arrived here. With `skipHistory` what the
 * session held before the stream opened is left out (the assistant's earlier conversation). The stream is reopened
 * when it drops, and when the run finds a stored event it did not deliver (`reopen`: a stream can stall without
 * dropping); an event stored while it was down arrives with the new stream's history and is taken with the time it
 * was seen, so a gap only makes a latency look longer, never shorter. Each reopening is logged and kept in REOPENED.
 */
class LiveStream {
  readonly events: LiveEvent[] = [];
  private readonly seen = new Set<string>();
  private closed = false;
  private abort = new AbortController();
  private first = true;
  private forced = false;
  /** Called when the next stream's history has been read (`reopen`). */
  private readonly onHistory: Array<() => void> = [];

  constructor(private readonly sessionId: string, private readonly skipHistory: boolean) {}

  async open(): Promise<void> {
    let ready!: () => void;
    const historyDone = new Promise<void>((r) => { ready = r; });
    void (async () => {
      while (!this.closed) {
        this.forced = false;
        try { await this.read(ready); } catch { /* dropped, or reopened on purpose: reopened below */ }
        if (this.closed) break;
        const why = this.forced ? "forced" : "dropped";
        if (this.forced) this.forced = false; else await sleep(2_000);
        if (this.closed) break;
        REOPENED.push({ at: Date.now(), why });
        log(`the stream of ${this.sessionId} is opened again (${why === "forced" ? "a stored event was not delivered" : "it dropped"})`);
      }
    })();
    // A stop ends the wait as well: the cleanup's own wait follows.
    await Promise.race([historyDone, sleep(60_000), new Promise<void>((r) => { if (stopSignal) r(); else wakers.add(r); })]);
  }

  private async read(ready: () => void): Promise<void> {
    this.abort = new AbortController();
    const res = await fetch(`${CLAW}/v1/chat/sessions/${this.sessionId}/messages`, {
      headers: { authorization: `Bearer ${KEY}`, accept: "text/event-stream" }, signal: this.abort.signal,
    });
    if (res.status !== 200 || !res.body) throw new Error(`stream answered ${res.status}`);
    const decoder = new TextDecoder();
    let buffer = "";
    let live = false;
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true });
      const { frames, rest } = sseFrames(buffer);
      buffer = rest;
      for (const f of frames) {
        if (f.event === "historyComplete") { live = true; ready(); for (const done of this.onHistory.splice(0)) done(); continue; }
        let data: Record<string, any>;
        try { data = JSON.parse(f.data); } catch { continue; }
        const id = f.id || `${data.type}:${data.say_id ?? data.actionId ?? ""}:${data.status ?? ""}:${data.message_id ?? ""}`;
        if (this.seen.has(id)) continue;
        this.seen.add(id);
        if (!live && this.first && this.skipHistory) continue;
        this.events.push({ at: Date.now(), eventId: id, data });
      }
      if (live) this.first = false;
    }
  }

  /**
   * Open the stream again now, and wait (up to `ms`) until the new stream's history is read: what was stored and not delivered
   * comes with it. False when that history did not come in time.
   */
  async reopen(ms = 30_000): Promise<boolean> {
    if (this.closed) return false;
    let timer: NodeJS.Timeout | undefined;
    let wake: (() => void) | undefined;
    // A stop ends the wait as well, as in `open`: the cleanup's own wait follows.
    const read = new Promise<boolean>((r) => {
      this.onHistory.push(() => r(true));
      timer = setTimeout(() => r(false), ms);
      wake = () => r(false);
      if (stopSignal) r(false); else wakers.add(wake);
    });
    this.forced = true;
    this.abort.abort();
    try { return await read; } finally { clearTimeout(timer); if (wake) wakers.delete(wake); }
  }

  close(): void { this.closed = true; this.abort.abort(); for (const done of this.onHistory.splice(0)) done(); }
}

// --- Reads --------------------------------------------------------------------------------------------------------

async function board(): Promise<ItemSeen[]> {
  const r = await api("GET", "/v1/work-items");
  if (r.status !== 200 || !Array.isArray(r.json?.data)) throw new Error(`board answered ${r.status}`);
  return (r.json.data as any[]).map((i) => ({
    item_id: String(i.item_id), seq: Number(i.seq), title: String(i.title ?? ""), kind: String(i.kind ?? "task"),
    board_state: String(i.board_state), can_accept: i.can_accept === true, result_version: Number(i.result_version ?? 0),
    outcome: i.outcome ?? null,
  }));
}

async function replay(sessionId: string): Promise<EventRow[]> {
  const r = await api("GET", `/v1/chat/sessions/${sessionId}/messages?mode=replay`);
  if (r.status !== 200 || !Array.isArray(r.json?.data)) throw new Error(`replay answered ${r.status}`);
  return r.json.data as EventRow[];
}

/** The tool calls of an item's worker; [] for an item that names none. Throws when the item or the worker's events cannot be read. */
async function workerCalls(itemId: string): Promise<ToolCall[]> {
  const r = await api("GET", `/v1/work-items/${itemId}`);
  if (r.status !== 200) throw new Error(`the item answered ${r.status}`);
  const sid = r.json?.data?.worker_session_id;
  if (typeof sid !== "string" || !sid) return [];
  return withToolFailures(traceOf(await replay(sid)).calls);
}

/**
 * Reads whose failure leaves `fallback` and records why in `unread`: a read that failed is not evidence, so an attempt with
 * one is the run's error (after its cleanup), never graded on what is missing.
 */
const reading = (unread: string[]) => async <T>(what: string, p: Promise<T>, fallback: T): Promise<T> => {
  try { return await p; } catch (err) { unread.push(`${what} (${err instanceof Error ? err.message : String(err)})`); return fallback; }
};

/** The board, read again for a while when a read fails (the cleanup's reads); null when it could not be read in that time. */
const boardWithin = (ms: number): Promise<ItemSeen[] | null> => until(async () => board().catch(() => undefined), Date.now() + ms, 3_000);

async function idle(sessionId: string, waitMs: number): Promise<boolean> {
  return (await waitFor(async () => {
    const r = await api("GET", `/v1/sessions/${sessionId}`).catch(() => null);
    return r?.status === 200 && r.json?.data?.agent_status !== "running" ? true : undefined;
  }, Date.now() + waitMs, 2_000)) === true;
}

/** The values each fact expects, read now with the eval identity: the Claw API, GitHub, or a read tool of the plugin. */
async function factValues(c: EvalCase): Promise<Array<string[] | null>> {
  const out: Array<string[] | null> = [];
  for (const [k, f] of (c.facts ?? []).entries()) {
    const o = f.oracle;
    const q = oracleQuery(o);
    if (!q) { out.push(o && o.kind !== "api" && o.value !== undefined ? [o.value] : null); continue; }
    // An oracle that could not be read (an error status, an outage, a server it may not call) says nothing about the answer:
    // the attempt is the run's error, before anything is sent; never a pass, never the assistant's FAIL. One that was read and
    // picked nothing expects something unnamed, and the fact fails.
    try { out.push(await readOracle(q)); } catch (err) {
      throw new Error(`infra: the oracle of fact ${k + 1} could not be read (${err instanceof Error ? err.message : String(err)}): not graded`);
    }
  }
  return out;
}

async function readOracle(q: OracleQuery): Promise<string[]> {
  if (q.via === "claw") {
    const r = await api("GET", q.path);
    if (r.status !== 200) throw new Error(`the Claw API answered ${r.status}`);
    return oracleValues(r.json, q);
  }
  if (q.via === "github" || q.via === "github-graphql") {
    const tokenFile = process.env.EVAL_GITHUB_TOKEN_FILE;
    const token = tokenFile ? readFileSync(tokenFile, "utf8").trim() : "";
    const root = (process.env.EVAL_GITHUB_API || "https://api.github.com").replace(/\/+$/, "");
    const headers = { accept: "application/vnd.github+json", ...(token ? { authorization: `Bearer ${token}` } : {}) };
    const res = q.via === "github"
      ? await fetch(`${root}${q.path}`, { headers, signal: AbortSignal.timeout(30_000) })
      // GraphQL needs a token; a query only (`oracleQuery` takes no mutation).
      : await fetch(`${root}/graphql`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ query: q.query }), signal: AbortSignal.timeout(30_000) });
    if (res.status !== 200) throw new Error(`GitHub answered ${res.status}`);
    const json = await res.json() as { errors?: unknown[] };
    // GraphQL answers a refused query with 200 and `errors`: nothing was read.
    if (q.via === "github-graphql" && Array.isArray(json?.errors) && json.errors.length) throw new Error("GitHub GraphQL answered errors");
    return oracleValues(json, q);
  }
  if (!oracleMayRun(q, ROUTER_READS)) throw new Error(`mcp:${q.server}/${q.tool} is not one of the router's reads`);
  const client = await mcpClient(q.server);
  const r = await client.callTool({ name: q.tool, arguments: q.args }) as { content?: Array<{ type: string; text?: string }>; isError?: boolean };
  const text = r.content?.find((x) => x.type === "text")?.text ?? "";
  if (r.isError) throw new Error(`mcp:${q.server}/${q.tool} answered an error`);
  let json: unknown = text;
  try { json = JSON.parse(text); } catch { /* a plain-text answer: picked as it is */ }
  return oracleValues(json, q);
}

const mcpClients = new Map<string, Promise<Client>>();
/** A client of one of the oracle plugin's MCP servers, as Brain connects to it, with the eval identity's key. */
function mcpClient(server: string): Promise<Client> {
  let c = mcpClients.get(server);
  if (!c) {
    c = (async () => {
      const id = process.env.EVAL_ORACLE_PLUGIN_ID || process.env.EVAL_PLUGIN_ID;
      if (!id) throw new Error("mcp: oracles need EVAL_ORACLE_PLUGIN_ID");
      const r = await api("GET", `/v1/plugins/${encodeURIComponent(id)}`);
      const specs = ((r.json?.data?.tools ?? []) as Array<{ type?: string; config?: { mcpServers?: Record<string, Record<string, unknown>> } }>)
        .filter((t) => String(t.type).toLowerCase() === "mcp").map((t) => t.config?.mcpServers?.[server]).filter(Boolean);
      const spec = specs[0];
      if (!spec || typeof spec.url !== "string") throw new Error(`plugin ${id} has no MCP server ${server}`);
      // The key goes only where the operator said MCP oracles may send it: a host of EVAL_ORACLE_MCP_HOSTS (default: the Claw
      // API's own host), and only where the spec asks for it by the placeholder Brain fills with the caller's key. A spec that
      // names another host, or a plugin that points a known server name somewhere else, gets nothing and its oracle fails.
      const target = oracleMcpTarget(spec, (process.env.EVAL_ORACLE_MCP_HOSTS || new URL(CLAW).host).split(","), KEY);
      if (typeof target === "string") throw new Error(`MCP server ${server} of plugin ${id}: ${target}`);
      const { url, headers } = target;
      const client = new Client({ name: "sa-eval-oracle", version: "1.0.0" });
      await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers } }));
      return client;
    })();
    // A connection that failed is tried again by the next oracle, not remembered as the server's answer.
    c.catch(() => mcpClients.delete(server));
    mcpClients.set(server, c);
  }
  return c;
}

// --- The optional judge ---------------------------------------------------------------------------------------------

/** The judge's verdict; `failed` when it gave none (unreachable, an error status, no PASS or FAIL): the run's, not the assistant's. */
// The gateway's Sonnet answers with a thinking block first: 200 tokens could leave no text, and the attempt became an error
// ("judge gave no PASS or FAIL") rather than a grade.
const JUDGE_MAX_TOKENS = int("EVAL_JUDGE_MAX_TOKENS", 1024, 64, 16_384);

/** One ask of the judge: its verdict, its reason (300 characters) and its whole answer (`text`), keys scrubbed. */
interface JudgeVote { pass: boolean; why: string; text?: string; failed?: true }

/**
 * The judge's verdict on an attempt. A FAIL on an attempt every deterministic check passed (`checksPass`) is asked again, and a third
 * time when the two disagree: the majority decides, so one bad sample does not fail a right answer (E249: a judge that held a newer
 * ROCm version than it knew to be made up). Every vote is kept. A vote the judge did not give makes it the run's error.
 */
async function judge(c: EvalCase, turns: Turn[], o: Observed, checksPass: boolean): Promise<(JudgeVote & { votes?: JudgeVote[] }) | null> {
  const url = process.env.EVAL_JUDGE_URL, model = process.env.EVAL_JUDGE_MODEL, keyFile = process.env.EVAL_JUDGE_KEY_FILE;
  // Every case, not only those with content only a judge can grade: the no-false-denial rule is in every prompt.
  if (!url || !model || !keyFile) return null;
  const key = readFileSync(keyFile, "utf8").trim();
  const prompt = judgePrompt(c, turns, o.final, o.calls, o.factValues);
  const first = await judgeOnce(url, model, key, prompt);
  if (first.failed || first.pass || !checksPass) return first;
  const votes = [first, await judgeOnce(url, model, key, prompt)];
  if (!votes[1]!.failed && votes[1]!.pass) votes.push(await judgeOnce(url, model, key, prompt));
  const failed = votes.find((v) => v.failed);
  if (failed) return { ...failed, votes };
  const passes = votes.filter((v) => v.pass).length;
  const pass = passes * 2 > votes.length;
  return { ...votes.find((v) => v.pass === pass)!, pass, votes };
}

async function judgeOnce(url: string, model: string, key: string, prompt: string): Promise<JudgeVote> {
  // An answer without a verdict, a gateway that is busy or down (429, 5xx) and a request that failed are asked once more: the
  // gateway's model sometimes spends its turn on a thinking block, or reasons first and gives no verdict line. The second ask of a
  // verdict-less answer says what was missing. Only then is it the run's error.
  let why = "judge gave no PASS or FAIL";
  let noVerdict = false;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const content = noVerdict ? prompt + JUDGE_RETRY_NOTE : prompt;
      const res = await fetch(`${url.replace(/\/+$/, "")}/v1/messages`, {
        method: "POST", signal: AbortSignal.timeout(60_000),
        headers: { "content-type": "application/json", "x-api-key": key, authorization: `Bearer ${key}`, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model, max_tokens: JUDGE_MAX_TOKENS, messages: [{ role: "user", content }] }),
      });
      if (!res.ok) {
        why = `judge answered ${res.status}`;
        if (res.status === 429 || res.status >= 500) continue;
        return { pass: false, why, failed: true };
      }
      const body = (await res.json()) as any;
      const text = (Array.isArray(body?.content) ? body.content : []).filter((b: any) => b?.type === "text").map((b: any) => String(b.text ?? "")).join("\n");
      const word = judgeVerdict(text);
      if (word) {
        const whole = scrubWith(text.trim(), [KEY, key, ...sendTokens]);
        return { pass: word === "PASS", why: whole.slice(0, 300), text: whole };
      }
      why = `judge gave no PASS or FAIL (stop_reason ${String(body?.stop_reason ?? "?")}, ${text.length} chars of text)`;
      noVerdict = true;
    } catch (err) {
      why = `judge failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
  return { pass: false, why, failed: true };
}

/** Every deterministic check passed: what is left to decide is the judge's (`verdictOf`). */
const checksPassed = (checks: readonly Check[]): boolean => checks.every((x) => x.pass && (!x.unverified || x.name === "no false denial"));

const attemptOf = async (c: EvalCase, turns: Turn[], observed: Observed, tools: string[], items: Attempt["items"]): Promise<Attempt> => {
  const o = c.expect_memory?.length || c.expect_no_memory?.length ? { ...observed, madeMemories: await madeMemories() } : observed;
  const checks = grade(c, o);
  const verdict = await judge(c, turns, o, checksPassed(checks));
  // The recording keeps the judge's whole answers; the results keep each reason (keys scrubbed, 300 characters), with or without
  // EVAL_KEEP_TEXT: without it a FAIL could not be looked into.
  const short = (v: JudgeVote): { pass: boolean; why: string } => ({ pass: v.pass, why: scrub(v.why) });
  if (RECORD_DIR) {
    recordings.push({ case_id: c.id, mode: MODE, attempt: recordings.filter((r) => r.case_id === c.id).length + 1, at: iso(), observed: forRecording(c, o),
      ...(verdict ? { judge: { pass: verdict.pass, ...(verdict.failed ? { failed: true } : {}), answers: (verdict.votes ?? [verdict]).map((v) => v.text ?? v.why) } } : {}) });
  }
  const kept = KEEP_TEXT ? checks : checks.map((x) => (TEXT_DETAIL.test(x.name) && x.detail ? { ...x, detail: "<hidden: EVAL_KEEP_TEXT>" } : x));
  return {
    // A judge that gave no verdict makes the attempt an error of the run, never a FAIL of the assistant.
    ...(verdict?.failed ? { pass: false, error: scrub(`infra: ${verdict.why}`) } : verdictOf(c, checks, verdict)), checks: kept, route: o.route, cards: o.cards, tools, final: KEEP_TEXT ? scrub(o.final) : null, finalChars: o.final.length,
    firstReplyMs: o.firstReplyMs, finalMs: o.finalMs, items,
    judge: verdict && { ...short(verdict), ...(verdict.votes ? { votes: verdict.votes.map(short) } : {}) },
  };
};

// --- One attempt on the assistant path ------------------------------------------------------------------------------

/**
 * The files of a turn, as a channel sends them: uploaded to the assistant's session (`POST /v1/sessions/:id/upload`, one folder per
 * turn) and named beside the message (`channel_context.files`, with the path the upload answered).
 */
async function uploadFiles(sessionId: string, folder: string, files: readonly TurnFile[]): Promise<Array<Record<string, unknown>>> {
  const form = new FormData();
  const named: Array<{ name: string; type: string; size: number }> = [];
  for (const f of files) {
    const bytes = readFileSync(join(CASES_DIR, f.fixture));
    const name = f.name ?? basename(f.fixture);
    const type = f.media_type ?? "application/octet-stream";
    form.append("file", new Blob([bytes], { type }), `${folder}/${name}`);
    named.push({ name, type, size: bytes.length });
  }
  const res = await fetch(`${CLAW}/v1/sessions/${sessionId}/upload?ttl_days=1`, {
    method: "POST", headers: { authorization: `Bearer ${KEY}` }, body: form, signal: AbortSignal.timeout(120_000),
  });
  const out = await res.json().catch(() => null) as { uploaded?: Array<{ path?: string }> } | null;
  const uploaded = new Set((out?.uploaded ?? []).map((u) => u.path));
  if (res.status !== 200 || named.some((n) => !uploaded.has(`${folder}/${n.name}`))) throw new Error(`upload answered ${res.status}`);
  return named.map((n) => ({ path: `${folder}/${n.name}`, name: n.name, media_type: n.type, size: n.size }));
}

async function runAssistant(c: EvalCase, turns: Turn[], session: AssistantSession): Promise<Attempt> {
  const { id: sessionId, stream } = session;
  // Never into a conversation still going: its messages and items would be taken for this case's.
  if (!(await idle(sessionId, turnWaitMs(true)))) throw new Error(`the assistant session was still running ${turnWaitMs(true) / 1000} s before ${c.id}: nothing sent, not graded`);
  const floor = Math.max(0, ...(await board()).map((i) => i.seq));
  const values = await factValues(c);
  const start = Date.now();
  const messageIds: string[] = [];
  const sentAt: number[] = [];
  // The Router's turn for each message ends (each is short: it answers or hands the work on), each within the wait from its own
  // message, watched from when it is sent; one that has not is not graded: what was seen of it is part of a turn.
  const over: Array<Promise<boolean>> = [];
  try {
    for (const t of turns) {
      const wait = start + (t.after_ms ?? 0) - Date.now();
      if (wait > 0) await pause(wait);
      live();
      const files = t.files?.length ? await uploadFiles(sessionId, `sa-eval/${c.id}-${messageIds.length + 1}-${Date.now()}`, t.files) : [];
      const at = Date.now();
      // A message whose answer was lost (or a 5xx) may still have been taken: its turn is waited for at the end, unnamed.
      // Sent signed in when EVAL_SEND_TOKEN_CMD gives a token (the person's own message, `attendedTurn`), else with the key.
      const path = `/v1/sessions/${sessionId}/messages`;
      const body = turnMessageBody(t, files);
      const r = await (SEND_TOKEN_CMD ? tokenApi("POST", path, body) : api("POST", path, body, KEY))
        .catch((err) => { session.unknownSends++; throw err; });
      if (r.status >= 500) session.unknownSends++;
      const id = r.json?.message_id;
      if (r.status !== 200 || typeof id !== "string") throw new Error(`message answered ${r.status}`);
      RUN_MESSAGES.push(id);
      session.messages.push(id);
      messageIds.push(id);
      sentAt.push(at);
      over.push(turnsOver(sessionId, (stored) => stored.includes(id), () => turnEnded(stream.events, id), at + turnWaitMs(true), waitFor));
    }
  } finally {
    // A watch left behind by a failed send or a stop ends on its own; what it answers is not read.
    for (const w of over) w.catch(() => undefined);
  }
  const ended = await Promise.all(over);
  const late = messageIds.filter((_, k) => !ended[k]);
  if (late.length) throw new Error(`no end of the turn of ${late.join(",")} within ${turnWaitMs(true) / 1000} s of its message: not graded`);
  // A turn whose router said nothing gets the server's own reply (a fallback say) a moment after its end: each turn's first say is
  // waited for a little (EVAL_SAY_GRACE_S), so that reply is graded and timed rather than taken for no answer.
  // The server's "on it" line said while the turn worked is not that reply: the answer said after the turn's end takes its place.
  if (SAY_GRACE_MS) {
    await waitFor(() => (turnsAnswered(saysOf(stream.events), messageIds, ME_USER_ID) ? true : undefined), Date.now() + SAY_GRACE_MS, 200);
  }
  // A card the server shows after the turn's end (a skill it drafted from the turn): waited for, up to the case's card_wait_s.
  if (c.card_wait_s && (c.cards === "confirm" || c.cards === "accept")) {
    const want = c.cards;
    await waitFor(() => (cardsOf(caseSays(saysOf(stream.events), [messageIds.at(-1)!], [])) === want ? true : undefined),
      Date.now() + Math.min(c.card_wait_s, 120) * 1000, 500);
  }
  // The case's items are only those its own turns started (read from their work_create / review_start answers): an item
  // someone else put on the board meanwhile (a review asked of this identity) is neither graded nor closed here.
  const started = turnCalls(stream.events, messageIds);
  const mine = (all: ItemSeen[]): ItemSeen[] => itemsStartedBy(started, all.filter((i) => i.seq > floor), RUN_ITEMS);
  // The highest item number on the board: a "#n" above it in a reply is no item of the person's (items-named-by-title).
  let seqMax = 0;
  const onBoard = (all: ItemSeen[]): ItemSeen[] => { for (const i of all) seqMax = Math.max(seqMax, i.seq); return all; };
  let items = mine(onBoard(await board()));
  for (const i of items) RUN_ITEMS.add(i.item_id);
  // A request the case's item holds for its person: answered the way that person's channel answers it.
  const hold = c.hold && items.length ? await answerHold(c.hold, items, start + (c.item_wait_s ?? ITEM_WAIT_SEC) * 1000) : undefined;
  const unread: string[] = [];
  const read = reading(unread);
  if (items.length) {
    // The item's result (or question, or failure; or its end, for a case that stops it), then what was said about it. The items
    // graded are the last ones read: a board that could not be read at the end gives none (an error, not a stale state).
    const settled = (is: ItemSeen[]): boolean => is.every((i) => (c.items_closed ? i.board_state === "done" : i.board_state !== "in_progress"));
    let boardError: string | null = null;
    await waitFor(async () => {
      try { items = mine(onBoard(await board())); boardError = null; } catch (err) { boardError = err instanceof Error ? err.message : String(err); }
      return !boardError && settled(items) ? true : undefined;
    }, start + (c.item_wait_s ?? ITEM_WAIT_SEC) * 1000, 5_000);
    if (boardError) unread.push(`the board (${boardError})`);
    await waitFor(() => (items.every((i) => i.board_state === "in_progress"
      || saysOf(stream.events).some((s) => s.itemId === i.item_id && s.itemState !== "in_progress")) ? true : undefined), Date.now() + 30_000, 1_000);
  }
  // What is graded is what the stream showed, so only when it showed every stored event of the case's turns and of what was
  // said about its items (a stream stalled without dropping would hide a leak, a card or a work_create). A gap opens the stream
  // again at once (its history brings what was stored), and then it gets 15 s to catch up.
  const missed = async (): Promise<string[]> => streamMissed(await replay(sessionId).catch(() => null), stream.events, messageIds, items.map((i) => i.item_id));
  let gaps = await missed();
  if (gaps.length) {
    await stream.reopen();
    await waitFor(async () => ((gaps = await missed()).length ? undefined : true), Date.now() + 15_000, 3_000);
  }
  // What is graded is the last turn (earlier turns are its context and may start items of their own): its Router turn's
  // calls, the items that turn started and their workers' calls, what was said in it and about those items. Leaks are
  // looked for in everything the case showed; latencies run from the last turn's sending.
  const says = saysOf(stream.events);
  const lastId = messageIds.at(-1)!;
  const lastSent = sentAt.at(-1)!;
  const lastRouter = turnCalls(stream.events, [lastId]);
  const lastItems = itemsStartedBy(lastRouter, items, RUN_ITEMS);
  const lastIds = lastItems.map((i) => i.item_id);
  const lastCalls = [...lastRouter];
  for (const i of lastItems) lastCalls.push(...(await read(`item ${i.seq}'s worker calls`, workerCalls(i.item_id), [])));
  const lastSays = caseSays(says, [lastId], lastIds);
  const final = finalSay(says, [lastId], lastIds);
  const shown = caseSays(says, messageIds, items.map((i) => i.item_id));
  const firstOwn = lastSays.length ? Math.min(...lastSays.map((s) => s.at)) : null;
  const observed: Observed = {
    mode: MODE, route: routeOf(lastItems, lastRouter, lastSays), cards: cardsOf(lastSays), calls: lastCalls, shown: shown.map((s) => s.text),
    final: final?.text ?? "", finalChoices: final?.choices.length ?? 0,
    firstReplyMs: firstOwn === null ? null : firstOwn - lastSent, finalMs: final ? final.at - lastSent : null,
    replyMs: messageIds.map((id, k) => { const s = says.find((x) => x.turn === id); return s ? s.at - sentAt[k]! : null; }),
    items, factValues: values, delivered: filesFrom(says, lastIds), ownSays: ownSays(says, lastId, ME_USER_ID), ...(hold ? { hold } : {}), ...(seqMax ? { itemSeqMax: seqMax } : {}),
  };
  const allCalls = [...turnCalls(stream.events, messageIds)];
  for (const i of items) if (!lastIds.includes(i.item_id)) allCalls.push(...(await read(`item ${i.seq}'s worker calls`, workerCalls(i.item_id), [])));
  allCalls.push(...lastCalls.filter((x) => !lastRouter.includes(x)));
  // Clean up: everything the attempt started is accepted (a result that waits, at its version) or stopped.
  const cleaned: Attempt["items"] = [];
  for (const i of mine(await board().catch(() => items))) {
    RUN_ITEMS.add(i.item_id);
    const seen = items.find((x) => x.item_id === i.item_id) ?? i;
    cleaned.push({ seq: i.seq, kind: i.kind, board_state: seen.board_state, cleanup: await closeItem(i), last: lastIds.includes(i.item_id) });
  }
  if (gaps.length) throw new Error(`the stream missed ${gaps.length} stored event(s) of the case (${gaps.slice(0, 3).join(",")}): not graded`);
  if (unread.length) throw new Error(`infra: could not read ${unread.join("; ")}: not graded`);
  return attemptOf(c, turns, observed, allCalls.map((x) => x.name), cleaned);
}

/**
 * Wait for one of the case's items to hold a request `spec` names for its person (`params.holds`), then answer it as the person's
 * channel does: a `decision` or an `answer` on the worker's session, after `wait_s`. What is seen is graded (`grade`, `hold`).
 * Gives up when every item has gone on without such a request, or at the deadline.
 */
async function answerHold(spec: HoldSpec, items: readonly ItemSeen[], deadline: number): Promise<HoldSeen> {
  const seen: HoldSeen = { tool: null, cardMs: null, answered: null, heldAfterWait: null, ran: null };
  const want = toolPattern(spec.tool);
  const look = async (itemId: string): Promise<any> => {
    const r = await api("GET", `/v1/work-items/${itemId}`).catch(() => null);
    return r?.status === 200 ? r.json?.data : null;
  };
  const found = await until(async () => {
    let open = false;
    for (const i of items) {
      const d = await look(i.item_id);
      const waiting: any[] = Array.isArray(d?.params?.holds) ? d.params.holds : [];
      const h = waiting.find((x) => typeof x?.tool_use_id === "string" && want.test(String(x.tool)));
      if (d && h) {
        const held = (d.events ?? []).find((e: any) => e.source === "hold" && e.kind === "waiting" && e.result?.tool_use_id === h.tool_use_id);
        return { itemId: i.item_id, sid: String(d.worker_session_id), toolUseId: h.tool_use_id as string, tool: String(h.tool), heldAt: held ? Date.parse(held.created_at) : Date.now() };
      }
      if (!d || d.board_state === "in_progress" || waiting.length) open = true;
    }
    return open ? undefined : null;
  }, deadline, 1_000);
  if (!found) return seen;
  seen.tool = found.tool;
  const rows = await replay(found.sid).catch(() => []);
  const request = heldRequest(rows, found.toolUseId);
  if (request && Number.isFinite(request.ts)) seen.cardMs = found.heldAt - request.ts;
  if (spec.wait_s) {
    await sleep(spec.wait_s * 1000);
    const d = await look(found.itemId);
    seen.heldAfterWait = d?.board_state === "needs_you"
      && (Array.isArray(d?.params?.holds) ? d.params.holds : []).some((x: any) => x?.tool_use_id === found.toolUseId);
  }
  const body = spec.decide === "answer"
    ? { messageType: "answer", extData: { tool_use_id: found.toolUseId, answers: holdAnswers(spec, request?.questions), skipped: [] } }
    : { messageType: "decision", extData: { tool_use_id: found.toolUseId, action: spec.decide } };
  seen.answered = (await api("POST", `/v1/sessions/${found.sid}/messages`, body).catch(() => ({ status: 0 }))).status;
  // How the call ended: its own result after the answer, read off the worker's session.
  seen.ran = await until(async () => {
    const ran = heldCallRan(await replay(found.sid).catch(() => []), found.toolUseId);
    return ran === null ? undefined : ran;
  }, Date.now() + 120_000, 2_000);
  return seen;
}

/**
 * Whether turns of a session are over by `deadlineAt`, as `over` judges the message ids of their stored exec_complete
 * (`storedTurnEnds`). Brain sends exec_complete last, after the workspace sync and the transcript, and a stream never carries
 * it; the stream's end of a turn (`streamed`: its executionStats) only says it is finishing. So the stored events are read
 * once the stream says so, every `readEveryMs` whatever it says (10 s in an attempt; a turn whose delivery Brain gave up on
 * has exec_complete alone), and in the last 2 s before the deadline; never after it, so a turn that ends late is late, by this
 * runner's clock. `wait` is the `until` the caller's waits use (one a stop ends, or not).
 */
async function turnsOver(
  sessionId: string, over: (stored: readonly string[]) => boolean, streamed: () => boolean, deadlineAt: number,
  wait: <T>(probe: () => Promise<T | undefined>, deadlineAt: number, everyMs: number) => Promise<T | null>, readEveryMs = 10_000,
): Promise<boolean> {
  let readAt = 0;
  const probe = async (): Promise<true | undefined> => {
    if (!streamed() && Date.now() - readAt < readEveryMs && deadlineAt - Date.now() > 2_000) return undefined;
    readAt = Date.now();
    return over(storedTurnEnds(await replay(sessionId).catch(() => []))) ? true : undefined;
  };
  return (await wait(probe, deadlineAt, 1_000)) === true;
}

/**
 * Close one of the run's items (`close`), then delete its worker's session and see it gone: a session the server made for the
 * run's own item, read from that item. An item that did not close keeps its worker.
 */
async function closeItem(i: ItemSeen): Promise<string> {
  const how = await close(i);
  const r = await until(async () => {
    const got = await api("GET", `/v1/work-items/${i.item_id}`).catch(() => null);
    return got?.status === 200 && got.json?.data?.board_state === "done" ? got : undefined;
  }, Date.now() + 15_000, 1_000);
  if (!r) {
    const why = `#${i.seq} not seen closed (${how}): its worker's session kept`;
    CLEANUP_ISSUES.push(why);
    return why;
  }
  CLEARED.add(i.item_id);
  const sid = r.json.data.worker_session_id;
  if (typeof sid !== "string" || !sid) return how;
  OWN_SESSIONS.add(sid);
  if (await deleteOwn(sid)) return `${how}; worker session deleted`;
  sessionsLeft.push(sid);
  return `${how}; worker session ${sid} not deleted`;
}

async function close(i: ItemSeen): Promise<string> {
  const op = cleanupOf(i);
  if (!op) return "already closed";
  if (op.op === "accept") {
    const r = await api("POST", `/v1/work-items/${i.item_id}/accept`, { version: op.version });
    if (r.status === 200) return `accepted v${op.version}`;
  }
  const s = await api("POST", `/v1/work-items/${i.item_id}/stop`, {});
  return s.status === 200 ? "stopped" : `stop answered ${s.status}`;
}

// --- One attempt on a plain session (baseline) ------------------------------------------------------------------------

async function runBaseline(c: EvalCase, turns: Turn[]): Promise<Attempt> {
  const values = await factValues(c);
  live();
  const start = Date.now();
  // With an idempotency key, asked again (the same key) when the answer was lost or a 5xx: the API answers a repeat with the
  // session the first request made, so the run always knows the session it made, and deletes it.
  const key = randomUUID();
  const create = async (): Promise<{ status: number; json: any } | undefined> => {
    try {
      const res = await fetch(`${CLAW}/v1/sessions`, {
        method: "POST", signal: AbortSignal.timeout(30_000),
        headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json", "idempotency-key": key },
        body: JSON.stringify({ name: `sa-eval-${c.id}`, message: { content: turns[0]!.user, pluginId: PLUGIN_ID } }),
      });
      const json = await res.json().catch(() => null);
      return res.status >= 500 ? undefined : { status: res.status, json };
    } catch { return undefined; }
  };
  // A stop ends the asking: a repeat could be the request that makes the session, and nothing is sent after a stop.
  let created: Awaited<ReturnType<typeof create>> | null = await create();
  if (!created && !stopSignal) created = await until(async () => (stopSignal ? null : create()), Date.now() + 60_000, 5_000);
  if (!created) {
    CLEANUP_ISSUES.push(`the session of ${c.id} was asked for and never confirmed (idempotency key ${key}): one may be left`);
    live();
    throw new Error("the session's creation could not be confirmed in 60 s: not graded");
  }
  const sessionId: string | undefined = created.json?.data?.session_id;
  if (!sessionId) throw new Error(`create answered ${created.status}`);
  OWN_SESSIONS.add(sessionId);
  const stream = new LiveStream(sessionId, false);
  // Each turn's message id (the first came with the session) and when it was sent: what is graded of a turn is its own.
  const idOf = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
  const mids: Array<string | null> = [idOf(created.json?.data?.message?.message_id)];
  const sentAt: number[] = [start];
  const denied = new Set<string>();
  /** Turn k is over by the stored events: its own exec_complete, or (no id known) as many as turns sent. */
  const overBy = (k: number) => (stored: readonly string[]): boolean => (mids[k] ? stored.includes(mids[k]!) : stored.length >= k + 1);
  const streamedBy = (k: number) => (): boolean => (mids[k] ? turnEnded(stream.events, mids[k]!) : endedTurns(stream.events).length >= k + 1);
  // A reply is the main agent's message in that turn: a sub-agent's is not shown to the user, and would make a slow reply
  // look on time; another turn's (a message the stream delivered again after a reconnect) is not this turn's.
  // A message with no text shows nothing.
  const repliesOf = (k: number): LiveEvent[] => stream.events.filter((e) => e.data?.type === "AssistantMessage" && !e.data.subagent_id
    && messagesOf([e]).length > 0 && (mids[k] ? e.data.message_id === mids[k] : e.at >= sentAt[k]! && !mids.includes(idOf(e.data.message_id))));
  try {
    await stream.open();
    // The cases only read: every approval is denied, so a turn waiting on one does not hang the run. One that has not ended
    // in time is not graded: what was seen of it is part of a turn.
    const waitTurn = async (k: number): Promise<void> => {
      const over = await turnsOver(sessionId, overBy(k), streamedBy(k), sentAt[k]! + turnWaitMs(false), (probe, at, every) => waitFor(async () => {
        for (const e of stream.events) {
          const tid = e.data?.tool_use_id;
          if (e.data?.type !== "permissionRequest" || typeof tid !== "string" || denied.has(tid)) continue;
          denied.add(tid);
          live();
          await api("POST", `/v1/sessions/${sessionId}/messages`, { messageType: "decision", extData: { tool_use_id: tid, action: "deny" } });
        }
        return probe();
      }, at, every));
      if (!over) throw new Error(`no end of turn ${k + 1} within ${turnWaitMs(false) / 1000} s of its message: not graded`);
    };
    await waitTurn(0);
    for (const t of turns.slice(1)) {
      const wait = start + (t.after_ms ?? 0) - Date.now();
      if (wait > 0) await pause(wait);
      live();
      const at = Date.now();
      sentAt.push(at);
      const r = await api("POST", `/v1/sessions/${sessionId}/messages`, { content: t.user, messageType: "text", pluginId: PLUGIN_ID });
      mids.push(idOf(r.json?.message_id));
      if (r.status !== 200) throw new Error(`message answered ${r.status}`);
      await waitTurn(mids.length - 1);
    }
    // Every turn's exec_complete is stored (`waitTurn`), and Brain sends it last: the stored events are complete.
    let rows = await replay(sessionId);
    // Graded is what the stream showed, so only when it showed every stored event of the case's turns (15 s to catch up).
    const sentIds = mids.filter((m): m is string => !!m);
    let gaps = streamMissed(rows, stream.events, sentIds);
    if (gaps.length) {
      await stream.reopen();
      await waitFor(async () => {
        rows = await replay(sessionId).catch(() => rows);
        return (gaps = streamMissed(rows, stream.events, sentIds)).length ? undefined : true;
      }, Date.now() + 15_000, 3_000);
    }
    if (gaps.length) throw new Error(`the stream missed ${gaps.length} stored event(s) of the case (${gaps.slice(0, 3).join(",")}): not graded`);
    const all = traceOf(rows);
    const last = turns.length - 1;
    const lastMid = mids[last];
    const lastTrace = lastMid ? traceOf(rows, lastMid) : all;
    // What the user was shown: the main agent's messages as they streamed (a turn's end on a stream carries no text). The
    // final answer is the last turn's own, shown with its last message, which can be well before the turn's end (the
    // workspace sync follows it). Without one streamed, it is the main agent's final text its stored exec_complete has; never
    // a sub-agent's, nor an earlier turn's.
    const lastReplies = repliesOf(last);
    const storedFinal = rows.filter((r) => (r.data?.type ?? r.event_type) === "exec_complete" && !r.data?.subagent_id
      && (!lastMid || r.data?.message_id === lastMid)).at(-1)?.data?.final_text;
    const finalText = lastReplies.length ? messagesOf(lastReplies).at(-1) ?? "" : (typeof storedFinal === "string" ? storedFinal : "");
    // A final answer that only the stored exec_complete had is checked with what was shown as well.
    const streamed = messagesOf(stream.events);
    const shown = finalText && !streamed.includes(finalText) ? [...streamed, finalText] : streamed;
    const firstText = turns.map((_, k) => repliesOf(k)[0]?.at ?? null);
    const observed: Observed = {
      mode: MODE, calls: lastTrace.calls, shown, final: finalText,
      firstReplyMs: firstText[last] === null ? null : firstText[last]! - sentAt[last]!,
      finalMs: lastReplies.length ? lastReplies.at(-1)!.at - sentAt[last]! : null,
      replyMs: firstText.map((a, k) => (a === null ? null : a - sentAt[k]!)), items: [], factValues: values,
    };
    return attemptOf(c, turns, observed, all.calls.map((x) => x.name), []);
  } finally {
    // Stopped mid-case: the turns already sent are let end first (a minute at most), as in the assistant mode; deleting the
    // session would cut them off half done. Nothing is sent after the stop, a decision included: a turn waiting for one is cut
    // off when the session is deleted, and the call it waits for never runs.
    if (stopSignal) {
      const over = await turnsOver(sessionId, (stored) => mids.every((_, k) => overBy(k)(stored)), () => mids.every((_, k) => streamedBy(k)()),
        Date.now() + Math.min(60_000, turnWaitMs(false)), until, 2_000);
      if (!over) log(`a turn of ${c.id} was still running when its session was deleted`);
    }
    stream.close();
    if (!(await deleteOwn(sessionId))) { log(`could not delete session ${sessionId} of ${c.id}`); sessionsLeft.push(sessionId); }
  }
}

/**
 * Before each attempt: wait until the identity's counted says of the last hour (those an earlier run on this host saw, those
 * stored in the assistant session before the run, and the run's own), with EVAL_SAY_RESERVE more for the attempt, are within
 * EVAL_SAY_PER_HOUR (`sayWaitMs`). A stop ends the wait.
 */
async function paceSays(stream: LiveStream, prior: readonly SayMark[]): Promise<void> {
  for (let said = false; ;) {
    const wait = sayWaitMs(mergeSays([prior, countedSays(stream.events)], Date.now()).map((m) => m.at), Date.now(), sayPerHour, SAY_RESERVE);
    if (!wait) return;
    if (!said) { log(`say cap: waiting ${Math.ceil(wait / 1000)}s for room (pace ${sayPerHour} an hour: EVAL_SAY_PER_HOUR=${SAY_PER_HOUR}, EVAL_SAY_RESERVE=${SAY_RESERVE})`); said = true; }
    await pause(Math.min(wait, 60_000));
  }
}

/** EVAL_SAY_LOG, else a file per identity under the operator's own ~/.cache/sa-eval (not a shared temporary directory). */
const sayLogPath = (identity: string): string => process.env.EVAL_SAY_LOG
  || join(homedir(), ".cache", "sa-eval", `says-${createHash("sha256").update(identity.trim().toLowerCase()).digest("hex").slice(0, 16)}.jsonl`);

function readSayLog(file: string): SayMark[] {
  try { return parseSayLog(readFileSync(file, "utf8")); } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") log(`say log ${file} could not be read: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

/** The hour's counted says, for the next run on this host (written whole, then renamed into place). */
function writeSayLog(file: string, says: readonly SayMark[]): void {
  try {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(`${file}.tmp`, says.map((m) => JSON.stringify(m)).join("\n") + (says.length ? "\n" : ""), { mode: 0o600 });
    renameSync(`${file}.tmp`, file);
  } catch (err) {
    log(`say log ${file} could not be written (the next run will not see this run's says): ${err instanceof Error ? err.message : String(err)}`);
  }
}

// --- The assistant conversation ---------------------------------------------------------------------------------------

/** One assistant session the run works in, and what it knows of it. */
interface AssistantSession {
  id: string;
  stream: LiveStream;
  /** The run made it: it is deleted when the run is done with it. */
  created: boolean;
  /** Its stored events from before the run (none for one the run made), and the turns they ended. */
  before: EventRow[];
  historyAtStart: Set<string>;
  historyEnds: Set<string>;
  /** The messages the run sent to it, and how many more whose answer was lost (taken or not, the run cannot say). */
  messages: string[];
  unknownSends: number;
}

/**
 * An assistant session the run did not make, read now: its stored events, when nobody is using it (no turn running, no event within
 * EVAL_QUIET_S, not made a moment ago: `assistantInUse`). Otherwise, or when it cannot be read, the run is refused before anything is sent.
 */
async function quietOrRefuse(id: string): Promise<{ rows: EventRow[] }> {
  const s = await api("GET", `/v1/sessions/${id}`);
  if (s.status !== 200) { console.error(`refusing to run: GET of the assistant session answered ${s.status}`); process.exit(2); }
  const rows = await replay(id).catch(() => null);
  if (!rows) { console.error("refusing to run: the assistant session's events could not be read"); process.exit(2); }
  const lastAt = rows.reduce<number | null>((m, x) => { const t = Date.parse(x.created_at); return Number.isFinite(t) && (m === null || t > m) ? t : m; }, null);
  const busy = assistantInUse(s.json?.data ?? null, lastAt, Date.now(), QUIET_MS);
  if (busy) { console.error(`refusing to run: ${busy}; another run or a person is using this identity`); process.exit(2); }
  return { rows };
}

/** The counted says of an assistant session the run deleted before it began (EVAL_FRESH_SESSION_EVERY): they still count for the pace. */
const DELETED_SAYS: SayMark[] = [];

/**
 * The identity's assistant session (`POST /v1/assistant`), its stream open. One the run did not make is used only when nobody else is
 * using it; with EVAL_FRESH_SESSION_EVERY it is instead deleted, and seen gone, and a new one is asked for (the run deletes the
 * sessions it changes from, so each must be its own). After the first, the run has just deleted its previous one, so the server
 * must make a new one.
 */
async function openAssistant(first: boolean): Promise<AssistantSession> {
  const a = await api("POST", "/v1/assistant", {});
  const id = a.json?.data?.session_id;
  if (a.status !== 200 || typeof id !== "string" || !id) throw new Error(`POST /v1/assistant answered ${a.status}`);
  const created = a.json?.data?.created === true;
  const paced = pacedPerHour(SAY_PER_HOUR, a.json?.data?.say_max_per_hour, SAY_RESERVE);
  if (paced !== sayPerHour) {
    log(`say pace: ${paced} an hour (EVAL_SAY_PER_HOUR=${SAY_PER_HOUR}; the server's cap for this identity: ${a.json?.data?.say_max_per_hour ?? "not said"})`);
    sayPerHour = paced;
  }
  if (created) OWN_SESSIONS.add(id);
  else if (!first) throw new Error(`POST /v1/assistant gave session ${id}, which the run did not make, after the run deleted its own`);
  else {
    // Nobody else may be using it: another run's messages and items would be taken for this one's, and either run's
    // cleanup would close what the other is still grading. Each parallel run needs an identity of its own.
    const { rows } = await quietOrRefuse(id);
    if (FRESH_EVERY) {
      // Nobody is using it (above), and the identity is a test one (`identityRefusal`): the first case gets a new conversation as
      // well, not this one's. Its says of the last hour still count against the cap. The API has no delete-if-idle, so it is
      // looked at once more right before the DELETE: still quiet, and not one event more than at the first look.
      DELETED_SAYS.push(...countedSaysOf(rows));
      const again = await quietOrRefuse(id);
      if (again.rows.length !== rows.length) {
        console.error(`refusing to run: the identity's assistant session ${id} changed while the run looked at it; another run or a person is using this identity`);
        process.exit(2);
      }
      if (!(await deleteSessionConfirmed(api, id, Date.now() + 60_000, 5_000))) {
        console.error(`refusing to run: EVAL_FRESH_SESSION_EVERY could not delete the identity's assistant session ${id} (a GET after the DELETE did not answer 404)`);
        process.exit(2);
      }
      log(`deleted the identity's assistant session ${id} before the run (EVAL_FRESH_SESSION_EVERY): each case starts in a new one`);
      return openAssistant(false);
    }
  }
  const stream = new LiveStream(id, true);
  await stream.open();
  // Read after the stream opened, so a say in between is counted twice rather than not at all (and an event in between is
  // taken as before the run: nothing was sent yet).
  const before = created ? [] : await replay(id);
  const session: AssistantSession = { id, stream, created, before, historyAtStart: new Set(), historyEnds: new Set(), messages: [], unknownSends: 0 };
  for (const r of before as Array<EventRow & { event_id?: unknown }>) session.historyAtStart.add(String(r.event_id ?? ""));
  for (const t of storedTurnEnds(before)) session.historyEnds.add(t);
  return session;
}

/**
 * Done with a session: its turns are let end (a minute at most), every item they started is closed (`closeRunItems`), its stream is
 * closed and, when the run made it, it is deleted and seen gone. Returns what could not be done; `leftOpen` gets the run's items left open.
 */
async function closeSession(session: AssistantSession, floorAtStart: number, leftOpen: number[]): Promise<string[]> {
  const issues: string[] = [];
  const { id, stream } = session;
  // A turn already asked for may still start an item: let the session's turns end (a minute at most) and take every item
  // their calls answered for as the run's, whatever stopped the run.
  // A message whose answer was lost has a turn the run cannot name: it waits for as many more turns ended since it began.
  const ended = (stored: readonly string[]): boolean => session.messages.every((m) => stored.includes(m))
    && stored.filter((m) => !session.historyEnds.has(m)).length >= session.messages.length + session.unknownSends;
  const over = await turnsOver(id, ended, () => !session.unknownSends && session.messages.every((m) => turnEnded(stream.events, m)),
    Date.now() + Math.min(60_000, turnWaitMs(true)), until, 2_000);
  // What a turn still running starts later is not seen, and not closed: a person must look. Named by the stored events,
  // which are what says a turn is over.
  if (!over) {
    const stored = storedTurnEnds(await replay(id).catch(() => []));
    const open = session.messages.filter((m) => !stored.includes(m));
    if (session.unknownSends) open.push(`${session.unknownSends} message(s) whose answer was lost`);
    issues.push(`turns of the run still running at its end (what they start is not closed): ${open.join(",") || "(the stored events could not be read)"}`);
  }
  issues.push(...await closeRunItems(floorAtStart, leftOpen, session));
  stream.close();
  if (session.created) {
    const gone = await deleteOwn(id);
    log(gone ? `deleted the assistant session ${id} the run created` : `could not delete the assistant session ${id} the run created`);
    if (!gone) issues.push(`the assistant session ${id} the run created was not deleted`);
  }
  return issues;
}

/**
 * Close every item of the run still open: those its attempts saw, and (with `session`) every one a turn of the run's own messages started,
 * from the stream and from the stored events after the run began (a work_create answer the stream missed still ties its item). A
 * turn of anyone else's message in the session, or of a message whose answer was lost, ties nothing. An open item above the run's first board number that is tied to nothing is
 * left alone and said.
 */
async function closeRunItems(floorAtStart: number, leftOpen: number[], session: AssistantSession | null): Promise<string[]> {
  const issues: string[] = [];
  try {
    // One read of the board, again for up to 30 s, both to tie items to the run's turns and to close them.
    const open = await boardWithin(30_000);
    if (!open) throw new Error("the board could not be read for 30 s");
    if (session) {
      const rows = await until(async () => replay(session.id).catch(() => undefined), Date.now() + 30_000, 3_000);
      if (!rows) issues.push("the stored events could not be read to tie the run's items to its turns");
      const after = (rows ?? []).filter((r) => !session.historyAtStart.has(String((r as { event_id?: unknown }).event_id ?? "")));
      // Only the turns of the messages the run sent and knows by id tie items. A turn of a message someone else sent to the
      // session meanwhile is not the run's; nor, as far as anything shows, is a message whose answer was lost: the server
      // may or may not have taken it, and a person's message with the same text would look the same. Their items are left
      // alone and said below.
      const calls = [...turnCalls(session.stream.events, session.messages), ...storedTurnCalls(after, session.messages)];
      const above = open.filter((x) => x.seq > floorAtStart);
      for (const i of itemsStartedBy(calls, above, RUN_ITEMS)) RUN_ITEMS.add(i.item_id);
    }
    // Each item on its own: one that cannot be closed does not keep the others open.
    for (const i of open.filter((x) => RUN_ITEMS.has(x.item_id) && !CLEARED.has(x.item_id))) {
      try { log(`closing #${i.seq}: ${await closeItem(i)}`); } catch (err) {
        issues.push(`#${i.seq} could not be closed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    // Each closed item was seen done (`closeItem`): the board is read again at once.
    const final = await boardWithin(30_000);
    if (!final) throw new Error("the board could not be read for 30 s");
    const after = final.filter((x) => x.seq > floorAtStart && x.board_state !== "done");
    for (const seq of after.filter((x) => RUN_ITEMS.has(x.item_id)).map((x) => x.seq)) if (!leftOpen.includes(seq)) leftOpen.push(seq);
    // New open items the run cannot tie to its own calls are left alone, and said: on a test identity nobody else
    // makes items, so they are most likely the run's own whose answer could not be read, and a person must look.
    const foreign = after.filter((x) => !RUN_ITEMS.has(x.item_id)).map((x) => x.seq);
    if (foreign.length) {
      const lost = session?.unknownSends ? ` (${session.unknownSends} message(s) of the run whose answer was lost may have started some: check and close those)` : "";
      issues.push(`open items not tied to the run's calls, left alone: ${foreign.join(",")}${lost}`);
    }
  } catch (err) {
    issues.push(`the board could not be read to close the run's items: ${err instanceof Error ? err.message : String(err)}`);
  }
  return issues;
}

// --- Cards waiting, and a case's setup ----------------------------------------------------------------------------------

/** The cards that appeared during each case's attempts (EVAL_FRESH_SESSION_EVERY=attempt), by case id: the next attempt must not find them. */
const CASE_CARDS = new Map<string, Set<string>>();

/**
 * The cards waiting for the identity's answer now (`waitingCards`), or null when a list could not be read. A deployment without the
 * feature of one of the two lists answers 404 for it: no card of that kind can wait.
 */
async function cardsNow(): Promise<WaitingCard[] | null> {
  const [a, g] = await Promise.all([api("GET", "/v1/assistant/confirmations"), api("GET", "/v1/github-review/confirmations")]);
  if ((a.status !== 200 && a.status !== 404) || (g.status !== 200 && g.status !== 404)) return null;
  return waitingCards(a.status === 200 ? a.json : null, g.status === 200 ? g.json : null);
}

/**
 * Close every card waiting for the identity (a test one, `identityRefusal`): `deny` on its decision route, which takes only the
 * person's signed-in answer, so with EVAL_SEND_TOKEN_CMD's token; without one nothing can close them. The cards still waiting after,
 * or null when they could not be read.
 */
async function closeCards(): Promise<WaitingCard[] | null> {
  const waiting = await cardsNow();
  if (!waiting?.length || !SEND_TOKEN_CMD) return waiting;
  for (const w of waiting) {
    live();   // a stop sends no more decisions
    const route = w.source === "assistant" ? "/v1/assistant/confirmations" : "/v1/github-review/confirmations";
    const r = await tokenApi("POST", `${route}/${encodeURIComponent(w.id)}/decision`, { decision: "deny" }).catch(() => null);
    log(`card ${w.source}:${w.kind || "?"} waiting before the attempt: deny answered ${r?.status ?? "nothing"}`);
  }
  return cardsNow();
}

/** Triggers the run made for a case's setup and has not seen gone: deleted after their attempt, and again at the end. */
const SETUP_TRIGGERS = new Set<string>();

/**
 * Make what the case's `setup` says the identity has (`triggers`, with `POST /v1/triggers`): the ids made. Throws an `infra:` error, having
 * removed what it made, when a trigger cannot be made, or the identity already has one under a setup trigger's name (the case would be
 * graded against a trigger it did not mean).
 */
async function makeSetup(c: EvalCase): Promise<string[]> {
  const wanted = c.setup?.triggers ?? [];
  if (!wanted.length) return [];
  const list = await api("GET", "/v1/triggers");
  if (list.status !== 200 || !Array.isArray(list.json?.data)) throw new Error(`infra: setup: GET /v1/triggers answered ${list.status}`);
  const have = new Set((list.json.data as Array<{ name?: unknown }>).map((t) => String(t?.name ?? "").trim()));
  const clash = wanted.filter((t) => have.has(t.name.trim())).map((t) => JSON.stringify(t.name));
  if (clash.length) throw new Error(`infra: setup: the identity already has a trigger named ${clash.join(", ")}, which the run did not make for this attempt`);
  const made: string[] = [];
  for (const t of wanted) {
    if (stopSignal) { await removeSetup(made); live(); }   // a stop makes nothing more
    const r = await api("POST", "/v1/triggers", setupTriggerBody(t)).catch(() => null);
    const id = r?.json?.data?.trigger_id;
    if (r?.status !== 200 || typeof id !== "string" || !id) {
      // One made whose answer was lost is found by its name: the identity had no trigger under any setup name before (above).
      const now = await api("GET", "/v1/triggers").catch(() => null);
      const wantedNames = new Set(wanted.map((x) => x.name.trim()));
      for (const x of (Array.isArray(now?.json?.data) ? now!.json.data : []) as Array<{ trigger_id?: unknown; name?: unknown }>) {
        if (typeof x?.trigger_id === "string" && wantedNames.has(String(x.name ?? "").trim()) && !made.includes(x.trigger_id)) {
          SETUP_TRIGGERS.add(x.trigger_id);
          made.push(x.trigger_id);
        }
      }
      await removeSetup(made);
      throw new Error(`infra: setup: POST /v1/triggers for ${JSON.stringify(t.name)} answered ${r?.status ?? "nothing"}${typeof r?.json?.error === "string" ? ` (${r.json.error})` : ""}`);
    }
    SETUP_TRIGGERS.add(id);
    made.push(id);
  }
  log(`setup of ${c.id}: made ${made.length} trigger(s)`);
  return made;
}

/** Delete setup triggers the run made; each one a GET then answers 404 for is gone. What is left stays in SETUP_TRIGGERS. */
async function removeSetup(ids: readonly string[]): Promise<void> {
  for (const id of ids) {
    const path = `/v1/triggers/${encodeURIComponent(id)}`;
    await api("DELETE", path).catch(() => null);
    if ((await api("GET", path).catch(() => null))?.status === 404) SETUP_TRIGGERS.delete(id);
  }
}

// --- Memory entries -----------------------------------------------------------------------------------------------------

/** Memory entries attempts made that the run has not seen gone: deleted after their attempt, and again at the end. */
const RUN_MEMORIES = new Set<number>();
/**
 * The ids of the identity's memory entries when the run first listed them, before anything was sent: an entry not among them is the
 * run's, also one saved after its attempt's cleanup (a turn still running past its attempt, after a stop or a timeout). Null until read.
 */
let RUN_START_MEMORIES: ReadonlySet<number> | null = null;

/** Delete the run's entries listed in `rows` (not there when the run began) that are still listed; what is left stays in RUN_MEMORIES. */
async function sweepRunMemories(rows: readonly MemoryEntrySeen[]): Promise<number[]> {
  const start = RUN_START_MEMORIES;
  const late = start ? rows.map((r) => r.id).filter((id) => !start.has(id)) : [];
  for (const id of late) RUN_MEMORIES.add(id);
  if (!RUN_MEMORIES.size) return [];
  const left = new Set(await deleteMemories([...RUN_MEMORIES]));
  for (const id of [...RUN_MEMORIES]) if (!left.has(id)) RUN_MEMORIES.delete(id);
  if (late.length) log(`memory entries the run made after their attempt: ${late.length}, deleted ${late.filter((id) => !left.has(id)).length}`);
  return [...left];
}

/** The ids of the identity's memory entries as the running attempt started (`memoriesBefore`); null between attempts. */
let ATTEMPT_MEMORIES_BEFORE: ReadonlySet<number> | null = null;

/**
 * The memory entries the running attempt made so far, read for `expect_memory` / `expect_no_memory` after its turns and before they
 * are deleted. Throws an `infra:` error when they cannot be read: the attempt is not graded on a list it never saw.
 */
async function madeMemories(): Promise<MemoryEntrySeen[]> {
  const before = ATTEMPT_MEMORIES_BEFORE;
  const now = before ? await memoriesNow() : null;
  if (!before || !now) throw new Error("infra: the memory entries could not be read for expect_memory: not graded");
  return now.filter((r) => !before.has(r.id));
}

/** The identity's memory entries now, or null when they could not be read. */
async function memoriesNow(): Promise<MemoryEntrySeen[] | null> {
  const r = await api("GET", "/v1/users/me/memories").catch(() => null);
  return r?.status === 200 ? memoryRows(r.json) : null;
}

/** Delete memory entries by id: the ones still listed after (all of them when the list could not be read). */
async function deleteMemories(ids: readonly number[]): Promise<number[]> {
  for (const id of ids) await api("DELETE", `/v1/users/me/memories/${id}`).catch(() => null);
  const now = await memoriesNow();
  if (!now) return [...ids];
  const listed = new Set(now.map((r) => r.id));
  return ids.filter((id) => listed.has(id));
}

/**
 * The ids of the identity's memory entries as an attempt starts, after the case's `setup.forget_memories` deleted those it names. Throws
 * an `infra:` error when the entries cannot be read (what the attempt saves could not be told from what was there) or one the case names
 * is not deleted (the case would be graded against an entry it did not mean).
 */
async function memoriesBefore(c: EvalCase): Promise<Set<number>> {
  const unread = "infra: setup: GET /v1/users/me/memories could not be read: what the attempt saves could not be told apart";
  let rows = await memoriesNow();
  if (!rows) throw new Error(unread);
  if (!RUN_START_MEMORIES) RUN_START_MEMORIES = new Set(rows.map((r) => r.id));
  else if (rows.some((r) => !RUN_START_MEMORIES!.has(r.id))) {
    // The run's own, saved after an earlier attempt's cleanup: deleted first, so this attempt neither meets it nor counts it as its own.
    // One that cannot be deleted stays in RUN_MEMORIES (reported at the end) and in this attempt's before.
    await sweepRunMemories(rows);
    rows = await memoriesNow();
    if (!rows) throw new Error(unread);
  }
  const forget = memoriesMatching(rows, c.setup?.forget_memories ?? []);
  if (forget.length) {
    live();   // a stop deletes nothing more
    const left = await deleteMemories(forget);
    if (left.length) throw new Error(`infra: setup: memory entries named by forget_memories not deleted: ${left.join(",")}`);
    log(`setup of ${c.id}: deleted ${forget.length} memory entry(ies) it names`);
    rows = await memoriesNow();
    if (!rows) throw new Error(unread);
  }
  return new Set(rows.map((r) => r.id));
}

/** Delete the memory entries an attempt made (listed now, not in `before`); what could not be is left in RUN_MEMORIES or CLEANUP_ISSUES. */
async function removeAttemptMemories(before: ReadonlySet<number>, caseId: string): Promise<void> {
  const after = await memoriesNow();
  if (!after) { CLEANUP_ISSUES.push(`the memory entries could not be listed after an attempt of ${caseId}: what it saved may be left`); return; }
  const made = newMemoryIds(before, after);
  if (!made.length) return;
  for (const id of made) RUN_MEMORIES.add(id);
  const left = new Set(await deleteMemories(made));
  for (const id of made) if (!left.has(id)) RUN_MEMORIES.delete(id);
  log(`memory entries ${caseId} made: ${made.length}, deleted ${made.length - left.size}`);
}

// --- The run ------------------------------------------------------------------------------------------------------------

async function main(): Promise<void> {
  const loaded = loadCases(CASES_DIR);
  for (const b of loaded.bad) log(`case not loaded: ${b}`);
  const cases = select(loaded.cases, list("EVAL_CASES"), list("EVAL_PIPELINES"), process.env.EVAL_VARIANTS === "1");
  if (!cases.length) { console.error("no case selected"); process.exit(2); }
  if (DRY_RUN) {
    console.log(`dry run: mode=${MODE} k=${K} cases=${cases.length} from ${CASES_DIR}; nothing is sent`);
    for (const line of planOf(cases, MODE, VARS)) console.log(line);
    process.exit(loaded.bad.length ? 1 : 0);
  }
  if (STATIC) staticCheck(cases, loaded.bad);
  if (OFFLINE) return offline(cases, OFFLINE);
  // Before anything is said to anybody's assistant: whose key this is, and whether a channel would carry the run to a person.
  const me = await api("GET", "/v1/me");
  if (me.status !== 200) { console.error(`GET /v1/me answered ${me.status}`); process.exit(2); }
  ME_USER_ID = typeof me.json?.userId === "string" && me.json.userId ? me.json.userId : null;
  const subs = await api("GET", "/v1/notification-subscriptions");
  if (subs.status !== 200 || !Array.isArray(subs.json?.data)) { console.error(`GET /v1/notification-subscriptions answered ${subs.status}: refusing to run blind`); process.exit(2); }
  const refusal = identityRefusal(me.json ?? {}, subs.json.data, process.env);
  if (refusal) { console.error(`refusing to run: ${refusal}`); process.exit(2); }
  process.on("SIGINT", stopOn);
  process.on("SIGTERM", stopOn);
  log(`mode=${MODE} plugin=${PLUGIN_ID ?? "-"} cases=${cases.length} k=${K}`);
  // Messages go with a signed-in token when EVAL_SEND_TOKEN_CMD gives one: it must be the same identity's.
  if (SEND_TOKEN_CMD && LIVE && MODE === "assistant") {
    const tme = await tokenApi("GET", "/v1/me");
    // The same account: `userId`, the one identifier `/v1/me` always has (a name or an email can be shared, or missing).
    const userId = me.json?.userId;
    if (tme.status !== 200 || typeof userId !== "string" || !userId || tme.json?.userId !== userId) {
      console.error(`refusing to run: the token of EVAL_SEND_TOKEN_CMD is not the key's identity (GET /v1/me answered ${tme.status})`);
      process.exit(2);
    }
  }
  let session: AssistantSession | null = null;
  let priorSays: SayMark[] = [];  // the identity's counted says made before the run was listening (and of its earlier sessions)
  const sayLog = sayLogPath(String(me.json?.email || me.json?.name || ""));
  // The board's highest number is read before anything is made, so whatever fails after it, everything numbered above it
  // is the run's and is closed below.
  const floorAtStart = MODE === "assistant" ? Math.max(0, ...(await board()).map((i) => i.seq)) : 0;
  const results: CaseResult[] = [];
  let cleanupFailed: string[] = [];
  const leftOpen: number[] = [];
  let casesInSession = 0;
  let attemptsInSession = 0;
  /**
   * Change to a new assistant session: the one before is settled (its items closed) and deleted, and seen gone, first. False (with why in
   * cleanupFailed) when that could not be done: the run stops.
   */
  const nextSession = async (): Promise<boolean> => {
    priorSays = mergeSays([priorSays, countedSays(session!.stream.events)], Date.now());
    const old = session!;
    session = null;
    const issues = await closeSession(old, floorAtStart, leftOpen);
    if (issues.length) { cleanupFailed.push(...issues); return false; }
    try { session = await openAssistant(false); } catch (err) {
      cleanupFailed.push(`a new assistant session could not be had: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
    attemptsInSession = 0;
    return true;
  };
  try {
    if (MODE === "assistant") {
      live();
      session = await openAssistant(true);
      priorSays = mergeSays([readSayLog(sayLog), countedSaysOf(session.before), DELETED_SAYS], Date.now());
      if (FRESH_ATTEMPT) {
        const waiting = await cardsNow();
        if (!waiting) throw new Error("the cards waiting for the identity's answer could not be read");
        log(`cards waiting for the identity when the run began: ${waiting.length}${waiting.length && !SEND_TOKEN_CMD ? " (they stay: closing one needs EVAL_SEND_TOKEN_CMD)" : ""}`);
      }
    }
    let lastCaseEnd = 0;   // when the last case that sent anything ended: the next waits EVAL_GAP_S from it
    cases: for (const c of cases) {
      const r: CaseResult = { id: c.id, area: c.area, pipeline: c.pipeline, mode: MODE, hash: c.source?.hash ?? caseHash(c), attempts: [] };
      if (stopSignal) break;
      results.push(r);
      if (c.modes && !c.modes.includes(MODE)) { r.skipped = `${c.modes.join(",")} only`; continue; }
      if (MODE !== "assistant" && c.turns.some((t) => t.files?.length)) { r.skipped = "files are sent on the assistant path only"; continue; }
      if (GAP_MS && lastCaseEnd) {
        try { await pause(lastCaseEnd + GAP_MS - Date.now()); } catch (err) { if (err instanceof Interrupted) break cases; throw err; }
      }
      // The run's variables, read again right before the case when EVAL_VARS_CMD says how (its failure is the run's error here).
      let vars: Vars;
      try { vars = caseVars(); } catch (err) {
        const why = scrub(err instanceof Error ? err.message : String(err));
        r.attempts.push({ pass: false, checks: [], tools: [], final: null, finalChars: 0, firstReplyMs: null, finalMs: null, items: [], error: why });
        log(`ERROR ${c.id}#1 ${why}`);
        continue;
      }
      // Placeholders filled everywhere they sit: turns, claims, values, oracle queries and the rubric.
      const filled = filledCase(c, vars);
      if (filled === null) { r.skipped = `needs ${missingVars(c, vars).join(", ")}`; continue; }
      const turns = filled.turns;
      // A new assistant conversation every EVAL_FRESH_SESSION_EVERY cases: what an earlier case said is not this one's context. The
      // old one is settled (its items closed) and deleted, and seen gone, first; a run that cannot do that stops.
      if (MODE === "assistant" && FRESH_EVERY && !FRESH_ATTEMPT && casesInSession >= FRESH_EVERY) {
        if (!(await nextSession())) break cases;
        casesInSession = 0;
      }
      casesInSession++;
      for (let k = 0; k < K; k++) {
        // EVAL_FRESH_SESSION_EVERY=attempt: each attempt in a new session (the first of the run has one already).
        if (MODE === "assistant" && FRESH_ATTEMPT && attemptsInSession > 0 && !(await nextSession())) break cases;
        if (MODE === "assistant") {
          try { await paceSays(session!.stream, priorSays); } catch (err) { if (err instanceof Interrupted) break cases; throw err; }
        }
        const once = async (): Promise<Attempt> => {
          let a: Attempt;
          const caseStart = Date.now();
          const earlier = new Set(RUN_MESSAGES);   // an earlier attempt's refusal that arrives late is not this one's
          let waiting: WaitingCard[] | null = null;
          let setup: string[] = [];
          let memBefore: Set<number> | null = null;
          attemptsInSession++;
          preflightFailed = true;
          try {
            if (MODE === "assistant" && FRESH_ATTEMPT) {
              waiting = await closeCards();
              if (!waiting) throw new Error("infra: the cards waiting for the identity's answer could not be read: not graded");
              const left = cardsLeftError(filled, waiting, CASE_CARDS.get(c.id) ?? new Set());
              if (left) throw new Error(left);
            }
            // The entries before the attempt are listed once no earlier turn is running (one past its attempt, after a timeout, may
            // still save): its entry would otherwise be taken for this attempt's own. A session still running is the run's error and,
            // as when runAssistant finds it, no preflight failure: the attempt is run again once (EVAL_INFRA_RETRY), in a new session
            // with EVAL_FRESH_SESSION_EVERY=attempt.
            if (MODE === "assistant") {
              preflightFailed = false;
              if (!(await idle(session!.id, turnWaitMs(true)))) {
                throw new Error(`the assistant session was still running ${turnWaitMs(true) / 1000} s before ${c.id}: nothing sent, not graded`);
              }
              preflightFailed = true;
            }
            memBefore = await memoriesBefore(filled);
            ATTEMPT_MEMORIES_BEFORE = memBefore;
            setup = await makeSetup(filled);
            preflightFailed = false;
            a = MODE === "assistant" ? await runAssistant(filled, turns, session!) : await runBaseline(filled, turns);
          } catch (err) {
            a = { pass: false, checks: [], tools: [], final: null, finalChars: 0, firstReplyMs: null, finalMs: null, items: [], error: scrub(err instanceof Error ? err.message : String(err)) };
          } finally {
            if (setup.length) await removeSetup(setup);
            ATTEMPT_MEMORIES_BEFORE = null;
            if (memBefore) await removeAttemptMemories(memBefore, c.id);
          }
          // The cards this attempt made: those waiting now that did not before it. A card it made that could not be read stays unseen,
          // and the next attempt is graded as without it (the same as before this runner closed cards at all).
          if (waiting && !preflightFailed) {
            const before = new Set(waiting.map((w) => w.id));
            const own = CASE_CARDS.get(c.id) ?? new Set<string>();
            for (const w of (await cardsNow().catch(() => null)) ?? []) if (!before.has(w.id)) own.add(w.id);
            CASE_CARDS.set(c.id, own);
          }
          if (waiting) a = { ...a, cardsWaiting: waiting.length };
          // A say the server refused for its hourly cap is the run's failure, not the assistant's.
          const refused = MODE === "assistant" && !a.error ? capRefusedSays(session!.stream.events, caseStart, earlier) : 0;
          if (refused) a = { ...a, pass: false, error: `infra: ${refused} say(s) refused by the hourly cap (say_rate_limited)` };
          if (MODE === "assistant") writeSayLog(sayLog, mergeSays([priorSays, countedSays(session!.stream.events)], Date.now()));
          const reopened = REOPENED.filter((x) => x.at >= caseStart).map((x) => `${new Date(x.at).toISOString()} ${x.why}`);
          return reopened.length ? { ...a, reopened } : a;
        };
        const recorded = recordings.length;
        let preflightFailed = false;
        let a = await once();
        // An attempt that ended in an error of the run (a missed stream, a read or a judge that failed, a turn that did not end) is
        // run again once: what is reported is the second try, with the first one's error. A stop is not run again, nor an attempt
        // that never ran because a card the run left could not be closed or its setup could not be made: a second try finds the same.
        if (a.error && INFRA_RETRY && !stopSignal && !preflightFailed) {
          log(`ERROR ${c.id}#${k + 1} ${a.error}: running it again once`);
          if (MODE === "assistant" && FRESH_ATTEMPT && !(await nextSession())) { r.attempts.push(a); break cases; }
          if (MODE === "assistant") {
            try { await paceSays(session!.stream, priorSays); } catch (err) { if (err instanceof Interrupted) { r.attempts.push(a); break cases; } throw err; }
          }
          const first = a;
          // The first try is thrown away: a recording it left (its error came from the judge or the say cap, after it was
          // recorded) goes too, so EVAL_OFFLINE grades the same K attempts as the live report.
          recordings.length = recorded;
          a = { ...(await once()), retried: first.error };
          if (first.reopened) a.reopened = [...first.reopened, ...(a.reopened ?? [])];
        }
        r.attempts.push(a);
        const failed = a.checks.filter((x) => !x.pass).map((x) => x.name);
        log(`${a.error ? "ERROR" : a.pass ? "pass" : "FAIL"} ${c.id}#${k + 1} route=${a.route ?? "-"} cards=${a.cards ?? "-"} first=${a.firstReplyMs}ms final=${a.finalMs}ms ${a.error ?? failed.join("; ")}${a.retried ? " (second try)" : ""}`);
        lastCaseEnd = Date.now();
        if (stopSignal) break cases;
      }
    }
    if (stopSignal) cleanupFailed.push(`the run was stopped by ${stopSignal} before its cases finished`);
  } catch (err) {
    log(`run stopped: ${err instanceof Error ? err.message : String(err)}`);
    cleanupFailed.push("the run stopped before its cases finished");
  } finally {
    // Whatever happened, nothing the run started stays open; what could not be closed fails the run.
    if (MODE === "assistant") {
      if (session) {
        writeSayLog(sayLog, mergeSays([priorSays, countedSays(session.stream.events)], Date.now()));
        cleanupFailed.push(...await closeSession(session, floorAtStart, leftOpen));
      } else {
        // No session open (none was had, or the run stopped while it changed sessions): the run's items are still closed.
        cleanupFailed.push(...await closeRunItems(floorAtStart, leftOpen, null));
      }
      // The cards the last attempts made are closed as well, so the next run, or the person, does not find them waiting.
      if (FRESH_ATTEMPT && SEND_TOKEN_CMD && !stopSignal) {
        const waiting = await closeCards().catch(() => null);
        if (waiting === null) cleanupFailed.push("the cards waiting for the identity's answer could not be read after the run");
        else if (waiting.length) cleanupFailed.push(`cards still waiting for the identity's answer after the run: ${waiting.length}`);
      }
      log(`items created by the run that are still open: ${leftOpen.length ? leftOpen.join(",") : "none"}`);
      if (leftOpen.length) cleanupFailed.push(`items still open: ${leftOpen.join(",")}`);
    }
  }
  if (SETUP_TRIGGERS.size) await removeSetup([...SETUP_TRIGGERS]);
  if (SETUP_TRIGGERS.size) cleanupFailed.push(`setup triggers the run made not deleted: ${[...SETUP_TRIGGERS].join(",")}`);
  // After the run's sessions are closed (their turns over): every entry not there when the run began is the run's, and is deleted.
  let memoriesLeft: number[] = [];
  if (RUN_START_MEMORIES) {
    const now = await memoriesNow();
    if (now) memoriesLeft = await sweepRunMemories(now);
    else cleanupFailed.push("the memory entries could not be listed after the run: what it saved may be left");
  } else if (RUN_MEMORIES.size) memoriesLeft = await deleteMemories([...RUN_MEMORIES]);
  if (memoriesLeft.length) cleanupFailed.push(`memory entries the run made not deleted: ${memoriesLeft.join(",")}`);
  if (sessionsLeft.length) cleanupFailed.push(`sessions the run made not deleted: ${sessionsLeft.join(",")}`);
  cleanupFailed.push(...new Set(CLEANUP_ISSUES));
  cleanupFailed = cleanupFailed.map(scrub);
  if (RECORD_PATH) {
    // Written by the real path checked before the run (nobody else can have replaced it: see privateDir), checked once more, into a
    // new file of the run's own (`wx`: never through one that was there) that then takes the recordings' name.
    const why = ownPrivate(RECORD_PATH, typeof process.getuid === "function" ? process.getuid() : null);
    if (why) cleanupFailed.push(`the recordings were not written: EVAL_RECORD_DIR ${why}`);
    else {
      const file = join(RECORD_PATH, `${MODE}-recordings.jsonl`);
      const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
      try {
        writeFileSync(tmp, scrub(recordings.map((r) => JSON.stringify(r)).join("\n") + "\n"), { mode: 0o600, flag: "wx" });
        renameSync(tmp, file);
      } catch (err) {
        cleanupFailed.push(`the recordings were not written: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  report(results, cases.length, leftOpen, cleanupFailed);
}

/**
 * The arms' tools from the code that gives them (`assistant/read-tools.ts`, and the GitHub and web lookups where a version of it
 * has them), and every case's findings against them. Nothing is sent.
 */
function staticCheck(cases: readonly EvalCase[], bad: readonly string[]): never {
  const m = readTools as Record<string, unknown>;
  const github = Array.isArray(m.ROUTER_GITHUB_READ_TOOLS) ? (m.ROUTER_GITHUB_READ_TOOLS as string[]).map((t) => `mcp__github__${t}`) : [];
  const web = Array.isArray(m.ROUTER_WEB_TOOLS) ? (m.ROUTER_WEB_TOOLS as string[]) : [];
  const servers = (process.env.EVAL_STATIC_SERVERS || [...Object.keys(readTools.ROUTER_READ_TOOLS), "github", "schedules"].join(","))
    .split(",").map((s) => s.trim()).filter(Boolean);
  const worker = [...servers.map((s) => `mcp__${s}__*`), BUILTIN_TOOLS];
  const arms: Arms = { router: ["mcp__assistant__*", ...ROUTER_READS, ...github, ...web], worker, baseline: worker };
  const found = staticFindings(cases, arms, VARS);
  const count = (xs: Array<{ kind: string }>) => xs.reduce<Record<string, number>>((n, x) => ({ ...n, [x.kind]: (n[x.kind] ?? 0) + 1 }), {});
  for (const p of found.problems) console.log(`PROBLEM ${p.id} ${p.kind}: ${p.detail}`);
  const summary = { cases: cases.length, not_loaded: bad.length, problems: count(found.problems), notes: count(found.notes), router_servers: Object.keys(readTools.ROUTER_READ_TOOLS),
    router_github: github.length > 0, router_web: web.length > 0, worker_servers: servers };
  console.log(JSON.stringify(summary));
  if (OUT) {
    mkdirSync(OUT, { recursive: true });
    writeFileSync(join(OUT, "static.json"), JSON.stringify({ ...summary, problems: found.problems, notes: found.notes }, null, 1));
  }
  process.exit(found.problems.length || bad.length ? 1 : 0);
}

/** Grade recorded attempts again with the current cases and grader: no key, no request. */
function offline(cases: readonly EvalCase[], file: string): void {
  const byId = new Map(cases.map((c) => [c.id, c]));
  const results = new Map<string, CaseResult>();
  for (const rec of parseRecordings(readFileSync(file, "utf8"))) {
    const c = byId.get(rec.case_id) && filledCase(byId.get(rec.case_id)!, VARS);
    if (!c) continue;
    const r = results.get(c.id) ?? { id: c.id, area: c.area, pipeline: c.pipeline, mode: rec.mode, hash: c.source?.hash ?? caseHash(c), attempts: [] };
    results.set(c.id, r);
    const o = rec.observed;
    const checks = grade(c, o);
    r.attempts.push({ ...verdictOf(c, checks, null), checks, route: o.route, cards: o.cards, tools: o.calls.map((x) => x.name), final: KEEP_TEXT ? o.final : null,
      finalChars: o.final.length, firstReplyMs: o.firstReplyMs, finalMs: o.finalMs, items: [] });
  }
  if (!results.size) { console.error(`no recording in ${file} matches a selected case`); process.exit(2); }
  report([...results.values()], results.size, [], []);
}

function report(results: CaseResult[], selected: number, leftOpen: number[], cleanupFailed: string[]): void {
  const sum = totals(results);
  const summary = { mode: MODE, offline: !!OFFLINE, plugin: PLUGIN_ID ?? null, k: K, finished_at: iso(), cases: selected, totals: sum, left_open: leftOpen, cleanup_failed: cleanupFailed };
  if (OUT) {
    mkdirSync(OUT, { recursive: true });
    writeFileSync(join(OUT, `${MODE}.json`), scrub(JSON.stringify({ ...summary, results }, null, 1)));
    writeFileSync(join(OUT, `${MODE}.md`), scrub(`# sa-eval ${MODE} (k=${K})\n\n${renderTable(results)}\n`));
  }
  console.log(scrub(renderTable(results)));
  console.log(JSON.stringify(summary));
  for (const why of cleanupFailed) console.error(`cleanup: ${why}`);
  process.exit(results.every((r) => r.attempts.every((a) => !a.error)) && !cleanupFailed.length ? 0 : 1);
}

void main();
