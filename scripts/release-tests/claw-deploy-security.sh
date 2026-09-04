#!/usr/bin/env bash
# Copyright Advanced Micro Devices, Inc.
# SPDX-License-Identifier: MIT

# claw-deploy-security.sh
#
# The deployment half of least-privilege NATS + sealed checkpoints. Everything
# here is a behaviour that only exists outside TypeScript: what a re-render
# preserves, what a one-way retirement refuses to do, and which value
# combinations the chart must not render at all.
#
# Each case is written against the failure it prevents, because all three are
# silent in the way that matters -- an upgrade that authenticates nobody, a
# retirement that cuts off a CronJob nobody saw connected, and a `v4` rollout
# that renders cleanly and CrashLoops afterwards.

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
deploy_dir="$repo_root/claw/deploy"
chart_dir="$deploy_dir/charts/claw"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/bin"

pass=0
ok()   { pass=$((pass + 1)); echo "  ok: $1"; }
bad()  { echo "  FAIL: $1" >&2; exit 1; }

# ── A helm that records its argv instead of rendering ────────────────────
# render_chart's whole contract is the command line it builds, so that is what
# is captured. Writing something to $dst keeps the redirection honest.
cat >"$tmp/bin/helm" <<'EOF'
#!/usr/bin/env bash
: >"$HELM_ARGS_FILE"
for a in "$@"; do printf '%s\n' "$a" >>"$HELM_ARGS_FILE"; done
echo "# rendered by the recording helm stub"
EOF
chmod +x "$tmp/bin/helm"

# ── A cluster whose contents each case declares ──────────────────────────
# Absent by default, which is what a first-time upgrade looks like. Absent and
# unreachable are DIFFERENT answers here, as they are from real kubectl: an
# object that does not exist is a successful empty reply under
# --ignore-not-found, while a refusal or a timeout is a non-zero exit with no
# output. MOCK_FAIL_QUERY produces the second for whichever query names it.
cat >"$tmp/bin/kubectl" <<'EOF'
#!/usr/bin/env bash
args="$*"
emit() { printf '%s' "$1" | base64 | tr -d '\n'; exit 0; }
if [ -n "${MOCK_FAIL_QUERY:-}" ]; then
  case "$args" in *"$MOCK_FAIL_QUERY"*) exit 7 ;; esac
fi
case "$args" in
  *"secret primus-claw-nats-api"*NATS_PASSWORD*)
    [ -n "${MOCK_API_PASSWORD:-}" ] && emit "$MOCK_API_PASSWORD" ;;
  *"secret primus-claw-nats-api"*NATS_USER*)
    [ -n "${MOCK_API_USER:-}" ] && emit "$MOCK_API_USER" ;;
  *"secret primus-claw-brain-checkpoint"*)
    [ -n "${MOCK_CHECKPOINT_KEY:-}" ] && emit "$MOCK_CHECKPOINT_KEY" ;;
  *"deployment primus-claw-brain"*)
    [ -n "${MOCK_WRITE_VERSION:-}" ] && { printf '%s' "$MOCK_WRITE_VERSION"; exit 0; } ;;
esac
# Nothing was declared for this query, so the object is not there.
case " $args " in *" --ignore-not-found "*) exit 0 ;; esac
exit 1
EOF
chmod +x "$tmp/bin/kubectl"

render() {
  # Runs render_chart in a subshell with the stubs in front of PATH, and
  # returns the recorded argv on stdout, one argument per line.
  local args_file="$tmp/helm-args"
  (
    export PATH="$tmp/bin:$PATH" HELM_ARGS_FILE="$args_file"
    export NAMESPACE=primus-claw REGISTRY=example.invalid TAG=test
    SCRIPT_DIR="$deploy_dir"
    # shellcheck disable=SC1091
    source "$deploy_dir/common.sh"
    render_chart "brain-deployment.yaml" "$tmp/out.yaml"
  ) >/dev/null
  cat "$args_file"
}

# The same run, reporting whether render_chart itself succeeded rather than
# what it told helm.
render_status() {
  (
    export PATH="$tmp/bin:$PATH" HELM_ARGS_FILE="$tmp/helm-args-status"
    export NAMESPACE=primus-claw REGISTRY=example.invalid TAG=test
    SCRIPT_DIR="$deploy_dir"
    # shellcheck disable=SC1091
    source "$deploy_dir/common.sh"
    render_chart "brain-deployment.yaml" "$tmp/out.yaml" >/dev/null
  ) 2>&1
}

echo "==> upgrade preservation"

# 1. First-time upgrade: nothing deployed to preserve.
#
# `printf '%s\n'` over an empty array still prints one newline, mapfile turns
# that into a single empty element, and it reaches helm as an empty positional
# argument. helm rejects it -- so the function written to keep an upgrade
# working broke the one upgrade that had nothing to preserve.
args="$(MOCK_API_PASSWORD= MOCK_CHECKPOINT_KEY= render)"
if grep -qxF '' <<<"$args"; then
  bad "a first-time upgrade passed an empty argument to helm:
