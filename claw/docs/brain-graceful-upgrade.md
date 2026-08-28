# Brain Graceful Upgrade Design

## 1. Goals and Constraints

| Goal | Description |
|------|------|
| Old Brain stops accepting new tasks during upgrade | Stops pulling within milliseconds after version signal arrives |
| New Brain comes online first, old Brain exits last | maxSurge=100%, no gap, no forced interruption |
| Old Brain exits naturally, K8s auto-cleans | Old Pod completes tasks then receives SIGTERM → exit, Deployment auto-reclaims |
| Current in-flight tasks are not interrupted or can be resumed | Checkpoint after SIGTERM, any new Brain can resume |
| No task loss | NATS JetStream at-least-once + session lock dual guarantee |
| Can resume after sandbox rebuild | S3 file snapshot + NATS KV conversation history dual-layer checkpoint |

---

## 2. Overall Architecture

### 2.1 Deployment Model Change

```
Old: StatefulSet (podManagementPolicy: Parallel, rollingUpdate)
New: Deployment  (maxSurge=100%, maxUnavailable=0)
```

Brain is essentially a stateless worker — all persistent state (NATS/PG/S3/KV) is external.
StatefulSet's stable Pod ordinals were only used for NATS durable consumer naming;
after switching to Ephemeral consumers, this dependency is eliminated and safe migration to Deployment is possible.

### 2.2 Upgrade Flow

```
upgrade.sh: kubectl apply brain-deployment.yaml (NEW_TAG)
        │ (Deployment rolling update, maxSurge=100%, maxUnavailable=0)
        ▼
K8s starts 3 new Pods first (6 Pods total), old Pods continue serving
New Brain (BRAIN_VERSION = min_version):
  Pulls immediately → checks task-ckpt.{sessionId} → resume or fresh execution

        │ After all new Pods are Ready
        ▼
upgrade.sh writes to NATS KV: brain.min_version = NEW_TAG
        │ (KV Watch millisecond-level push)
        ▼
All Brains whose BRAIN_VERSION != min_version:
  versionDrained=true  ← Hand new deliveries back; keep the consumer running
  Continue running in-flight tasks to completion

  The test is identity, not order: tags are <prefix>-<sha>-<timestamp>, so a
  lexicographic compare is decided by the prefix and then by a random sha and
  never reaches the timestamp. It is also reversible — a pod that booted while
  the previous upgrade's value was still in the key drains on a stale tag, and
  the write above is what releases it.

  Reversible means every reader of the flag has to re-ask it. Deliveries do,
  per message. So does the claim-next loop, per cycle: it sleeps through a
  drain rather than exiting on one, because it is started once and only
  shutdown ends it — exiting would cost the pod claim-next for the rest of its
  life, including after the drain was released.

        │
        ▼
K8s sends SIGTERM to old 3 Pods
Old Brain: already idle (tasks completed earlier) → exits in seconds
K8s auto-cleans old Pods, Deployment stabilizes at 3 replicas
```

### 2.3 NATS Consumer Change: Durable → Ephemeral

```
Old: durable consumer (name = BRAIN_ID = primus-claw-brain-0)
    → Consumer persists after Pod exits, requires manual cleanup

New: ephemeral consumer (no durable_name)
    → NATS auto-destroys on connection disconnect, zero residual
    → Multiple concurrent Brains still fan-out, session lock ensures single-instance processing
    → Pod restart creates new ephemeral consumer, nak'd messages redeliver after ack_wait
```

---

## 3. Data Structures

### 3.1 NATS KV Checkpoint

```typescript
// Bucket: BRAIN_REGISTRY  Key: task-ckpt.{sessionId}
// TTL: 15 minutes (7.5x ack_wait 120s, sufficient to span a complete rolling update)

interface TaskCheckpoint {
  version: 1;
  session_id: string;
  message_id: string;          // Matches NATS message, prevents stale checkpoint misuse
  user_id: string;             // Needed for S3 path
  messages: Message[];         // Full conversation history up to the last complete turn (including tool_result)
  turns_completed: number;     // Completed turn count (starting from 0)
  usage: TokenUsage;           // Accumulated tokens
  text_parts: string[];        // Already output text segments
  error_count: number;
  tool_calls_by_name: Record<string, number>;
  total_tool_calls: number;
  elapsed_ms_before: number;   // Time already spent, added to final elapsedMs on resume
  has_s3_snapshot: boolean;    // Whether S3 file snapshot exists (only written on SIGTERM)
  s3_snapshot_prefix: string;  // checkpoints/{userId}/{sessionId}/{msgId}/
  checkpointed_at: number;     // Unix ms, for expiry detection
}
```

**Checkpoint Write Timing:**
- After each completed turn (tool results appended to messages) → write KV (no S3, fast)
- On SIGTERM abort → write KV + sync /workspace → S3 (complete snapshot)

### 3.2 S3 File Snapshot

```
Path: checkpoints/{userId}/{sessionId}/{msgId}/

Notes:
  - Only written on SIGTERM (not per turn)
  - Content = all files under /workspace at SIGTERM time
  - Consistent with KV messages[] at the same turn boundary
  - Deleted after successful resume (saves storage)

No conflict with existing S3 paths:
  users/{userId}/sessions/{sessionId}/          ← Synced at message end (unchanged)
  users/{userId}/sessions/{sessionId}/{msgId}/  ← Per-message archive (unchanged)
  checkpoints/{userId}/{sessionId}/{msgId}/      ← New, checkpoint-specific
```

### 3.3 NATS KV Version Signal

```
Bucket: BRAIN_REGISTRY  Key: brain.min_version
Value:  "202604220000"  (= NEW_TAG, written by upgrade.sh)
TTL:    None (manually cleaned after deploy completes or overwritten by new Brain)
```

---

## 4. Resume Decision Tree

```
Brain receives NATS message (new message or redelivery)
         │
         ▼
    ensureHands(sessionId)
         │
    ┌────┴──────────────────────┐
created=false               created=true
 (sandbox alive)              (sandbox rebuilt)
    │                            │
    ▼                            ▼
Read task-ckpt.{sessionId}    Read task-ckpt.{sessionId}
 Exists and message_id match?   Exists + has_s3_snapshot
                                and message_id match?
    │                            │
  Yes    No                   Yes          No
  │      │                    │             │
  ▼      ▼                    ▼             ▼
resume  fresh execution  syncWorkspaceFromS3   fresh execution
KV      (normal flow)   (s3_snapshot_prefix)  (session-base
msgs[]               + resume KV msgs[]        S3 restore)
no S3
restore
needed

Note: "fresh execution" = original flow, consistent with current code behavior
```

