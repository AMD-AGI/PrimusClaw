// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What the assistant can and cannot do, for this user on this deployment (`claw_capabilities`), generated from what the router turn
 * really has: the tools registered on its assistant server (`mcp.ts`), the deployment's features that are on, the lookups it is given
 * (`read-tools.ts`), the user's review mode, and the limits that hold here. Never prose written by hand: asked "what can't you do" or
 * "how do you compare", the router answered from guesswork (2026-11-23) and said it had no background watching (`github-events.ts`
 * watches pull requests, `job-watch.ts` jobs, triggers run on schedules), could not see images (`files.ts` shows them to it), that every
 * write needs a worker and a confirmation (its own tools act at once, and under fully_auto a review merges by itself), and that it
 * cannot check a worker's conclusions (`work_recall`, `pr_state`). Each entry here is on only when the tool or the setting behind it is.
 *
 * The list is pure (`capabilityList`); what it is built from is read by `capabilityInputs`. The same list is what the API serves the
 * user (`GET /v1/assistant/capabilities`), which the evaluation grades an answer against (`test/e2e/sa-eval-lib.ts`, `self_knowledge`).
 * The API's list has no Brain to name its web tools, so an entry that depends on them alone (`look_up` without GitHub or other systems)
 * is neither on nor off there but not known (`on: null`), which the evaluation grades neither way: listing it off told the user, and
 * the grader, that a turn which can search the web cannot (2026-11-23).
 */
import {
  CLAW_ASSISTANT_GITHUB_POLL_SEC, CLAW_ASSISTANT_JOB_POLL_SEC, CLAW_ASSISTANT_TOOLS, CLAW_GITHUB_REVIEW_ENABLED, CLAW_USER_SKILLS_ENABLED,
} from "../config.js";
import { type Querier } from "../infra/db.js";
import { getReviewMode, type ReviewMode } from "../github-review/store.js";
import { githubMcpServers } from "../github-mcp/mcp.js";
import { CHAT_SURFACES, chatSurface } from "./chat-surface.js";
import { devenvToolsOn } from "./devenv-tools.js";
import { PROMPT_IMAGES_MAX } from "./files.js";
import { githubEventPorts, githubEventsEnabled } from "./github-events.js";
import { jobWatchesEnabled } from "./job-watch.js";
import { assistantMemoryOn, sessionWithoutMemory } from "./memory-tools.js";
import { getMemoryPreference } from "../memory/service.js";
import { reviewItemPorts, reviewItemsEnabled } from "./review-items.js";
import { ROUTER_WEB_TOOLS, routerReadTools } from "./read-tools.js";
import { assistantSchedulesOn } from "./schedules.js";

/** The tool's name on the assistant's server. */
export const CAPABILITIES_TOOL = "claw_capabilities";
/** The shape of the list; moves when an entry is added, removed or changes meaning. */
export const CAPABILITIES_VERSION = "capabilities-v4";

/** The deployment's switches that decide what the assistant can do, beside the tools they register. */
export interface DeploymentFeatures {
  /** CLAW_ASSISTANT_TOOLS: the router starts reviews and changes settings itself. */
  review_tools: boolean;
  /** CLAW_GITHUB_REVIEW_ENABLED: Claw reviews pull requests. */
  github_review: boolean;
  /** CLAW_ASSISTANT_REVIEW_ITEMS: a review is started from the assistant as an item (`review_start` refuses without it). */
  review_items: boolean;
  /** CLAW_ASSISTANT_GITHUB_EVENTS: items watch pull requests in the background. */
  github_events: boolean;
  /** CLAW_ASSISTANT_MEMORY_TOOLS: long-term memory. */
  memory: boolean;
  /** CLAW_REMOTE_AGENTS_ENABLED: the user's own machines, through the connector. */
  remote_agents: boolean;
  /** Triggers and the brief (`assistantSchedulesOn`). */
  triggers: boolean;
  /** CLAW_ASSISTANT_JOB_EVENTS: jobs watched in the background. */
  job_watch: boolean;
  /** Files sent with a message, and the images among them shown to the router (`files.ts`). */
  files_and_images: boolean;
  /** CLAW_USER_SKILLS_ENABLED: the user's personal skills. */
  user_skills: boolean;
  /** How often a watched pull request and a watched job are read, in seconds. */
  github_poll_sec: number;
  job_poll_sec: number;
  /** At most this many images of one message are shown to the router. */
  images_per_message: number;
}

