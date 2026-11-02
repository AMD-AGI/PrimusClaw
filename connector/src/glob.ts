// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** A small glob: `*` and `?` stay inside one path segment, `**` crosses segments. */
export function globToRegExp(glob: string): RegExp {
  let re = "^";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        i++;
        if (glob[i + 1] === "/") { i++; re += "(?:.*/)?"; } else re += ".*";
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(re + "$");
}

export const globMatches = (glob: string, relPath: string): boolean => globToRegExp(glob).test(relPath);
