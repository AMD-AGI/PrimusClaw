// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** Remote agents: which session a chat is attached to, how far it has read, and the permission cards it showed
 * (tables `remote_state`, `remote_session_names`, `remote_permissions`). */

/** 'card': the chat box goes to the assistant and the session card's input to the session; 'chat': all to the session. */
export type ChatBox = "card" | "chat";

export interface RemoteState {
  /** null: not attached. */
  readonly sessionId: string | null;
  readonly connectorId: string;
  readonly agentId: string;
  readonly agentLabel: string;
  readonly host: string;
  readonly cwd: string;
  /** Id of the last event of the session handled ('' none). */
  readonly cursor: string;
  /** A prompt was sent and its turn end has not been seen. */
  readonly turnOpen: boolean;
  readonly mode: string;
  readonly modes: readonly string[];
  /** Session ids of the last /agent sessions, in the order shown. */
  readonly listing: readonly string[];
  /** The session does not ask before a step; null: not said. */
  readonly unattended: boolean | null;
  /** mode id -> whether selecting it makes the session unattended. */
  readonly modeFlags: Readonly<Record<string, boolean>>;
  readonly statusCard: string;
  readonly attachedAt: number;
  readonly conversation: string;
  readonly conversationRef: string;
  readonly window: ChatBox | (string & {});
  readonly windowCards: readonly string[];
}

export interface RemoteAttachment {
  readonly sessionId: string;
  readonly connectorId: string;
  readonly agentId: string;
  readonly agentLabel: string;
  readonly host: string;
  readonly cwd: string;
  readonly cursor?: string;
  readonly mode?: string;
  readonly modes?: readonly string[] | null;
  readonly unattended?: boolean | null;
  readonly modeFlags?: Readonly<Record<string, boolean>> | null;
  readonly conversation?: string;
  readonly conversationRef?: string;
  readonly window?: string;
}

/** What the agent said about its permission modes; an absent part stays as it was. */
export interface RemoteModes {
  readonly mode?: string | null;
  readonly modes?: readonly string[] | null;
  readonly unattended?: boolean | null;
  readonly modeFlags?: Readonly<Record<string, boolean>> | null;
}

export interface RemoteSessionName {
  readonly title: string;
  readonly conversationRef: string;
}

export interface RemoteStateRepository {
  getRemote(chatKey: string): RemoteState | null;
  remoteAttachedUsers(): string[];
  attachedRemote(chatKey: string): RemoteState | null;
  /** The last listing and status card survive an attach. */
  attachRemote(chatKey: string, attachment: RemoteAttachment): void;
  setRemoteWindow(chatKey: string, window: string): void;
  /** Remember a replaced session card (the last WINDOW_CARDS_KEPT). */
  noteWindowCard(chatKey: string, cardId: string, kept?: number): void;
  detachRemote(chatKey: string): void;
  /** Only forward, and only for the attached session; a non-numeric cursor is ignored. */
  setRemoteCursor(chatKey: string, sessionId: string, cursor: string): void;
  setRemoteTurn(chatKey: string, sessionId: string, isOpen: boolean): void;
  setRemoteModes(chatKey: string, sessionId: string, modes: RemoteModes): void;
  setRemoteStatusCard(chatKey: string, cardId: string): void;
  setRemoteListing(chatKey: string, sessionIds: readonly string[]): void;
}

export interface RemoteSessionNameRepository {
  nameRemoteSession(userId: string, sessionId: string, name?: Partial<RemoteSessionName>): void;
  /** Only a session with no title yet gets one. */
  titleRemoteSession(sessionId: string, title: string): void;
  setRemoteSessionAcp(sessionId: string, acpSessionId: string): void;
  remoteSessionAcps(userId: string): Map<string, string>;
  remoteSessionNames(userId: string): Map<string, RemoteSessionName>;
}

export type RemotePermissionState = "pending" | "sending" | "decided" | "expired" | (string & {});

export interface RemotePermission {
  readonly sessionId: string;
  readonly actionId: string;
  readonly userId: string;
  readonly tool: string;
  /** [{optionId, name, kind}] exactly as the agent offered them. */
  readonly options: readonly unknown[];
  readonly expiresAt: number;
  readonly state: RemotePermissionState;
}

export interface NewRemotePermission {
  readonly userId: string;
  readonly sessionId: string;
  readonly actionId: string;
  readonly tool: string;
  readonly options: readonly unknown[];
  readonly expiresAt: number;
}

export interface RemotePermissionRepository {
  /** Recorded before it is shown; false when this request already has a row. */
  saveRemotePermission(permission: NewRemotePermission): boolean;
  getRemotePermission(sessionId: string, actionId: string): RemotePermission | null;
  /** Pending and not run out, oldest first. */
  pendingRemotePermissions(userId: string, sessionId: string): RemotePermission[];
  waitingRemoteSessions(userId: string): Set<string>;
  forgetRemotePermission(sessionId: string, actionId: string): void;
  closeRemotePermission(sessionId: string, actionId: string, state: RemotePermissionState, options?: { readonly onlyIfPending?: boolean }): boolean;
}
