#!/bin/bash
# Exercises migration failure reporting and the Helm version gate.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATE="${ROOT}/sandbox/deploy/scripts/migrate-sandbox-policy.sh"
UPGRADE="${ROOT}/deploy/upgrade.sh"

fail() { printf 'FAIL %s\n' "$*" >&2; exit 1; }

tmp="$(mktemp -d)"
trap 'rm -rf "${tmp}"' EXIT

cat >"${tmp}/kubectl" <<'EOF'
#!/bin/bash
joined="$*"
if [[ "${joined}" == *missing-sb* ]]; then
    echo 'Error from server (NotFound): sandboxes.agents.x-k8s.io "missing-sb" not found' >&2
    exit 1
fi
if [[ "${joined}" == *timeout-sb* ]]; then
    echo 'Unable to connect to the server: timeout' >&2
    exit 1
fi
if [[ "${joined}" == *gone-sb* ]]; then
    printf '%s' 'uid-9|2026-01-01T00:00:00Z'
    exit 0
fi
if [[ "${joined}" == *live-sb* ]]; then
    printf '%s' 'uid-1|'
    exit 0
fi
echo "unexpected kubectl ${joined}" >&2
exit 1
EOF
cat >"${tmp}/helm" <<'EOF'
#!/bin/bash
printf '%s\n' "${HELM_FAKE_VERSION:?}"
EOF
chmod +x "${tmp}/kubectl" "${tmp}/helm"

(
    export PATH="${tmp}:${PATH}"
    # shellcheck disable=SC1090
    source "${MIGRATE}"
    rc=0
    uid="$(sandbox_uid sandboxes live-sb)" || rc=$?
    [[ "${rc}" -eq 0 && "${uid}" == "uid-1" ]] || fail "live sandbox uid rc=${rc} uid=${uid}"
    rc=0
    sandbox_uid sandboxes missing-sb >/dev/null || rc=$?
    [[ "${rc}" -eq 2 ]] || fail "missing sandbox rc=${rc}, want 2"
    rc=0
    sandbox_uid sandboxes timeout-sb >/dev/null || rc=$?
    [[ "${rc}" -eq 1 ]] || fail "kubectl timeout rc=${rc}, want 1"
    rc=0
    sandbox_uid sandboxes gone-sb >/dev/null || rc=$?
    [[ "${rc}" -eq 3 ]] || fail "deleting sandbox rc=${rc}, want 3"
)

if (
    # shellcheck disable=SC1090
    source "${MIGRATE}"
    redis_cli() { printf '%s\n' 'session:partial'; return 1; }
    copy_session_keys "${tmp}/keys"
) >/dev/null 2>&1; then
    fail "a failed Redis SCAN was treated as success"
fi

if (
    export PATH="${tmp}:${PATH}" HELM_FAKE_VERSION="v3.13.5+gabcdef"
    # shellcheck disable=SC1090
    source "${UPGRADE}"
    require_helm
) >/dev/null 2>&1; then
    fail "Helm 3.13 was accepted"
fi

(
    export PATH="${tmp}:${PATH}" HELM_FAKE_VERSION="v3.14.0+gabcdef"
    # shellcheck disable=SC1090
    source "${UPGRADE}"
    require_helm
) || fail "Helm 3.14 was rejected"

out="$( (
    # shellcheck disable=SC1090
    source "${UPGRADE}"
    SANDBOX_NAMESPACE=agent-sandbox-system
    CONTROLPLANE_PAUSED=true
    trap report_paused_controlplane EXIT
    exit 1
) 2>&1 || true)"
[[ "${out}" == *"still scaled to 0"* && "${out}" == *"rerun deploy/upgrade.sh"* ]] \
    || fail "a failure after pausing the control plane did not say so: ${out}"

out="$( (
    # shellcheck disable=SC1090
    source "${UPGRADE}"
    CONTROLPLANE_PAUSED=true
    trap report_paused_controlplane EXIT
    exit 0
) 2>&1)"
[[ -z "${out}" ]] || fail "a successful run reported a paused control plane: ${out}"

printf 'ok\n'
