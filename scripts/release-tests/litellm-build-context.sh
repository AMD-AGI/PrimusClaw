#!/usr/bin/env bash
# Copyright Advanced Micro Devices, Inc.
# SPDX-License-Identifier: MIT

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/bin"

cat >"$tmp/bin/kubectl" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
for arg in "$@"; do
  case "$arg" in
    --from-file=build-context.tar.gz=*)
      cp "${arg#--from-file=build-context.tar.gz=}" "$BUILD_CONTEXT_CAPTURE"
      printf 'apiVersion: v1\nkind: ConfigMap\n'
      exit 0
      ;;
  esac
done
case "$*" in
  *"apply -f -"*) cat >>"$BUILD_JOB_CAPTURE" ;;
esac
EOF
chmod +x "$tmp/bin/kubectl"

env -u HARBOR_PASSWORD "PATH=$tmp/bin:$PATH" \
  "BUILD_CONTEXT_CAPTURE=$tmp/context.tar.gz" "BUILD_JOB_CAPTURE=$tmp/job.yaml" \
  REGISTRY=registry.example.invalid/gateway PUSH_SECRET=build-fixture-credentials \
  NAMESPACE=build-fixture TAG=v1.99.0-build-test \
  bash "$repo_root/deploy/litellm/build.sh" >"$tmp/build.log" 2>&1 || {
    cat "$tmp/build.log" >&2
    exit 1
  }

python3 - "$tmp/context.tar.gz" <<'PY'
import sys
import tarfile

required = {
    "Dockerfile",
    "apim_key_hook.py",
    "patches/apply_responses_stream_errors.py",
    "patches/responses_stream_errors.py",
}
with tarfile.open(sys.argv[1]) as archive:
    names = set(archive.getnames())
    missing = required - names
    if missing:
        raise SystemExit(f"Missing build context files: {sorted(missing)}")
    for name in names:
        if "__pycache__" in name or name.endswith(".pyc"):
            raise SystemExit(f"Unexpected bytecode in build context: {name}")
    for name in required:
        if name.endswith(".py"):
            compile(archive.extractfile(name).read(), name, "exec")
PY

grep -qF 'tar -xzf /cm/build-context.tar.gz -C /workspace' "$tmp/job.yaml"
grep -qF 'secretName: build-fixture-credentials' "$tmp/job.yaml"
echo "LiteLLM patched image build context: ok"
