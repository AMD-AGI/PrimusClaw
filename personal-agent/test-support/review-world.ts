// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A world for the review delegation's tests (the Python worker's `test_github_review.world`): the real service over the real
 * SQLite store, the real identity-service client and GitHub device flow behind fake HTTP answers, a fake Claw that records
 * what it is asked, a recording channel, and a host that records the turns it is asked to start. Alice asks; Bob reviews.
 */
import {
  type ClawPort,
  type Conversation,
  type InboundMessage,
  type InboundMention,
  type JsonObject,
  type ReviewStart,
  type StartReviewTurn,
  type UserRef,
  ClawError,
  ReviewsRefused,
  GithubReview,
  Guardrails,
  ok,
  err,
  silentLogger,
  type ReviewDeps,
} from "../packages/core/src/index.js";
import { GithubApi } from "../packages/runtime/src/github/api.js";
import { IdentityCredentialClient } from "../packages/runtime/src/github/credential-client.js";
import { GithubDeviceFlow } from "../packages/runtime/src/github/device-flow.js";
import { PublicPullReader } from "../packages/runtime/src/github/pull-reader.js";
import { FakeClock } from "./clock.js";
import { SeededRandom } from "./random.js";
import { openTestStore } from "./store.js";
import { FakeSurface } from "./surface.js";

export const CONV = "19:group@thread.v2";
export const PR = "AMD-AGI/Hyperloom#12";
export const ALICE: UserRef = { id: "aad-a", channelUserId: "29:a", name: "Alice", email: "" };
export const BOB: UserRef = { id: "aad-b", channelUserId: "29:b", name: "Bob", email: "" };
export const CAROL: UserRef = { id: "aad-c", channelUserId: "29:c", name: "Carol", email: "" };
/** A GitHub OAuth token shape: it must show up in no message and no request but the bind. */
export const TOKEN = `gho_${"A1b2C3d4E5".repeat(4)}`;

interface Known {
  userId: string;
  login: string | null;
  delegation: boolean;
  expired: boolean;
  scopes: string[];
}

/** The identity service's /oauth/external-credentials: a user it has a binding for answers, any other is invalid_grant. */
export class Identity {
  readonly users = new Map<string, Known>();
  readonly requests: { action: string; body: Record<string, unknown> }[] = [];
  bindError: [number, string] | undefined;
  down = false;

  know(
    aad: string,
    userId: string,
    login: string | null = null,
    delegation = false,
    expired = false,
    scopes = ["repo"],
  ): void {
    this.users.set(aad, { userId, login, delegation, expired, scopes });
  }

  handle(url: string, body: Record<string, unknown>): Response {
    const action = url.split("/").at(-1) ?? "";
    this.requests.push({ action, body });
    if (this.down) return Response.json({ error: "server_error" }, { status: 503 });
    const user = this.users.get(String(body.user).split("|")[1] ?? "");
    if (user === undefined) return Response.json({ error: "invalid_grant" }, { status: 400 });
    if (action === "bind") {
      if (this.bindError)
        return Response.json({ error: this.bindError[1], error_description: TOKEN }, { status: this.bindError[0] });
      user.login = `octo-${user.userId}`;
      user.scopes = ["repo"];
    } else if (action === "unbind") {
      const had = user.login !== null;
      user.login = null;
      user.delegation = false;
      return Response.json({ user_id: user.userId, unbound: had });
    } else if (action === "delegation") {
      if (user.login === null) return Response.json({ error: "not_bound" }, { status: 404 });
      user.delegation = body.enabled === true;
    }
    const item =
      user.login === null
        ? null
        : {
            provider: "github",
            providerLogin: user.login,
            scopes: user.scopes,
            expiresAt: "2027-01-27T00:00:00Z",
            lastUsedAt: null,
            delegation: user.delegation,
            expired: user.expired,
          };
    return Response.json(
      action === "status"
        ? { user_id: user.userId, bound: item !== null, ...(item ? { item } : {}) }
        : { user_id: user.userId, item },
    );
  }