$(cat -A <<<"$args")"
fi
ok "a first-time upgrade passes no empty argument to helm"
grep -qxF -- '--show-only' <<<"$args" || bad "render_chart did not build a --show-only render"
grep -q 'secret.natsUsers' <<<"$args" && bad "nothing was deployed, so nothing may be preserved"
ok "a first-time upgrade preserves nothing"

# 2. A custom username survives the upgrade with its password.
#
# Restoring the password alone leaves the chart default username next to a
# password belonging to a differently-named user, and every connection from
# that workload is rejected from then on.
args="$(MOCK_API_PASSWORD=s3cret MOCK_API_USER=claw-api-prod render)"
grep -qxF -- '--set-string' <<<"$args" || bad "no --set-string was emitted at all"
grep -qxF 'secret.natsUsers.api.password=s3cret' <<<"$args" \
  || bad "the deployed NATS password was not preserved"
grep -qxF 'secret.natsUsers.api.user=claw-api-prod' <<<"$args" \
  || bad "the deployed NATS username was dropped, leaving a password tied to a user that no longer renders"
ok "a custom NATS username is preserved together with its password"

# 3. A Secret with a password and no username (written before usernames were
#    preserved) still preserves the password, and forwards no half credential.
args="$(MOCK_API_PASSWORD=s3cret MOCK_API_USER= render)"
grep -qxF 'secret.natsUsers.api.password=s3cret' <<<"$args" \
  || bad "an older Secret's password must still be preserved"
grep -q 'secret.natsUsers.api.user=' <<<"$args" \
  && bad "a username that is not deployed must not be invented"
ok "a Secret with no username preserves the password alone"

# 4. The seal key and the write version are preserved, or a routine upgrade
#    resets a v4 fleet to v3 and unmounts the key that opens what it wrote.
args="$(MOCK_CHECKPOINT_KEY=$(head -c 32 /dev/zero | base64) MOCK_WRITE_VERSION=4 render)"
grep -q 'secret.brainCheckpointKey=' <<<"$args" || bad "the checkpoint seal key was not preserved"
grep -qxF 'brain.checkpointWriteVersion=4' <<<"$args" \
  || bad "a v4 fleet was silently re-rendered as v3"
ok "the seal key and checkpoint write version survive a re-render"

# 5. A read that FAILS is not a read that came back empty.
#
# This path decides what the upgrade carries forward. Treating an RBAC denial
# or an API timeout as "nothing is deployed" re-renders a v4 fleet as v3 with
# no seal key and hands every workload back the shared all-access credential --
# the whole of this PR, undone by one bad minute on the API server, with a
# successful-looking helm upgrade to show for it.
for q in "secret primus-claw-brain-checkpoint" "deployment primus-claw-brain" \
         "secret primus-claw-nats-api"; do
  if out="$(MOCK_FAIL_QUERY="$q" MOCK_API_PASSWORD=s3cret \
            MOCK_CHECKPOINT_KEY=k MOCK_WRITE_VERSION=4 render_status)"; then
    bad "a failed read of '$q' was rendered through as if nothing were deployed:
$out"
  fi
  grep -q 'could not read the deployed security settings' <<<"$out" \
    || bad "the operator must be told which read failed, got: $out"
done
ok "a read that fails stops the upgrade instead of preserving nothing"

echo "==> prod retirement gating"

missing() {
  (
    export NAMESPACE=primus-claw
    SCRIPT_DIR="$deploy_dir"
    # shellcheck disable=SC1091
    source "$deploy_dir/common.sh"
    _missing_nats_identities || true
  )
}

# reaper is a CronJob and ops only runs during an upgrade, so a connection
# census taken at any moment can show api and brain alone. Retiring prod on
# that evidence cuts off the two that were merely idle.
out="$(NATS_PER_USER_WORKLOADS="api,brain" \
      NATS_PASSWORD_API=a NATS_PASSWORD_BRAIN=b \
      NATS_PASSWORD_REAPER=r NATS_PASSWORD_OPS=o missing)"
grep -q 'reaper' <<<"$out" || bad "a workload absent from NATS_PER_USER_WORKLOADS must block retirement"
grep -q 'ops' <<<"$out" || bad "ops must block retirement when it is not provisioned"
ok "a partial cutover blocks retiring the all-access user"

out="$(NATS_PER_USER_WORKLOADS="api,brain,reaper,ops" \
      NATS_PASSWORD_API=a NATS_PASSWORD_BRAIN=b NATS_PASSWORD_OPS=o missing)"
grep -q 'reaper' <<<"$out" \
  || bad "a named workload with no password is not provisioned and must block retirement"
ok "a named workload with no password blocks retirement"

out="$(NATS_PER_USER_WORKLOADS="api,brain,reaper,ops" \
      NATS_PASSWORD_API=a NATS_PASSWORD_BRAIN=b \
      NATS_PASSWORD_REAPER=r NATS_PASSWORD_OPS=o missing)"
[ -z "$out" ] || bad "all four identities are configured, so this check must pass them: $out"
ok "all four configured identities clear the input-side check"

# ── The decision path itself, against a declared cluster ─────────────────
#
# Everything above is the operator's own input. It is the weaker half: the
# environment describes the render that is ABOUT to happen, so a run that
# exports the four passwords and retires prod in the same breath satisfies it
# with nothing deployed -- workloads still on the shared credential, and the
# credential about to be deleted. These cases drive the real gate, with a
# cluster and a NATS server whose answers each case declares.

