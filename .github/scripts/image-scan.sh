#!/usr/bin/env bash
# Copyright Advanced Micro Devices, Inc.
# SPDX-License-Identifier: MIT
#
# Scans a built image, before it is published, with the same Trivy release and the same parameters as the scan an
# image passes on its way to a public docker.io/rocm repository, and fails on what that scan fails on.
#
# Usage: image-scan.sh <name> <image archive>
#
#   <image archive>  the image as a docker archive (`buildah push <image> docker-archive:<file>`), an OCI archive
#                    (`oci-archive:<file>`, unpacked here: Trivy reads an OCI layout only as a directory) or an OCI
#                    layout directory.
#
# Environment:
#   TRIVY                a trivy binary to use. Unset: trivy on PATH when it is the pinned release, otherwise the
#                        pinned release is downloaded, its sha256 checked, into $RUNNER_TEMP (or /tmp) and reused by
#                        later calls in the same job. Any other release is refused rather than trusted: two releases
#                        disagree on what they find, and a precheck that disagrees with the real scan is worse than
#                        none.
#   TRIVY_CACHE_DIR      Trivy's cache (vulnerability DB, checks bundle); default Trivy's own.
#   IMAGE_SCAN_ENFORCE   "true" (default) fails on a finding; anything else reports the same table and passes.
#   GITHUB_STEP_SUMMARY  when set, the table is appended to it as well.
#
# What fails, and why:
#   - a HIGH or CRITICAL vulnerability that has a fixed version (`--ignore-unfixed`), in OS or language packages;
#   - a HIGH or CRITICAL misconfiguration;
#   - a secret of ANY severity. The publishing scan's Trivy step fails on HIGH and CRITICAL secrets only, but a second
#     scanner with its own rule set also checks secrets there, rates them independently and cannot be waived. A
#     secret Trivy calls LOW can be the one that scanner calls HIGH, so every secret blocks here;
#   - a scan that did not complete (exit 2), never a pass.
#
# There is deliberately no ignore file: the publishing scan reads none, so an entry here would only hide from this
# check what still fails there. The scan therefore runs from an empty directory, where Trivy finds neither a
# .trivyignore nor a trivy.yaml to pick up.
#
# One Trivy run at every severity, filtered here, rather than one run at HIGH,CRITICAL plus a second for secrets:
# Trivy applies --severity after detection, so the HIGH/CRITICAL subset of this run is exactly what the
# `--severity HIGH,CRITICAL` run reports, and the image is read once instead of twice.
#
# A secret is reported by rule and location only. The matched text never reaches the log, the step summary or an
# artifact, and the raw report (which holds it) is deleted on exit.

set -euo pipefail

if [ "$#" -ne 2 ]; then
  echo "usage: image-scan.sh <name> <image archive>" >&2
  exit 2
fi
name="$1"
archive="$2"
enforce="${IMAGE_SCAN_ENFORCE:-true}"

# The release the publishing scan's runners were measured to run, and the digest GitHub publishes for its linux-64bit
# archive. Bump both together, and only to the release that scan runs.
want_version=0.74.0
trivy_sha256=2ae6fe3ee734b7fdf11335663e18c75ea12dccc76062f09f164a3b0f8be4371a

if [ ! -s "$archive" ] && [ ! -f "$archive/index.json" ]; then
  echo "::error::image-scan: $name: no image archive at $archive" >&2
  exit 2
fi
command -v jq >/dev/null || { echo "::error::image-scan: jq is required" >&2; exit 2; }

trivy_version() { "$1" --version 2>/dev/null | sed -n 's/^Version: //p' | head -1 || true; }

if [ -n "${TRIVY:-}" ]; then
  trivy_bin="$TRIVY"
elif command -v trivy >/dev/null && [ "$(trivy_version trivy)" = "$want_version" ]; then
  trivy_bin=trivy