  askedAbout(): string[] {
    return this.requests.map((r) => String(r.body.user));
  }
}

/** github.com's device flow (answers to the polls scripted) and api.github.com's public pull request reads. */
export class Github {
  script: string[] = ["ok"];
  readonly polls: Record<string, string>[] = [];
  startStatus = 200;
  verificationUri = "https://github.com/login/device";
  authors = new Map<string, string>();
  defaultAuthor = "alice-gh";
  repos = new Map([
    ["amd-agi/primusclaw", "AMD-AGI/PrimusClaw"],
    ["amd-agi/hyperloom", "AMD-AGI/Hyperloom"],
  ]);
  readonly reads: string[] = [];

  handle(url: string, form: Record<string, string>): Response {
    const path = new URL(url).pathname;
    if (path === "/login/device/code") {
      if (this.startStatus !== 200) return Response.json({}, { status: this.startStatus });
      return Response.json({
        device_code: "dc-secret",
        user_code: "ABCD-1234",
        expires_in: 900,
        interval: 5,
        verification_uri: this.verificationUri,
      });
    }
    this.polls.push(form);
    const step = this.script.shift() ?? "authorization_pending";
    if (step === "ok") return Response.json({ access_token: TOKEN, token_type: "bearer", scope: "repo" });
    if (step === "slow_down") return Response.json({ error: "slow_down", interval: 10 });
    return Response.json({ error: step });
  }

  api(url: string): Response {
    const parts = new URL(url).pathname.split("/");
    this.reads.push(new URL(url).pathname);
    if (parts.length === 4) {
      const full = this.repos.get(`${parts[2] ?? ""}/${parts[3] ?? ""}`.toLowerCase());
      return full ? Response.json({ full_name: full, private: false }) : Response.json({}, { status: 404 });
    }
    const [, , owner = "", repo = "", , number = ""] = parts;
    const author = this.authors.get(`${owner}/${repo}#${number}`.toLowerCase()) ?? this.defaultAuthor;
    return Response.json({ number: Number(number), user: { login: author }, title: "a change", base: { ref: "main" } });
  }
}

/** The parts of Claw the review service calls, recording what it is asked. */
export class ReviewClaw {
  readonly calls: [string, ...unknown[]][] = [];
  reviewModes = new Map<string, string>();
  modeError: number | undefined;
  models: string[] | ClawError = ["claude-sonnet-5.5", "claude-opus-5.5", "gpt-6-luna"];
  modelChoice: JsonObject | null = null;
  /** What `startReviews` answers: 404 (a Claw without items) unless a test sets the items. */
  starts: ((token: string, request: Record<string, unknown>) => ReviewStart[]) | undefined;
  confirmations: JsonObject[] = [];
  decision: JsonObject | ClawError = { status: "merged", merge_sha: "0123456789abcdef" };
  connection: JsonObject | null = null;
  /** Refusals by pull request ("owner/repo#n", lower case): [status, error, data]. */
  refuse = new Map<string, [number, string, Record<string, unknown>]>();
  /** What the asker's view of each item says. */
  views = new Map<string, Record<string, unknown>>();
  /** A whole request refused, or not answered. */
  refuseAll: Error | undefined;

  private refused(request: Record<string, unknown>): Error | undefined {
    if (this.refuseAll !== undefined) return this.refuseAll;
    for (const pr of request.prs as { pull: { owner: string; repo: string; number: number } }[]) {
      const refusal = this.refuse.get(`${pr.pull.owner}/${pr.pull.repo}#${String(pr.pull.number)}`.toLowerCase());
      if (refusal) return new ReviewsRefused(refusal[0], refusal[1], "", { ...refusal[2], pr: pr.pull });
    }
    return undefined;
  }

