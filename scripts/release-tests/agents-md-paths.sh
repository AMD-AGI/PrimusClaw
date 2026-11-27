#!/usr/bin/env bash
# Copyright Advanced Micro Devices, Inc.
# SPDX-License-Identifier: MIT

# agents-md-paths.sh
#
# Keep AGENTS.md a true map of the repository.
#
# AGENTS.md names files, directories and make targets, and a coding agent follows
# every one of them. A rename that forgets the file leaves the agent with a path
# that does not exist, and nothing else in CI reads Markdown for that, so this
# guard does. What it checks, in the code spans and fenced blocks only (prose is
# not parsed):
#
#   - a path whose first segment is a top-level directory (`claw/...`,
#     `.github/...`) exists, and any word that ends in `/` is a directory that
#     exists, whatever its first segment;
#   - a path with a file extension (`scripts/check-pack.mjs`, `assistant/inbound.ts`)
#     exists relative to the directory the command has `cd`-ed into or to the root,
#     or some tracked file ends with it; a code span that is only a file name
#     (`schema-guard.ts`) must be the end of some tracked file's path;
#   - every `make` on a line, in any `a && make x && make y` chain, names targets
#     the Makefile it runs against defines: the one in the directory `cd`, `-C` or
#     `-f` points at, else the root one. Options (`-k`, `-j4`) and `VAR=value` are
#     skipped.
#
# `cd` is followed along a line and down a fenced block, except that a line that
# starts with `(` is a subshell and its `cd` ends with the line. Words with a
# placeholder or a glob (`<name>`, `*`, `$`, `{`) and anything after ` #` are skipped.
#
# It does not run the commands (CI already does) and does not parse prose.
#
# Modes (same convention as the claw lint scripts):
#
#   (no args)    same as --all.
#   --all        CI: check AGENTS.md at the repository root.
#   --self-test  Build a small repository, require its AGENTS.md to pass, then seed
#                each kind of stale reference and require every one to be rejected,
#                so a guard that stopped guarding fails CI rather than passing all.
#
# Exit codes:
#   0  AGENTS.md is consistent with the tree
#   1  at least one reference is stale
#   2  invocation error (bad arg, AGENTS.md or git missing)

set -euo pipefail

usage() {
  echo "usage: $(basename "$0") [--all|--self-test]" >&2
  exit 2
}

mode="all"
if [ "$#" -gt 0 ]; then
  case "$1" in
    --all)       mode="all" ;;
    --self-test) mode="self-test" ;;
    *)           usage ;;
  esac
  [ "$#" -eq 1 ] || usage
fi

# Top-level directories whose paths are checked even if the tree has lost them, so
# a removed directory is reported rather than silently unchecked. Directories the
# tree has beyond these are added at run time.
static_roots="claw connector personal-agent sandbox scripts docs deploy .github"

# Extensions that make a word with a slash a file reference.
ext_re='\.(ts|tsx|js|mjs|cjs|sh|md|json|yml|yaml|toml|py|go|sql|txt)$'

# One record per code span or fenced line: "<block id> <line> <text>", tab separated.
# Every inline span is a block of its own; a fenced block (``` or ~~~) is one block,
# so a `cd` on one of its lines holds for the next.
extract_code() {
  awk '
    { s = $0; sub(/^[[:space:]]+/, "", s) }
    fence == "" && (s ~ /^```/ || s ~ /^~~~/) { fence = substr(s, 1, 3); blk++; next }
    fence != "" && substr(s, 1, 3) == fence { fence = ""; next }
    fence != "" { printf "F%d\t%d\t%s\n", blk, NR, $0; next }
    {
      line = $0; n = 0
      while (match(line, /`[^`]+`/)) {
        n++
        printf "S%d_%d\t%d\t%s\n", NR, n, NR, substr(line, RSTART + 1, RLENGTH - 2)
        line = substr(line, RSTART + RLENGTH)
      }
    }
  ' "$1"
}