cluster="$tmp/cluster"
cat >"$tmp/bin/kubectl" <<'EOF'
#!/usr/bin/env bash
# A cluster made of files. Absent file, absent object.
args="$*"
b64() { printf '%s' "$1" | base64 | tr -d '\n'; }
val() { [ -f "$CLUSTER_DIR/$1" ] && cat "$CLUSTER_DIR/$1" || return 1; }
fld() {
  local v
  v="$(val "replicas-$1" | awk -v n="$2" '{print $n}')" || exit 1
  [ "$v" = "!" ] && exit 7          # the query itself fails, as kubectl does
  [ "$v" = "-" ] && exit 0          # the field is simply not there
  printf '%s' "$v"
}
# Which Secret and key one container env var reads. Absent means the workload
# does not set it -- with --ignore-not-found that is a successful empty answer,
# exactly as kubectl reports a filter that matched nothing.
envref() {
  local v
  v="$(val "envref-$1-$2")" || exit 0
  [ "$v" = "!" ] && exit 7
  printf '%s ' "$v"
  exit 0
}
# --ignore-not-found: an object that is not there is empty and SUCCESSFUL. The
# stub has to model that, or the fail-closed paths cannot be told from it.
absent_ok() { case " $args " in *" --ignore-not-found "*) exit 0 ;; esac; exit 1; }

case "$args" in
  *"exec"*"nats rtt"*)
    # The probe. Record the credential it was given -- an adoption check that
    # authenticates as something other than the identity under test proves
    # nothing -- then answer as this case declared.
    creds="${args#*nats://}"; creds="${creds%%@*}"
    printf '%s\n' "$creds" >>"$CLUSTER_DIR/probes"
    user="${creds%%:*}"
    grep -qxF "$user" "$CLUSTER_DIR/auth-ok" 2>/dev/null || exit 1
    echo "round trip time: 1ms"; exit 0 ;;
  *"get pods"*nats-box*)
    echo -n "primus-claw-nats-box-0"; exit 0 ;;
  *"get secret primus-claw-secrets"*NATS_URL*)
    b64 "nats://primus-claw-nats.primus-claw.svc.cluster.local:4222"; exit 0 ;;
  *"get secret primus-claw-nats-"*)
    name="${args#*get secret }"; name="${name%% *}"; comp="${name#primus-claw-nats-}"
    line="$(val "secret-$comp")" || absent_ok
    [ "$line" = "!" ] && exit 7
    case "$args" in
      *NATS_USER*) b64 "${line%% *}" ;;
      *NATS_PASSWORD*) b64 "${line##* }" ;;
      *) exit 1 ;;
    esac
    exit 0 ;;
  *"get deployment primus-claw-"*)
    name="${args#*get deployment }"; name="${name%% *}"; comp="${name#primus-claw-}"
    case "$args" in
      *'@.name=="NATS_USER"'*)     envref "$comp" NATS_USER ;;
      *'@.name=="NATS_PASSWORD"'*) envref "$comp" NATS_PASSWORD ;;
      # replicas-<comp> is: desired updated ready total generation observed.
      # A field written as `-` is one the API server does not report at all --
      # a zero-valued status counter, or an object that has no such field.
      *".spec.replicas}"*)       fld "$comp" 1 ;;
      *updatedReplicas*)         fld "$comp" 2 ;;
      *readyReplicas*)           fld "$comp" 3 ;;
      *".status.replicas}"*)     fld "$comp" 4 ;;
      *".metadata.generation}"*) fld "$comp" 5 ;;
      *observedGeneration*)      fld "$comp" 6 ;;
      *) exit 1 ;;
    esac
    exit 0 ;;
  *"get cronjob primus-claw-workspace-reaper"*)
    case "$args" in
      *'@.name=="NATS_USER"'*)     envref reaper-cronjob NATS_USER ;;
      *'@.name=="NATS_PASSWORD"'*) envref reaper-cronjob NATS_PASSWORD ;;
    esac
    exit 1 ;;
  # The durable record of the retirement decision.
  *"get configmap "*)
    v="$(val prod-retired-marker)" || absent_ok
    [ "$v" = "!" ] && exit 7
    echo "configmap/primus-claw-nats-prod-retired"; exit 0 ;;
  *"create configmap "*)
    echo recorded >"$CLUSTER_DIR/prod-retired-marker"; exit 0 ;;
esac
exit 1
EOF
chmod +x "$tmp/bin/kubectl"

