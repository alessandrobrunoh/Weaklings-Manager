# Plan: Controlli Discord nel thread evento

**Branch**: `feat/event-discord-thread-controls`
**Status**: Active — Slice 1 implemented; mutation tooling unavailable; awaiting checkpoint approval

## Goal

Ogni evento, Call to Arms o normale, pubblica nel proprio thread Discord una card con cinque pulsanti (`Join / Change Build`, `Leave`, `Ping`, `Start`, `Stop`) che permette di gestire iscrizioni, reminder e ciclo di vita dell’evento, inclusa la creazione di un canale vocale all’avvio.

## Decisioni confermate

1. I cinque pulsanti vivono nella card interattiva già inviata **dentro il thread dell’annuncio**, non nel messaggio principale del canale.
2. La stessa card è usata sia per gli eventi normali sia per i Call to Arms.
3. `Ping`, `Start` e `Stop` richiedono il permesso applicativo `events.manage`; `Join / Change Build` e `Leave` restano disponibili ai membri autenticati come oggi.
4. Il canale vocale viene creato sotto una categoria Discord configurabile dalle impostazioni admin.
5. Allo Stop il bot elimina il canale vocale soltanto se è vuoto. Se contiene ancora utenti, lo lascia esistente e comunica chiaramente che non è stato eliminato.
6. `Start` e `Stop` sono due pulsanti distinti, portando la riga al limite Discord di cinque componenti.

## Comportamento proposto

### Stati dei pulsanti

| Stato evento | Join / Change Build | Leave | Ping | Start | Stop |
|---|---:|---:|---:|---:|---:|
| `scheduled` | attivo | attivo | attivo | attivo | disabilitato |
| `live` | disabilitato | disabilitato | disabilitato | disabilitato | attivo |
| `stopped` / `auto_stopped` | disabilitato | disabilitato | disabilitato | disabilitato | disabilitato |

I componenti Discord sono condivisi da tutti gli utenti e non possono essere nascosti per singolo viewer. Per questo `Ping`, `Start` e `Stop` restano visibili, mentre l’autorizzazione reale viene sempre applicata dal backend. Un click non autorizzato riceve una risposta ephemeral e non produce effetti Discord.

### Ping manuale

Il pulsante `Ping` pubblica nel thread un reminder che:

- menziona esattamente i `discord_role_ids` salvati sull’evento;
- mostra il tempo residuo con il timestamp relativo Discord, per esempio `<t:...:R>`;
- invita esplicitamente a iscriversi tramite `Join / Change Build`;
- usa `allowedMentions.roles` con gli stessi ID e non abilita mention generiche;
- è ammesso solo mentre l’evento è `scheduled`.

La prima versione non introduce un cooldown: ogni click autorizzato è un reminder intenzionale e viene registrato nell’audit log. Un doppio click concorrente deve comunque essere gestito senza risposte Discord duplicate accidentali dalla stessa interaction.

### Start

Il pulsante `Start`:

1. verifica `events.manage`, stato e configurazione della categoria vocale;
2. porta l’evento a `live` usando il lifecycle backend già esistente;
3. crea un canale vocale con nome deterministico e riconoscibile, includendo l’ID evento per evitare collisioni;
4. salva sull’evento il Discord channel ID creato, così riavvii del bot, pulsante e slash command condividono la stessa risorsa;
5. aggiorna embed e pulsanti della card nel thread;
6. invia nello stesso thread un messaggio che menziona tutti gli iscritti con `discord_id` collegato e il canale vocale tramite `<#channel-id>`.

Gli iscritti senza `discord_id` non possono tecnicamente essere pingati da Discord: vengono elencati per nome nel messaggio, senza costruire mention non valide. `allowedMentions.users` contiene esclusivamente gli ID Discord dei partecipanti collegati e deduplicati; la mention del canale non richiede `allowedMentions`.

