#!/usr/bin/env bash
# Copyright Advanced Micro Devices, Inc.
# SPDX-License-Identifier: MIT
#
# Every LLM_* / PROMPT_CACHE_* setting the brain reads must be reachable from a
# deployment.
#
# LLM_CACHE_STYLE shipped without this. config.ts read it, every test set it,
# and no chart ever wrote it -- so on every real cluster it sat at its default,
# which is "send no cache markers". The feature was present, tested, and off.
# A setting the image reads but the chart cannot write is not a setting; it is
# a constant with a misleading name, and nothing in the build says so.
#
# Scoped deliberately: this family decides which provider is called and how it
# is billed. Per-pod identity (BRAIN_ID, SESSION_ID) and per-session
# credentials are set by other means and are not in scope.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."

CONFIG=claw/packages/brain/src/config.ts
SECRET=claw/deploy/charts/claw/templates/secret.yaml
VALUES=claw/deploy/charts/claw/values.yaml
DEPLOY=claw/deploy/deploy.sh

# Credentials are handed to a session at run time, not baked into the release.
EXEMPT="ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN OPENAI_API_KEY LLM_KEY_SOURCE"

fail=0
for name in $(grep -oE 'env\("(LLM_|PROMPT_CACHE_)[A-Z0-9_]*"' "$CONFIG" | sed 's/env("//;s/"//' | sort -u); do
  case " $EXEMPT " in *" $name "*) continue;; esac
  if ! grep -q "^\s*$name:" "$SECRET"; then
    echo "ERROR: $name is read by config.ts but never written by $SECRET"
    fail=1
    continue
  fi
  # A key in the template that no default backs renders empty on a fresh
  # install, which is the same silence by a different route.
  key=$(grep -oE "\.Values\.secret\.[a-zA-Z0-9]+" <(grep "^\s*$name:" "$SECRET") | head -1 | sed 's/.*\.//')
  if [ -n "$key" ] && ! grep -q "^\s*$key:" "$VALUES"; then
    echo "ERROR: $name maps to secret.$key, which $VALUES does not default"
    fail=1
  fi
  if [ -n "$key" ] && ! grep -q "\"$key\"" "$DEPLOY"; then
    echo "ERROR: $name maps to secret.$key, which $DEPLOY never sets"
    fail=1
  fi
done
[ $fail -eq 0 ] && echo "ok: every LLM_*/PROMPT_CACHE_* setting is deployable"
exit $fail
