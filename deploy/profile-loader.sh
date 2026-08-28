#!/usr/bin/env bash
# Copyright Advanced Micro Devices, Inc.
# SPDX-License-Identifier: MIT

# Shared loader for an operator-supplied deployment profile. The caller chooses
# the path explicitly; this library never probes local/ or another private path.

LOADED_DEPLOY_PROFILE=""

load_deploy_profile() {
  local explicit_path="${1:-}"
  local profile_path="${explicit_path:-${DEPLOY_PROFILE_FILE:-}}"
  [ -n "$profile_path" ] || return 0

  if [ ! -f "$profile_path" ] || [ ! -r "$profile_path" ]; then
    echo "[one-click] ERROR: deployment profile is not a readable file: $profile_path" >&2
    return 2
  fi

  local resolved mode
  resolved="$(readlink -f "$profile_path")"
  mode="$(stat -c '%a' "$resolved" 2>/dev/null || true)"
  if [ -n "$mode" ] && (( (8#$mode & 0022) != 0 )); then
    echo "[one-click] WARN: deployment profile is group/world-writable: $resolved" >&2
  fi
  if [ -n "$mode" ] && (( (8#$mode & 0004) != 0 )); then
    echo "[one-click] WARN: deployment profile is world-readable: $resolved" >&2
  fi

  # Explicit process environment wins over profile values. Snapshot all
  # exported variables, source the trusted operator file with allexport, then
  # restore the original environment values.
  local key had_allexport=false
  local -a existing_keys=() existing_values=()
  while IFS= read -r key; do
    existing_keys+=("$key")
    existing_values+=("${!key}")
  done < <(compgen -e)

  case "$-" in *a*) had_allexport=true ;; esac
  set -a
  # shellcheck disable=SC1090
  source "$resolved"
  [ "$had_allexport" = "true" ] || set +a

  local i
  for ((i = 0; i < ${#existing_keys[@]}; i += 1)); do
    printf -v "${existing_keys[$i]}" '%s' "${existing_values[$i]}"
    export "${existing_keys[$i]}"
  done

  LOADED_DEPLOY_PROFILE="$resolved"
  export DEPLOY_PROFILE_FILE="$resolved"
}