L’orchestrazione deve essere ripetibile: se l’evento è già `live` ma non ha ancora un canale persistito a causa di un errore Discord precedente, un nuovo tentativo autorizzato completa la creazione invece di lasciare l’evento irrecuperabile. Se il canale viene creato ma il binding backend fallisce, il bot prova a rimuovere il canale appena creato e restituisce un errore operativo chiaro.

### Stop

Il pulsante `Stop`:

1. porta l’evento da `live` a `stopped` tramite il backend;
2. aggiorna embed e pulsanti della card;
3. recupera il canale vocale persistito;
4. lo elimina solo se esiste ancora ed è vuoto;
5. se è occupato, lo conserva e indica nella risposta ephemeral che serve svuotarlo/gestirlo manualmente;
6. tratta canale già rimosso come cleanup completato, senza trasformarlo in errore.

`/event-start` e `/event-stop` devono riusare la stessa orchestrazione dei pulsanti, evitando che i comandi slash mantengano il vecchio ping al ruolo globale o producano un lifecycle Discord differente.

## Acceptance Criteria

- [ ] Per ogni nuovo evento normale o CTA, la card nel thread mostra esattamente cinque pulsanti: `Join / Change Build`, `Leave`, `Ping`, `Start`, `Stop`.
- [ ] Gli stati enabled/disabled dei pulsanti corrispondono allo stato backend dell’evento.
- [ ] Join, cambio build e leave continuano a usare i flussi esistenti e aggiornano roster/embed senza regressioni.
- [ ] Un utente senza `events.manage` non può inviare reminder, avviare o fermare eventi, anche costruendo manualmente un `custom_id` valido.
- [ ] `Ping` su un evento scheduled invia nel thread un reminder con tempo relativo e menziona solo i ruoli configurati per quell’evento.
- [ ] `Ping` con zero ruoli produce un reminder leggibile con `allowedMentions: { parse: [] }`, senza fallback al ruolo Discord globale.
- [ ] `Ping` su un evento non scheduled viene rifiutato senza pubblicare messaggi.
- [ ] L’admin può configurare o cancellare l’ID della categoria vocale nelle impostazioni Discord; ID vuoti o non-snowflake vengono rifiutati/normalizzati secondo i pattern esistenti.
- [ ] `Start` fallisce prima della transizione a `live` se la categoria vocale non è configurata o non è utilizzabile dal bot.
- [ ] `Start` crea un solo canale vocale nella categoria configurata, ne persiste l’ID e rende l’operazione recuperabile dopo retry o riavvio.
- [ ] Il messaggio di avvio nel thread menziona tutti e soli gli iscritti con account Discord collegato, elenca per nome quelli non collegati e include la mention cliccabile del canale vocale.
- [ ] Il messaggio Start limita `allowedMentions.users` agli iscritti deduplicati e disabilita parsing generico di utenti, ruoli ed everyone.
- [ ] Dopo Start la card mostra lo stato `LIVE`, disabilita le azioni scheduled e abilita Stop.
- [ ] `Stop` ferma l’evento e cancella il canale vocale quando è vuoto; canale già assente è considerato già pulito.
- [ ] `Stop` non cancella un canale occupato e informa l’officer senza espellere o spostare utenti.
- [ ] Dopo Stop la card mostra lo stato fermato e tutte le azioni sono disabilitate.
- [ ] `/event-start` e `/event-stop` producono lo stesso comportamento dei rispettivi pulsanti.
- [ ] Errori Discord parziali non falsificano lo stato mostrato: la risposta ephemeral distingue transizione backend, creazione canale, binding e cleanup.
- [ ] Backend, bot e frontend superano i rispettivi test, typecheck/build, lint e mutation checks disponibili.

## Data and API shape

### Guild settings

Aggiungere al singleton `guild_settings`:

```text
discord_event_voice_category_id: Option<String>
```

Estendere `GuildSettingsView`, `UpdateGuildSettingsRequest`, impostazioni frontend e `SettingsService` del bot. Il backend valida almeno il formato snowflake; quando possibile il bot verifica a runtime che l’ID risolva a una categoria del guild configurato e che disponga di `Manage Channels`, `View Channel`, `Connect` e `Move Members` solo se effettivamente necessaria.