  port(): ClawPort {
    const fail = (): never => {
      throw new ClawError(404, "not here");
    };
    const port = {
      settings: {
        reviewMode: (token: string) => {
          if (this.modeError) throw new ClawError(this.modeError);
          return Promise.resolve(this.reviewModes.get(token) ?? "");
        },
        setReviewMode: (token: string, mode: string) => {
          this.calls.push(["setReviewMode", token, mode]);
          if (this.modeError) throw new ClawError(this.modeError);
          this.reviewModes.set(token, mode);
          return Promise.resolve();
        },
        githubConnection: () => Promise.resolve(this.connection),
        models: (key: string) => {
          this.calls.push(["models", key]);
          return this.models instanceof ClawError ? Promise.reject(this.models) : Promise.resolve([...this.models]);
        },
        assistantSettings: () => Promise.resolve(this.modelChoice),
      },
      assistant: {
        startReviews: (token: string, request: Record<string, unknown>) => {
          this.calls.push(["startReviews", token, request]);
          const refused = this.refused(request);
          if (refused !== undefined) return Promise.reject(refused);
          if (this.starts === undefined)
            return Promise.reject(new ClawError(404, '{"message":"Route POST:/v1/assistant/reviews not found"}'));
          return Promise.resolve(this.starts(token, request));
        },
      },
      mergeConfirmations: {
        pending: (key: string, sessionId: string) => {
          this.calls.push(["confirmations", key, sessionId]);
          return Promise.resolve(this.confirmations.map((c) => ({ ...c })));
        },
        decide: (token: string, id: string, decision: string) => {
          this.calls.push(["decide", token, id, decision]);
          return this.decision instanceof ClawError ? Promise.reject(this.decision) : Promise.resolve(this.decision);
        },
      },
      workItems: {
        get: fail,
        requesterView: (token: string, itemId: string) => {
          this.calls.push(["view", token, itemId]);
          const view = this.views.get(itemId);
          if (view === undefined) return Promise.reject(new ClawError(404));
          return Promise.resolve({
            itemId,
            status: "",
            prUrl: "",
            verdict: "",
            merged: false,
            waitingFor: "",
            findings: null,
            note: "",
            prSummary: "",
            ...view,
          });
        },
      },
    };
    return port as unknown as ClawPort;
  }
}

export interface Started extends StartReviewTurn {
  readonly ended: () => void;
}

/** A host that records the turns it is asked to start and the onboarding it is asked for. */
function recordingHost(
  started: Started[],
  said: { onboard: number; askLink: string[]; connect: string[] },
): ReviewDeps["host"] {
  return {
    startTurn: (request) => {
      let ended: () => void = () => undefined;
      const done = new Promise<void>((resolve) => {
        ended = resolve;
      });
      started.push({ ...request, ended });
      return Promise.resolve({ ended: done });
    },
    onboard: () => {
      said.onboard += 1;
      return Promise.resolve();
    },
    askLink: (person, _c, lead) => {
      said.askLink.push(`${person.id}:${lead}`);
      return Promise.resolve();
    },
    connectIdentity: (person, _c, lead) => {
      said.connect.push(`${person.id}:${lead}`);
      return Promise.resolve();
    },
  };
}