# A cluster that has adopted all four identities completely. Each case below
# starts from this and breaks exactly one thing, so what it proves is the
# thing it broke.
adopted() {
  rm -rf "$cluster"; mkdir -p "$cluster"
  local c
  for c in api brain reaper ops; do echo "claw-$c pw-$c" >"$cluster/secret-$c"; done
  for c in api brain; do
    echo "primus-claw-nats-$c/NATS_USER" >"$cluster/envref-$c-NATS_USER"
    echo "primus-claw-nats-$c/NATS_PASSWORD" >"$cluster/envref-$c-NATS_PASSWORD"
    # desired 2, both updated, both Ready, two pods in total (no old
    # ReplicaSet left) and the controller has acted on the current spec.
    echo "2 2 2 2 7 7" >"$cluster/replicas-$c"
  done
  echo "primus-claw-nats-reaper/NATS_USER" >"$cluster/envref-reaper-cronjob-NATS_USER"
  echo "primus-claw-nats-reaper/NATS_PASSWORD" >"$cluster/envref-reaper-cronjob-NATS_PASSWORD"
  printf 'claw-api\nclaw-brain\nclaw-reaper\nclaw-ops\n' >"$cluster/auth-ok"
}

# Runs the gate deploy.sh actually calls, against $cluster.
blockers() {
  (
    export PATH="$tmp/bin:$PATH" CLUSTER_DIR="$cluster" NAMESPACE=primus-claw
    export NATS_PER_USER_WORKLOADS="api,brain,reaper,ops"
    export NATS_PASSWORD_API=pw-api NATS_PASSWORD_BRAIN=pw-brain
    export NATS_PASSWORD_REAPER=pw-reaper NATS_PASSWORD_OPS=pw-ops
    SCRIPT_DIR="$deploy_dir"
    # shellcheck disable=SC1091
    source "$deploy_dir/common.sh"
    nats_retirement_blockers || true
  )
}

# 1. Configured everywhere, deployed nowhere. This is the run the old check
#    waved through: four exported passwords and an empty cluster.
rm -rf "$cluster"; mkdir -p "$cluster"
out="$(blockers)"
for c in api brain reaper ops; do
  grep -q "^$c (no primus-claw-nats-$c Secret" <<<"$out" \
    || bad "an identity with nothing deployed must block retirement, got: $out"
done
ok "four configured passwords and an empty cluster block retirement"

# 2. Everything adopted: the gate has to get out of the way, or it has simply
#    banned retirement.
adopted
out="$(blockers)"
[ -z "$out" ] || bad "a fully adopted cluster must allow retirement, got: $out"
ok "a cluster that has adopted all four identities allows retirement"

# The probe must have authenticated as each identity in turn, with that
# identity's own deployed password. Probing as one credential four times would
# pass every case here and prove nothing about the other three.
for c in api brain reaper ops; do
  grep -qxF "claw-$c:pw-$c" "$cluster/probes" \
    || bad "the probe never authenticated as claw-$c: $(cat "$cluster/probes" 2>/dev/null)"
done
ok "the probe authenticates as each identity with its own deployed credential"

# 3. The Secret is deployed but holds a different password than the one
#    configured here -- the cluster is a render behind, and the credential the
#    workload holds is not the one that is about to become the only way in.
adopted
echo "claw-brain pw-brain-old" >"$cluster/secret-brain"
out="$(blockers)"
grep -q "^brain (the deployed Secret holds a different password" <<<"$out" \
  || bad "a stale deployed password must block retirement, got: $out"
ok "a deployed password that differs from the configured one blocks retirement"

# 4. The Secret exists and the workload does not read it. A Secret can be
#    applied a full deploy before the Deployment that consumes it.
adopted
rm -f "$cluster/envref-api-NATS_USER" "$cluster/envref-api-NATS_PASSWORD"
out="$(blockers)"
grep -q "^api (the primus-claw-api deployment does not set NATS_USER from a Secret" <<<"$out" \
  || bad "a workload that does not read its Secret must block retirement, got: $out"
ok "a Deployment that does not read its own credential blocks retirement"

# 4a. It reads A Secret -- the shared one. This is what the cutover looks like
#     when the chart rendered the Deployment before the identity existed: the
#     env var is there, it resolves, the pod runs, and the value it resolves to
#     is the all-access credential this retirement is about to delete.
adopted
echo "primus-claw-secrets/NATS_PASSWORD" >"$cluster/envref-api-NATS_PASSWORD"
out="$(blockers)"
grep -q "^api (the primus-claw-api deployment reads NATS_PASSWORD from primus-claw-secrets/NATS_PASSWORD rather than primus-claw-nats-api/NATS_PASSWORD" <<<"$out" \
  || bad "a Deployment on the shared credential must block retirement, got: $out"
ok "a Deployment reading the shared Secret blocks retirement"

# 4b. The right Secret, the wrong key in it. Same name, different value.
adopted
echo "primus-claw-nats-api/NATS_PASSWORD_OLD" >"$cluster/envref-api-NATS_PASSWORD"
out="$(blockers)"
grep -q "^api (the primus-claw-api deployment reads NATS_PASSWORD from primus-claw-nats-api/NATS_PASSWORD_OLD" <<<"$out" \
  || bad "the key inside the Secret has to match too, got: $out"
ok "the right Secret under the wrong key blocks retirement"

# 4c. And a query that fails is not a workload that passed.
adopted
echo '!' >"$cluster/envref-brain-NATS_USER"
out="$(blockers)"
grep -q "^brain (the primus-claw-brain deployment could not be read" <<<"$out" \
  || bad "an unreadable Deployment must block retirement, got: $out"
