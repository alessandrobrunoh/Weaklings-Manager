export type EventJoinLocale = "en" | "it";

const eventJoinText = {
  en: {
    chooseGuildTitle: "Select Guild",
    chooseGuildBody:
      "🏰 You are a member of more than one guild. Choose which guild to sign up with for event **#{id}**:",
    chooseGuildPlaceholder: "Select your guild",
    noGuildTitle: "No Active Guild",
    noGuildBody:
      "You need an active guild membership to sign up for this event. Ask an officer to add you to a guild, then try again.",
    guildsFetchFailedTitle: "Fetch Error",
    guildsFetchFailed:
      "Failed to fetch your guild options. Try again in a moment.",
  },
  it: {
    chooseGuildTitle: "Scegli la gilda",
    chooseGuildBody:
      "🏰 Sei membro di più di una gilda. Scegli con quale gilda iscriverti all'evento **#{id}**:",
    chooseGuildPlaceholder: "Seleziona la tua gilda",
    noGuildTitle: "Nessuna gilda attiva",
    noGuildBody:
      "Per iscriverti a questo evento serve un'iscrizione attiva a una gilda. Chiedi a un officer di aggiungerti a una gilda e riprova.",
    guildsFetchFailedTitle: "Errore di caricamento",
    guildsFetchFailed:
      "Non è stato possibile recuperare le tue gilde. Riprova tra poco.",
  },
} satisfies Record<EventJoinLocale, Record<string, string>>;

export type EventJoinCopyKey = keyof typeof eventJoinText.en;

/** Uses the Discord interface locale; all unsupported locales fall back to English. */
function resolveEventJoinLocale(locale?: string | null): EventJoinLocale {
  return locale?.toLowerCase().startsWith("it") ? "it" : "en";
}

/** Returns one event-join-flow string with simple named substitutions. */
export function eventJoinCopy(
  locale: string | null | undefined,
  key: EventJoinCopyKey,
  values: Record<string, string | number> = {},
): string {
  let result = eventJoinText[resolveEventJoinLocale(locale)][key];
  for (const [name, value] of Object.entries(values)) {
    result = result.replaceAll(`{${name}}`, String(value));
  }
  return result;
}