**Key Rules:**
- Sandbox rebuilt + no S3 snapshot → **must** execute fresh (messages[] reference files that don't exist in new sandbox; forcing resume would cause LLM hallucination)
- SIGTERM abort with turns_completed=0 → don't write checkpoint, just nak and rerun

---

## 5. File Change Details

### 5.1 `packages/brain/src/config.ts`

**2 new exports:**

```typescript
// Brain image version tag, injected by StatefulSet env BRAIN_VERSION.
// Used for version-aware cooperative drain: Brain compares own version
// against brain.min_version in NATS KV and self-drains if outdated.
export const BRAIN_VERSION = env("BRAIN_VERSION", "");

// TTL for task checkpoint KV entries (ms). Must exceed the rolling
// update window: terminationGracePeriodSeconds + new pod startup time.
export const CHECKPOINT_TTL_MS = envInt("CHECKPOINT_TTL_MS", 15 * 60 * 1000);
```

---

### 5.2 `packages/brain/src/workspace/s3-uploader.ts`

**Modified `syncWorkspaceToS3` and `syncWorkspaceFromS3`, added optional `s3PrefixOverride`:**

```typescript
// syncWorkspaceToS3: added options parameter
export async function syncWorkspaceToS3(
  hands: HandsClient,
  sessionId: string,
  userId: string,
  options?: { s3PrefixOverride?: string },  // ADD
): Promise<number> {
  const s3Prefix = options?.s3PrefixOverride   // ADD
    ?? `users/${userId}/sessions/${sessionId}/`;  // CHANGE (was hardcoded)
  // ... rest unchanged
}

// syncWorkspaceFromS3: added options parameter
export async function syncWorkspaceFromS3(
  hands: HandsClient,
  sessionId: string,
  userId: string,
  options?: { s3PrefixOverride?: string },  // ADD
): Promise<number> {
  const s3Prefix = options?.s3PrefixOverride   // ADD
    ?? `users/${userId}/sessions/${sessionId}/`;  // CHANGE (was hardcoded)
  // ... rest unchanged
}
```

**Note:** All existing callers don't pass options, behavior is completely unchanged.

---

### 5.3 `packages/brain/src/agent/index.ts`

**Extended `ExecuteExtras` interface:**

```typescript
export interface CheckpointState {
  messages: Message[];
  turns_completed: number;
  usage: TokenUsage;
  text_parts: string[];
  error_count: number;
  tool_calls_by_name: Record<string, number>;
  total_tool_calls: number;
  elapsed_ms_before: number;
}

export interface ExecuteExtras {
  recreateHands?: () => Promise<HandsClient>;
  /** Called after each complete turn to persist execution state. */
  onCheckpoint?: (state: CheckpointState) => Promise<void>;
  /** If present, resume from this checkpoint instead of starting fresh. */
  resumeCheckpoint?: CheckpointState;
}
```

---

### 5.4 `packages/brain/src/agent/agent-loop.ts`

**Modified `LoopOptions` interface:**

```typescript
export interface LoopOptions {
  // ... all existing fields unchanged ...

  /** Called after each complete turn (tool results appended to messages).
   *  Caller persists state to NATS KV for cross-Brain resume. */
  onCheckpoint?: (state: LoopCheckpointState) => Promise<void>;

  /** Resume from a prior checkpoint. Skips turns 0..resumeFrom.turns_completed-1.
   *  Messages, usage, stats are pre-populated from checkpoint values. */
  resumeFrom?: LoopCheckpointState;
}

// LoopCheckpointState mirrors CheckpointState in engines/index.ts
export interface LoopCheckpointState {
  messages: Message[];
  turns_completed: number;
  usage: TokenUsage;
  text_parts: string[];
  error_count: number;
  tool_calls_by_name: Record<string, number>;
  total_tool_calls: number;
  elapsed_ms_before: number;
  /** Package-manager commands (pip/npm/apt…) that succeeded during this task.
   *  Replayed in order when the sandbox is rebuilt on resume, so system-level
   *  dependencies are reinstated before the LLM continues. */
  setup_commands: Array<{ cmd: string; turn: number }>;
}
```

**Modified `agentLoop` function body:**

```typescript
/** Detects bash commands that install system-level packages. */
const SETUP_CMD_RE =
  /\b(pip3?\s+install|npm\s+install|npm\s+ci|yarn\s+add|pnpm\s+install|
      apt-get?\s+install|apt\s+install|conda\s+install|cargo\s+install|
      gem\s+install|brew\s+install|poetry\s+add|uv\s+pip\s+install)\b/;

export async function agentLoop(
  messages: Message[],
  tools: ToolSchema[],
  opts: LoopOptions,
): Promise<LoopResult> {
  // --- Resume: pre-populate state from checkpoint ---
  const resumeFrom = opts.resumeFrom;
  const workingMessages: Message[] = resumeFrom
    ? [...resumeFrom.messages]   // start from checkpointed history
    : [...messages];             // start fresh (current behavior)

  const usage: TokenUsage = resumeFrom
    ? { ...resumeFrom.usage }
    : { input_tokens: 0, output_tokens: 0, cache_read: 0, cache_create: 0, turns: 0 };

  const textParts: string[] = resumeFrom ? [...resumeFrom.text_parts] : [];
  let errorCount = resumeFrom?.error_count ?? 0;
  const toolCallsByName: Record<string, number> = resumeFrom
    ? { ...resumeFrom.tool_calls_by_name }
    : {};
  let totalToolCalls = resumeFrom?.total_tool_calls ?? 0;
  // Accumulate setup commands across turns; seed from checkpoint on resume.
  const setupCommands: Array<{ cmd: string; turn: number }> =
    resumeFrom?.setup_commands ? [...resumeFrom.setup_commands] : [];

  // elapsedMs offset for final reporting
  const startTime = Date.now() - (resumeFrom?.elapsed_ms_before ?? 0);

  const initialTurn = resumeFrom?.turns_completed ?? 0;

  // ... existing setup code (effectiveTools, client, logger.info, etc.) ...

  for (let turn = initialTurn; maxTurns <= 0 || turn < maxTurns + initialTurn; turn++) {
    // ... existing LLM call (streamingTurn) ...

    // --- Tool execution (inside runRegularTool) ---
    // After resultText is resolved, detect and record setup commands:
    //
    //   const cmd = String(toolInput.command ?? "");
    //   if (toolName === "bash" && SETUP_CMD_RE.test(cmd) && !resultText.startsWith("Error:")) {
    //     setupCommands.push({ cmd, turn });
    //   }

    // ── Checkpoint: after tool results are appended to workingMessages ──
    // This is the only clean boundary: LLM response + all tool results are
    // committed; next iteration starts a fresh LLM call.
    workingMessages.push({ role: "assistant", content: content as any });
    workingMessages.push({ role: "user", content: results as any });

    if (opts.onCheckpoint && !signal?.aborted) {
      await opts.onCheckpoint({
        messages: workingMessages,
        turns_completed: turn + 1,
        usage: { ...usage },
        text_parts: [...textParts],
        error_count: errorCount,
        tool_calls_by_name: { ...toolCallsByName },
        total_tool_calls: totalToolCalls,
        elapsed_ms_before: Date.now() - startTime,
        setup_commands: [...setupCommands],      // ADD: included in every checkpoint
      }).catch((e) => logger.warn({ err: e, sessionId }, "checkpoint.write_failed"));
      // Non-fatal: checkpoint failure must never abort the task
    }

    // Check if done (existing logic, use workingMessages instead of messages)
    // ...
  }

  return {
    finalText: textParts.join("\n").trim(),
    tokenUsage: usage,
    turns: turn - initialTurn,   // report only turns executed in this run
    // ...
  };
}
```

**Key Points:**
- `onCheckpoint` failure logs warn, **must never throw** (cannot kill the task due to persistence failure)
- When `resumeFrom` exists, directly use `resumeFrom.messages` as initial conversation history, skipping the original `messages` parameter
- Events (`AssistantMessage`, `toolUsed`, etc.) emit from `turn = initialTurn`; completed turn events are not replayed (frontend already processed them)

---

### 5.5 `packages/brain/src/engines/claude.ts`

**Integrate checkpoint in `ClaudeEngine.execute`:**

```typescript
async execute(
  request: ExecuteRequest,
  onEvent: EventCallback,
  signal?: AbortSignal,
  hands?: HandsClient,
  extras?: ExecuteExtras,
): Promise<ExecuteResult> {
  // ... existing setup (resolveToolIds, MCP, skills, prompt, messages) ...

  try {
    // Determine resume checkpoint
    const resume = extras?.resumeCheckpoint;

    const loopResult = await agentLoop(
      messages,          // used only when resume is absent
      allToolSchemas,
      {
        // ... existing fields ...
        recreateHands: extras?.recreateHands,
        onCheckpoint: extras?.onCheckpoint,   // ADD
        resumeFrom: resume,                   // ADD (undefined = fresh start)
      },
    );

    // ... existing post-loop logic ...
  } finally {
    await mcpResult.closeAll();
  }
}
```

---

### 5.6 `packages/brain/src/index.ts`

This is the file with the most changes, described by logical blocks.

#### 5.6.1 New Top-Level State and Constants

```typescript
// ── Graceful drain state ────────────────────────────────────────────────────
let draining = false;
let consumerIter: Awaited<ReturnType<typeof consumer.consume>> | null = null;
const inflightHandleTasks = new Set<Promise<void>>();

// Unique symbol distinguishes SIGTERM abort from user interrupt abort.
// Checked in handleTask catch block to branch into checkpoint path.
const SIGTERM_ABORT_REASON = Symbol("sigterm");
```

#### 5.6.2 SIGTERM / SIGINT Signal Handling

```typescript
// Install once, after consumer is created (so consumerIter is accessible).
function installSignalHandlers(): void {
  const handler = (sig: string) => {
    if (draining) return;
    draining = true;
    logger.info({ signal: sig }, "brain.drain.signal_received");

    // Stop pulling new tasks immediately.
    consumerIter?.stop();

    // Abort all in-flight tasks with SIGTERM reason (triggers checkpoint path).
    for (const ctrl of activeAbort.values()) {
      ctrl.abort(SIGTERM_ABORT_REASON);
    }

    // Wait for all in-flight handleTask promises, then exit.
    Promise.allSettled([...inflightHandleTasks]).then(async () => {
      try { await nc.drain(); } catch { /* ignore */ }
      logger.info("brain.drain.complete");
      process.exit(0);
    });
  };

  process.once("SIGTERM", () => handler("SIGTERM"));
  process.once("SIGINT",  () => handler("SIGINT"));
}
```

#### 5.6.3 Version-Aware Drain (KV Watch)

```typescript
// Watch brain.min_version key; self-drain when own version is outdated.
async function watchVersionDrain(): Promise<void> {
  if (!BRAIN_VERSION) return;  // skip in environments without version tag
  try {
    const watcher = await kv.watch({ key: "brain.min_version" });
    (async () => {
      for await (const entry of watcher) {
        const minVersion = sc.decode(entry.value);
        if (BRAIN_VERSION < minVersion && !draining) {
          draining = true;
          consumerIter?.stop();
          logger.info({ brainVersion: BRAIN_VERSION, minVersion }, "brain.drain.version_outdated");
          // Do NOT abort in-flight tasks: they run to completion.
          // K8s rolling update will eventually send SIGTERM for clean exit.
        }
      }
    })().catch((e) => logger.warn({ err: e }, "brain.version_watch.error"));
  } catch (e) {
    logger.warn({ err: e }, "brain.version_watch.init_failed");
  }
}
```

#### 5.6.4 Checkpoint Utility Functions

```typescript
// KV key for task checkpoint. Session-scoped, not Brain-scoped.
function checkpointKey(sessionId: string): string {
  return `task-ckpt.${sessionId}`;
}

// S3 prefix for workspace snapshot (written only on SIGTERM).
function checkpointS3Prefix(userId: string, sessionId: string, messageId: string): string {
  return `checkpoints/${userId}/${sessionId}/${messageId}/`;
}

/** Write KV checkpoint. Non-fatal: errors are logged and swallowed. */
async function writeKvCheckpoint(
  sessionId: string,
  state: CheckpointState,
  messageId: string,
  userId: string,
  s3SnapshotPrefix?: string,
): Promise<void> {
  const payload: TaskCheckpoint = {
    version: 1,
    session_id: sessionId,
    message_id: messageId,
    user_id: userId,
    messages: state.messages,
    turns_completed: state.turns_completed,
    usage: state.usage,
    text_parts: state.text_parts,
    error_count: state.error_count,
    tool_calls_by_name: state.tool_calls_by_name,
    total_tool_calls: state.total_tool_calls,
    elapsed_ms_before: state.elapsed_ms_before,
    has_s3_snapshot: !!s3SnapshotPrefix,
    s3_snapshot_prefix: s3SnapshotPrefix ?? "",
    checkpointed_at: Date.now(),
  };
  await kv.put(checkpointKey(sessionId), sc.encode(JSON.stringify(payload)));
}

/** Read KV checkpoint. Returns null if absent, expired, or version mismatch. */
async function readKvCheckpoint(
  sessionId: string,
  messageId: string,
): Promise<TaskCheckpoint | null> {
  try {
    const entry = await kv.get(checkpointKey(sessionId));
    if (!entry) return null;
    const ckpt = JSON.parse(sc.decode(entry.value)) as TaskCheckpoint;
    if (ckpt.version !== 1) return null;
    if (ckpt.message_id !== messageId) return null;
    // Treat checkpoints older than CHECKPOINT_TTL_MS as stale.
    if (Date.now() - ckpt.checkpointed_at > CHECKPOINT_TTL_MS) return null;
    return ckpt;
  } catch {
    return null;
  }
}

/** Delete KV checkpoint after successful task completion. */
async function deleteKvCheckpoint(sessionId: string): Promise<void> {
  try { await kv.delete(checkpointKey(sessionId)); } catch { /* ignore */ }
}

/** Delete S3 checkpoint snapshot after successful task completion. */
async function deleteS3Checkpoint(
  hands: HandsClient,
  userId: string,
  sessionId: string,
  messageId: string,
): Promise<void> {
  // S3 cleanup: list + delete objects under the checkpoint prefix.
  // Implemented via a Hands bash call to aws CLI or equivalent.
  // Non-fatal: leftover checkpoint prefixes are harmless (TTL on the KV key
  // prevents them from being used; operators can clean S3 manually).
  const prefix = checkpointS3Prefix(userId, sessionId, messageId);
  logger.info({ prefix }, "s3.checkpoint.cleanup");
  // TODO: implement S3 object deletion if bucket lifecycle rules not configured.
  // For now, rely on S3 lifecycle rules to expire checkpoints/ prefix after 7 days.
}
```

#### 5.6.5 Refactored `handleTask`

**Added checkpoint reading and resume logic at function entry:**

```typescript
async function handleTask(msg: JsMsg): Promise<void> {
  // ... existing: parse request, tombstone check, activeAbort guard ...

  const sessionId = request.session_id;
  const messageId = request.message_id || "";
  const userId    = request.user_id || "default";

  const locked = await acquireSessionLock(sessionId);
  if (!locked) { msg.nak(3000); return; }

  const abortCtrl = new AbortController();
  activeAbort.set(sessionId, abortCtrl);

  // Track this promise for graceful drain.
  const taskPromise = _runHandleTask(
    msg, request, sessionId, messageId, userId, abortCtrl,
  );
  inflightHandleTasks.add(taskPromise);
  taskPromise.finally(() => inflightHandleTasks.delete(taskPromise));
  await taskPromise;
}

async function _runHandleTask(
  msg: JsMsg,
  request: ExecuteRequest,
  sessionId: string,
  messageId: string,
  userId: string,
  abortCtrl: AbortController,
): Promise<void> {
  // --- keepAlive interval (unchanged) ---
  const keepAlive = setInterval(() => {
    try { msg.working(); } catch {}
    refreshSessionLock(sessionId).catch(() => {});
    kv.get(`hands.${sessionId}`).then(e => {
      if (e) kv.put(`hands.${sessionId}`, e.value).catch(() => {});
    }).catch(() => {});
  }, 10_000);

  // --- mutable checkpoint state (updated by onCheckpoint callback) ---
  let latestCheckpointState: CheckpointState | null = null;

  const onCheckpoint = async (state: CheckpointState): Promise<void> => {
    latestCheckpointState = state;
    // Write KV-only checkpoint on every turn (fast path, no S3).
    await writeKvCheckpoint(sessionId, state, messageId, userId);
  };

  try {
    const { handsUrl, created, token: handsToken } =
      await ensureHands(sessionId, /* platformKey */ ..., onEvent, request.sandbox_image);

    // --- Resume decision ---
    let resumeCheckpoint: CheckpointState | undefined;
    if (created) {
      // Sandbox was recreated — only resume if we have a matching S3 snapshot.
      const ckpt = await readKvCheckpoint(sessionId, messageId);
      if (ckpt?.has_s3_snapshot) {
        // Layer 1: restore /workspace files from checkpoint S3 snapshot.
        await syncWorkspaceFromS3(hands, sessionId, userId,
          { s3PrefixOverride: ckpt.s3_snapshot_prefix });

        // Layer 2: replay system-level package-install commands (pip/npm/apt…).
        // These are not in /workspace so S3 restore cannot recover them.
        if (ckpt.setup_commands?.length) {
          logger.info(
            { sessionId, count: ckpt.setup_commands.length },
            "task.resume.replaying_setup_commands",
          );
          for (const { cmd } of ckpt.setup_commands) {
            try {
              await hands.callTool("bash", { command: cmd });
              logger.info({ cmd: cmd.slice(0, 100) }, "task.resume.setup_command_ok");
            } catch (e) {
              // Non-fatal: LLM handles missing packages via layer-3 notice below.
              logger.warn({ err: e, cmd: cmd.slice(0, 100) }, "task.resume.setup_command_failed");
            }
          }
        }

        // Layer 3: inject sandbox-restart notice so LLM can self-heal
        // any remaining dependency gaps not covered by layers 1 & 2.
        ckpt.messages.push({
          role: "user",
          content: [{
            type: "text",
            text:
              "[System Notice] The execution sandbox was restarted. " +
              "/workspace files have been restored from a pre-restart snapshot. " +
              "Previously detected package-install commands (pip/npm/apt) have been " +
              "automatically replayed. If any subsequent tool call fails due to a " +
              "missing dependency, please reinstall it and retry — " +
              "your prior work context is fully preserved.",
          }],
        });

        resumeCheckpoint = ckpt;
        logger.info(
          { sessionId, turns: ckpt.turns_completed, setupCmds: ckpt.setup_commands?.length ?? 0 },
          "task.resume.with_s3_snapshot",
        );
      } else {
        // No S3 snapshot: restore from session-base S3 (existing behavior).
        await syncWorkspaceFromS3(hands, sessionId, userId);
        // Discard any KV checkpoint: messages[] may reference files or system
        // state that can't be reliably reconstructed → restart task from scratch.
        logger.info({ sessionId }, "task.resume.no_s3_snapshot_restart");
      }
    } else {
      // Sandbox alive: resume from KV checkpoint if available.
      // No setup command replay or sandbox notice needed — system state is intact.
      const ckpt = await readKvCheckpoint(sessionId, messageId);
      if (ckpt) {
        resumeCheckpoint = ckpt;
        logger.info({ sessionId, turns: ckpt.turns_completed }, "task.resume.sandbox_alive");
      }
    }

    // --- Execute ---
    let hands = new HandsClient(handsUrl, handsToken);
    await onEvent({ type: "statusUpdate", agentStatus: "running" });

    if (created && !resumeCheckpoint) {
      // Fresh sandbox, no resume: restore workspace (existing behavior).
      try { await syncWorkspaceFromS3(hands, sessionId, userId); } catch (e) {
        logger.warn({ err: e, sessionId }, "s3.restore_failed");
      }
    }

    const recreateHands = async (): Promise<HandsClient> => { /* unchanged */ };

    const result = await engine.execute(request, onEvent, abortCtrl.signal, hands, {
      recreateHands,
      onCheckpoint,                          // ADD
      resumeCheckpoint,                      // ADD (undefined = fresh start)
    });

    // ... existing: stats events, S3 sync, archiveRunToS3, exec_complete ...

    msg.ack();
    await deleteKvCheckpoint(sessionId);
    // S3 checkpoint cleanup: rely on S3 lifecycle rules (7-day expiry on checkpoints/).

  } catch (err: any) {

    // ── SIGTERM abort: checkpoint and re-queue ──────────────────────────
    if (abortCtrl.signal.reason === SIGTERM_ABORT_REASON) {
      logger.info({ sessionId }, "task.sigterm.checkpointing");

      if (latestCheckpointState && latestCheckpointState.turns_completed > 0) {
        // Write S3 snapshot of workspace (the critical piece for sandbox-rebuild resume).
        const s3Prefix = checkpointS3Prefix(userId, sessionId, messageId);
        try {
          await syncWorkspaceToS3(hands, sessionId, userId,
            { s3PrefixOverride: s3Prefix });
          // Update KV checkpoint with S3 snapshot metadata.
          await writeKvCheckpoint(sessionId, latestCheckpointState,
            messageId, userId, s3Prefix);
          logger.info({ sessionId, s3Prefix, turns: latestCheckpointState.turns_completed },
            "task.sigterm.checkpoint_written");
        } catch (e) {
          logger.warn({ err: e, sessionId }, "task.sigterm.checkpoint_s3_failed");
          // KV checkpoint (without S3 snapshot) was written by onCheckpoint;
          // resume will still work if sandbox stays alive.
        }
      } else {
        logger.info({ sessionId }, "task.sigterm.no_completed_turns_skip_checkpoint");
      }

      msg.nak(0);   // Immediate redelivery: any available Brain picks it up.
      return;       // falls through to finally
    }

    // ── User interrupt (existing behavior) ─────────────────────────────
    if (abortCtrl.signal.aborted) {
      // ... existing interrupt handling unchanged ...
      msg.ack();
      return;
    }

    // ── Retryable / fatal (existing behavior) ──────────────────────────
    if (isRetryable(err)) { msg.nak(5000); }
    else {
      // ... existing fatal error handling unchanged ...
      msg.ack();
    }

  } finally {
    clearInterval(keepAlive);
    activeAbort.delete(sessionId);
    await releaseSessionLock(sessionId);
  }
}
```

#### 5.6.6 Refactored `main()`

```typescript
async function main() {
  // ... existing: validateStartupConfig, engine, emitter, kv ...

  // Start version-aware drain watcher.
  await watchVersionDrain();                    // ADD

  // ── Ephemeral consumer (replaces durable) ────────────────────────────────
  // No durable_name → NATS server destroys consumer when connection closes.
  // Pod restart creates a fresh consumer; in-flight messages are redelivered
  // after ack_wait. Zero orphaned consumers on upgrades.
  const consumerCfg = {
    // durable_name intentionally omitted: ephemeral consumer
    filter_subject: taskSub,
    ack_policy: AckPolicy.Explicit,
    max_ack_pending: MAX_CONCURRENT,
    ack_wait: 120_000_000_000,  // 120s in ns — unchanged
  };
  // IMPORTANT: create the consumer explicitly so cfg actually takes effect.
  // The exact API differs across nats.js versions; wrap it in one helper.
  //
  // Example contract:
  //   const consumer = await createEphemeralConsumer(jsm, js, taskStreamName, consumerCfg);
  //
  // Helper semantics:
  //   1) create ephemeral consumer with consumerCfg (no durable_name)
  //   2) return a handle supporting consume()
  //   3) on process exit / nc.drain(), server auto-removes the consumer
  const consumer = await createEphemeralConsumer(jsm, js, taskStreamName, consumerCfg);

  // Wrap consume loop to support draining.
  const iter = await consumer.consume();
  consumerIter = iter;                          // ADD: store ref for drain

  (async () => {
    for await (const msg of iter) {
      if (draining) {
        // Drain mode: return message to stream; new Brain picks it up.
        msg.nak(5000);
        continue;
      }
      handleTask(msg as any)
        .catch((e) => logger.error({ err: e }, "task.unhandled"));
    }
  })();

  // Install signal handlers after consumerIter is available.
  installSignalHandlers();                      // ADD

  // ... existing: interrupt subscriber, cleanup subscriber,
  //               startSandboxKeepalive, startSandboxSweeper,
  //               Fastify health + metrics endpoints ...
}
```

#### 5.6.7 Brain Asset Download Endpoint Strong Authentication

**`/internal/assets/*` must use strong verification tokens; "non-empty equals pass" is forbidden.**

```typescript
interface BootstrapAssetTokenClaims {
  session_id: string;
  sandbox_id: string;
  exp: number; // unix seconds
}

function verifyBootstrapAssetToken(
  rawAuth: string | undefined,
  expectedSessionId: string,
  expectedSandboxId: string,
): BootstrapAssetTokenClaims {
  if (!rawAuth?.startsWith("Bearer ")) throw new Error("missing bearer token");
  const token = rawAuth.slice("Bearer ".length).trim();
  // Example: HMAC/JWT signature verification with AUTH_INTERNAL_TOKEN as secret.
  const claims = verifyAndDecodeToken<BootstrapAssetTokenClaims>(token);
  if (claims.exp <= Math.floor(Date.now() / 1000)) throw new Error("token expired");
  if (claims.session_id !== expectedSessionId) throw new Error("session mismatch");
  if (claims.sandbox_id !== expectedSandboxId) throw new Error("sandbox mismatch");
  return claims;
}

// In /internal/assets/hands-bundle and /internal/assets/node-bin handlers:
// 1) verify signature
// 2) verify exp
// 3) verify session/sandbox binding
// On any failure -> return 401/403 and emit audit log.
```

---

### 5.7 `deploy/manifests/brain-deployment.yaml`

**Changed StatefulSet to Deployment, key changes:**

```yaml
apiVersion: apps/v1
kind: Deployment                        # CHANGE: was StatefulSet
metadata:
  name: primus-claw-brain
  namespace: primus-claw
  labels:
    app: primus-claw
    component: primus-claw-brain
spec:
  replicas: 3
  selector:
    matchLabels:
      app: primus-claw
      component: primus-claw-brain
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxSurge: 3           # Start all new pods before any old pod is removed
      maxUnavailable: 0     # Never reduce below desired count during update
  template:
    metadata:
      labels:
        app: primus-claw
        component: primus-claw-brain
        brain-version: "<TAG>"   # ADD: rollout precision selector for new pods
      annotations:
        prometheus.io/scrape: "true"
        prometheus.io/port:   "8100"
        prometheus.io/path:   "/metrics"
    spec:
      securityContext:
        runAsNonRoot: true
        runAsUser: 1000
        fsGroup: 1000
      # Grace: tool batch (~5s) + S3 snapshot (~30s) + buffer
      terminationGracePeriodSeconds: 90   # was: 120
      topologySpreadConstraints:
        - maxSkew: 1
          topologyKey: kubernetes.io/hostname
          whenUnsatisfiable: ScheduleAnyway
          labelSelector:
            matchLabels:
              app: primus-claw
              component: primus-claw-brain
      containers:
        - name: brain
          image: <REGISTRY>/claw:<TAG>
          imagePullPolicy: IfNotPresent
          args: ["brain"]
          ports:
            - name: http
              containerPort: 8100
          lifecycle:
            preStop:
              exec:
                command: ["sleep", "3"]  # Let readiness probe propagate before SIGTERM
          envFrom:
            - secretRef: { name: primus-claw-secrets }
          env:
            - name: POD_NAME
              valueFrom: { fieldRef: { fieldPath: metadata.name } }
            - name: BRAIN_ID
              value: $(POD_NAME)         # Unique per pod; no longer needs to be stable
            - name: BRAIN_VERSION
              value: <TAG>               # ADD: for version-aware drain comparison
            # ... POSTGRES_*, NODE_TLS_REJECT_UNAUTHORIZED unchanged ...
          # ... probes, resources unchanged ...

# NOTE: serviceName and volumeClaimTemplates removed (Deployment has neither).
# The primus-claw-brain-headless Service is no longer needed.
# Keep only primus-claw-brain ClusterIP Service for health checks.
```

**Also delete the headless service from `services.yaml`** (Brain no longer needs stable Pod DNS):

```yaml
# DELETE this block from services.yaml:
# apiVersion: v1
# kind: Service
# metadata:
#   name: primus-claw-brain-headless
# ...
```

---

### 5.8 `deploy/upgrade.sh`

**Added `upgrade_brain` function at Step 4's Brain apply:**

**Order principle: confirm new Pods Ready first, then send version signal to evict old Pods.**
If new Pods fail to start, the signal is never sent, old Pods continue serving, zero task blackout.

```bash
# ── Helper: run a throwaway pod to write a NATS KV value ─────────────────────
nats_kv_put() {
  local key="$1" val="$2"
  kubectl run "nats-kv-put-$$" --rm -i --restart=Never \
    -n "$NAMESPACE" \
    --image=natsio/nats-box:latest \
    --env="NATS_URL=nats://prod:${NATS_PASSWORD_PROD}@${NATS_RELEASE}:4222" \
    --command -- sh -c \
    "nats kv put --server \"\$NATS_URL\" BRAIN_REGISTRY \"$key\" \"$val\"" \
    2>/dev/null
}

# ── Helper: block until N pods with the given image tag are Ready ─────────────
wait_for_new_pods_ready() {
  local tag="$1" desired="$2" timeout="${3:-300}"
  local elapsed=0
  log "  Waiting for $desired Brain pod(s) with brain-version=$tag to be Ready (timeout ${timeout}s) ..."
  while [ "$elapsed" -lt "$timeout" ]; do
    # Count only pods belonging to THIS rollout version label.
    local ready
    ready=$(kubectl get pods -n "$NAMESPACE" \
      -l "component=primus-claw-brain,brain-version=$tag" \
      -o jsonpath="{range .items[*]}{range .status.containerStatuses[?(@.name=='brain')]}{.ready}{'\n'}{end}{end}" \
      | grep -c "^true$" || true)
    if [ "$ready" -ge "$desired" ]; then
      log "  $ready new Brain pod(s) Ready."
      return 0
    fi
    sleep 5
    elapsed=$((elapsed + 5))
  done
  return 1
}

# ── Brain upgrade helper ──────────────────────────────────────────────────────
# Order (safety-first):
#   1. Apply new Deployment → new pods start alongside old (maxSurge=3)
#   2. Wait for new pods Ready → confirms new version is healthy
#   3. Write min_version → old pods drain (stop pulling new tasks)
#   4. Wait for rollout complete → old pods exit, K8s cleans up
#
# If new pods fail to start, step 2 aborts, step 3 is never reached,
# old pods continue serving normally. Zero task blackout on failure.
# ─────────────────────────────────────────────────────────────────────────────
upgrade_brain() {
  local new_manifest="$1"
  local replicas
  replicas=$(kubectl get deployment/primus-claw-brain -n "$NAMESPACE" \
    -o jsonpath='{.spec.replicas}' 2>/dev/null || echo "3")

  log "Brain upgrade: applying new image (tag=$TAG, replicas=$replicas) ..."

  # Step 1: apply new manifest (Deployment rolling update starts, maxSurge=replicas)
  kubectl apply -f "$new_manifest"

  # Step 2: wait for new pods to become Ready before touching old pods
  if ! wait_for_new_pods_ready "$TAG" "$replicas" 300; then
    fail "New Brain pods did not become Ready within 300s. \
Old pods are still running normally. \
Rollback with: kubectl rollout undo deployment/primus-claw-brain -n $NAMESPACE"
  fi

  # Step 3: new pods confirmed healthy — NOW signal old pods to drain
  log "Brain upgrade: new pods Ready. Signaling old pods to drain (min_version=$TAG) ..."
  nats_kv_put "brain.min_version" "$TAG" \
    || fail "Failed to write brain.min_version. Abort rollout to avoid mixed scheduling behavior."

  # Step 4: wait for rollout complete (old pods exit and are cleaned up by K8s)
  log "Brain upgrade: waiting for old pods to exit ..."
  kubectl rollout status deployment/primus-claw-brain \
    -n "$NAMESPACE" --timeout=120s
  log "Brain upgrade complete."
}

# In Step 4, replace direct brain-deployment apply:
if kubectl get deployment/primus-claw-brain -n "$NAMESPACE" >/dev/null 2>&1; then
  if ! $DRY_RUN; then
    upgrade_brain "$WORK_DIR/brain-deployment.yaml"
  else
    log "[dry-run] upgrade_brain (apply → wait Ready → signal → wait complete)"
    kubectl apply -f "$WORK_DIR/brain-deployment.yaml" --dry-run=client
  fi
else
  kubectl_apply "$WORK_DIR/brain-deployment.yaml"   # first install
fi
```

---

## 6. Complete Upgrade Timeline

### 6.1 Normal Upgrade (New Pods Start Successfully)

```
t=0   upgrade.sh: kubectl apply brain-deployment.yaml (new image)
        Deployment controller: maxSurge=3, maxUnavailable=0
        → Start 3 new Pods (6 Pods total)
        Old 3 Pods: continue normal operation, accepting new tasks ← unaffected

t=0~30 Old Pods handle tasks normally, new Pods starting up
        upgrade.sh: wait_for_new_pods_ready polls every 5s

t=30  All 3 new Pods pass readinessProbe
        ↓ (new version confirmed healthy, safety point)
        upgrade.sh: write brain.min_version = NEW_TAG
        │ (KV Watch millisecond-level push)
        ├─ Brain-old-0 → draining=true → consumerIter.stop()
        ├─ Brain-old-1 → draining=true → consumerIter.stop()
        └─ Brain-old-2 → draining=true → consumerIter.stop()

t=30  New Pods take over all new tasks (old Pods stopped pulling)
      Deployment controller: simultaneously sends SIGTERM to old Pods

t=30  Brain-old-0,1,2 receive SIGTERM
        ├─ No in-flight (no new tasks after version drain): exits in seconds ✓
        └─ Has in-flight (accepted before t=30, not yet completed long tasks):
             Wait for tool batch to complete → S3 snapshot → KV checkpoint → nak → exit
             New Pod resumes from checkpoint

t=60  All old Pods gone, K8s auto-cleaned
      Upgrade complete, 3 new Pods running normally
```

### 6.2 Failed Rollback (New Pods Fail to Start)

```
t=0   upgrade.sh: kubectl apply brain-deployment.yaml (new image)
      New Pods fail to start (CrashLoopBackOff / OOM / config error...)

t=300 wait_for_new_pods_ready timeout
      upgrade.sh: fail() outputs error, script exits
      brain.min_version never written ← Key: old Pods perceive no signal

      Old Pods: run normally the entire time, zero task blackout ✓

Ops: kubectl rollout undo deployment/primus-claw-brain -n $NAMESPACE
      K8s cleans up failed new Pods, normal operation restored
```

---

## 7. Edge Case Handling

| Scenario | Handling |
|------|------|
| SIGTERM when turns_completed=0 | Don't write checkpoint, just nak and rerun |
| S3 snapshot write failure | KV checkpoint (without s3_snapshot) still preserved; can still resume when sandbox alive; degrades to fresh execution on sandbox rebuild |
| KV checkpoint write failure | Warn log, task continues (non-fatal); no checkpoint on SIGTERM, rerun |
| message_id mismatch in checkpoint on message redelivery | Treated as no checkpoint, fresh execution |
| Checkpoint exceeds CHECKPOINT_TTL_MS | readKvCheckpoint returns null, fresh execution |
| Sandbox rebuilt + no S3 snapshot | Fresh execution (safe degradation, no LLM hallucination) |
| `pip install` and other system dependencies | Recoverable (Layer 2 setup command replay); replay failure handled by Layer 3 (LLM notice) |
| Upgrade rollback | Roll back with `upgrade.sh --rollback`, not a bare `kubectl rollout undo` — see §7.1 |
| brain.min_version KV write failure | Fail-fast terminates upgrade; old Brain maintains current state and continues serving, does not enter mixed scheduling state |
| Asset download token missing/expired/bad signature/binding mismatch | `/internal/assets/*` denies access (401/403), logs audit entry, does not degrade to weak verification |
| sub-agent executing when SIGTERM | Parent loop abort signal propagates to child loop; checkpoint saves parent loop's last complete turn; child's turn reruns |

---

### 7.1 Rolling back

Use:

```bash
bash claw/deploy/upgrade.sh -n <ns> --rollback
```

**Not** a bare `kubectl rollout undo` on the Brain deployment.

`undo` reverts the Deployment's pod template, so the pods come back on the
previous tag. It does not touch `brain.min_version`, which still names the tag
you are rolling away from — and a pod that is not the version that key names
stops taking work. So the fleet comes back up, passes its readiness probe, and
serves nothing. `/health` reports `draining: true` with `drainReason: version`,
which is the only way to tell this apart from a healthy idle fleet.

`--rollback` does the whole sequence: revert, wait for the reverted pods, read
the tag the cluster now actually runs (from the pod template's `brain-version`
label — never a value typed by the operator, because this path runs when
something is already wrong), rewrite `brain.min_version` to it, and then verify
`/health` reports the pods are taking work again.

The KV write comes *after* the pods are Ready, for the same reason the upgrade
writes it after the new pods are Ready: writing it first would drain the pods
that are still serving before their replacements exist.

One case does not need any of this. If an upgrade fails at the readiness gate,
`upgrade_brain` aborts before it ever writes the key, so `brain.min_version`
still names the running version and a bare `kubectl rollout undo` is correct —
which is what that failure message says.

To repair a fleet by hand (e.g. `--rollback` itself failed after reverting the
pods), set the key to the deployed tag. The pods release their drain when the
key names them, so this un-drains a fleet in place — no restart needed:

```
POST /v1/internal/brain/min-version   {"minVersion": "<deployed tag>"}
```

## 8. Recoverable and Non-Recoverable State

### 8.1 Recovery Mechanism Overview

The system uses a **three-layer recovery strategy** covering most sandbox state:

```
Layer 1: S3 file snapshot         → Restore all /workspace files
Layer 2: Setup command replay     → Restore pip/npm/apt system dependencies
Layer 3: LLM notice fallback      → LLM self-heals remaining dependencies
```

### 8.2 Setup Command Auto-Tracking and Replay

#### Tracking (in agent/agent-loop.ts)

During `runRegularTool` bash tool execution, identify package manager commands and record them in checkpoint:

```typescript
/** Pattern covering major package managers. */
const SETUP_CMD_RE =
  /\b(pip3?\s+install|npm\s+install|npm\s+ci|yarn\s+add|pnpm\s+install|
      apt-get?\s+install|apt\s+install|conda\s+install|cargo\s+install|
      gem\s+install|brew\s+install|poetry\s+add|uv\s+pip\s+install)\b/;

// Inside runRegularTool, after resultText is resolved:
const cmd = String(toolInput.command ?? "");
if (
  toolName === "bash" &&
  SETUP_CMD_RE.test(cmd) &&
  !resultText.startsWith("Error:")
) {
  setupCommands.push({ cmd, turn });
}
```

`setupCommands` included in `LoopCheckpointState` and `TaskCheckpoint`:

```typescript
// In LoopCheckpointState and TaskCheckpoint:
setup_commands: Array<{ cmd: string; turn: number }>;
```

#### Replay (in index.ts, after sandbox rebuild)

```typescript
// After syncWorkspaceFromS3 with S3 snapshot (created=true path):
if (resumeCheckpoint.setup_commands?.length) {
  logger.info(
    { count: resumeCheckpoint.setup_commands.length },
    "task.resume.replaying_setup_commands",
  );
  // Replay in original order (turn order preserved).
  for (const { cmd } of resumeCheckpoint.setup_commands) {
    try {
      await hands.callTool("bash", { command: cmd });
      logger.info({ cmd: cmd.slice(0, 100) }, "task.resume.setup_command_ok");
    } catch (e) {
      // Non-fatal: LLM receives the layer-3 notice and handles failures.
      logger.warn({ err: e, cmd: cmd.slice(0, 100) }, "task.resume.setup_command_failed");
    }
  }
}
```

#### Sandbox Restart Notice Injection (Layer 3 Fallback)

After replay completes, append a synthetic user message at the end of restored `messages[]`:

```typescript
// Injected only when created=true (sandbox was rebuilt).
// Placed after all tool_result blocks so LLM sees it as the latest context.
resumeCheckpoint.messages.push({
  role: "user",
  content: [{
    type: "text",
    text:
      "[System Notice] The execution sandbox was restarted due to maintenance. " +
      "/workspace files have been restored from a pre-restart snapshot. " +
      "Previously detected package-install commands have been automatically " +
      "replayed. If any subsequent tool call fails due to a missing dependency, " +
      "reinstall it and retry — your prior work context is preserved.",
  }],
});
```

### 8.3 Recovery Coverage for Various Sandbox Side Effects

| Tool Call Side Effect | Recovery Layer | Description |
|---|---|---|
| Files created by `file_write` / `bash` | Layer 1 (S3) | Full `/workspace` snapshot |
| bash stdout / stderr output | KV messages[] | Already in conversation history |
| MCP tool call results | KV messages[] | Already in conversation history |
| `pip install X` | Layer 2 (replay) | Detected by regex, reinstalled |
| `pip install -r requirements.txt` | Layer 2 (replay) | `requirements.txt` already restored by Layer 1 |
| `npm install` / `npm ci` | Layer 2 (replay) | `package.json` / `package-lock.json` already restored |
| `apt-get install curl` etc. | Layer 2 (replay) | Requires sudo privilege in sandbox |
| Mixed commands (`pip install X && python setup.py install`) | Layer 2 partial + Layer 3 | Regex catches pip part; LLM handles the rest |
| `curl url \| bash` and other non-standard installs | Layer 3 (LLM notice) | LLM self-repairs upon seeing error |
| Process memory / background daemons | Layer 3 (LLM notice) | LLM restarts on tool failure |
| System-level files (`/etc`, `/usr`) | ❌ Non-recoverable | Inherent sandbox architecture limitation |

### 8.4 When Sandbox Is Alive (created=false)

Sandbox alive means:
- `/workspace` files intact (not lost)
- System-level packages (pip/npm/apt) intact (not lost)
- Only need to restore `messages[]` from KV, **no need to replay setup commands or inject sandbox notice**

---

## 9. File Change Summary

| File | Change Type | Change Size |
|------|----------|--------|
| `packages/brain/src/config.ts` | Add `BRAIN_VERSION`, `CHECKPOINT_TTL_MS` exports | ~5 lines |
| `packages/brain/src/workspace/s3-uploader.ts` | Add optional `s3PrefixOverride` parameter to 2 functions | ~6 lines |
| `packages/brain/src/agent/index.ts` | Extend `ExecuteExtras`, add `CheckpointState` interface | ~20 lines |
| `packages/brain/src/agent/agent-loop.ts` | `LoopOptions` extension, resume initialization, setup_commands tracking, turn boundary checkpoint | ~60 lines |
| `packages/brain/src/engines/claude.ts` | Pass `onCheckpoint` / `resumeFrom` to agentLoop | ~5 lines |
| `packages/brain/src/index.ts` | SIGTERM handler, version drain KV Watch, ephemeral consumer, checkpoint utility functions, handleTask refactor | ~160 lines |
| `deploy/manifests/brain-deployment.yaml` | StatefulSet → Deployment, maxSurge=3, BRAIN_VERSION env, preStop, remove serviceName | Rewrite (~60 lines) |
| `deploy/charts/claw/templates/services.yaml` | Delete headless service | ~15 lines deleted |
| `deploy/upgrade.sh` | `upgrade_brain()` function (signal + apply), Step 4/5 reference new filenames | ~30 lines |

### Change Dependency Order (Follow This Order During Implementation)

```
1. config.ts            (no dependencies)
2. workspace/s3-uploader.ts       (no dependencies)
3. engines/index.ts     (no dependencies)
4. agent/agent-loop.ts        (depends on engines/index.ts CheckpointState)
5. engines/claude.ts    (depends on agent/agent-loop.ts LoopOptions)
6. index.ts             (depends on all above)
7. brain-deployment.yaml + services.yaml  (independent, can parallel with 6)
8. upgrade.sh           (depends on brain-deployment.yaml filename)
```