ok "a Deployment that cannot be read blocks retirement"

# 5. The spec is right and the rollout is not finished. Half the pods are still
#    the old ReplicaSet, authenticating as prod.
adopted
echo "2 1 1 2 8 8" >"$cluster/replicas-brain"
out="$(blockers)"
grep -q "^brain (the primus-claw-brain rollout has not finished" <<<"$out" \
  || bad "an unfinished rollout must block retirement, got: $out"
ok "a rollout still in progress blocks retirement"

# 5b. The rolling update that satisfies the obvious check. With
#     maxUnavailable 0 the new ReplicaSet takes both replicas before the old
#     one gives any up: desired 2, updated 2, and one new pod Ready -- which
#     reads as finished if you only ever look at the new ReplicaSet. The
#     Deployment owns three pods, and the third is an old-ReplicaSet pod that
#     is Ready and taking traffic on the shared credential. Retire prod here
#     and that pod is cut off mid-request.
adopted
echo "2 2 2 3 8 8" >"$cluster/replicas-api"
out="$(blockers)"
grep -q "^api (the primus-claw-api Deployment still owns pods from an older ReplicaSet" <<<"$out" \
  || bad "an old ReplicaSet pod still serving must block retirement, got: $out"
ok "a mid-rollout Deployment whose old ReplicaSet still has a pod blocks retirement"

# 5c. No old pods left and a replacement that is not Ready yet. The update can
#     still fail and roll back onto the old credential, so it is not finished.
adopted
echo "2 2 1 2 8 8" >"$cluster/replicas-api"
out="$(blockers)"
grep -q "^api (the primus-claw-api rollout is not complete" <<<"$out" \
  || bad "a replacement pod that is not Ready must block retirement, got: $out"
ok "a replacement pod that is not Ready blocks retirement"

# 5d. The spec has moved and the controller has not acted on it. Every count
#     describes the previous generation, so agreeing with it proves nothing.
adopted
echo "2 2 2 2 9 8" >"$cluster/replicas-brain"
out="$(blockers)"
grep -q "^brain (the primus-claw-brain Deployment has been changed since" <<<"$out" \
  || bad "an unobserved spec change must block retirement, got: $out"
ok "status from a generation older than the spec blocks retirement"

# 5e. The fields the comparisons are made of can be absent or be something
#     other than a number, and every one of those readings used to become a 0
#     -- which compares equal, compares not-less-than, and reports a finished
#     rollout on no evidence whatsoever. On a decision that cannot be undone,
#     "I could not read it" has to land on the same side as "no".
adopted
echo "2 2 2 2 - 8" >"$cluster/replicas-api"
out="$(blockers)"
grep -q "^api (the primus-claw-api Deployment's rollout cannot be verified" <<<"$out" \
  || bad "a missing generation must block retirement, got: $out"
grep -q "metadata.generation was not reported" <<<"$out" \
  || bad "the blocker must name the field it could not read, got: $out"
ok "a Deployment with no generation reported blocks retirement"

adopted
echo "2 2 2 2 - -" >"$cluster/replicas-brain"
out="$(blockers)"
grep -q "^brain (the primus-claw-brain Deployment's rollout cannot be verified" <<<"$out" \
  || bad "two missing generations must block retirement, got: $out"
ok "a Deployment with neither generation reported blocks retirement"

adopted
echo "2 2 2 2 v9 8" >"$cluster/replicas-api"
out="$(blockers)"
grep -q "^api (the primus-claw-api Deployment's rollout cannot be verified" <<<"$out" \
  || bad "a non-numeric generation must block retirement, got: $out"
ok "a generation that is not a number blocks retirement"

# A word compares equal to itself, so counts that match and are not numbers
# satisfy every equality below while meaning nothing.
adopted
echo "two two two two 8 8" >"$cluster/replicas-brain"
out="$(blockers)"
grep -q "^brain (the primus-claw-brain Deployment's rollout cannot be verified" <<<"$out" \
  || bad "non-numeric replica counts must block retirement, got: $out"
ok "replica counts that are not numbers block retirement"

# 5f. Scaled to zero on purpose, with the status counters Kubernetes omits
#     when they are zero. Nothing is running, so nothing holds a credential and
#     there is nothing left to wait for -- blocking here would be the gate
#     refusing a state that is already finished.
adopted
echo "0 - - - 8 8" >"$cluster/replicas-api"
out="$(blockers)"
[ -z "$out" ] || bad "a Deployment intentionally scaled to zero must not block retirement, got: $out"
ok "a Deployment scaled to zero with no pods left allows retirement"

# That legitimate zero and a kubectl that never answered look identical on
# stdout: both are empty. Fail the one query for status.replicas and leave
# every other field reading like the finished scale-down above -- if the exit
# status is thrown away, the gate reports "zero pods owned, safe to retire"
# about a cluster it never managed to ask.
adopted
echo "0 - - ! 8 8" >"$cluster/replicas-api"
out="$(blockers)"
grep -q "^api (the primus-claw-api Deployment's rollout cannot be verified" <<<"$out" \
  || bad "a failed status.replicas query must block retirement, got: $out"