/** The deployment's features as this process has them. */
export function deploymentFeatures(): DeploymentFeatures {
  return {
    review_tools: CLAW_ASSISTANT_TOOLS, github_review: CLAW_GITHUB_REVIEW_ENABLED, review_items: reviewItemsEnabled(), github_events: githubEventsEnabled(),
    memory: assistantMemoryOn(), remote_agents: devenvToolsOn(), triggers: assistantSchedulesOn(), job_watch: jobWatchesEnabled(),
    // Unconditional where the assistant runs: a channel's files are named with the message, and its images shown to the router.
    files_and_images: PROMPT_IMAGES_MAX > 0, user_skills: CLAW_USER_SKILLS_ENABLED,
    github_poll_sec: CLAW_ASSISTANT_GITHUB_POLL_SEC, job_poll_sec: CLAW_ASSISTANT_JOB_POLL_SEC, images_per_message: PROMPT_IMAGES_MAX,
  };
}

/**
 * Brain's own web tools, as the Brain that runs the turn has them: it has web_search only with a search provider
 * (`WEB_SEARCH_PROVIDER`, off by default) and web_fetch only with `WEB_FETCH_ENABLED` (off by default), each on its own. The API has
 * neither setting: the Brain names the ones it has when it calls the assistant's server (`WEB_TOOLS_HEADER`). Null where that is not
 * known (the API's own list, a Brain that does not say): then neither is claimed.
 */
export interface WebTools { search: boolean; fetch: boolean }

/** The header a Brain names its web tools in, on its calls to the assistant's server (`brain/src/clients/mcp.ts`). */
export const WEB_TOOLS_HEADER = "x-claw-web-tools";

/** The header's value as the Brain sent it: the web tools it names ("none": neither), or null when there is no header. */
export function parseWebTools(value: string | string[] | undefined): WebTools | null {
  const raw = Array.isArray(value) ? value.join(",") : value;
  if (raw === undefined) return null;
  const names = new Set(raw.split(",").map((s) => s.trim()).filter(Boolean));
  return { search: names.has("web_search"), fetch: names.has("web_fetch") };
}

/** What the router turn may look up itself, besides its own tools. */
export interface Lookups {
  /** Brain's web_search and web_fetch, as the Brain running the turn has them; null: not known, so neither is claimed. */
  web: WebTools | null;
  /** The user's GitHub, as them (their linked account). */
  github: boolean;
  /** The read servers of the deployment's assistant plugin (`routerReadTools`). */
  systems: readonly string[];
}

/** Whether the user has a GitHub account a tool can act with: yes, none, one that ran out (`expired`), or not known just now (`unknown`). */
export type GithubAccountState = "yes" | "none" | "expired" | "unknown";

/** The user's GitHub, as the tools that act with it find it. */
export interface GithubAccount {
  /**
   * A token as their pull request watches and their comments resolve it (`githubEventPorts.loadToken`, `resolveGithubToken`): a GH_TOKEN
   * kept in their settings, else the account they bound with /github bind where bindings count. Without one a watch is `no_github_token`
   * and a comment pressed on its card is not posted.
   */
  token: GithubAccountState;
  /**
   * An account bound at the identity provider, which a review made as them acts with (the review service's credential; a GH_TOKEN does not
   * count there). Without one a review as them is refused `actor_not_bound`.
   */
  bound: GithubAccountState;
}

export interface CapabilityInputs {
  /** The tools registered on the router's assistant server, without the `mcp__assistant__` prefix. */
  tools: readonly string[];
  features: DeploymentFeatures;
  lookups: Lookups;
  /** The user's review mode (`getReviewMode`). */
  reviewMode: ReviewMode;
  /** The user's GitHub account as the review, watch and comment tools find it. */
  githubAccount: GithubAccount;
  /**
   * The user's own memory: `enabled` is their setting (`getMemoryPreference`, off: the memory tools refuse with memory_off), `here`
   * whether this conversation is one where it is kept (never a group's: `sessionWithoutMemory`).
   */
  userMemory: { enabled: boolean; here: boolean };
  /** The chat apps the assistant is talked to in: the channels with a surface of their own, and the one this message came through. */
  channels: readonly string[];
}

/** How a tool of the assistant's own takes effect. */
export type ToolEffect = "speaks" | "reads" | "at_once" | "card_first";

