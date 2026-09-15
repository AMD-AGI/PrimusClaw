#!/usr/bin/env bash
# Copyright Advanced Micro Devices, Inc.
# SPDX-License-Identifier: MIT

# Fetch the pinned promtool into .tools/bin, so the rollout gates are evaluated
# by the engine version they were written against and by no other.
#
# Pinned by version and verified by digest: an unpinned engine turns a green
# gate suite into a statement about whatever Prometheus published today, and a
# verified download is the only thing separating that from arbitrary code.
#
# Idempotent: a matching binary already in place is a no-op.

set -euo pipefail

version="2.53.3"
tarball_sha256="ebe549477a699c464a0cef0d8d55c0cc9972a1b301fc910b5f260cfc3e08f6a3"
binary_sha256="f74b9a2456d993fd089d52cc9a44709be4e730b690e1486f4c9233d707592100"

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
dest_dir="$repo_root/.tools/bin"
dest="$dest_dir/promtool"

if [ -x "$dest" ] && [ "$(sha256sum "$dest" | cut -d' ' -f1)" = "$binary_sha256" ]; then
  echo "promtool $version already installed at $dest"
  exit 0
fi

for tool in curl tar sha256sum; do
  command -v "$tool" >/dev/null 2>&1 || {
    echo "error: $tool is required to install promtool" >&2
    exit 1
  }
done

# linux-amd64 is what CI runs and what the digests above are for. Any other
# platform is refused rather than served an unverified build.
case "$(uname -s)/$(uname -m)" in
  Linux/x86_64) ;;
  *)
    echo "error: no pinned promtool for $(uname -s)/$(uname -m). Install promtool $version yourself and put it on PATH." >&2
    exit 1 ;;
esac

release="prometheus-${version}.linux-amd64"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

curl -fsSLo "$work/$release.tar.gz" \
  "https://github.com/prometheus/prometheus/releases/download/v${version}/${release}.tar.gz"
echo "$tarball_sha256  $work/$release.tar.gz" | sha256sum -c - >/dev/null
tar -xzf "$work/$release.tar.gz" -C "$work" "$release/promtool"
echo "$binary_sha256  $work/$release/promtool" | sha256sum -c - >/dev/null

mkdir -p "$dest_dir"
install -m 0755 "$work/$release/promtool" "$dest"
echo "promtool $version installed at $dest"