else
  tools="${RUNNER_TEMP:-/tmp}/image-scan-trivy-$want_version"
  trivy_bin="$tools/trivy"
  if [ ! -x "$trivy_bin" ]; then
    mkdir -p "$tools"
    url="https://github.com/aquasecurity/trivy/releases/download/v$want_version/trivy_${want_version}_Linux-64bit.tar.gz"
    if ! curl -fsSL --retry 5 --retry-delay 10 -o "$tools/trivy.tar.gz" "$url"; then
      echo "::error::image-scan: could not download Trivy $want_version" >&2
      exit 2
    fi
    if ! echo "$trivy_sha256  $tools/trivy.tar.gz" | sha256sum -c --quiet -; then
      echo "::error::image-scan: the Trivy $want_version archive does not have the pinned sha256" >&2
      exit 2
    fi
    tar -xzf "$tools/trivy.tar.gz" -C "$tools" trivy
    rm -f "$tools/trivy.tar.gz"
  fi
fi

got_version="$(trivy_version "$trivy_bin")"
if [ "$got_version" != "$want_version" ]; then
  echo "::error::image-scan: $trivy_bin is Trivy '${got_version:-unknown}', expected $want_version" >&2
  exit 2
fi

archive="$(cd "$(dirname "$archive")" && pwd)/$(basename "$archive")"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
mkdir "$work/cwd"
report="$work/report.json"

if [ -f "$archive" ] && ! tar -tf "$archive" manifest.json >/dev/null 2>&1; then
  if ! tar -tf "$archive" index.json >/dev/null 2>&1; then
    echo "::error::image-scan: $name: $archive is neither a docker archive nor an OCI archive" >&2
    exit 2
  fi
  mkdir "$work/oci"
  tar -xf "$archive" -C "$work/oci"
  archive="$work/oci"
fi

cache_args=()
if [ -n "${TRIVY_CACHE_DIR:-}" ]; then cache_args=(--cache-dir "$TRIVY_CACHE_DIR"); fi

echo "image-scan: $name: Trivy $got_version over $(du -sh "$archive" | cut -f1) of image"
start=$(date +%s)
rc=0
(
  cd "$work/cwd"
  "$trivy_bin" image "${cache_args[@]}" \
    --input "$archive" \
    --scanners vuln,secret,misconfig \
    --pkg-types os,library \
    --severity UNKNOWN,LOW,MEDIUM,HIGH,CRITICAL \
    --ignore-unfixed \
    --timeout 90m \
    --no-progress \
    --skip-version-check \
    --format json \
    --output "$report"
) || rc=$?
elapsed=$(( $(date +%s) - start ))
if [ "$rc" -ne 0 ] || [ ! -s "$report" ]; then
  echo "::error::image-scan: $name: Trivy did not complete (exit $rc after ${elapsed}s); an image that was not scanned does not pass" >&2
  exit 2
fi
if ! jq -e '.Results | type == "array" or . == null' "$report" >/dev/null; then
  echo "::error::image-scan: $name: Trivy wrote a report without Results; not treating it as clean" >&2
  exit 2
fi

