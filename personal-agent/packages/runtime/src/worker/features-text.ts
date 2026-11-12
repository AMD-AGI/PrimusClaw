// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The router's small readers, built from core's pure functions: what a message carries besides its words (quotes, links,
 * files the surface gave no way to fetch), the per-person limits, the channel context a message to the assistant carries, the
 * note card a settled click ends as, `/whoami`'s connection lines, and fetching a message's files through the surface.
 */
import type {
  PendingEntry,
  ChannelContextBuilder,
  Clock,
  ConnectionsText,
  FetchedFile,
  InboundFile,
  InboundMessage,
  KnownMember,
  Integrations,
  MessageFiles,
  MessageText,
  NoteFactory,
  NoteTone,
  RouterLimits,
  Surface,
  UserLimits,
  ViewButton,
} from "@primusclaw/personal-agent";
import {
  channelActions,
  channelContext,
  connectionsText,
  limitsText,
  MessageRateLimiter,
  noteMessage,
  peopleOf,
  quoteBlock,
  redactText,
  turn,
  UNKNOWN,
  ASSISTANT_PENDING_SECONDS,
  waitWords,
  withLinks,
  withQuote,
} from "@primusclaw/personal-agent";

/** Python `activity.is_group`: a group chat (not a channel) is masked. */
function isGroup(message: InboundMessage): boolean {
  return message.conversation.kind === "group";
}

const mask = (text: string): string => redactText(text).text;

/**
 * The router's reading of quotes, links and unreadable files (Python `activity.quote_block`, `with_links`, `with_quote`), on
 * the surface people know as `channelName` (what an unreadable file's line says did not give it).
 */
export function messageTextFor(channelName: string): MessageText {
  return {
    quoteBlock: (message, group) => quoteBlock(message.quotes, { group, redact: mask }),
    withLinks: (text, message) => withLinks(text, message.links, { group: isGroup(message), redact: mask }),
    withQuote,
    unreadable(message) {
      const names = message.unreadableFiles;
      if (names.length === 0) return undefined;
      // (Python `inbound.unreadable_line`; core's turn/files.ts has the shown name but no such line)
      const line = `${channelName} did not give me ${names.map((n) => turn.shownName(n)).join(", ")}. I can read images pasted into the message.`;
      return { line, count: names.length };
    },
  };
}

/** TEAMS_USER_*: messages per window, tasks at once (Python `limits.UserLimits` and `MessageRateLimiter`). */
export function routerLimits(limits: UserLimits, clock: Clock): RouterLimits {
  const rate = new MessageRateLimiter(limits.messageLimit, limits.messageWindowSeconds, clock);
  return {
    maxConcurrentTasks: limits.maxConcurrentTasks,
    assistantPendingSeconds: ASSISTANT_PENDING_SECONDS,
    checkMessage(userId) {
      const verdict = rate.check(userId);
      if (verdict.allowed) return { allowed: true };
      return {
        allowed: false,
        notify: verdict.notify,
        retryAfterSeconds: verdict.retryAfterSeconds,
        limit: rate.limit,
        windowSeconds: rate.windowSeconds,
      };
    },
    rateNotice: (lang, retryAfterSeconds) =>
      limitsText.in(lang).rateLimited({ s: rate.limit > 1 ? "s" : "", wait: waitWords(retryAfterSeconds, lang) }),
    concurrencyNotice: (lang, running, what) => limitsText.in(lang).concurrencyLimited({ running, what }),
  };
}

