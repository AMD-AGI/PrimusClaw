// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import type { Lang } from "./lang.js";

/**
 * User-facing text lives in catalogs, one per feature (`locales/<feature>.ts`), never inline in domain code. A catalog
 * is defined once per language with the same keys and the same parameters, which the compiler checks:
 *
 *     export const apimText = defineCatalog({
 *       en: { guidance: (p: { url: string }) => `Please upload it here:\n${p.url}` },
 *       zh: { guidance: (p) => `请先在这里上传：\n${p.url}` },
 *     });
 *     apimText.in(lang).guidance({ url });
 *
 * A message is a fixed string or a function of named parameters. Byte-for-byte equality with the Python worker's
 * texts is a test of the feature that ports them, not of this mechanism.
 */
export type Message = string | ((params: never) => string);

export type Messages = Readonly<Record<string, Message>>;

export interface Catalog<M extends Messages> {
  /** The messages in `lang`. */
  in(lang: Lang): M;
}

export function defineCatalog<M extends Messages>(texts: { readonly en: M; readonly zh: NoInfer<M> }): Catalog<M> {
  return { in: (lang) => texts[lang] };
}