# The targets a Makefile defines, one per line. `.PHONY` and the other dot targets
# are not targets of interest; `VAR := x` is an assignment, not a rule.
make_targets() {
  awk '
    /^[A-Za-z0-9_%\/.-]+([ \t]+[A-Za-z0-9_%\/.-]+)*[ \t]*:([^=]|$)/ {
      lhs = $0; sub(/[ \t]*:.*/, "", lhs)
      n = split(lhs, a, /[ \t]+/)
      for (i = 1; i <= n; i++) if (a[i] != "" && substr(a[i], 1, 1) != ".") print a[i]
    }' "$1"
}

# Succeeds when some line of stdin is "$1" or ends in "/$1". A plain string
# comparison on purpose: file names hold dots, which a regex would take as any
# character.
ends_with_path() {
  awk -v f="$1" 'BEGIN { n = length(f) }
    { l = length($0); if ($0 == f || (l > n && substr($0, l - n) == "/" f)) found = 1 }
    END { exit !found }'
}

# Applies a `cd` argument to the current directory ($1, "" for the root) and prints
# the new one. Forms that cannot be followed (absolute, ~, $VAR, -) leave it as is.
# `..` goes back to the root, which is where every sibling hop in this file leads.
cd_to() {
  local cur="$1" arg="$2" rest
  case "$arg" in
    ""|/*|\~*|\$*|-) printf '%s' "$cur" ;;
    ..|../*)
      rest="${arg#..}"; rest="${rest#/}"
      printf '%s' "$rest" ;;
    *)
      arg="${arg#./}"; arg="${arg%/}"
      printf '%s' "${cur:+$cur/}$arg" ;;
  esac
}

check_tree() {
  local root="$1" md="$1/AGENTS.md" fail=0
  local tracked roots id line text last_id="" cur="" seg first word saved lead
  local -a w args

  if [ ! -f "$md" ]; then
    echo "agents-md-paths: $md not found" >&2
    return 2
  fi
  if ! tracked="$(git -C "$root" ls-files 2>/dev/null)"; then
    echo "agents-md-paths: $root is not a git checkout (git ls-files failed)" >&2
    return 2
  fi
  roots="$static_roots $(git -C "$root" ls-files | awk -F/ 'NF > 1 { print $1 }' | sort -u | tr '\n' ' ')"

  stale() { echo "AGENTS.md:$line: $*" >&2; fail=1; }

  is_root() { case " $roots " in *" $1 "*) return 0 ;; *) return 1 ;; esac; }

  # Exists relative to the current directory or the root; a trailing slash means a
  # directory.
  exists_here() {
    local ref="$1" bare="${1%/}" b
    for b in "$cur" ""; do
      if [ "$ref" != "$bare" ]; then
        [ -d "$root/${b:+$b/}$bare" ] && return 0
      else
        [ -e "$root/${b:+$b/}$bare" ] && return 0
      fi
    done
    return 1
  }

  # The Makefile a `make` runs against, and whether it defines each target.
  check_make() {
    local dir="$cur" file="" a t defs
    local -a targets=()
    while [ "$#" -gt 0 ]; do
      a="$1"; shift
      case "$a" in
        -C)   dir="$(cd_to "$cur" "${1:-}")"; [ "$#" -gt 0 ] && shift ;;
        -f)   file="${1:-}"; [ "$#" -gt 0 ] && shift ;;
        -*|*=*) ;;
        *)    targets+=("$a") ;;
      esac
    done
    [ "${#targets[@]}" -gt 0 ] || return 0
    # -f is read in the directory make runs in, which is the one `cd` or -C led to.
    file="${dir:+$dir/}${file:-Makefile}"
    if [ ! -f "$root/$file" ]; then
      stale "make runs against $file, which does not exist"
      return 0
    fi
    defs="$(make_targets "$root/$file")"
    for t in "${targets[@]}"; do
      grep -qxF -- "$t" <<<"$defs" || stale "make target '$t' is not defined in $file"
    done
  }

  while IFS=$'\t' read -r id line text; do
    if [ "$id" != "$last_id" ]; then cur=""; last_id="$id"; fi
    text="${text%% #*}"
    saved="$cur"
    lead="${text#"${text%%[![:space:]]*}"}"
    while IFS= read -r seg; do
      [ -n "${seg//[[:space:]]/}" ] || continue
      read -r -a w <<<"$seg" || true
      [ "${#w[@]}" -gt 0 ] || continue
      w[0]="${w[0]#(}"
      w[${#w[@]}-1]="${w[${#w[@]}-1]%)}"

      if [ "${w[0]}" = "cd" ]; then
        cur="$(cd_to "$cur" "${w[1]:-}")"
        [ -d "$root/$cur" ] || stale "cd into '$cur', which is not a directory"
        continue
      fi
      if [ "${w[0]}" = "make" ]; then
        args=("${w[@]:1}")
        check_make "${args[@]+"${args[@]}"}"
      fi

      for word in "${w[@]}"; do
        word="${word#[\"\'(]}"; word="${word%[\"\'),:]}"
        case "$word" in
          *'<'*|*'>'*|*'*'*|*'$'*|*'{'*|*'}'*|*'?'*|*'['*|*'='*|*'://'*) continue ;;
        esac
        first="${word%%/*}"
        if { [ "$first" != "$word" ] && is_root "$first"; } || [ "${word%/}" != "$word" ]; then
          exists_here "$word" || stale "'$word' does not exist"
        elif [ "$first" != "$word" ] && [[ "$word" =~ $ext_re ]]; then
          exists_here "$word" || ends_with_path "$word" <<<"$tracked" || stale "'$word' is not a file in the tree"
        elif [ "$first" = "$word" ] && [ "${#w[@]}" -eq 1 ] && [[ "${id}" == S* ]] && [[ "$word" =~ $ext_re ]]; then
          [ -e "$root/$word" ] || ends_with_path "$word" <<<"$tracked" || stale "'$word' is not a file in the tree"
        fi
      done
    done < <(printf '%s\n' "$text" | awk '{ gsub(/&&|[|][|]|;|[|]/, "\n"); print }')
    case "$lead" in "("*) cur="$saved" ;; esac
  done < <(extract_code "$md")

  if [ "$fail" -ne 0 ]; then
    echo >&2
    echo "AGENTS.md names something the tree does not have. Fix the reference in the same" >&2
    echo "change that moved or renamed the file, directory or make target." >&2
    return 1
  fi
  return 0
}

# A small repository whose AGENTS.md uses every construct the guard understands.
make_fixture() {
  local d="$1"
  mkdir -p "$d/claw/packages/api/src/assistant" "$d/claw/scripts" "$d/sandbox" "$d/scripts/release-tests" "$d/docs"
  : > "$d/claw/packages/api/src/assistant/prompts.ts"
  : > "$d/claw/packages/api/src/assistant/inbound.ts"
  : > "$d/claw/scripts/lint-x.sh"
  : > "$d/scripts/release-tests/x.sh"
  : > "$d/docs/index.md"
  printf '.PHONY: verify lint\nverify: lint\n\t@true\nlint:\n\t@true\n' > "$d/Makefile"
  printf 'all: build\nbuild:\n\t@true\nfmt-verify:\n\t@true\n' > "$d/sandbox/Makefile"
  cat > "$d/AGENTS.md" <<'MD'
# AGENTS.md

Trees: `claw/`, `sandbox/` and `docs/`; the assistant is `claw/packages/api/src/assistant/`. Not checked: `claw/packages/*/test/`, `claw/<name>/x.ts`,
`test/<name>.test.ts`, `$HOME/x.ts`, `DATABASE_URL=postgres://u:p@127.0.0.1:5432/db`.

Run `make verify`, then `make -k lint`, or `make verify && make lint` in one go.
Sandbox: `cd sandbox && make all && make fmt-verify`, or `make -C sandbox all`, or
`cd sandbox && make -f Makefile fmt-verify`.
The prompt lives in `claw/packages/api/src/assistant/prompts.ts` (also `inbound.ts`
and `assistant/inbound.ts`). Run `bash scripts/release-tests/x.sh`.

```bash
cd claw
bash scripts/lint-x.sh --all   # a comment may name scripts/gone.sh
cd ../sandbox
make all
cd ..
(cd sandbox && make fmt-verify)
make lint
```

~~~sh

bash scripts/release-tests/x.sh
~~~
MD
  git -C "$d" init -q
  git -C "$d" add -A
}