/** Python `understanding.channel_context` as `Agent._understood` builds it (the people named, the chat's actions). */
export function channelContextBuilder(
  store: ContextStore,
  /** What waits for the person's answer (the review service's held confirmations; none without it). */
  pending: (userId: string) => readonly PendingEntry[] = () => [],
): ChannelContextBuilder {
  return (request) => {
    const mentions = request.message.mentions.map((m) => ({
      mentioned: { id: m.channelUserId, name: m.name, aadObjectId: m.userId },
    }));
    const known = store.members.knownMembers().map((m) => ({
      id: m.id,
      name: m.name,
      objectId: m.objectId,
      ...(m.email ? { email: m.email } : {}),
    }));
    const people = peopleOf(
      mentions,
      request.message.text,
      known,
      (aad) => store.links.clawUserIdOf(aad),
      (channelId) => store.members.userForChannelId(channelId),
    );
    const actions = channelActions(request.parts as Parameters<typeof channelActions>[0]);
    const context = channelContext({
      channelMessageId: request.channelMessageId,
      people,
      pending: [...pending(request.userId)],
      actions: actions as unknown as Parameters<typeof channelContext>[0]["actions"],
      handoffs: request.handoffs,
      ...("attached" in request ? { attached: request.attached } : {}),
      via: request.via,
    });
    return {
      context,
      actions: actions.map((a) => a.name),
      people: people.flatMap((p) => (p.user_id ? [p.user_id] : [])),
    };
  };
}

interface ContextStore {
  readonly members: {
    knownMembers(): readonly KnownMember[];
    userForChannelId(channelUserId: string): string | null;
  };
  readonly links: { clawUserIdOf(userId: string): string | null };
}

const TONES: ReadonlySet<string> = new Set(["default", "good", "attention", "warning", "accent"]);

/** The note card a settled click ends as (Python `render.note_card`). */
export const noteFactory: NoteFactory = (text, options = {}) => {
  const buttons: ViewButton[] = (options.buttons ?? []).map((b) => ({
    title: b.title,
    verb: b.verb,
    data: { ...b.data },
    ...(b.style ? { style: b.style } : {}),
  }));
  return noteMessage({
    text,
    ...(options.title === undefined ? {} : { title: options.title }),
    ...(options.tone !== undefined && TONES.has(options.tone) ? { tone: options.tone as NoteTone } : {}),
    ...(buttons.length ? { buttons } : {}),
  });
};

/** `/whoami`'s lines after its first (the review service's `connectionsText`, with the deployment's integration lines). */
export function whoamiConnections(integrations: Integrations): ConnectionsText {
  return (c) =>
    connectionsText({
      safe: c.owner === undefined ? null : { name: c.owner.name },
      githubState:
        c.githubState === undefined ? null : (c.githubState as Parameters<typeof connectionsText>[0]["githubState"]),
      connection: c.connection ?? null,
      connectionKnown: c.connectionKnown,
      githubPart: c.githubPart,
      memory: c.memory ?? UNKNOWN,
      memoryPage: c.memoryPage,
      zh: c.zh,
      extraLines: integrations.connectionLines.map((line) => line(c.owner, c.zh ? "zh" : "en")),
    });
}

/** A message's files through the surface, each once (Python `FileFetcher.fetch_all`): fetched, and why not for the rest. */
export async function fetchAll(
  surface: Pick<Surface, "fetchFile">,
  files: readonly InboundFile[],
): Promise<{ fetched: FetchedFile[]; failed: [string, string][] }> {
  const fetched: FetchedFile[] = [];
  const failed: [string, string][] = [];
  const names = new Set<string>();
  for (const [at, file] of files.entries()) {
    const index = at + 1;
    const got = await surface.fetchFile(file);
    if (!got.ok) {
      failed.push([file.name || `image ${String(index)}`, got.error.reason]);
      continue;
    }
    let name = got.value.name;
    while (names.has(name)) name = `${String(index)}-${name}`;
    names.add(name);
    fetched.push({ ...got.value, name });
  }
  return { fetched, failed };
}

/** The assistant's side of a message's files (W5 `MessageFiles`). */
export function messageFiles(surface: Pick<Surface, "fetchFile">): MessageFiles {
  return {
    fetch: (files) => fetchAll(surface, files),
    uploadFolder: (messageId) => turn.uploadFolder(messageId),
    failedLine: (failed) => turn.failedFilesLine(failed),
  };
}