grep -q "the query for .status.replicas failed" <<<"$out" \
  || bad "the blocker must say the query failed, got: $out"
ok "a status query that fails blocks retirement instead of reading as zero"

# The same zero with a pod still owned is a scale-down in flight, and that pod
# is serving.
adopted
echo "0 - - 1 8 8" >"$cluster/replicas-api"
out="$(blockers)"
grep -q "^api (the primus-claw-api Deployment is scaled to zero but still owns 1 pod" <<<"$out" \
  || bad "a scale-down still holding a pod must block retirement, got: $out"
ok "a scale-down that still owns a pod blocks retirement"

# 6. The reaper's CronJob is the case a connection census cannot see at all:
#    between sweeps there is nothing connected to count, so the spec is the
#    only evidence there is.
adopted
echo "primus-claw-secrets/NATS_PASSWORD" >"$cluster/envref-reaper-cronjob-NATS_PASSWORD"
out="$(blockers)"
grep -q "^reaper (the primus-claw-workspace-reaper cronjob reads NATS_PASSWORD from primus-claw-secrets" <<<"$out" \
  || bad "a CronJob still on the shared credential must block retirement, got: $out"
ok "a reaper CronJob still on the shared credential blocks retirement"

# 7. Kubernetes says adopted and NATS refuses the credential -- nats-values.yaml
#    was never applied, or the user exists with a different password. The
#    workload is running on prod and nothing in the cluster says so.
adopted
printf 'claw-brain\nclaw-reaper\nclaw-ops\n' >"$cluster/auth-ok"
out="$(blockers)"
grep -q "^api (NATS refused 'claw-api'" <<<"$out" \
  || bad "a credential NATS does not accept must block retirement, got: $out"
ok "an identity NATS refuses blocks retirement even when the cluster looks right"

# 8. The server cannot be reached. Unknown and no have to mean the same thing
#    for a decision that cannot be undone.
adopted
rm -f "$cluster/auth-ok"
out="$(blockers)"
grep -q "^api (NATS refused" <<<"$out" || bad "an unreachable server must block retirement, got: $out"
ok "a probe that cannot get an answer blocks retirement"

# 9. deploy.sh has to run this gate before it strips the user, not after. The
#    check is on the call, because the retirement branch is inline in a script
#    that runs top to bottom and cannot be sourced.
retire_block="$(sed -n '/NATS_RETIRE_PROD:-false/,/_strip_prod=./p' "$deploy_dir/deploy.sh")"
grep -q 'nats_retirement_blockers' <<<"$retire_block" \
  || bad "deploy.sh retires prod without running the adoption gate"
grep -q 'exit 1' <<<"$retire_block" \
  || bad "deploy.sh must abort, not warn, when the gate reports blockers"
grep -q 'NATS_PROD_STRIP_EXPR' <<<"$retire_block" \
  || bad "the retirement branch no longer strips the prod user block"
grep -q '__PROD_USER_BEGIN__' "$deploy_dir/nats-prod-retirement.sh" \
  || bad "NATS_PROD_STRIP_EXPR no longer removes the prod user block"
ok "deploy.sh runs the gate before stripping the prod user, and aborts on blockers"

# ── 10. The decision has to outlive the run that took it ─────────────────
#
# Every script that touches nats-values.yaml re-renders the WHOLE file and
# helm-upgrades the WHOLE release. A retirement kept only in NATS_RETIRE_PROD
# therefore lasts exactly one invocation: the next ordinary deploy, or the next
# developer running make-dev-account.sh to add themselves, renders the
# all-access user straight back onto the server. Nothing errors, nothing logs,
# and the credential this PR exists to remove is serving again.
#
# These cases execute the real blocks out of both scripts rather than reading
# them, so a future edit that reintroduces the env-only decision fails here.

# deploy.sh's retirement decision and the render it feeds, lifted verbatim.
deploy_render() {
  (
    export PATH="$tmp/bin:$PATH" CLUSTER_DIR="$cluster" NAMESPACE=primus-claw
    export NATS_PER_USER_WORKLOADS="api,brain,reaper,ops"
    export NATS_PASSWORD_PROD=pw-prod NATS_PASSWORD_SYS=pw-sys
    export NATS_PASSWORD_API=pw-api NATS_PASSWORD_BRAIN=pw-brain
    export NATS_PASSWORD_REAPER=pw-reaper NATS_PASSWORD_OPS=pw-ops
    export HELM_ARGS_FILE="$tmp/helm-args-deploy"
    SCRIPT_DIR="$deploy_dir"
    DEV_BLOCKS=""
    DRY_RUN=false
    STORAGE_CLASS=standard
    NATS_RELEASE=primus-claw-nats
    RENDERED_NATS_VALUES="$tmp/rendered.yaml"
    # shellcheck disable=SC1091
    source "$deploy_dir/common.sh"
    eval "$(sed -n '/^  _strip_prod=""/,/^  log "NATS ready\."/p' "$deploy_dir/deploy.sh")"
    cat "$RENDERED_NATS_VALUES"
  )
}

