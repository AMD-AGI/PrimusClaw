// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The repository a session is bound to: `config.repo = { url, branch? }`.
 *
 * One definition, used twice. The API refuses a malformed value at
 * `POST /v1/sessions`, before any row exists, and Brain checks it again before
 * it builds a shell command out of it, because Brain does not know the value
 * came through that door (a row written by an older API, an admin edit). Two
 * copies of these rules would be two answers to "is this a safe url".
 *
 * What is accepted is deliberately narrower than what git accepts. The url is
 * handed to `git clone` and its last segment names a directory under
 * /workspace; the branch is handed to `git checkout`. Neither is trusted to
 * carry a credential, an option, a path or anything a shell would read.
 */

export interface SessionRepo {
  /** `https://<host>/<owner>/<name>[.git]`, no credentials, no query, no fragment. */
  url: string;
  /** A plain branch name. Absent means the remote's default branch. */
  branch?: string;
}

export type SessionRepoParse =
  | { ok: true; repo: SessionRepo | null }
  | { ok: false; error: string };

export const SESSION_REPO_URL_MAX_LENGTH = 512;
export const SESSION_REPO_BRANCH_MAX_LENGTH = 200;
/** The longest directory name `/workspace/<name>` may have. */
export const SESSION_REPO_NAME_MAX_LENGTH = 100;

const SEGMENT = "[A-Za-z0-9._-]+";
const HOST_LABEL = "[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?";
/** scheme, host[:port], exactly two path segments, optional `.git`; nothing after. */
const URL_RE = new RegExp(
  `^https://(${HOST_LABEL}(?:\\.${HOST_LABEL})*)(?::[0-9]{1,5})?/(${SEGMENT})/(${SEGMENT}?)(?:\\.git)?$`,
);
/** A branch starts with a letter, digit or `_`, so it can never be read as an option or a path. */
const BRANCH_RE = /^[A-Za-z0-9_][A-Za-z0-9._/+-]*$/;

const URL_HINT = "must be an https clone URL of the form https://host/owner/name or https://host/owner/name.git, "
  + "without credentials, a query or a fragment";

/** The `<name>` of a url that passed the check, which is the directory under /workspace. */
function nameOf(url: string): string | null {
  const m = URL_RE.exec(url);
  return m ? m[3] : null;
}

function checkUrl(url: string): string | null {
  if (url.length > SESSION_REPO_URL_MAX_LENGTH) return `config.repo.url must be at most ${SESSION_REPO_URL_MAX_LENGTH} characters`;
  const m = URL_RE.exec(url);
  if (!m) return `config.repo.url ${URL_HINT}`;
  const [, , owner, name] = m;
  // `.` and `..` are path steps, and a leading dot would put the checkout in a
  // hidden directory that collides with the names the workspace reserves
  // (.skills, .uploads, .cache, ...).
  if (owner.startsWith(".") || name.startsWith(".")) return `config.repo.url ${URL_HINT}`;
  if (name.length > SESSION_REPO_NAME_MAX_LENGTH) return `config.repo.url repository name is longer than ${SESSION_REPO_NAME_MAX_LENGTH} characters`;
  return null;
}

function checkBranch(branch: string): string | null {
  const bad = "config.repo.branch is not a valid branch name";
  if (branch.length > SESSION_REPO_BRANCH_MAX_LENGTH) return `config.repo.branch must be at most ${SESSION_REPO_BRANCH_MAX_LENGTH} characters`;
  if (!BRANCH_RE.test(branch)) return bad;
  // git's own refname rules, for the shapes the character set still lets through.
  if (branch.includes("..") || branch.includes("//") || branch.includes("/.") || branch.includes(".lock/")) return bad;
  if (branch.endsWith("/") || branch.endsWith(".") || branch.endsWith(".lock")) return bad;
  return null;
}

/**
 * Check a `config.repo` value as a client sent it.
 *
 * `undefined` and `null` mean no repository. An empty `branch` means the
 * remote's default branch, the same as leaving it out. Anything else that is
 * not exactly the documented shape is refused, including keys this version does
 * not know: a typo would otherwise be dropped without a word.
 *
 * The result carries the normalised value (`branch` left out when empty), which
 * is what Brain is given; the caller stores whatever the client sent.
 */
export function parseSessionRepo(raw: unknown): SessionRepoParse {
  if (raw === undefined || raw === null) return { ok: true, repo: null };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "config.repo must be an object with a url and an optional branch" };
  }
  const o = raw as Record<string, unknown>;
  for (const key of Object.keys(o)) {
    if (key !== "url" && key !== "branch") return { ok: false, error: `config.repo.${key} is not supported` };
  }
  if (o.url === undefined) return { ok: false, error: "config.repo.url is required" };
  if (typeof o.url !== "string") return { ok: false, error: "config.repo.url must be a string" };
  const urlError = checkUrl(o.url);
  if (urlError) return { ok: false, error: urlError };
  if (o.branch === undefined || o.branch === null || o.branch === "") return { ok: true, repo: { url: o.url } };
  if (typeof o.branch !== "string") return { ok: false, error: "config.repo.branch must be a string" };
  const branchError = checkBranch(o.branch);
  if (branchError) return { ok: false, error: branchError };
  return { ok: true, repo: { url: o.url, branch: o.branch } };
}

/** The directory name under /workspace for a validated repo, or null for one that is not. */
export function sessionRepoDirName(repo: SessionRepo): string | null {
  if (checkUrl(repo.url)) return null;
  return nameOf(repo.url);
}