/**
 * Every tool the router's server can register, by how it takes effect: `at_once` changes something when called (with an Undo where it
 * has one), `card_first` only shows the user a card and nothing happens until they press it. A tool registered and not listed here is
 * reported in `unclassified` and fails the tests, so a new tool is classified before it ships.
 */
export const TOOL_EFFECTS: Readonly<Record<string, ToolEffect>> = {
  say: "speaks", deliver_text: "speaks",
  work_recall: "reads", memory_recall: "reads", skill_read: "reads", skill_list: "reads", devenv_list: "reads", claw_self_status: "reads",
  brief: "reads", trigger_list: "reads", job_watch_list: "reads", pr_state: "reads", [CAPABILITIES_TOOL]: "reads", seat_roster: "reads",
  work_create: "at_once", work_send: "at_once", work_stop: "at_once", model_default_set: "at_once", work_subscribe: "at_once",
  work_unsubscribe: "at_once", review_start: "at_once", review_restart: "at_once", review_mode_set: "at_once", channel_action: "at_once",
  confirmation_answer: "at_once", job_watch: "at_once", job_unwatch: "at_once", memory_save: "at_once", memory_update: "at_once",
  memory_forget: "at_once", memory_undo: "at_once", skill_save: "at_once", skill_update: "at_once", skill_disable: "at_once",
  skill_enable: "at_once", skill_delete: "at_once", skill_undo: "at_once", devenv_pair: "at_once",
  // (a role or an alias is a card the user presses; `refresh` asks the seat again at once, so it is listed as acting)
  seat_set: "at_once",
  github_comment: "card_first", trigger_create: "card_first", trigger_cancel: "card_first", devenv_send: "card_first",
  devenv_hide: "card_first", skill_draft: "card_first",
};

export interface Ability {
  id: string;
  /**
   * True: the assistant has it; false: it does not. Null: this list cannot tell, because it depends on something the list was not given
   * (`look_up` in the API's own list, which does not know the web tools of the Brain that runs a turn, `Lookups.web`): neither claimed
   * nor denied.
   */
  on: boolean | null;
  what: string;
  /** The assistant's own tools that do it (those it has now), or the lookups. */
  tools?: string[];
}

export interface Limit {
  id: string;
  /** Whether the assistant can do it after all: a limit is data, and a deployment that has what it needs turns it on. */
  on: boolean;
  what: string;
}

export interface Capabilities {
  version: string;
  /** What the router is told to do with the list (the tool's answer only). */
  rule?: string;
  abilities: Ability[];
  limits: Limit[];
  review_mode: { mode: ReviewMode; means: string } | null;
  /** The assistant's own tools, by how they take effect. */
  acts_at_once: string[];
  asks_first: string[];
  reads: string[];
  /** Registered tools that refuse for this user here, because the ability they belong to is off (not in the three lists above). */
  off_here?: string[];
  /** Registered tools that no entry of TOOL_EFFECTS classifies (none in a correct build). */
  unclassified?: string[];
  lookups: { web: WebTools | null; github: boolean; systems: string[] };
  channels: string[];
}

/** What the router is told with the list. */
export const CAPABILITIES_RULE = "This list is generated from the tools and settings you have now. Answer questions about what you can or "
  + "cannot do, and comparisons with other assistants, from it alone: an ability with on true is one you have (never say you cannot do "
  + "it), one with on false or a limit with on false is one you do not have (never claim it), one with on null is not known to this list "
  + "(neither claim nor deny it). acts_at_once are your own tools that change "
  + "something when you call them, with no worker and no card; asks_first show the user a card first; off_here are tools you have that "
  + "refuse here (their ability is off): never offer what they do.";

interface AbilitySpec {
  id: string;
  /** The tools that do it: on only when at least one is registered (none: decided by `needs` alone). */
  tools?: readonly string[];
  needs?: (i: CapabilityInputs) => boolean;
  /** What it is, said where it is on. */
  what: (i: CapabilityInputs) => string;
  /** What is said where it is off: that it is not there, and what would turn it on where the user can. */
  off: (i: CapabilityInputs) => string;
  /**
   * Whether an ability that `needs` leaves off could still be there through something the list was not given: then it is neither on
   * nor off (`on: null`), and `unknown` says so.
   */
  unknown?: { when: (i: CapabilityInputs) => boolean; what: (i: CapabilityInputs) => string };
  /** Registered tools that refuse while this ability is off: listed under off_here instead of by how they act. */
  gates?: readonly string[];
}