# Counts per category and severity, and the rows that block, one per line with fields separated by US (0x1f): a tab
# would collapse empty fields in `read`. Secrets carry rule, category and location only.
jq -r '
  def sev($s): if $s == "CRITICAL" or $s == "HIGH" or $s == "MEDIUM" or $s == "LOW" then $s else "UNKNOWN" end;
  def gating: . == "HIGH" or . == "CRITICAL";
  [ (.Results // [])[]
    | .Target as $t
    | ( (.Vulnerabilities // [])[] | {cat: "vuln", sev: sev(.Severity),
          row: [.VulnerabilityID, .PkgName, (.InstalledVersion // ""), (.FixedVersion // ""), (.PkgPath // $t)]} ),
      ( (.Secrets // [])[] | {cat: "secret", sev: sev(.Severity),
          row: [.RuleID, (.Category // ""), "", "", ($t + ":" + ((.StartLine // 0) | tostring))]} ),
      ( (.Misconfigurations // [])[] | select((.Status // "FAIL") == "FAIL") | {cat: "misconfig", sev: sev(.Severity),
          row: [(.ID // .AVDID // ""), (.Title // ""), "", "", $t]} )
  ] as $f
  | ["vuln", "secret", "misconfig"] as $cats
  | ["CRITICAL", "HIGH", "MEDIUM", "LOW", "UNKNOWN"] as $sevs
  | ($cats[] as $c | (["COUNT", $c] + [$sevs[] as $s | [$f[] | select(.cat == $c and .sev == $s)] | length | tostring] | join("\u001f"))),
    ($f[] | select(.cat == "secret" or (.sev | gating)) | (["BLOCK", .cat, .sev] + (.row | map(tostring | gsub("[\t\n|\u001f`]"; " "))) | join("\u001f")))
' "$report" > "$work/rows"

declare -A count
blocking=0
while IFS=$'\x1f' read -r kind cat c h m l u; do
  [ "$kind" = COUNT ] || continue
  count[$cat]="$c $h $m $l $u"
done < "$work/rows"
blocking=$(grep -c '^BLOCK' "$work/rows" || true)

verdict() { # <category> -> the gate's word for it
  local c h m l u
  read -r c h m l u <<<"${count[$1]}"
  if [ "$1" = secret ]; then
    [ $((c + h + m + l + u)) -eq 0 ] && echo pass || echo FAIL
  else
    [ $((c + h)) -eq 0 ] && echo pass || echo FAIL
  fi
}

table() { # <markdown?>
  local md="$1" cat c h m l u rule
  if [ "$md" = 1 ]; then
    echo "| category | CRITICAL | HIGH | MEDIUM | LOW | UNKNOWN | blocks on | result |"
    echo "|---|---:|---:|---:|---:|---:|---|---|"
  else
    echo "image: $name"
    printf '%-10s %8s %5s %6s %4s %7s  %-24s %s\n' category CRITICAL HIGH MEDIUM LOW UNKNOWN "blocks on" result
  fi
  for cat in vuln secret misconfig; do
    read -r c h m l u <<<"${count[$cat]}"
    case "$cat" in
      vuln) rule="HIGH/CRITICAL with a fix" ;;
      secret) rule="any severity" ;;
      misconfig) rule="HIGH/CRITICAL" ;;
    esac
    # Below the gate, vulnerabilities are counted at every severity too; MEDIUM and lower never block.
    if [ "$md" = 1 ]; then
      echo "| $cat | $c | $h | $m | $l | $u | $rule | $(verdict "$cat") |"
    else
      printf '%-10s %8s %5s %6s %4s %7s  %-24s %s\n' "$cat" "$c" "$h" "$m" "$l" "$u" "$rule" "$(verdict "$cat")"
    fi
  done
}

findings() { # <markdown?> -> the blocking rows, at most 50
  local md="$1" n=0 kind cat sev a b inst fix where
  [ "$blocking" -gt 0 ] || return 0
  if [ "$md" = 1 ]; then
    echo
    echo "| category | severity | id / rule | package / title | installed | fixed in | where |"
    echo "|---|---|---|---|---|---|---|"
  else
    echo "blocking findings:"
  fi
  while IFS=$'\x1f' read -r kind cat sev a b inst fix where; do
    [ "$kind" = BLOCK ] || continue
    n=$((n + 1))
    if [ "$n" -gt 50 ]; then
      echo "... and $((blocking - 50)) more"
      break
    fi
    if [ "$md" = 1 ]; then
      echo "| $cat | $sev | $a | $b | $inst | $fix | \`$where\` |"
    else
      printf '  %-9s %-8s %-22s %-24s %-14s %-24s %s\n' "$cat" "$sev" "$a" "$b" "$inst" "$fix" "$where"
    fi
  done < "$work/rows"
}

echo
table 0
findings 0
echo "image-scan: $name: scanned in ${elapsed}s; $blocking blocking finding(s)"

if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  {
    echo "### Image scan: $name (Trivy $got_version)"
    echo
    table 1
    findings 1
    echo
  } >> "$GITHUB_STEP_SUMMARY"
fi

if [ "$blocking" -gt 0 ]; then
  if [ "$enforce" = true ]; then
    echo "::error::image-scan: $name: $blocking finding(s) that would stop this image at publication; see the table above"
    exit 1
  fi
  echo "::warning::image-scan: $name: $blocking finding(s) that would stop this image at publication (reported only: this run does not publish it)"
fi
exit 0
