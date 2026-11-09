// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A person's GitHub binding, made and managed in their 1:1 chat: `/github bind` (GitHub's device flow; the token goes
 * straight to the identity service, never stored or logged here), `/github unbind`, `/github status`, `/github auto-merge
 * on|off` (the delegation switch, off by default) and the confirmation setting (`/github mode`, its card, or asked for in
 * the person's own words). Nothing here needs a Claw key: the person only has to be someone the identity service knows.
 */

import { errorName } from "../../errors.js";
import { accountText as t } from "../../locales/review-account.js";
import { NARROW_HINT as NARROW, NOT_YET_TEXT, REAUTHORIZE_LEAD, USAGE } from "../../locales/review-github.js";
import {
  type CredentialFailure,
  type DeviceCode,
  type GithubState,
  describeRefusal,
  needsWiderScope,
  usable,
} from "../../ports/github.js";
import type { Conversation, OutMessage, UserRef } from "../../ports/surface.js";
import { consentText, readsLine } from "../consent.js";
import { DEFAULT_MODE, type ReviewMode, isReviewMode } from "../review-turn.js";
import { REVIEW_MODES, TYPED_MODE_HINT, reviewModeMessage } from "../views.js";
import { say, sayQuietly } from "./chat.js";
import type { ReviewDeps } from "./deps.js";
import { NOT_YET, connectionOf, modeOf, writeMode } from "./identity.js";

/** A device flow that waits for a person's approval. */
interface Binding {
  readonly done: Promise<void>;
  readonly abort: AbortController;
  finished: boolean;
}

/** `(connected, login)` once a device flow has ended, for a question that waited for it. */
export type OnBound = (connected: boolean, login: string) => Promise<void>;

const notYetSentence = (): string => `${NOT_YET_TEXT.slice(0, 1).toUpperCase()}${NOT_YET_TEXT.slice(1)}。`;

export class GithubAccount {
  /** Teams user -> the device flow that waits for their approval. */
  private readonly binding = new Map<string, Binding>();
  /** Teams user -> the confirmation setting chosen while their binding is made. */
  private readonly modeChosen = new Map<string, ReviewMode>();

  constructor(private readonly deps: ReviewDeps) {}

  /** Settles when every device flow started so far has ended (for tests and an orderly stop). */
  async idle(): Promise<void> {
    await Promise.all([...this.binding.values()].map((b) => b.done));
  }

  /** `/github ...` in a 1:1 chat. */
  async command(sender: UserRef, args: string, conversation: Conversation): Promise<void> {
    const failure = await this.run(sender, args.toLowerCase().split(/\s+/u).filter(Boolean), conversation);
    if (failure === undefined) return;
    if (failure.kind === "not_bound") {
      await this.connectFirst(sender, conversation);
      return;
    }
    this.deps.logger.warn("github credential call failed", { error: describeRefusal(failure) });
    await say(this.deps, conversation, t.identityUnreachable);
  }

  private async run(
    sender: UserRef,
    words: readonly string[],
    conversation: Conversation,
  ): Promise<CredentialFailure | undefined> {
    const [verb = "", choice = ""] = words;
    const alone = words.length === 1;
    if (alone && verb === "bind") return this.bind(sender, conversation);
    if (alone && verb === "unbind") return this.unbind(sender, conversation);
    if (alone && verb === "status") return this.status(sender, conversation);
    if (alone && verb === "mode") return this.mode(sender, conversation);
    if (verb === "auto-merge" && (alone || (words.length === 2 && ["on", "off"].includes(choice)))) {
      return this.autoMerge(sender, choice, conversation);
    }
    await say(this.deps, conversation, USAGE);
    return undefined;
  }

  /** The identity service does not know this chat's user: they connect their Primus account first, then ask again. */
  async connectFirst(sender: UserRef, conversation: Conversation): Promise<void> {
    await this.deps.host.connectIdentity(sender, conversation, t.connectFirstLead);
  }

  private waiting(userId: string): boolean {
    const binding = this.binding.get(userId);
    return binding !== undefined && !binding.finished;
  }

  private async bind(sender: UserRef, conversation: Conversation): Promise<CredentialFailure | undefined> {
    const status = await this.deps.credentials.status(sender.id);
    if (!status.ok) return status.error;
    const state = status.value;
    if (usable(state) && !needsWiderScope(state.scopes)) {
      await say(this.deps, conversation, t.alreadyConnected(state.login));
      return undefined;
    }
    // (bound with `public_repo` only: approving the code again replaces it with one that reads private repositories)
    if (usable(state)) await say(this.deps, conversation, REAUTHORIZE_LEAD.replace("{login}", state.login));
    if (this.waiting(sender.id)) {
      await say(this.deps, conversation, t.alreadyWaiting);
      return undefined;
    }
    const started = await this.deps.device.start();
    if (!started.ok) {
      await say(this.deps, conversation, t.noCode);
      return undefined;
    }
    const [connection, known] = await connectionOf(this.deps, sender.id);
    await say(this.deps, conversation, consentText(started.value, !known || connection?.bindingReads === true));
    this.modeChosen.delete(sender.id);
    try {
      // (the choice goes with the binding; pressing nothing is the default)
      await conversation.send(this.modeCard(sender.id, "", "", t.chooseWithBind));
    } catch (err) {
      this.deps.logger.warn("the confirmation setting card could not be sent; the default applies", {
        error: errorName(err),
      });
    }
    this.startBinding(sender, started.value, conversation, undefined);
    return undefined;
  }

  /**
   * The device flow started for a question that needs the person's GitHub (the connect card shows the code): the code, or
   * undefined when there is nothing to start (connected already, a code already waits, or GitHub gave none). `onDone` runs
   * once when the flow ends; the default confirmation applies. A failure of the identity service is returned.
   */
  async bindForQuestion(
    sender: UserRef,
    conversation: Conversation,
    onDone: OnBound,
  ): Promise<DeviceCode | CredentialFailure | undefined> {
    const status = await this.deps.credentials.status(sender.id);
    if (!status.ok) return status.error;
    if (usable(status.value) || this.waiting(sender.id)) return undefined;
    const started = await this.deps.device.start();
    if (!started.ok) return undefined;
    this.modeChosen.delete(sender.id);
    this.startBinding(sender, started.value, conversation, onDone);
    return started.value;
  }

  private startBinding(
    sender: UserRef,
    code: DeviceCode,
    conversation: Conversation,
    onDone: OnBound | undefined,
  ): void {
    const abort = new AbortController();
    const entry: Binding = { abort, finished: false, done: Promise.resolve() };
    const done = this.finishBind(sender, code, conversation, abort.signal, onDone).finally(() => {
      entry.finished = true;
      if (this.binding.get(sender.id) === entry) this.binding.delete(sender.id);
    });
    Object.assign(entry, { done });
    this.binding.set(sender.id, entry);
  }

  /** Waits for the approval and hands the token to the identity service, in memory only. */
  private async finishBind(
    sender: UserRef,
    code: DeviceCode,
    conversation: Conversation,
    signal: AbortSignal,
    onDone: OnBound | undefined,
  ): Promise<void> {
    let outcome: readonly [boolean, string] = [false, ""];
    try {
      outcome = await this.waitAndBind(sender, code, conversation, signal, onDone !== undefined);
    } finally {
      if (onDone !== undefined) {
        try {
          await onDone(...outcome);
        } catch (err) {
          this.deps.logger.warn("what waited for a GitHub binding failed", { error: errorName(err) });
        }
      }
    }
  }

  /** (connected, the GitHub login) once the flow has ended; every way it can end is said to the person here. */
  private async waitAndBind(
    sender: UserRef,
    code: DeviceCode,
    conversation: Conversation,
    signal: AbortSignal,
    short: boolean,
  ): Promise<readonly [boolean, string]> {
    try {
      const token = await this.deps.device.waitForToken(code, signal);
      if (!token.ok) {
        if (token.error.kind === "device_flow_cancelled") return [false, ""];
        const reason = token.error.reason;
        const text = reason === "expired" ? t.codeExpired : reason === "denied" ? t.codeDenied : t.codeUnanswered;
        await sayQuietly(this.deps, conversation, text, "github bind");
        return [false, ""];
      }
      const bound = await this.deps.credentials.bind(sender.id, token.value);
      if (bound.ok) return await this.bound(sender, bound.value, conversation, short);
      await sayQuietly(this.deps, conversation, this.bindRefusal(bound.error), "github bind");
    } catch (err) {
      // (the type only: the frame that failed may have held the token)
      this.deps.logger.warn("github bind failed", { error: errorName(err) });
      await sayQuietly(this.deps, conversation, t.bindFailed, "github bind");
    }
    return [false, ""];
  }

  private bindRefusal(failure: CredentialFailure): string {
    if (failure.kind === "not_bound") return t.primusGone;
    this.deps.logger.warn("github bind was not accepted", { error: describeRefusal(failure) });
    return Object.hasOwn(t.bindRefused, failure.code) ? (t.bindRefused[failure.code] ?? "") : t.bindNotAccepted;
  }

  /** What the person is told once GitHub is connected: the review settings, or (`short`, a question waits) one line. */
  private async bound(
    sender: UserRef,
    state: GithubState,
    conversation: Conversation,
    short: boolean,
  ): Promise<readonly [boolean, string]> {
    const chosen = this.modeChosen.get(sender.id) ?? DEFAULT_MODE;
    this.modeChosen.delete(sender.id);
    // A choice Claw did not take is said: what Claw holds may be an earlier setting, so nothing is claimed about it.
    const written = await writeMode(this.deps, sender.id, chosen);
    if (short) {
      await sayQuietly(this.deps, conversation, t.connectedShort(state.login), "github bind");
      return [true, state.login];
    }
    const [zh, en] = REVIEW_MODES[chosen];
    const confirmation = written === true ? `${en} / ${zh}` : written === NOT_YET ? NOT_YET_TEXT : t.choiceNotSaved;
    await sayQuietly(this.deps, conversation, t.connected(state.login, confirmation), "github bind");
    return [true, state.login];
  }

  /** A click on one of the two confirmation settings: the clicker's own binding is the only one changed. */
  async modeClick(
    sender: UserRef,
    data: Readonly<Record<string, unknown>>,
    settle: (text: string) => Promise<unknown>,
    conversation: Conversation,
  ): Promise<void> {
    const mode = data.mode;
    if (!isReviewMode(mode)) {
      await settle(t.choiceInactive);
      return;
    }
    const [text, connect] = await this.chooseMode(sender, mode);
    await settle(text);
    if (connect) await this.connectFirst(sender, conversation);
  }

  /**
   * The one way a person's choice of a confirmation setting is carried out, pressed or typed: while their binding is being
   * made it waits for it; otherwise it is written now, as them. (What they are told, and whether to connect first.)
   */
  async chooseMode(sender: UserRef, mode: ReviewMode): Promise<readonly [string, boolean]> {
    const [zh, en] = REVIEW_MODES[mode];
    if (this.waiting(sender.id)) {
      this.modeChosen.set(sender.id, mode);
      return [t.chosenWhileBinding(en, zh), false];
    }
    const status = await this.deps.credentials.status(sender.id);
    let written: Awaited<ReturnType<typeof writeMode>> = false;
    if (status.ok) {
      if (!status.value.bound) return [t.connectGithubFirst, false];
      written = await writeMode(this.deps, sender.id, mode);
    } else if (status.error.kind === "not_bound") {
      return [t.connectPrimusFirst, true];
    } else {
      this.deps.logger.warn("github status call failed", { error: describeRefusal(status.error) });
    }
    if (written === NOT_YET) return [t.nothingChanged(NOT_YET_TEXT), false];
    return written ? [t.modeNow(en, zh), false] : [t.notSaved, false];
  }

  /** The confirmation-setting card; it says how to answer by typing until a click of the person's has arrived. */
  modeCard(userId: string, current: ReviewMode | "", suggested: ReviewMode | "", lead: string): OutMessage {
    const hint = !this.deps.store.members.clickedPersonally(userId);
    return reviewModeMessage({
      current,
      suggested,
      lead,
      hint: hint ? TYPED_MODE_HINT : "",
      installUrl: this.deps.installUrl,
    });
  }

  private async mode(sender: UserRef, conversation: Conversation): Promise<CredentialFailure | undefined> {
    const status = await this.deps.credentials.status(sender.id);
    if (!status.ok) return status.error;
    if (!status.value.bound) {
      await say(this.deps, conversation, t.modeNotConnected);
      return undefined;
    }
    const current = await modeOf(this.deps, sender.id);
    if (current === NOT_YET) {
      await say(this.deps, conversation, notYetSentence());
      return undefined;
    }
    await conversation.send(this.modeCard(sender.id, current, "", ""));
    return undefined;
  }

  /** Shows the card for a 1:1 message that asked about the setting (`suggested`: the one asked for; undefined: show it). */
  async showMode(sender: UserRef, suggested: ReviewMode | "" | "show", conversation: Conversation): Promise<void> {
    const status = await this.deps.credentials.status(sender.id);
    if (!status.ok) {
      if (status.error.kind === "not_bound") {
        await this.connectFirst(sender, conversation);
        return;
      }
      this.deps.logger.warn("github credential call failed", { error: describeRefusal(status.error) });
      await say(this.deps, conversation, t.identityUnreachable);
      return;
    }
    if (!status.value.bound) {
      await say(this.deps, conversation, t.notConnectedYet);
      return;
    }
    if (suggested === "show") {
      await this.status(sender, conversation);
      return;
    }
    const current = await modeOf(this.deps, sender.id);
    if (current === NOT_YET) {
      await say(this.deps, conversation, notYetSentence());
      return;
    }
    const lead =
      suggested !== "" && suggested === current
        ? t.alreadyThisOne(REVIEW_MODES[suggested][0]) + t.pressToChange
        : t.pressToChange;
    await conversation.send(this.modeCard(sender.id, current, suggested, lead));
  }

  private async unbind(sender: UserRef, conversation: Conversation): Promise<CredentialFailure | undefined> {
    const waiting = this.binding.get(sender.id);
    this.binding.delete(sender.id);
    waiting?.abort.abort();
    const removed = await this.deps.credentials.unbind(sender.id);
    if (!removed.ok) return removed.error;
    await say(this.deps, conversation, t.unbound(removed.value));
    return undefined;
  }

  async status(sender: UserRef, conversation: Conversation): Promise<CredentialFailure | undefined> {
    const status = await this.deps.credentials.status(sender.id);
    if (!status.ok) return status.error;
    const state = status.value;
    if (!state.bound) {
      // No binding here; Claw may still read GitHub with the GH_TOKEN of the person's settings, and then that is said too.
      const [connection, known] = await connectionOf(this.deps, sender.id);
      const reads = connection?.readsWith === "env" ? `\n\n${readsLine(connection, known)}` : "";
      await say(this.deps, conversation, t.statusNotConnected + reads);
      return undefined;
    }
    const mode = await modeOf(this.deps, sender.id);
    const lines = [
      t.statusLogin(state.login, state.expired),
      t.statusPermission(state.scopes.join(", ") || "unknown", needsWiderScope(state.scopes) ? NARROW : ""),
      t.statusValid(state.expiresAt || "unknown"),
      t.statusAutoMerge(state.delegation),
      t.statusConfirmation(
        isReviewMode(mode)
          ? `${REVIEW_MODES[mode][1]} / ${REVIEW_MODES[mode][0]}`
          : mode === NOT_YET
            ? NOT_YET_TEXT
            : t.statusConfirmationUnknown,
      ),
    ];
    if (state.lastUsedAt) lines.push(t.statusLastUsed(state.lastUsedAt));
    lines.push(readsLine(...(await connectionOf(this.deps, sender.id))));
    await say(this.deps, conversation, lines.join("\n\n"));
    return undefined;
  }

  private async autoMerge(
    sender: UserRef,
    choice: string,
    conversation: Conversation,
  ): Promise<CredentialFailure | undefined> {
    if (!choice) {
      const status = await this.deps.credentials.status(sender.id);
      if (!status.ok) return status.error;
      await say(this.deps, conversation, t.autoMergeIs(status.value.delegation));
      return undefined;
    }
    const set = await this.deps.credentials.setDelegation(sender.id, choice === "on");
    if (!set.ok) {
      if (set.error.kind === "credential_refused" && set.error.status === 404) {
        await say(this.deps, conversation, t.connectGithubFirstPlain);
        return undefined;
      }
      return set.error;
    }
    await say(this.deps, conversation, set.value.delegation ? t.autoMergeOn : t.autoMergeOff);
    return undefined;
  }
}