const has = (i: CapabilityInputs, t: string): boolean => i.tools.includes(t);
/** Reviews as `review_start` has them: the assistant's review tools, Claw's reviews and review items, all three. */
const reviewsHere = (i: CapabilityInputs): boolean => i.features.review_tools && i.features.github_review && i.features.review_items;
const webSearch = (i: CapabilityInputs): boolean => i.lookups.web?.search === true;
const webFetch = (i: CapabilityInputs): boolean => i.lookups.web?.fetch === true;
/** The web tools the turn has, by name. */
const webToolsOf = (i: CapabilityInputs): string[] => ROUTER_WEB_TOOLS.filter((t) => (t === "web_search" ? webSearch(i) : webFetch(i)));
const listed = (xs: readonly string[]): string => xs.join(", ");
const hasToken = (i: CapabilityInputs): boolean => i.githubAccount.token === "yes";
const isBound = (i: CapabilityInputs): boolean => i.githubAccount.bound === "yes";

/** Why the user's GitHub cannot be acted with, and what they do about it: `doing` needs it ("Watching pull requests"). */
function githubMissing(state: GithubAccountState, doing: string, how: string): string {
  if (state === "expired") return `${doing} needs the user's GitHub account, and their authorization has expired: they bind GitHub again (/github bind) and then ask again.`;
  if (state === "unknown") return `${doing} needs the user's GitHub account, which could not be checked just now: do not promise it; they can ask again shortly.`;
  return `${doing} needs the user's GitHub account first, and they have not connected one: they connect it once with ${how}, then ask again.`;
}
const CONNECT_GITHUB = "/github bind (or a GH_TOKEN kept in their Claw settings)";

