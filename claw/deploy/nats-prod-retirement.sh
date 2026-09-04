#!/usr/bin/env bash
# Copyright Advanced Micro Devices, Inc.
# SPDX-License-Identifier: MIT

# ═══════════════════════════════════════════════════════════════════════════
# Is the all-access `prod` NATS user retired on this cluster?
#
# Source this file — do NOT execute directly. Requires NAMESPACE to be set.
#
# Retirement has to outlive the invocation that performed it. NATS_RETIRE_PROD
# is an environment variable, and every script that renders nats-values.yaml
# renders the WHOLE file and helm-upgrades the WHOLE release: deploy.sh, and
# make-dev-account.sh, which exists to add one developer account and rewrites
# every production user on its way there. So a decision kept only in that
# variable lasts exactly one run. The next ordinary deploy -- or the next
# developer onboarding themselves, who has no idea this decision was ever
# taken -- renders the prod block back in and helm puts the all-access user
# back on the server, with no error and no log line. A permanent security
# property cannot depend on every future operator remembering a flag.
#
# So the decision lives in the cluster it applies to, as a ConfigMap. The
# cluster is the right place for it: it is what the decision is ABOUT, every
# script that renders these values already talks to it, and it is where an
# operator can see the decision and (deliberately, with kubectl) undo it.
#
# Reading it has three answers, not two, and the third is the one that matters.
# "Retired", "not retired", and "the cluster could not be asked" are different,
# and both ways of collapsing the third into one of the others are wrong:
# guessing "not retired" re-adds the all-access user on a transient API error,
# and guessing "retired" deletes a credential that workloads may still hold.
# Neither guess is available, so callers refuse to render at all.
# ═══════════════════════════════════════════════════════════════════════════

# The marker object. Overridable only so tests can name their own.
NATS_PROD_RETIRED_MARKER="${NATS_PROD_RETIRED_MARKER:-primus-claw-nats-prod-retired}"

# The sed expression that removes the prod user from a rendered nats-values.
# One definition, so deploy.sh and make-dev-account.sh cannot drift into
# stripping different things.
NATS_PROD_STRIP_EXPR='/__PROD_USER_BEGIN__/,/__PROD_USER_END__/d'

# Exit 0 = retired, 1 = not retired, 2 = could not tell.
#
# --ignore-not-found is what makes the three answers distinguishable: a
# ConfigMap that does not exist is exit 0 with no output, so every remaining
# non-zero status means the query itself failed.
nats_prod_retirement_state() {
  local out
  if ! out="$(kubectl get configmap "$NATS_PROD_RETIRED_MARKER" -n "$NAMESPACE" \
              --ignore-not-found -o name 2>/dev/null)"; then
    return 2
  fi
  [ -n "$out" ] && return 0
  return 1
}

# Record the decision, so no later run has to be told about it again.
#
# Called only after the retiring upgrade succeeded: a marker written before
# that would survive a failed helm upgrade and make every subsequent run strip
# a user the server still has.
record_nats_prod_retirement() {
  kubectl create configmap "$NATS_PROD_RETIRED_MARKER" -n "$NAMESPACE" \
    --from-literal=retiredAt="$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --from-literal=note="The all-access 'prod' NATS user has been retired. Every render of nats-values.yaml omits it while this ConfigMap exists. Delete it only to deliberately reinstate the shared credential." \
    >/dev/null
}
