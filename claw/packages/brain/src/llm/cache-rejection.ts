// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Does this error look like the endpoint objecting to our cache markers?
 *
 * Shared by both providers on purpose. It was written for the Anthropic path
 * and the OpenAI path shipped without it, which is not a smaller version of
 * the same guard but a different one: probing on the FIRST failure of any kind
 * turns one transient 429 into a session that never caches again. Matching
 * `prompt.?cach` covers `prompt_cache_breakpoint` and `prompt_cache_options`
 * as well as the Anthropic spellings.
 */
export function looksLikeCacheRejection(err: unknown): boolean {
  let text: string;
  try {
    const e = err as Record<string, unknown> | null;
    text = [
      (e?.message as string) ?? "",
      typeof e?.error === "object" ? JSON.stringify(e.error) : String(e?.error ?? ""),
      String(e === null || e === undefined ? "" : e),
    ].join(" ");
  } catch {
    text = String(err);
  }
  return /cache_control|cache_creation|ephemeral|prompt.?cach/i.test(text);
}
