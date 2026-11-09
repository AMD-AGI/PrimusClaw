/** A fixed reply in the two languages a person is answered in: `en` is the source, `zh` the Chinese of it. */
export type Lang = "en" | "zh";

export interface Phrase {
  readonly en: string;
  readonly zh: string;
}

/** `lang` as one of the two languages: "zh" is Chinese, anything else English. */
export function langOf(lang: string): Lang {
  return lang === "zh" ? "zh" : "en";
}

/** The phrase in `lang`. */
export function said(lang: string, phrase: Phrase): string {
  return langOf(lang) === "zh" ? phrase.zh : phrase.en;
}

/** The same text in both languages (a reply that has no Chinese of its own). */
export function both(text: string): Phrase {
  return { en: text, zh: text };
}
