// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The commands a sandbox runs to get a pull request's code, on the sandbox review
 * path. They are anonymous by construction: the repositories are public, so no
 * credential is needed and none may be given. The recipe starts git in a clean
 * environment (nothing the sandbox has set for another purpose reaches it), ignores
 * every git configuration file, turns the credential helper off, and talks to one
 * address, `https://github.com/<owner>/<repo>.git`. The pull request's own head is
 * fetched through GitHub's `pull/<n>/head` ref, so a fork's commits arrive without a
 * fork's remote ever being added, and it is pinned to the commit the tools returned:
 * if the fetched commit is anything else the recipe stops (exit 3) and the model
 * starts again from `gh_pr_get`.
 *
 * Only the code comes this way. The metadata, the diff and the existing comments
 * stay with the tools, which hold the acting user's token on the API's side.
 *
 * A checkout that is already there is reused: the same commands fetch only what is
 * new, and the objects are fetched without file contents (`--filter=blob:none`) and
 * shallow, so a large repository costs a fraction of a clone.
 */
import type { PrRef } from "./github.js";

const SHA_RE = /^[0-9a-f]{40}$/;
/** A branch name the recipe will put in a command; anything else is not trusted to be one. */
const SAFE_REF_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;

export const RECIPE_EXIT_HEAD_MOVED = 3;
export const RECIPE_DEPTH = 200;
export const RECIPE_DEEPEN = 1000;

export interface RecipeInput {
  ref: PrRef;
  baseRef: string;
  headSha: string;
}

export interface RecipeOptions {
  /** The remote to fetch from. Fixed to GitHub in production; a test points it at a local repository. */
  remote?: string;
  /** Where the checkout lives; reused when it already exists. */
  root?: string;
}

/** The recipe, or null when a value is not one it will put in a command. */
export function buildSandboxRecipe(input: RecipeInput, opts: RecipeOptions = {}): string | null {
  const { ref, baseRef, headSha } = input;
  if (!SHA_RE.test(headSha) || !SAFE_REF_RE.test(baseRef) || baseRef.includes("..") || baseRef.endsWith("/") || baseRef.endsWith(".lock")) return null;
  if (!Number.isSafeInteger(ref.number) || ref.number < 1) return null;
  const remote = opts.remote ?? `https://github.com/${ref.owner}/${ref.repo}.git`;
  const root = opts.root ?? "/workspace/.pr-review";
  const dir = `${root}/${ref.owner}-${ref.repo}`;
  const short = headSha.slice(0, 8);
  // Everything interpolated below is a validated owner, repository, number, branch name or commit id.
  return [
    "set -eu",
    `DIR='${dir}'`,
    `mkdir -p "$DIR"`,
    `cd "$DIR"`,
    "# Anonymous git: a clean environment (proxy settings and certificates are passed through, nothing else), no configuration files, no credential helper.",
    'E=(PATH="$PATH" HOME="$DIR" GIT_TERMINAL_PROMPT=0 GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1)',
    'for v in http_proxy https_proxy no_proxy HTTP_PROXY HTTPS_PROXY NO_PROXY SSL_CERT_FILE SSL_CERT_DIR; do if [ -n "${!v:-}" ]; then E+=("$v=${!v}"); fi; done',
    'g() { env -i "${E[@]}" git -c credential.helper= -c core.askPass= -c protocol.version=2 "$@"; }',
    `[ -d .git ] || g init -q .`,
    "# The checkout's own configuration is written afresh, so a reused one cannot carry a header, a helper, a rewrite or another remote.",
    `printf '[core]\\n\\trepositoryformatversion = 1\\n\\tbare = false\\n[extensions]\\n\\tpartialclone = origin\\n[remote "origin"]\\n\\turl = %s\\n\\tfetch = +refs/heads/*:refs/remotes/origin/*\\n\\tpromisor = true\\n\\tpartialclonefilter = blob:none\\n' '${remote}' > .git/config`,
    `g fetch -q --no-tags --depth=${RECIPE_DEPTH} --filter=blob:none origin '+refs/heads/${baseRef}:refs/remotes/origin/${baseRef}'`,
    `g fetch -q --no-tags --depth=${RECIPE_DEPTH} --filter=blob:none origin 'pull/${ref.number}/head'`,
    `if [ "$(g rev-parse FETCH_HEAD)" != '${headSha}' ]; then echo "pull request head is not ${short} any more: call gh_pr_get again" >&2; exit ${RECIPE_EXIT_HEAD_MOVED}; fi`,
    `g checkout -q --detach '${headSha}'`,
    `g merge-base 'origin/${baseRef}' HEAD >/dev/null 2>&1 || g fetch -q --no-tags --deepen=${RECIPE_DEEPEN} origin '+refs/heads/${baseRef}:refs/remotes/origin/${baseRef}' 'pull/${ref.number}/head' || true`,
    `echo "CHECKOUT=$DIR HEAD=${short} BASE=origin/${baseRef}"`,
  ].join("\n") + "\n";
}

/** How the model is told to use it. */
export const SANDBOX_RECIPE_USAGE =
  "Run this script as it is, once, with bash in the sandbox. It clones nothing with a credential and must not be given one: do not add a token, a header, a credential helper or another remote. "
  + "It leaves the code at CHECKOUT with the pull request's head checked out and the base as origin/<base> (compare with git diff origin/<base>...HEAD). "
  + "Exit code 3 means the head moved: call gh_pr_get again. The diff, metadata and comments you are reviewing are the ones in this result, not whatever the checkout says.";
