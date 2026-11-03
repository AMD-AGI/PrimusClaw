// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Bash approval rules every run has unless the deployment turns them off
 * (`BASH_APPROVAL_DEFAULTS_ENABLED=false`): the writes to GitHub that a model can
 * make from the sandbox with the user's own token. The GitHub MCP tools hold the
 * same writes for a person; without these, the shell would be the way around that.
 * A plain `git push` of a branch is not here: publishing a branch changes nothing
 * that is not the user's, and opening the pull request from it is held.
 *
 * Copied verbatim from the outbound-actions pack (examples/bash-approval), which
 * is where they are tested command by command; a test keeps the two the same.
 */
export const DEFAULT_BASH_APPROVAL_RULES: ReadonlyArray<Record<string, string>> = [
  {
    "label": "git push --force / --delete (rewrites or deletes remote history)",
    "program": "git",
    "args_regex": "^(?:(?:-[cC]|--(?:git-dir|work-tree|namespace|super-prefix|config-env|attr-source))\\s+\\S+\\s+|(?!(?:-[cC]|--(?:git-dir|work-tree|namespace|super-prefix|config-env|attr-source))\\s)-\\S*\\s+)*push\\s(?:.*\\s)?(?:--force(?:-with-lease|-if-includes)?(?:=\\S*)?|--delete|--mirror|--prune|-[A-Za-z]*[fd][A-Za-z]*|\\+\\S*|:\\S+)(?:\\s|$)"
  },
  {
    "label": "gh pr write (creates, changes or merges a pull request)",
    "program": "gh",
    "args_regex": "^(?:(?:-R|--repo)\\s+\\S+\\s+|(?!(?:-R|--repo)\\s)-\\S*\\s+)*pr\\s+(?:(?:-R|--repo)\\s+\\S+\\s+|(?!(?:-R|--repo)\\s)-\\S*\\s+)*(?:create|merge|close|review|ready|edit|reopen|comment|update-branch)(?:\\s|$)"
  },
  {
    "label": "gh issue write (creates, changes or comments on an issue)",
    "program": "gh",
    "args_regex": "^(?:(?:-R|--repo)\\s+\\S+\\s+|(?!(?:-R|--repo)\\s)-\\S*\\s+)*issue\\s+(?:(?:-R|--repo)\\s+\\S+\\s+|(?!(?:-R|--repo)\\s)-\\S*\\s+)*(?:create|close|comment|edit|delete|reopen|transfer|lock|unlock|pin|unpin|develop)(?:\\s|$)"
  },
  {
    "label": "gh release write (publishes or changes a release)",
    "program": "gh",
    "args_regex": "^(?:(?:-R|--repo)\\s+\\S+\\s+|(?!(?:-R|--repo)\\s)-\\S*\\s+)*release\\s+(?:(?:-R|--repo)\\s+\\S+\\s+|(?!(?:-R|--repo)\\s)-\\S*\\s+)*(?:create|edit|delete|upload|delete-asset)(?:\\s|$)"
  },
  {
    "label": "gh api write (POST / PUT / PATCH / DELETE)",
    "program": "gh",
    "flags": "i",
    "args_regex": "^(?:(?:-R|--repo)\\s+\\S+\\s+|(?!(?:-R|--repo)\\s)-\\S*\\s+)*api\\s(?:.*\\s)?(?:-X\\s*|--method(?:\\s+|=))(?:POST|PUT|PATCH|DELETE)(?:\\s|$)"
  },
  {
    "label": "gh api with fields or a body (an implied POST)",
    "program": "gh",
    "flags": "i",
    "args_regex": "^(?:(?:-R|--repo)\\s+\\S+\\s+|(?!(?:-R|--repo)\\s)-\\S*\\s+)*api(?!(?:.*\\s)?(?:-X\\s*|--method(?:\\s+|=))GET(?:\\s|$)).*\\s(?:-[fF]|--field|--raw-field|--input)"
  },
  {
    "label": "gh repo write (creates, changes or deletes a repository)",
    "program": "gh",
    "args_regex": "^(?:(?:-R|--repo)\\s+\\S+\\s+|(?!(?:-R|--repo)\\s)-\\S*\\s+)*repo\\s+(?:(?:-R|--repo)\\s+\\S+\\s+|(?!(?:-R|--repo)\\s)-\\S*\\s+)*(?:create|delete|edit|rename|archive|unarchive|fork|sync)(?:\\s|$)"
  },
  {
    "label": "gh workflow write (runs, enables or disables a workflow)",
    "program": "gh",
    "args_regex": "^(?:(?:-R|--repo)\\s+\\S+\\s+|(?!(?:-R|--repo)\\s)-\\S*\\s+)*workflow\\s+(?:(?:-R|--repo)\\s+\\S+\\s+|(?!(?:-R|--repo)\\s)-\\S*\\s+)*(?:run|enable|disable)(?:\\s|$)"
  }
];
