export type EventThreadUiLocale = "en" | "it";

const eventThreadText = {
  en: {
    wrongLocationTitle: "Use Inside An Event Thread",
    wrongLocationBody:
      "This command only works inside an event's discussion thread or forum post. Open one from the event calendar, or use `/event-join` or `/event-leave` with an event ID.",
    buildNoMatchTitle: "Build Not Found",
    buildNoMatchBody:
      "No signup build matches \"{query}\". Available builds: {builds}.",
    buildNotAllowedTitle: "Build Not Available To You",
    buildNotDeclaredBody:
      "{build} uses {weapon}, which is not in your weapons. Add it under My weapons in your Profile on the website, or sign up as Fill.",
    buildLockedBody:
      "{build} uses {weapon}, which an officer locked for you. Pick another build or sign up as Fill.",
    buildAmbiguousTitle: "Build Ambiguous",
    buildAmbiguousBody:
      "\"{query}\" matches more than one build: {matches}. Use the full name, or rerun without `build` to pick from the menu.",
  },
  it: {
    wrongLocationTitle: "Usa dentro un thread evento",
    wrongLocationBody:
      "Questo comando funziona solo dentro il thread o il post di discussione di un evento. Aprilo dal calendario eventi, oppure usa `/event-join` o `/event-leave` con un ID evento.",
    buildNoMatchTitle: "Build non trovata",
    buildNoMatchBody:
      "Nessuna build di iscrizione corrisponde a \"{query}\". Build disponibili: {builds}.",
    buildNotAllowedTitle: "Build non disponibile per te",
    buildNotDeclaredBody:
      "{build} usa {weapon}, che non è tra le tue armi. Aggiungila in Le mie armi, nel tuo Profilo sul sito, oppure iscriviti come Fill.",
    buildLockedBody:
      "{build} usa {weapon}, che un officer ti ha bloccato. Scegli un'altra build o iscriviti come Fill.",
    buildAmbiguousTitle: "Build ambigua",
    buildAmbiguousBody:
      "\"{query}\" corrisponde a più build: {matches}. Usa il nome completo, o riesegui senza `build` per scegliere dal menu.",
  },
} satisfies Record<EventThreadUiLocale, Record<string, string>>;

export type EventThreadCopyKey = keyof typeof eventThreadText.en;

/** Uses the Discord interface locale; all unsupported locales fall back to English. */
function resolveLocale(locale?: string | null): EventThreadUiLocale {
  return locale?.toLowerCase().startsWith("it") ? "it" : "en";
}

/** Returns one event-thread-command string with simple named substitutions. */
export function eventThreadCopy(
  locale: string | null | undefined,
  key: EventThreadCopyKey,
  values: Record<string, string | number> = {},
): string {
  let result = eventThreadText[resolveLocale(locale)][key];
  for (const [name, value] of Object.entries(values)) {
    result = result.replaceAll(`{${name}}`, String(value));
  }
  return result;
}