### Event state

Aggiungere all’evento:

```text
discord_voice_channel_id: Option<String>
```

Il campo è restituito in `EventView`/`EventDetailView`. Il binding e l’eventuale clear devono passare da endpoint backend autorizzati con `events.manage`, con regole di stato esplicite e protezione da overwrite concorrenti.

### Reminder authorization

Aggiungere un’azione backend autorizzata, per esempio:

```text
POST /api/events/{id}/remind
```

Non invia direttamente a Discord: valida permesso e stato, restituisce il dettaglio necessario al bot e registra l’intenzione nell’audit log. Il bot pubblica il messaggio solo dopo una risposta positiva.

### Voice channel binding

Esporre un contratto minimo per associare/sganciare il canale creato dal bot, per esempio:

```text
PUT /api/events/{id}/discord-voice-channel
{ "channel_id": "..." }

DELETE /api/events/{id}/discord-voice-channel
```

La forma esatta può essere adattata ai pattern router esistenti durante l’implementazione, ma deve mantenere autorizzazione, idempotenza e compare-before-overwrite. Qualsiasi cambiamento a questo contratto richiede aggiornamento esplicito del piano.

## Slices

Ogni slice segue RED-GREEN-MUTATE-KILL MUTANTS-REFACTOR. Prima del codice caricare `tdd`, `testing`, `mutation-testing`, `refactoring` e, per Rust, `rust-guidelines`. I criteri della singola slice devono essere presentati e approvati prima di modificare il codice applicativo.

### Slice 1: La card del thread offre cinque azioni e un officer può inviare un reminder per-evento

**Value**: membri e officer trovano tutte le azioni dell’evento nello stesso messaggio; un officer può richiamare i ruoli target senza ricreare l’annuncio.

**Actor**: membro Discord per le azioni di partecipazione; officer/admin con `events.manage` per il reminder.

**Trigger**: creazione della card nel thread oppure click su `Ping`.

**Observable outcome**: sia un evento normale sia un CTA mostrano cinque pulsanti; un click autorizzato su Ping pubblica nel thread il reminder con ruoli e tempo residuo, mentre un click non autorizzato resta ephemeral e non pubblica nulla.

**Path**: poller → thread evento → `sendEventSignupMessage` → action row state-aware → `event:ping:{id}` → endpoint backend autorizzato → renderer reminder → messaggio thread con allowed mentions → audit.

**Required implementation skills**: `tdd`, `testing`, `mutation-testing`, `refactoring`, `rust-guidelines`.

**Acceptance criteria**: cinque custom IDs stabili, card identica per CTA/non-CTA, stato scheduled corretto, reminder con zero/uno/più ruoli, timestamp relativo, no fallback globale, rifiuto permission/status, nessuna regressione join/change/leave.

**RED**: introdurre un test runner minimo per il bot usando gli strumenti già disponibili nel progetto e scrivere test fallenti per action row, renderer reminder e handler; aggiungere test router/service Rust per autorizzazione, stato e audit. Coprire mutanti su confronto stato, lista vuota, deduplicazione, inversione permission e `allowedMentions.parse`.

**GREEN**: rendere `buildEventManageActionRow` dipendente dall’evento, aggiungere i tre pulsanti operativi, implementare endpoint remind e handler Ping con il minimo wiring necessario.

**MUTATE**: eseguire mutation testing sui renderer/guard TypeScript e sui guard Rust dell’endpoint.

**KILL MUTANTS**: rafforzare test per evento live/stopped, zero ruoli, ruolo duplicato, utente senza permesso e timestamp al limite.

**REFACTOR**: estrarre una sola utility per role mentions + `allowedMentions` se reminder e annuncio duplicano realmente la logica.

**Done when**: i cinque pulsanti sono osservabili in entrambi i tipi di thread e il reminder manuale è autorizzato, sicuro e testato.