# Copies the fixture's AGENTS.md through one sed expression, then requires the guard
# to fail it.
expect_stale() {
  local what="$1" expr="$2" d
  d="$tmp/m$((++n))"
  make_fixture "$d"
  sed -i.bak -e "$expr" "$d/AGENTS.md"
  if cmp -s "$d/AGENTS.md" "$d/AGENTS.md.bak"; then
    echo "agents-md-paths: self-test mutation did not change the fixture: $what" >&2
    exit 1
  fi
  rm -f "$d/AGENTS.md.bak"
  if check_tree "$d" >/dev/null 2>&1; then
    echo "ERROR: self-test: the guard accepted AGENTS.md with $what. The guard is not guarding." >&2
    exit 1
  fi
}

if [ "$mode" = "self-test" ]; then
  command -v git >/dev/null 2>&1 || { echo "agents-md-paths: git is required" >&2; exit 2; }
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  n=0

  make_fixture "$tmp/ok"
  if ! check_tree "$tmp/ok"; then
    echo "ERROR: self-test: the guard rejected a consistent AGENTS.md." >&2
    exit 1
  fi

  expect_stale "a file under a top-level directory renamed" 's|assistant/prompts.ts|assistant/promptz.ts|'
  expect_stale "a directory with a trailing slash renamed" 's|is `claw/packages/api/src/assistant/`|is `claw/packages/api/srcx/`|'
  expect_stale "a trailing slash on a file" 's|lives in `claw/packages/api/src/assistant/prompts.ts`|lives in `claw/packages/api/src/assistant/prompts.ts/`|'
  expect_stale "a top-level directory ref to a missing directory" 's|`docs/`|`docs/missing/`|'
  expect_stale "a directory ref with a trailing slash whose first segment is unknown" 's|`sandbox/`|`sandboxx/`|'
  expect_stale "a bare file name renamed" 's|(also `inbound.ts`|(also `inboundz.ts`|'
  expect_stale "a path with a slash whose file is gone" 's|`assistant/inbound.ts`|`assistant/inboundz.ts`|'
  expect_stale "a second make target on a line, after &&" 's|make verify && make lint|make verify \&\& make nosuch|'
  expect_stale "a make target after an option" 's|make -k lint|make -k nosuch|'
  expect_stale "the first make target" 's|Run `make verify`|Run `make nosuch`|'
  expect_stale "a make target that only the root Makefile defines, after cd" 's|make all && make fmt-verify|make all \&\& make verify|'
  expect_stale "a path in a fenced block" 's|bash scripts/lint-x.sh|bash scripts/lint-y.sh|'
  expect_stale "a cd into a missing directory" 's|cd ../sandbox|cd ../sandboxx|'
  expect_stale "a make -C target that only the root Makefile defines" 's|make -C sandbox all|make -C sandbox verify|'
  expect_stale "a make -f target that only the root Makefile defines, after cd" 's|make -f Makefile fmt-verify|make -f Makefile verify|'
  expect_stale "a make -f file that does not exist in the directory" 's|make -f Makefile fmt-verify|make -f Makefile.gone fmt-verify|'
  expect_stale "a make target of the wrong Makefile in a fenced block" 's|^make all$|make lint|'
  expect_stale "a path in a ~~~ fenced block" 's|^bash scripts/release-tests/x.sh$|bash scripts/release-tests/z.sh|'
  expect_stale "a script path gone" 's|bash scripts/release-tests/x.sh|bash scripts/release-tests/y.sh|'

  d="$tmp/m$((++n))"
  make_fixture "$d"
  rm -rf "$d/docs"
  if check_tree "$d" >/dev/null 2>&1; then
    echo "ERROR: self-test: the guard accepted AGENTS.md naming a removed directory. The guard is not guarding." >&2
    exit 1
  fi

  d="$tmp/m$((++n))"
  make_fixture "$d"
  rm -f "$d/AGENTS.md"
  rc=0
  check_tree "$d" >/dev/null 2>&1 || rc=$?
  if [ "$rc" -ne 2 ]; then
    echo "ERROR: self-test: a missing AGENTS.md must be an invocation error (2), got $rc." >&2
    exit 1
  fi

  echo "agents-md-paths: self-test OK ($n seeded failures rejected)"
  exit 0
fi

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
rc=0
check_tree "$repo_root" || rc=$?
if [ "$rc" -eq 0 ]; then
  echo "agents-md-paths: OK"
fi
exit "$rc"