# A cluster that has retired prod, being deployed again by someone who has
# never heard of NATS_RETIRE_PROD.
adopted
echo recorded >"$cluster/prod-retired-marker"
out="$(NATS_RETIRE_PROD= deploy_render)"
grep -q '__PROD_USER_BEGIN__' <<<"$out" \
  && bad "an ordinary deploy re-added the all-access prod user after retirement"
grep -q 'SYS:' <<<"$out" || bad "the render lost the sys account along with prod: $out"
ok "an ordinary deploy with no flag keeps prod retired"

# And the flag is still what performs a retirement that has not happened yet,
# recording it so the run above has something to read.
adopted
out="$(NATS_RETIRE_PROD=true deploy_render)"
grep -q '__PROD_USER_BEGIN__' <<<"$out" \
  && bad "NATS_RETIRE_PROD=true did not strip the prod user"
[ -f "$cluster/prod-retired-marker" ] \
  || bad "the retirement was performed but never recorded, so the next run re-adds prod"
ok "retiring records the decision in the cluster"

# The gate still runs on the way there: a cluster that has not adopted the
# identities must not be able to retire, marker mechanism or not.
rm -rf "$cluster"; mkdir -p "$cluster"
if out="$(NATS_RETIRE_PROD=true deploy_render 2>&1)"; then
  bad "retirement proceeded on a cluster with nothing deployed: $out"
fi
grep -q "not in use yet" <<<"$out" || bad "the adoption gate no longer runs before retiring: $out"
[ -f "$cluster/prod-retired-marker" ] \
  && bad "a refused retirement must not be recorded as having happened"
ok "a blocked retirement neither strips nor records"

# Unknown is not "no". If the marker cannot be read, rendering either way is a
# guess -- one reinstates the all-access user, the other deletes a credential
# workloads may still hold -- so the render must not happen at all.
adopted
echo '!' >"$cluster/prod-retired-marker"
if out="$(NATS_RETIRE_PROD= deploy_render 2>&1)"; then
  bad "deploy.sh rendered while the retirement state was unreadable: $out"
fi
grep -q "is already retired is unknown" <<<"$out" \
  || bad "the operator must be told the marker could not be read, got: $out"
ok "an unreadable retirement marker stops the render instead of guessing"

# make-dev-account.sh is the one that surprises people: it exists to add a
# developer account and rewrites every production user on its way there.
dev_render() {
  (
    export PATH="$tmp/bin:$PATH" CLUSTER_DIR="$cluster" NAMESPACE=primus-claw
    export NATS_PASSWORD_PROD=pw-prod NATS_PASSWORD_SYS=pw-sys
    export NATS_PASSWORD_API=pw-api NATS_PASSWORD_BRAIN=pw-brain
    export NATS_PASSWORD_REAPER=pw-reaper NATS_PASSWORD_OPS=pw-ops
    SCRIPT_DIR="$deploy_dir"
    VALUES_TEMPLATE="$deploy_dir/nats-values.yaml"
    DEV_BLOCKS=""
    RENDERED="$tmp/dev-rendered.yaml"
    # shellcheck disable=SC1091
    source "$deploy_dir/nats-prod-retirement.sh"
    eval "$(sed -n '/^_strip_prod=""/,/> "\$RENDERED"/p' "$deploy_dir/make-dev-account.sh")"
    cat "$RENDERED"
  )
}

adopted
echo recorded >"$cluster/prod-retired-marker"
out="$(dev_render)"
grep -q '__PROD_USER_BEGIN__' <<<"$out" \
  && bad "onboarding a developer re-added the all-access prod user"
grep -q 'SYS:' <<<"$out" || bad "the dev render lost the sys account: $out"
ok "make-dev-account.sh keeps prod retired"

rm -rf "$cluster"; mkdir -p "$cluster"
out="$(dev_render)"
grep -q '__PROD_USER_BEGIN__' <<<"$out" \
  || bad "make-dev-account.sh must leave prod alone on a cluster that never retired it"
ok "make-dev-account.sh leaves prod in place where it was never retired"

echo "==> chart render guards"

command -v helm >/dev/null 2>&1 || {
  echo "error: helm is required for the chart render guards" >&2
  exit 1
}
# The recording stub must not be on PATH from here on.
helm_base=(helm template guards "$chart_dir"
  --set secret.create=false --set ingress.enabled=false --set postgres.enabled=false)

refuses() {
  local why="$1"; shift
  if "${helm_base[@]}" "$@" >/dev/null 2>"$tmp/err"; then
    bad "the chart rendered a combination it must refuse: $why"
  fi
  ok "refused: $why"
}

# v4 with no seal key. Brain refuses to start on this -- deliberately, rather
# than writing plaintext -- but that refusal is a CrashLoopBackOff after pods
# have already been replaced. The render is the place to say it.
refuses "checkpointWriteVersion=4 with no seal key" \
  --set brain.checkpointWriteVersion=4
"${helm_base[@]}" --set brain.checkpointWriteVersion=4 >/dev/null 2>"$tmp/err" || true
grep -q 'secret.brainCheckpointKey' "$tmp/err" \
  || bad "the v4 guard must name the value that is missing"
ok "the v4 guard names secret.brainCheckpointKey"

