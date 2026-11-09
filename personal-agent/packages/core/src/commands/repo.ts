/**
 * `/repo owner/name [branch]`. Claw is sent `config.repo = {url, branch?}` and clones it, so what is accepted is a name GitHub
 * itself allows and a branch git itself allows, and nothing else: no URL, no credential, no shell or option text.
 */
import { words } from "../text/words.js";

export const REPO_HOST = "https://github.com";

/** GitHub owners: at most 39 characters; no leading, trailing or double hyphen. */
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/u;
const NAME = /^[A-Za-z0-9._-]{1,100}$/u;
const BRANCH = /^[A-Za-z0-9._/-]{1,200}$/u;

export interface RepoPick {
  /** "owner/name", as typed. */
  readonly repo: string;
  /** "" is the remote's default branch. */
  readonly branch: string;
}

export function repoUrl(pick: RepoPick): string {
  return `${REPO_HOST}/${pick.repo}`;
}

export function repoLabel(pick: RepoPick): string {
  return pick.branch ? `${pick.repo}@${pick.branch}` : pick.repo;
}

export function validRepo(repo: string): boolean {
  const slash = repo.indexOf("/");
  if (slash < 0) return false;
  const owner = repo.slice(0, slash);
  const name = repo.slice(slash + 1);
  return (
    OWNER.test(owner) && NAME.test(name) && name !== "." && name !== ".." && !name.toLowerCase().endsWith(".git")
  );
}

/**
 * A name git accepts for a branch (`git check-ref-format`, narrowed to letters, digits and `._/-`): no leading `-` or `/`, no
 * `..`, no empty (so no leading, trailing or double `/`), dotted or `.lock` component, no trailing `.`. Claw checks it again.
 */
export function validBranch(branch: string): boolean {
  if (!BRANCH.test(branch) || branch.startsWith("-") || branch.includes("..") || branch.endsWith(".")) return false;
  return branch.split("/").every((part) => part !== "" && !part.startsWith(".") && !part.endsWith(".lock"));
}

/** `owner/name` or `owner/name branch` (what follows `/repo`) to a pick; null for anything else. */
export function parseRepo(args: string): RepoPick | null {
  const parts = words(args);
  const [repo, branch] = parts;
  if (repo === undefined || parts.length > 2 || !validRepo(repo)) return null;
  if (branch !== undefined && !validBranch(branch)) return null;
  return { repo, branch: branch ?? "" };
}