### Slice 2: Un admin configura la categoria Discord destinata ai canali vocali evento

**Value**: l’admin decide dove vengono creati i vocali senza modificare variabili d’ambiente o codice.

**Actor**: admin con accesso alle impostazioni Discord.

**Trigger**: salvataggio del nuovo campo nella pagina admin.

**Observable outcome**: dopo il salvataggio e reload, l’ID categoria è restituito dal backend e letto dal bot; svuotare il campo disabilita la configurazione.

**Path**: admin Discord UI → `PUT /api/admin/settings` → singleton SeaORM → `GET /api/admin/settings` → bot `SettingsService`.

**Required implementation skills**: `tdd`, `testing`, `mutation-testing`, `refactoring`, `rust-guidelines` e guida frontend Angular/accessibilità pertinente.

**Acceptance criteria**: migration compatibile con installazioni esistenti, round-trip set/clear, formato snowflake validato, label/hint accessibili, cache settings del bot aggiornata secondo il comportamento esistente.

**RED**: test backend per set/clear/invalid e test frontend del draft/submit; test bot del mapping setting. Coprire mutanti su trim, clear, campo omesso e cache stale.

**GREEN**: aggiungere migration, entity/DTO/service, modello/UI admin, traduzioni e accessor nel bot.

**MUTATE**: eseguire mutation testing sulla normalizzazione e sul mapping del nuovo campo.

**KILL MUTANTS**: casi campo assente, stringa vuota, whitespace, snowflake troppo corto e valore valido.

**REFACTOR**: riusare la normalizzazione degli altri channel IDs senza introdurre un framework di settings nuovo.

**Done when**: la categoria vocale è configurabile end-to-end e il bot può leggerla.

### Slice 3: Start crea e persiste un canale vocale e richiama gli iscritti nel thread

**Value**: l’officer avvia l’evento da Discord e gli iscritti ricevono immediatamente sia il ping sia il punto di ritrovo vocale.

**Actor**: officer/admin con `events.manage`; partecipanti iscritti come destinatari.

**Trigger**: click su Start oppure `/event-start`.

**Observable outcome**: l’evento diventa live, compare un solo vocale nella categoria configurata, la card si aggiorna e il thread riceve mention degli iscritti più `<#voice-channel>`.

**Path**: Start interaction → verifica setting/stato → lifecycle backend start → Discord guild channel create → endpoint binding channel/evento → fetch dettaglio/roster → update card → start notice con allowed mentions. Retry su evento live senza binding completa il percorso; failure di binding attiva cleanup compensativo.

**Required implementation skills**: `tdd`, `testing`, `mutation-testing`, `refactoring`, `rust-guidelines`.

**Acceptance criteria**: persistenza migration-safe, permission e stato, categoria mancante rifiutata prima dello start, nome canale valido e collision-safe, partecipanti linked deduplicati, unlinked elencati, retry senza duplicati, slash e button condividono il servizio.

**RED**: test backend per binding/overwrite/stato e serializzazione; test bot con adapter Discord mockato per ordine delle operazioni, creazione canale, payload mention, retry e compensazione. Coprire mutanti su ordine start/create/bind, controllo channel esistente, filtro `discord_id`, dedup e allowed mentions.

**GREEN**: aggiungere campo evento e binding API, un `EventLifecycleDiscordService` nel bot, creazione GuildVoice, renderer start notice e aggiornamento completo embed/components.

**MUTATE**: eseguire mutation testing sui guard di idempotenza, mapping partecipanti e branch di compensazione.

**KILL MUTANTS**: casi zero partecipanti, duplicati, account non collegato, evento già live senza canale, evento già live con canale, create fallita e bind fallito.

**REFACTOR**: far usare lo stesso servizio a pulsante e slash command; mantenere Discord SDK dietro un adapter testabile solo se riduce davvero i mock fragili.

**Done when**: Start è un flusso end-to-end recuperabile, crea una sola risorsa Discord e informa correttamente tutti gli iscritti raggiungibili.