# The same combination WITH a key has to render, or the guard has simply
# blocked the feature.
key="$(head -c 32 /dev/urandom | base64)"
"${helm_base[@]}" --set brain.checkpointWriteVersion=4 \
  --set-string "secret.brainCheckpointKey=$key" \
  --show-only templates/brain-deployment.yaml >"$tmp/v4.yaml" 2>/dev/null \
  || bad "v4 with a seal key must render"
grep -q 'CHECKPOINT_WRITE_VERSION' "$tmp/v4.yaml" || bad "the v4 render lost CHECKPOINT_WRITE_VERSION"
grep -q 'BRAIN_CHECKPOINT_KEY' "$tmp/v4.yaml" || bad "the v4 render did not mount the seal key"

# There are two checkpoint formats and no others. A guard that only catches
# "4 without a key" lets 2, 5 and "banana" through, and the brain reads them
# with readIntSetting, which does not clamp -- it falls back. So the operator
# who typed 5 meaning "newest" gets 3: redacted checkpoints, unsealed, from a
# render that reported success. Refuse the value instead of picking one.
for v in 2 5 0 -1 banana 3.5 ""; do
  refuses "checkpointWriteVersion=${v:-<empty>}" \
    --set-string "brain.checkpointWriteVersion=$v" \
    --set-string "secret.brainCheckpointKey=$key"
done
"${helm_base[@]}" --set-string brain.checkpointWriteVersion=5 >/dev/null 2>"$tmp/err" || true
grep -q 'must be 3 or 4' "$tmp/err" || bad "the version guard must say what the usable values are"
grep -q '"5"' "$tmp/err" || bad "the version guard must quote back the value it refused, got: $(cat "$tmp/err")"
ok "the version guard names the value it refused and the two that exist"

# And 3 -- the default, and the only value most clusters ever set -- still
# renders without a seal key, or the guard has broken every v3 deployment.
"${helm_base[@]}" --set brain.checkpointWriteVersion=3 >/dev/null 2>&1 \
  || bad "checkpointWriteVersion=3 must render on its own"
ok "checkpointWriteVersion=3 still renders"
ok "v4 with a seal key renders and mounts it"

# The reaper's guards, in both directions.
refuses "reaper.enabled with no workspacePersistBase" \
  --set reaper.enabled=true --set-string reaper.volume.hostPath.path=/shared
refuses "reaper.enabled with no volume" \
  --set reaper.enabled=true --set-string secret.workspacePersistBase=/shared/workspaces
"${helm_base[@]}" --set reaper.enabled=true \
  --set-string secret.workspacePersistBase=/shared/workspaces \
  --set-string reaper.volume.hostPath.path=/shared \
  --show-only templates/workspace-reaper-cronjob.yaml >/dev/null 2>&1 \
  || bad "reaper.enabled with both prerequisites must render"
ok "reaper.enabled with both prerequisites renders"

# ── Credential isolation, asserted on the render rather than the diff ────
render_secrets() {
  "${helm_base[@]}" --set-string "secret.natsUsers.api.password=$1" \
    --set-string "secret.natsUsers.brain.password=$2" "${@:3}"
}

api_a="$(render_secrets A1 B1 --show-only templates/api-deployment.yaml 2>/dev/null \
  | grep 'checksum/nats-user')"
api_b="$(render_secrets A2 B1 --show-only templates/api-deployment.yaml 2>/dev/null \
  | grep 'checksum/nats-user')"
brain_a="$(render_secrets A1 B1 --show-only templates/brain-deployment.yaml 2>/dev/null \
  | grep 'checksum/nats-user')"
brain_b="$(render_secrets A2 B1 --show-only templates/brain-deployment.yaml 2>/dev/null \
  | grep 'checksum/nats-user')"
[ -n "$api_a" ] || bad "the api Deployment has no NATS credential checksum"
[ "$api_a" != "$api_b" ] || bad "rotating api's credential must roll the api Deployment"
[ "$brain_a" = "$brain_b" ] || bad "rotating api's credential must not roll brain"
ok "each Deployment rolls on its own credential and only its own"

# The property the per-workload Secrets exist for: every workload mounts
# primus-claw-secrets with envFrom, so a per-workload password living there
# would be in every component's environment.
shared="$("${helm_base[@]}" --set secret.create=true \
  --set-string secret.authInternalToken=tok \
  --set-string secret.userEnvEncryptionKey=enc \
  --set-string secret.anthropicBaseUrl=https://example.invalid \
  --set-string secret.openaiBaseUrl=https://example.invalid \
  --set-string secret.s3Endpoint=https://example.invalid \
  --set-string secret.s3ApiEndpoint=https://example.invalid \
  --set-string secret.s3AccessKey=ak --set-string secret.s3SecretKey=sk \
  --set-string secret.natsUsers.brain.password=BSEC \
  --set-string "secret.brainCheckpointKey=$key" \
  --show-only templates/secret.yaml 2>/dev/null)"
grep -q 'BSEC' <<<"$shared" && bad "a per-workload NATS password reached the shared Secret"
grep -q "$key" <<<"$shared" && bad "the checkpoint seal key reached the shared Secret"
ok "per-workload credentials stay out of the envFrom Secret"

echo "claw deploy security: $pass checks passed"
