// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import { PY_B_END as E, PY_B_START as B, PY_D as D, PY_W_CHARS as W } from "../text/py-word.js";

/**
 * The words of a typed answer, with Python's `re` semantics (`../text/py-regex.ts`): every pattern is global and
 * Unicode-aware, case-insensitive where the Python one is. Use `has` to search (a global pattern's `test` keeps state).
 */
const re = (source: string, ignoreCase = true): RegExp => new RegExp(source, ignoreCase ? "giu" : "gu");

/** Whether `pattern` occurs in `text`. */
export const has = (pattern: RegExp, text: string): boolean => text.search(pattern) !== -1;

export const DENY = re(
  "拒绝|不同意|不批准|不通过|不要?合(?:入|并)?|别合(?:入|并)?|先别(?:合(?:入|并)?)?|不要?发(?:布)?|别发(?:布)?|取消|驳回|否决|" +
    `${B}(?:deny|reject|decline|no|nope)${E}|${B}do\\s*not\\s+(?:merge|post)${E}|${B}don'?t\\s+(?:merge|post)${E}`,
);
export const ALLOW = re(
  "确认|确定|同意|批准|通过|可以合|合吧|合入|合并|发布|发吧|可以发|没问题|好的|可以|" +
    `${B}(?:approve|confirm|allow|go\\s*ahead|merge|post|yes|ok|okay|lgtm|sure)${E}`,
);
/** An answer only next to the pull requests it answers. */
export const WEAK = re(`没问题|好的|可以|${B}(?:yes|ok|okay|sure|lgtm)${E}`);
export const ALL = re(`全部|所有|全都|都|一起|${B}(?:all|both|every(?:thing)?|them)${E}`);
export const QUESTION = re(
  "[?？]|吗|么|能不能|可不可以|能否|为什么|为何|怎么|是否|不确定|不知道|不清楚|再想想|考虑|" +
    `${B}(?:why|what|how|whether|maybe)${E}`,
);
export const FULLY = re("全自动(?:合入|合并)?(?:[，,]?\\s*无需人工确认)?|fully[\\s_-]*auto(?:matic)?(?:\\s+merge)?");
export const HIGH = re(
  "高风险(?:的)?(?:人工)?(?:再)?(?:确认一次|确认一下|确认|再问我|问我)?|人工(?:再)?确认(?:一次|一下)?|" +
    "high[\\s_-]*risk|默认档?|（默认）|\\(default\\)",
);
export const MODE_VERB = re(`确认|确定|选择?|就用|${B}(?:confirm|choose|pick|use)${E}`);
/**
 * A pull request as written: a link, owner/name#N, name#N, #N ("PR #N" too: PR is no repository), or a bare number of
 * two or more digits. A repository is written in ASCII letters, so Chinese run into it is not part of it.
 */
export const PULL = re(
  `https?://github\\.com/(?<lo>[${W}.-]+)/(?<ln>[${W}.-]+)/pull/(?<lnum>${D}+)\\S*` +
    `|(?<![A-Za-z0-9_./-])(?:(?<owner>[A-Za-z0-9_.-]+)/)?(?!(?:pr|prs|pull)\\s*#)(?<name>[A-Za-z][A-Za-z0-9_.-]*)\\s*#\\s*(?<rnum>${D}+)` +
    `|#\\s*(?<num>${D}+)` +
    `|(?<![${W}#/.])(?<bare>${D}{2,7})(?![${W}.])`,
);
/** The words that may stand beside an answer and leave it an answer (nothing that makes it a request: "帮我", "一下"). */
export const FILLER = re(
  `${B}(?:pr|prs|pull|requests?|review|please|the|it|and|of|for|to)${E}|评审|审阅|请|这个|那个|这些|那些|` +
    "这俩|两个|个|和|与|及|跟|以及|也|就|先|吧|了|的|啊|呀|哦|嗯|把|给|我|你|它们?|项|条|以上|上面|上述|号|吧",
);
export const WORD = re(`[${W}一-鿿]`, false);
/** Where one clause of a mixed answer ends. */
export const CLAUSE_END = re("[，,；;。.!！\\n]", false);

/**
 * The words that name a review and a merge, in every way a request to review and merge is written. A message with a
 * word of each is a request to review and merge, never an answer; a typed answer about a pull request held for both is
 * told apart by them.
 */
const REVIEW_WORDS = "review|评审|审阅|审查|审核|代审";
export const MERGE_WORD = re(`合入|合并|合了|合吧|可以合|${B}merg(?:e|es|ed|ing)${E}|${B}land(?:s|ed|ing)?${E}`);
/** (a held review is posted: "确认 #243 发布") */
export const REVIEW_WORD = re(`${REVIEW_WORDS}|发布|${B}post${E}`);
export const REVIEW_ONLY = re(REVIEW_WORDS);