/** The review service with everything it talks to faked, as `test_github_review.world` builds it. */
export function reviewWorld(owners: readonly string[] = ["AMD-AGI"]) {
  const { store, clock } = openTestStore({ clock: new FakeClock(Date.UTC(2026, 10, 9)) });
  const identity = new Identity();
  const github = new Github();
  const claw = new ReviewClaw();
  const surface = new FakeSurface({ reachable: ["aad-a", "aad-b", "aad-c"] });
  const bound = new Set(["aad-a", "aad-b"]);
  const started: Started[] = [];
  const said = { onboard: 0, askLink: [] as string[], connect: [] as string[] };
  const audits: [string, Record<string, unknown>][] = [];
  const fetchIdentity = (input: string, init?: RequestInit) =>
    Promise.resolve(
      identity.handle(input, JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Record<string, unknown>),
    );
  const fetchGithub = (input: string, init?: RequestInit) =>
    Promise.resolve(
      github.handle(input, Object.fromEntries(new URLSearchParams(typeof init?.body === "string" ? init.body : ""))),
    );
  const deps: ReviewDeps = {
    store,
    claw: claw.port(),
    credentials: new IdentityCredentialClient({
      baseUrl: "https://id.test/oauth/external-credentials",
      clientId: "cid",
      clientSecret: "csecret",
      issuer: "teams.microsoft.com",
      fetch: fetchIdentity,
    }),
    device: new GithubDeviceFlow({ clientId: "cli-id", clock, fetch: fetchGithub }),
    pulls: new PublicPullReader(new GithubApi({ fetch: (input) => Promise.resolve(github.api(input)) }), silentLogger),
    intent: undefined,
    surface,
    exchange: {
      enabled: true,
      tokenFor: (userId: string) =>
        Promise.resolve(bound.has(userId) ? ok(`tok-${userId}`) : err({ kind: "not_bound" as const })),
      bindingRequest: () => Promise.resolve(err({ kind: "exchange_unavailable" as const })),
      invalidate: () => undefined,
    },
    clock,
    logger: silentLogger,
    errors: { withhold: () => "ref-1", publicReason: (reason: unknown) => (typeof reason === "string" ? reason : "") },
    mask: (text) => text.replaceAll(TOKEN, "[hidden]"),
    guard: new Guardrails(clock, () => undefined),
    audit: (event, fields) => audits.push([event, { ...fields }]),
    host: recordingHost(started, said),
    followWire: () => ({}),
    restoreRef: (stored) => {
      const id = (stored.conversation as { id?: string } | undefined)?.id;
      return id
        ? { id, kind: id.startsWith("19:") ? "group" : "personal", tenantId: "tenant-1", wire: stored }
        : undefined;
    },
    owners,
    installUrl: "",
    defaultModel: "",
  };
  const link = (userId: string, name: string, key: string): void => {
    store.links.redeemPending(userId, name, store.links.stashPending(key));
  };
  link("aad-a", "Alice", "ak-alice-linked");
  link("aad-b", "Bob", "ak-bob-linked");
  identity.know("aad-a", "u-alice", "alice-gh");
  identity.know("aad-b", "u-bob", "bob-gh", true);
  store.members.rememberMember("29:b", "aad-b", "Bob");
  const service = new GithubReview(deps, new SeededRandom(7), () => Promise.resolve());
  return { service, deps, store, clock, identity, github, claw, surface, started, said, audits, bound, link };
}

export type ReviewWorld = ReturnType<typeof reviewWorld>;

/** A message in the group chat (or in Alice's 1:1 chat): `{Name}` is an @mention of that person. */
export function groupMessage(
  text: string,
  sender: UserRef = ALICE,
  people: readonly UserRef[] = [BOB, CAROL],
  id = "g1",
  kind: "group" | "personal" = "group",
): InboundMessage {
  const mentions: InboundMention[] = [];
  let shown = text;
  for (const person of people) {
    const tag = `{${person.name}}`;
    const at = shown.indexOf(tag);
    if (at < 0) continue;
    shown = shown.replace(tag, person.name);
    mentions.push({
      channelUserId: person.channelUserId,
      userId: "",
      name: person.name,
      shown: person.name,
      offset: at,
    });
  }
  const conversation =
    kind === "group"
      ? { id: CONV, kind, tenantId: "tenant-1", wire: { conversation: { id: CONV } } }
      : {
          id: `personal:${sender.id}`,
          kind,
          tenantId: "tenant-1",
          wire: { conversation: { id: `personal:${sender.id}` } },
        };
  return {
    type: "message",
    id,
    sender,
    conversation,
    locale: "",
    clientPlatform: "",
    text: shown,
    mentioned: true,
    targeted: false,
    namesBotFirst: false,
    conversationName: kind === "group" ? "Primus 运维群" : "",
    mentions,
    links: [],
    quotes: [],
    files: [],
    unreadableFiles: [],
    provenance: "typed",
  };
}

/** The texts the service said in a conversation. */
export function saidIn(surface: FakeSurface, conversation: string): string {
  return surface
    .of(conversation)
    .flatMap((r) => ("message" in r && r.message.body.type === "text" ? [r.message.body.text] : []))
    .join(" ");
}

export type { Conversation };