### Slice 4: Stop chiude l’evento e rimuove in sicurezza il vocale vuoto

**Value**: l’officer termina l’evento da Discord senza lasciare vocali vuoti né interrompere utenti ancora presenti.

**Actor**: officer/admin con `events.manage`.

**Trigger**: click su Stop oppure `/event-stop`.

**Observable outcome**: l’evento diventa stopped e la card si aggiorna; il vocale vuoto viene eliminato, quello occupato viene conservato con feedback esplicito.

**Path**: Stop interaction → lifecycle backend stop → resolve persisted channel → inspect voice members → conditional Discord delete → clear binding se eliminato/assente → update card → ephemeral outcome.

**Required implementation skills**: `tdd`, `testing`, `mutation-testing`, `refactoring`, `rust-guidelines`.

**Acceptance criteria**: solo live può essere fermato dal primo tentativo, stop/backend idempotente per retry cleanup, canale vuoto eliminato, occupato preservato, assente accettato, binding cleared solo quando cleanup concluso, slash/button condivisi.

**RED**: test bot per empty/occupied/missing/Discord forbidden e test backend per clear autorizzato/idempotente; coprire mutanti su `members.size === 0`, ordine stop/delete/clear e branch canale assente.

**GREEN**: estendere il servizio lifecycle con stop e cleanup condizionale, aggiornare handler e slash command, rigenerare components in stato stopped.

**MUTATE**: eseguire mutation testing sui branch di cleanup e sui guard di stato.

**KILL MUTANTS**: aggiungere casi un membro presente, zero membri, ID stale, clear fallito dopo delete e secondo tentativo.

**REFACTOR**: unificare la formattazione degli esiti parziali senza nascondere i dettagli operativi utili.

**Done when**: Stop non elimina mai un vocale occupato, pulisce quello vuoto e lascia stato/backend/card coerenti.

## Failure modes e osservabilità

- Log strutturati con `event_id`, `interaction_user_id`, `discord_voice_channel_id` e fase (`authorize`, `transition`, `create`, `bind`, `notify`, `delete`, `clear`).
- Le risposte ephemeral non devono dire genericamente “failed” quando la transizione backend è già avvenuta: devono indicare cosa è riuscito e cosa può essere ritentato.
- Missing Access/Permissions di Discord deve suggerire i permessi bot necessari e non essere interpretato come errore di autorizzazione applicativa dell’officer.
- Gli endpoint backend di remind/bind/clear devono produrre audit entry con actor e event ID.
- I custom ID devono validare event ID numerico positivo; payload manipolati non bypassano mai il backend.

## Out of scope

- Creare un vocale diverso per ogni party/build.
- Spostare automaticamente gli utenti nel vocale.
- Eliminare forzatamente un canale occupato o disconnettere membri allo Stop.
- Cooldown, scheduling multiplo o template personalizzati per il pulsante Ping.
- Modificare i ruoli Discord dell’evento dopo la creazione.
- Mettere i pulsanti nel messaggio principale del canale eventi/CTA.
- Cleanup automatico differito quando l’ultimo utente lascia un vocale che era occupato al momento dello Stop.

## Pre-PR Quality Gate

Prima di ogni PR/slice:

1. Mutation testing e report dei mutanti sopravvissuti.
2. Refactoring assessment.
3. Backend: `cargo fmt`, `cargo clippy` e test mirati, poi suite disponibile.
4. Bot: test mirati, `npm run type-check` e `npm run build`.
5. Frontend quando toccato: test mirati, typecheck/lint/build previsti dal workspace.
6. Verifica payload Discord: nessun `everyone`, ruolo o user parse generico; liste allowed mentions esatte.
7. Verifica manuale in guild di test dei permessi bot per creare/eliminare canali nella categoria configurata.
8. Presentare lavoro e mutation report; attendere approvazione umana prima di qualsiasi commit.

---
*Quando tutte le slice sono complete, eliminare questo file. Se `plans/` resta vuota, eliminare anche la directory.*