/** Every ability the list can name, in the order it names them. */
const ABILITIES: readonly AbilitySpec[] = [
  {
    id: "look_up",
    off: () => "Nothing to look up in the same turn here: no GitHub, no other systems, no web search and no reading web pages; a work item "
      + "can look things up instead.",
    // Brain's web tools are named only to a turn's own server (WEB_TOOLS_HEADER): without them, no GitHub and no other systems does not
    // mean nothing to look up, since the Brain running the turn may have web_search or web_fetch (the API's own list, 2026-11-23).
    unknown: {
      when: (i) => i.lookups.web === null,
      what: () => "Not known to this list: no GitHub and no other systems to look up here, and whether you can search the web or read a "
        + "web page in the same turn depends on the web tools (web_search, web_fetch) of the Brain that runs the turn.",
    },
    needs: (i) => webSearch(i) || webFetch(i) || i.lookups.github || i.lookups.systems.length > 0,
    what: (i) => `Look things up at once, in the same turn: ${[
      ...(webSearch(i) ? ["search the web (web_search)"] : []),
      ...(webFetch(i) ? ["read a web page at an address (web_fetch)"] : []),
      ...(i.lookups.github ? ["the user's GitHub as them (pull requests, issues, checks, reviews, files)"] : []),
      ...(i.lookups.systems.length ? [`these systems: ${listed(i.lookups.systems)}`] : []),
    ].join("; ")}.${i.lookups.web === null ? "" : [
      ...(webSearch(i) ? [] : [" No web search here."]),
      ...(webFetch(i) ? [] : [" No reading web pages here."]),
    ].join("")}`,
  },
  {
    id: "see_images",
    off: () => "No images or files here: what is sent with a message is not shown to you.",
    needs: (i) => i.features.files_and_images,
    what: (i) => `Images sent with a message are shown to you (up to ${i.features.images_per_message} per message), and every file sent `
      + "is handed to the work items you start.",
  },
  {
    id: "hand_off_work",
    off: () => "No work items here: you cannot start a worker to write or run code.",
    tools: ["work_create", "work_send", "work_stop"],
    what: () => "Start work items: a worker in its own sandbox writes and runs code, uses a shell and a checkout, opens and updates pull "
      + "requests, and reports back; you forward instructions to it or stop it.",
  },
  {
    id: "check_work",
    off: () => "No checking what a worker did here (no work_recall or pr_state).",
    tools: ["work_recall", "pr_state"],
    what: (i) => `Check what a worker did and concluded${has(i, "work_recall") ? " (work_recall: its reports, the tail of what it wrote, its latest steps live)" : ""}`
      + `${has(i, "pr_state") ? " and where a pull request stands (pr_state)" : ""}.`,
  },
  {
    id: "watch_pull_requests",
    tools: ["work_subscribe"],
    // A watch reads GitHub with the user's own token (`githubEventPorts.loadToken`): without one it is never made (`no_github_token`).
    needs: (i) => i.features.github_events && hasToken(i),
    off: (i) => (i.features.github_events && has(i, "work_subscribe")
      ? githubMissing(i.githubAccount.token, "Watching pull requests in the background", CONNECT_GITHUB)
      : "No watching pull requests in the background on this deployment: a pull request is read only when asked."),
    gates: ["work_subscribe"],
    what: (i) => `Watch pull requests in the background: an item that watches one gets its new comments, reviews and failed CI as they `
      + `happen (read every ${i.features.github_poll_sec} s), and a pull request named when an item starts is watched by itself.`,
  },
  {
    id: "watch_jobs",
    off: () => "No watching jobs in the background here.",
    tools: ["job_watch"],
    needs: (i) => i.features.job_watch,
    what: (i) => `Watch a job in the background and tell the user when it changes or ends (read every ${i.features.job_poll_sec} s).`,
  },
  {
    id: "scheduled_tasks",
    off: () => "No scheduled tasks and no brief here: nothing runs on a schedule.",
    tools: ["trigger_create", "brief"],
    needs: (i) => i.features.triggers,
    what: (i) => [
      has(i, "trigger_create") ? "Run a task on a schedule, as the user (a card first)" : "",
      has(i, "brief") ? "put together the user's daily or weekly brief" : "",
    ].filter(Boolean).join("; ") + ".",
  },
  {
    id: "memory",
    tools: ["memory_save", "memory_recall"],
    needs: (i) => i.features.memory && i.userMemory.enabled && i.userMemory.here,
    gates: ["memory_save", "memory_update", "memory_forget", "memory_undo", "memory_recall"],
    what: () => "Remember things across conversations: saved at once when the user asks, with Undo; read back in later conversations.",
    off: (i) => (!i.features.memory || (!has(i, "memory_save") && !has(i, "memory_recall"))
      ? "No long-term memory on this deployment: nothing is saved or recalled across conversations."
      : !i.userMemory.enabled
        ? "Long-term memory is off for this user: nothing is saved or recalled; they can turn it on in their settings."
        : "Long-term memory is not kept in this conversation (one others read, such as a group's): nothing is saved or recalled here."),
  },
  {
    id: "reviews",
    tools: ["review_start"],
    // review_start refuses without both (`review-tools.ts`, requireReviews(true)); a review made as the user acts with the GitHub
    // account they bound at the identity provider, and is refused actor_not_bound without one (`github-review/service.ts`).
    needs: (i) => reviewsHere(i) && isBound(i),
    gates: ["review_start", "review_restart"],
    what: (i) => `Review pull requests and merge them when asked (started at once, no worker needed to ask); ${
      i.reviewMode === "fully_auto"
        ? "the user's review mode is fully_auto: a merge asked for happens once the review approves, without asking them"
        : "the user's review mode is high_risk_confirm: a high-risk approval or merge waits for their confirmation"}.`,
    off: (i) => (!reviewsHere(i) || !has(i, "review_start")
      ? "Reviews cannot be started from you on this deployment: no review or merge of a pull request is started here."
      : `${githubMissing(i.githubAccount.bound, "Reviewing or merging a pull request as the user", "/github bind (a GH_TOKEN does not count for reviews)")} Until then no review or merge is started as them.`),
  },
  {
    id: "github_comment",
    tools: ["github_comment"],
    // Posted with the user's token when they press the card (`githubCommentPorts.post`): without one it is not posted (`no_github_token`).
    needs: hasToken,
    gates: ["github_comment"],
    what: () => "Draft a comment on a pull request or issue, posted as the user when they press its card.",
    off: (i) => (has(i, "github_comment")
      ? githubMissing(i.githubAccount.token, "Commenting on a pull request or issue as the user", CONNECT_GITHUB)
      : "No commenting on GitHub here."),
  },
  {
    id: "dev_environments",
    off: () => "No access to the user's own machines here: their agent sessions (claude, codex, cursor) cannot be seen or sent to.",
    tools: ["devenv_list", "devenv_send", "devenv_pair"],
    needs: (i) => i.features.remote_agents,
    what: () => "See the user's own machines and the agent sessions on them (claude, codex, cursor), send an agent an instruction (a "
      + "card first), and pair a new machine.",
  },
  {
    id: "personal_skills",
    off: () => "No personal skills here: none are used, saved or changed.",
    tools: ["skill_read", "skill_save"],
    needs: (i) => i.features.user_skills,
    what: () => "Use, save and change the user's personal skills.",
  },
  {
    id: "deliver_files",
    off: () => "No handing the user a file here: what you write is said in the message.",
    tools: ["deliver_text"],
    what: () => "Hand the user a file you wrote (a document, a report, a script).",
  },
  {
    id: "self_status",
    off: () => "No report of how you yourself have been running here.",
    tools: ["claw_self_status"],
    what: () => "Say how you yourself have been running: reply times, failures, the version.",
  },
  {
    id: "model_choice",
    off: () => "No choosing the model here: work items run on the deployment's default.",
    tools: ["model_default_set"],
    what: () => "Run work items on a model the user picks, and set their default.",
  },
];

