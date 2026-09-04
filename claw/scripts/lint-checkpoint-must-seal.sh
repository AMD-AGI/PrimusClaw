#!/usr/bin/env bash
# Copyright Advanced Micro Devices, Inc.
# SPDX-License-Identifier: MIT

# lint-checkpoint-must-seal.sh
#
# The sibling of lint-session-events-must-redact.sh, and deliberately its
# mirror image. Together they state one rule in two halves:
#
#   events must be redacted;  checkpoints must not be.
#
# The reason for the second half: a checkpoint is not observability output. It
# is the conversation a resumed run replays to the model. It used to be written
# through the same redactor that masks events on their way to NATS, and that
# redactor mutates -- correctly, for a log line. Applied to replayable state it
# deletes content: a resumed session comes back with `<redacted>` where a file
# path or an identifier had been, because the substring pass matches on shape
# rather than on provenance, and every such turn is also a total prompt-cache
# miss.
#
# Confidentiality of the bucket is answered by sealing (v4), not by rewriting
# the conversation. So:
#
#   1. events/redaction.ts must export no checkpoint-shaped redactor. The
#      egress redactor keeps its name; there must be no function whose name
#      invites someone to apply it to replay state again.
#   2. tasks/checkpoint-codec.ts must not import from ../events/. This is a
#      module-layering assertion rather than a keyword grep on purpose: a grep
#      for "redact" trips on comments and is silently defeated by a rename or a
#      reformat, while an import edge is the thing that actually has to be
#      absent.
#   3. Every kvCkpt.put of a checkpoint must be handed bytes from
#      encodeCheckpoint. A second serialization path is how the codec gets
#      bypassed without anyone touching it.
#
# Exits 2 when a file it checks has moved, because a guard that silently passes
# after a rename is worse than no guard.
set -euo pipefail

cd "$(dirname "$0")/.."
REDACTION="packages/brain/src/events/redaction.ts"
CODEC="packages/brain/src/tasks/checkpoint-codec.ts"
RUNNER="packages/brain/src/tasks/runner.ts"
fail=0

for f in "$REDACTION" "$CODEC" "$RUNNER"; do
  if [ ! -f "$f" ]; then
    echo "lint-checkpoint-must-seal: $f not found; update this guard" >&2
    exit 2
  fi
done

if grep -nE '^export (function|const) [A-Za-z]*[Cc]heckpoint' "$REDACTION"; then
  echo "ERROR: $REDACTION exports a checkpoint-shaped redactor." >&2
  echo "  Checkpoints are replay state. The egress redactor may be passed to the" >&2
  echo "  codec for the v3 path, but there must be no export inviting a caller to" >&2
  echo "  redact a checkpoint directly." >&2
  fail=1
fi

if grep -nE 'from "\.\./events/' "$CODEC"; then
  echo "ERROR: $CODEC imports from ../events/." >&2
  echo "  The codec must not be able to reach the observability redactor; the v3" >&2
  echo "  path takes it as a parameter instead." >&2
  fail=1
fi

# Scoped to writes addressed by checkpointKey(). The same bucket also holds the
# agent-done outbox under task-result.<taskId>, which is a delivery record
# rather than replay state and is serialized on its own.
if grep -n 'kvCkpt\.put(checkpointKey(' "$RUNNER" | grep -v 'encoded' >/dev/null 2>&1; then
  echo "ERROR: $RUNNER writes a checkpoint that did not come from encodeCheckpoint()." >&2
  grep -n 'kvCkpt\.put(checkpointKey(' "$RUNNER" >&2
  fail=1
fi

if ! grep -q 'encodeCheckpoint(' "$RUNNER"; then
  echo "ERROR: $RUNNER no longer calls encodeCheckpoint()." >&2
  fail=1
fi

[ "$fail" -eq 0 ] && echo "lint-checkpoint-must-seal: OK"
exit "$fail"
