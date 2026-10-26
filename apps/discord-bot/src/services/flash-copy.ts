export type FlashUiLocale = "en" | "it";

const flashText = {
  en: {
    modalTitle: "Flash mass",
    what: "What",
    when: "When (30m · 1h30m · 21:00)",
    notes: "Notes (optional)",
    notesPlaceholder: "meet Caerleon gate, bring escape",
    modalFailed: "Flash mass could not be created",
    invalidTime: '"{when}" is not a time I understand. Try 30m, 1h30m or 21:00.',
    missingChannel:
      'The flash mass channel is not configured. An admin must set it under Discord settings.',
    missingRole:
      'The default event ping role is not configured. An admin must set it under Discord settings.',
    noPermission: "You don't have permission to create a flash mass.",
    createFailed: "The flash mass could not be created. Try again or contact an admin.",
    createdTitle: "Flash Mass Created",
    createdBody:
      "**#{id} {what}** — mass <t:{massTs}:R> ({interpretation}). The public ping goes to <#{channelId}> after <t:{undoUntilTs}:R>; undo it below if needed.",
    undoButton: "Undo flash mass",
    undoSuccessTitle: "Flash Mass Undone",
    undoSuccessBody: "Flash mass **#{id}** was cancelled before its public ping.",
    undoUnavailableTitle: "Undo Unavailable",
    undoExpired: "The undo window has ended or this flash mass is no longer scheduled.",
    undoFailed: "The flash mass could not be undone.",
    joinedTitle: "You're In",
    joinedBody: "Flash mass **#{id}** — see you at mass <t:{massTs}:t>.",
    joinFailedTitle: "Join Failed",
    joinFailed: "Failed to join the flash mass.",
    leftTitle: "Left Flash Mass",
    leftBody: "You left flash mass **#{id}**.",
    leaveFailedTitle: "Leave Failed",
    leaveFailed: "Failed to leave the flash mass.",
    reminder: "🔔 {prefix}Reminder: **{title}** starts <t:{timestamp}:R>.",
    date: "Date",
    mass: "Mass",
    start: "Start",
    status: "Status",
    organizer: "Organizer",
    coming: "Coming",
    nobody: "*Nobody yet — one tap on Join below.*",
    join: "Join",
    leave: "Leave",
    ping: "Ping",
    startAction: "Start",
    stop: "Stop",
    reopen: "Reopen",
    cancel: "Cancel",
    controlsHint: "Use the controls below to join, leave or manage the event.",
    massNotice:
      "🔔 {mentions}\n**{title}** mass is starting — join <#{voiceChannelId}>. Start: <t:{startTs}:R>.{unlinked}",
    startNotice:
      "🚨 {mentions}\n**{title}** is now **LIVE** — join <#{voiceChannelId}>.{unlinked}",
    unlinked: "\nNot linked on Discord: {names}.",
    noParticipants: "No linked Discord participants yet.",
    flashCalendarHeading: "⚡ Flash Masses",
    flashCalendarSubtitle:
      "*Spontaneous content — one tap to join. Open a thread for details.*",
    calendarSectionLive: "🔴 Live now",
    calendarSectionNext: "✦ Next up",
    calendarFlashKind: "FLASH MASS",
    calendarPendingThread: "*Discussion thread is being prepared.*",
    calendarEmpty: "*There are no live or upcoming events right now.*",
    calendarContinuation: "continued",
  },
  it: {
    modalTitle: "Massa flash",
    what: "Cosa",
    when: "Quando (30m · 1h30m · 21:00)",
    notes: "Note (facoltative)",
    notesPlaceholder: "ritrovo al gate di Caerleon, porta la fuga",
    modalFailed: "Non è stato possibile creare la massa flash",
    invalidTime: 'L’orario "{when}" non è valido. Prova 30m, 1h30m o 21:00.',
    missingChannel:
      "Il canale flash mass non è configurato. Un admin deve impostarlo nelle impostazioni Discord.",
    missingRole:
      "Il ruolo per i ping evento non è configurato. Un admin deve impostarlo nelle impostazioni Discord.",
    noPermission: "Non hai il permesso di creare una massa flash.",
    createFailed: "Non è stato possibile creare la massa flash. Riprova o contatta un admin.",
    createdTitle: "Massa flash creata",
    createdBody:
      "**#{id} {what}** — mass <t:{massTs}:R> ({interpretation}). Il ping pubblico verrà inviato in <#{channelId}> <t:{undoUntilTs}:R>. Se serve, annullalo qui sotto.",
    undoButton: "Annulla massa flash",
    undoSuccessTitle: "Massa flash annullata",
    undoSuccessBody: "La massa flash **#{id}** è stata annullata prima del ping pubblico.",
    undoUnavailableTitle: "Annullamento non disponibile",
    undoExpired: "Il tempo per annullare è scaduto oppure la massa flash non è più programmata.",
    undoFailed: "Non è stato possibile annullare la massa flash.",
    joinedTitle: "Ci sei",
    joinedBody: "Massa flash **#{id}** — ci vediamo alla mass <t:{massTs}:t>.",
    joinFailedTitle: "Partecipazione non riuscita",
    joinFailed: "Non è stato possibile partecipare alla massa flash.",
    leftTitle: "Uscito dalla massa flash",
    leftBody: "Hai lasciato la massa flash **#{id}**.",
    leaveFailedTitle: "Uscita non riuscita",
    leaveFailed: "Non è stato possibile uscire dalla massa flash.",
    reminder: "🔔 {prefix}Promemoria: **{title}** inizia <t:{timestamp}:R>.",
    date: "Data",
    mass: "Mass",
    start: "Inizio",
    status: "Stato",
    organizer: "Organizzatore",
    coming: "Partecipanti",
    nobody: "*Nessuno per ora — premi Partecipa qui sotto.*",
    join: "Partecipa",
    leave: "Esci",
    ping: "Avvisa",
    startAction: "Inizia",
    stop: "Ferma",
    reopen: "Riapri",
    cancel: "Annulla",
    controlsHint: "Usa i pulsanti qui sotto per partecipare, uscire o gestire la massa.",
    massNotice:
      "🔔 {mentions}\n**{title}** — la mass è iniziata. Entra in <#{voiceChannelId}>. Inizio: <t:{startTs}:R>.{unlinked}",
    startNotice:
      "🚨 {mentions}\n**{title}** è ora **IN CORSO** — entra in <#{voiceChannelId}>.{unlinked}",
    unlinked: "\nNon collegati a Discord: {names}.",
    noParticipants: "Nessun partecipante collegato a Discord.",
    flashCalendarHeading: "⚡ Flash mass",
    flashCalendarSubtitle:
      "*Contenuti spontanei — premi Partecipa per unirti. Apri il thread per i dettagli.*",
    calendarSectionLive: "🔴 In corso",
    calendarSectionNext: "✦ Prossime",
    calendarFlashKind: "MASSA FLASH",
    calendarPendingThread: "*Il thread della discussione è in preparazione.*",
    calendarEmpty: "*Al momento non ci sono eventi in corso o in programma.*",
    calendarContinuation: "continua",
  },
} satisfies Record<FlashUiLocale, Record<string, string>>;

export type FlashCopyKey = keyof typeof flashText.en;

/** Uses the Discord interface locale; all unsupported locales fall back to English. */
export function resolveFlashLocale(locale?: string | null): FlashUiLocale {
  return locale?.toLowerCase().startsWith("it") ? "it" : "en";
}

/** Returns one flash-flow string with simple named substitutions. */
export function flashCopy(
  locale: string | null | undefined,
  key: FlashCopyKey,
  values: Record<string, string | number> = {},
): string {
  let result = flashText[resolveFlashLocale(locale)][key];
  for (const [name, value] of Object.entries(values)) {
    result = result.replaceAll(`{${name}}`, String(value));
  }
  return result;
}