/** A limit, and the words in the name of a lookup server or tool that would lift it. */
interface LimitSpec { id: string; lifted?: RegExp; what: (on: boolean, i: CapabilityInputs) => string }

const LIMITS: readonly LimitSpec[] = [
  {
    id: "email",
    lifted: /mail|outlook|exchange/i,
    what: (on) => (on ? "Email: a system you can look up handles mail." : "No email: you cannot read or send the user's mail."),
  },
  {
    id: "calendar",
    lifted: /calendar|outlook|exchange/i,
    what: (on) => (on ? "Calendar: a system you can look up handles calendars." : "No calendar: you cannot read or book the user's meetings."),
  },
  {
    id: "documents",
    lifted: /sharepoint|onedrive|gdrive|google-?docs|confluence|notion/i,
    what: (on) => (on
      ? "Documents: a system you can look up holds the user's documents."
      : "No document stores: you cannot open the user's SharePoint, OneDrive or Google Docs (a file they send you is read)."),
  },
  {
    // Messages carry text, files and images; nothing in Claw hears audio or takes a call.
    id: "voice",
    what: () => "No voice: no voice messages heard and no calls; text, files and images only.",
  },
  {
    id: "other_chat_apps",
    what: (on, i) => (on
      ? `Chat apps: ${listed(i.channels)}.`
      : `Only in ${listed(i.channels)}: not in other chat apps (Slack, WeChat, email).`),
  },
];

const sorted = (xs: Iterable<string>): string[] => [...new Set(xs)].sort();

/** The list, from what it is built from. Pure. */
export function capabilityList(i: CapabilityInputs): Capabilities {
  const abilities = ABILITIES.map((a): Ability => {
    const present = (a.tools ?? []).filter((t) => has(i, t));
    const registered = a.tools === undefined || present.length > 0;
    const needed = a.needs ? a.needs(i) : true;
    const on: boolean | null = needed && registered ? true : registered && a.unknown?.when(i) ? null : false;
    return {
      id: a.id, on, what: on === true ? a.what(i) : on === null ? a.unknown!.what(i) : a.off(i),
      ...(a.id === "look_up" && on === true ? { tools: [...webToolsOf(i), ...(i.lookups.github ? ["github"] : []), ...i.lookups.systems] } : {}),
      ...(present.length ? { tools: present } : {}),
    };
  });
  const names = [...i.lookups.systems];
  const limits = LIMITS.map((l): Limit => {
    const on = l.id === "other_chat_apps"
      ? i.channels.length > 1
      : l.lifted !== undefined && names.some((n) => l.lifted!.test(n));
    return { id: l.id, on, what: l.what(on, i) };
  });
  // A tool that refuses while its ability is off (or may: not known) is not offered by how it acts: it is named under off_here.
  const offHere = new Set(ABILITIES.filter((a) => abilities.find((x) => x.id === a.id)!.on !== true).flatMap((a) => a.gates ?? []).filter((t) => has(i, t)));
  const of = (effect: ToolEffect): string[] => sorted(i.tools.filter((t) => TOOL_EFFECTS[t] === effect && !offHere.has(t)));
  const unclassified = sorted(i.tools.filter((t) => !Object.hasOwn(TOOL_EFFECTS, t)));
  const reviews = abilities.find((a) => a.id === "reviews")!;
  return {
    version: CAPABILITIES_VERSION,
    abilities,
    limits,
    review_mode: reviews.on === true
      ? {
        mode: i.reviewMode,
        means: i.reviewMode === "fully_auto"
          ? "a merge the user asked for happens once the review approves, without asking them (what the repository itself requires still holds it)"
          : "a high-risk approval or merge waits for the user's confirmation",
      }
      : null,
    acts_at_once: of("at_once"),
    asks_first: of("card_first"),
    reads: of("reads"),
    ...(offHere.size ? { off_here: sorted(offHere) } : {}),
    ...(unclassified.length ? { unclassified } : {}),
    lookups: { web: i.lookups.web === null ? null : { ...i.lookups.web }, github: i.lookups.github, systems: [...i.lookups.systems] },
    channels: [...i.channels],
  };
}

