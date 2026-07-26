import type { Dictionary } from "./types";
import type { Locale } from "./locales";
import { de } from "./de";
import { en } from "./en";
import { es } from "./es";
import { fr } from "./fr";
import { ja } from "./ja";
import { zh } from "./zh";

const DICTIONARIES: Record<Locale, Dictionary> = { en, es, de, fr, ja, zh };

export function getDictionary(locale: Locale): Dictionary {
  return DICTIONARIES[locale];
}

export * from "./locales";
export type { Dictionary } from "./types";
