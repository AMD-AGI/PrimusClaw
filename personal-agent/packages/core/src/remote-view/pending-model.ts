// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// TEMPORARY: the shapes of W6's remote/model.ts (the zod-read Claw remote-agents listing), as W6 announced them. Replaced by an
// import of that module once W6's branch is merged in.

export interface RemoteAgent {
  readonly agentId: string;
  readonly kind: string;
  readonly name: string;
  /** The connector's own report, opaque to Claw: read key by key. */
  readonly capabilities: Readonly<Record<string, unknown>>;
}

export interface RemoteConnector {
  readonly connectorId: string;
  readonly name: string;
  readonly online: boolean;
  readonly version: string | null;
  readonly versionStatus: string | null;
  /** As Claw wrote it. */
  readonly lastSeenAt: string | null;
  readonly heartbeatAt: string | null;
  readonly paired: boolean;
  readonly agents: readonly RemoteAgent[];
}

export interface RemoteSession {
  readonly sessionId: string;
  readonly connectorId: string;
  readonly agentId: string;
  readonly cwd: string;
  readonly status: string;
  readonly mode: string | null;
  readonly readOnly: boolean;
  readonly connectorOnline: boolean;
  readonly createdAt: string | null;
  /** As Claw wrote it. */
  readonly updatedAt: string | null;
}