/** The chat apps the assistant is talked to in: those with a surface of their own and the one this message came through. */
export function channelsOf(current?: string): string[] {
  return sorted([...Object.keys(CHAT_SURFACES), ...(current ? [chatSurface(current).channel] : [])]);
}

/**
 * The user's GitHub as the tools that act with it find it: the token their watches and comments use (`githubEventPorts.loadToken`, which
 * throws where the identity provider cannot be asked), and the binding a review as them uses (the review service's own credential lookup,
 * `reviewItemPorts.delegationOf` asked of the user for themselves; absent where reviews are not set up). Each is asked only where the
 * deployment has what needs it.
 */
async function githubAccountOf(userId: string, features: DeploymentFeatures): Promise<GithubAccount> {
  let token: GithubAccountState;
  try {
    token = (await githubEventPorts.loadToken(userId, "assistant:capabilities")) ? "yes" : "none";
  } catch {
    token = "unknown";
  }
  let bound: GithubAccountState = "none";
  if (features.review_tools && features.github_review && features.review_items) {
    const ask = reviewItemPorts.delegationOf;
    let answer: Awaited<ReturnType<NonNullable<typeof ask>>> | "unavailable" = "unavailable";
    try {
      if (ask) answer = await ask(userId, userId);
    } catch {
      answer = "unavailable";
    }
    bound = answer === "on" || answer === "off" ? "yes" : answer === "not_bound" ? "none" : answer === "expired" ? "expired" : "unknown";
  }
  return { token, bound };
}

/** The user's memory as the memory tools decide it (`requireMemoryHere`): their setting, and whether this session keeps it. */
async function userMemoryOf(userId: string, sessionId: string | null): Promise<{ enabled: boolean; here: boolean }> {
  const enabled = await getMemoryPreference(userId);
  return { enabled, here: sessionId !== null && !(await sessionWithoutMemory(sessionId)) };
}

/**
 * What the list of a user is built from, read now; `sessionId` is the session of the turn (the router's own for the API's list; null:
 * none yet), `web` the web tools the Brain running the turn named (null: not known).
 */
export async function capabilityInputs(
  q: Querier, userId: string, sessionId: string | null, tools: readonly string[], channel?: string,
  deps: {
    features?: DeploymentFeatures;
    systems?: (userId: string) => Promise<readonly string[]>;
    github?: (sessionId: string) => Promise<boolean>;
    memory?: (userId: string, sessionId: string | null) => Promise<{ enabled: boolean; here: boolean }>;
    githubAccount?: (userId: string, features: DeploymentFeatures) => Promise<GithubAccount>;
    web?: WebTools | null;
  } = {},
): Promise<CapabilityInputs> {
  const features = deps.features ?? deploymentFeatures();
  const systems = await (deps.systems ?? (async (u: string) => (await routerReadTools(u))?.servers ?? []))(userId);
  const github = sessionId
    ? await (deps.github ?? (async (s: string) => Object.keys(await githubMcpServers(s)).length > 0))(sessionId)
    : false;
  const { mode } = await getReviewMode({ query: (t: string, p?: unknown[]) => q(t, p) } as never, userId);
  // Only asked where the deployment has memory at all: without it the entry is off whatever the user chose.
  const userMemory = features.memory ? await (deps.memory ?? userMemoryOf)(userId, sessionId) : { enabled: false, here: false };
  const githubAccount = await (deps.githubAccount ?? githubAccountOf)(userId, features);
  return {
    tools, features, lookups: { web: deps.web ?? null, github, systems }, reviewMode: mode, githubAccount, userMemory, channels: channelsOf(channel),
  };
}
