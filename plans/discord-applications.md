# Plan: Sistema Discord per le Application

**Branch**: `feat/discord-applications`
**Status**: Slice 1 implemented — awaiting commit approval; Slices 2–4 pending

## Goal

Un membro può aprire una sola application attiva da una card Discord configurabile; il bot crea un canale privato, permette agli officer di accettare o rifiutare la richiesta, archivia il canale secondo configurazione e comunica chiaramente quando le application sono aperte o chiuse.

## Decisioni e assunzioni da confermare

1. **Una application attiva per utente**: dopo `Accept` o `Decline`, il canale viene archiviato e l'application non è più attiva; l'utente potrà aprirne una nuova. Lo storico resta persistito.
2. **Ruolo di gestione**: il ruolo configurato è il solo ruolo operativo autorizzato a usare `Manage`, oltre agli eventuali amministratori/permission già riconosciuti dal gestionale. Il ruolo non viene assegnato automaticamente all'application.
3. **Ruoli Accept**: `Accept` rimuove il ruolo AutoRole già configurato (`discord_auto_role_id`) e assegna il ruolo di default del gestionale, identificato dalla configurazione ruoli con `is_default = true`. Se la configurazione manca, l'azione viene rifiutata senza archiviare parzialmente il canale.
4. **Decline**: non modifica i ruoli dell'utente, ma chiude il workflow e archivia il canale come `declined`.
5. **Card di apertura**: il messaggio/card viene pubblicato in un canale configurabile dal pannello Admin → Discord; se il canale non è configurato, il bot non tenta di pubblicare e mostra un errore operativo/loggabile.
6. **Messaggi personalizzabili**: titoli, descrizioni e testi dei messaggi della card, del benvenuto, dei permessi negati, dell'application chiusa, dell'accept/decline e degli aggiornamenti di stato sono impostazioni per-gilda. I pulsanti restano label configurabili solo se non compromettono la stabilità dei `custom_id`.

## Configurazione admin prevista

Aggiungere al pannello Discord e a `guild_settings` almeno:

- canale della card `Create Application`;
- categoria dei canali attivi;
- categoria Archive opzionale;
- ruolo che può gestire le application;
- stato globale application aperte/chiuse;
- canale per gli annunci di apertura/chiusura;
- titolo/testo della card di apertura;
- titolo/testo del messaggio di benvenuto;
- titolo/testo dei messaggi `Manage`, `Accept`, `Decline`, errori di permesso e application chiuse;
- titoli/testi degli annunci `@everyone` di apertura e chiusura.

Gli ID Discord devono usare la validazione/normalizzazione snowflake già presente; i testi devono avere limiti di lunghezza compatibili con Discord e valori di default retrocompatibili.

## Acceptance Criteria

- [ ] Un admin può configurare, salvare, ricaricare e cancellare gli ID di canale/categoria/ruolo richiesti dal pannello Discord.
- [ ] Un admin può modificare i titoli e i testi del workflow; i default sono usati quando un campo è vuoto/non ancora migrato.
- [ ] Un admin può aprire o chiudere le application dal pannello senza riavviare il bot.
- [ ] La card nel canale configurato mostra titolo, testo, stato `APERTE/CHIUSE` e bottone `Create Application`.
- [ ] Quando le application sono chiuse, il click non crea canali e restituisce all'utente il messaggio configurato di chiusura.
- [ ] Quando sono aperte, un click crea al massimo un canale attivo per utente, con nome deterministico `ticket-<username>` sanificato e limite Discord rispettato.
- [ ] Il canale attivo viene creato nella categoria configurata e vede soltanto l'utente, il ruolo gestore e il bot; `@everyone` non ha `ViewChannel`.
- [ ] Il canale contiene il messaggio di benvenuto configurato con i bottoni `Manage` e `Close`.
- [ ] `Manage` è utilizzabile soltanto dal ruolo/permesso autorizzato; gli altri ricevono una risposta ephemeral configurata e non vedono azioni di gestione.
- [ ] `Manage` mostra `Accept` e `Decline` senza duplicare messaggi in caso di click concorrenti o retry.
- [ ] `Decline` chiude l'application senza modificare ruoli e sposta il canale nella categoria Archive se configurata.
- [ ] `Accept` rimuove il ruolo automatico configurato e assegna il ruolo default del gestionale, in modo atomico dal punto di vista del workflow; errori parziali sono comunicati e non segnano falsamente l'application come accettata.
- [ ] Dopo Accept/Decline il canale non è più visibile all'utente e resta visibile soltanto a chi ha i permessi configurati/Discord appropriati.
- [ ] `Close` chiude l'application secondo lo stesso percorso sicuro di archiviazione, senza concedere privilegi di gestione all'utente.
- [ ] L'apertura/chiusura aggiorna la card e pubblica nel canale annunci configurato un messaggio con `@everyone`, testo configurato e mention controllata tramite `allowedMentions`.
- [ ] Il bot recupera le impostazioni aggiornate tramite la cache esistente e sopravvive a riavvii senza creare duplicati o perdere il legame application-canale.
- [ ] Migration backend, API, bot e frontend hanno test mirati; build, typecheck, lint e verifiche disponibili passano.

## Data model e API shape

### Guild settings

Estendere il singleton `guild_settings` con valori nullable/default-safe per gli ID, un booleano `discord_applications_open` e i testi configurabili. La migration deve lasciare funzionanti le installazioni esistenti con application chiuse e messaggi di default.

Possibili nomi (da allineare allo stile esistente):

```text
discord_applications_channel_id: Option<String>
discord_applications_category_id: Option<String>
discord_applications_archive_category_id: Option<String>
discord_applications_manage_role_id: Option<String>
discord_applications_status_channel_id: Option<String>
discord_applications_open: bool
discord_applications_panel_title: String
discord_applications_panel_message: String
discord_applications_welcome_title: String
discord_applications_welcome_message: String
discord_applications_manage_title: String
discord_applications_manage_message: String
discord_applications_closed_message: String
discord_applications_no_permission_message: String
discord_applications_accept_message: String
discord_applications_decline_message: String
discord_applications_status_open_message: String
discord_applications_status_closed_message: String
```

### Application persistence

Aggiungere una tabella `discord_applications` per rendere il limite di una application attiva e il recovery dopo riavvio deterministici:

```text
id
user_discord_id
user_id nullable
username_snapshot
channel_id
status: open | accepted | declined | closed
created_at
resolved_at nullable
resolved_by_discord_id nullable
```

Creare un vincolo/indice che impedisca due record attivi (`open`) per lo stesso `user_discord_id`; gli aggiornamenti di stato devono essere condizionati allo stato atteso per evitare doppie accettazioni.

### API

Riutilizzare il prefisso bot-auth esistente e i permessi backend già presenti. La forma esatta seguirà i router/service esistenti, con contratti equivalenti a:

```text
GET  /api/admin/settings
PUT  /api/admin/settings
GET  /api/applications/config
POST /api/applications
GET  /api/applications/active?discord_id=...
POST /api/applications/{id}/manage
POST /api/applications/{id}/accept
POST /api/applications/{id}/decline
POST /api/applications/{id}/close
```

Il backend deve essere la fonte di verità per open/closed, unicità, autorizzazione e stato; il bot resta responsabile delle operazioni Discord e dei ruoli/channel overwrite, con compensazione e messaggi operativi in caso di errore.

## Slices

Ogni slice segue RED-GREEN-MUTATE-KILL MUTANTS-REFACTOR. Prima del codice caricare `tdd`, `testing`, `mutation-testing`, `refactoring`, `rust-guidelines` e, per la UI, la guida frontend/accessibilità pertinente. I criteri della singola slice devono essere presentati e approvati prima di modificare il codice applicativo.

### Slice 1: Un admin configura il workflow e vede la card con stato application ✅

**Value**: l'admin può predisporre il sistema e i membri vedono una card coerente che comunica se le application sono aperte.

**Actor**: admin e membro Discord.

**Trigger**: salvataggio impostazioni admin; pubblicazione/refresh della card.

**Observable outcome**: il pannello salva ID, stato e testi; il bot pubblica/aggiorna la card nel canale configurato con stato aperto/chiuso e bottone stabile.

**Path**: Admin UI → API settings → migration/entity/service → SettingsService → renderer card → Discord channel.

**Acceptance criteria**: round-trip set/clear, validazione ID, testi con default/limiti, open/closed nella card, refresh senza restart.

**RED**: test backend per DTO/service/migration mapping, test frontend per draft/submit, test bot per renderer e cache. Coprire mutanti su trim, booleano invertito, default e stato card.

**GREEN**: aggiungere campi settings, API/UI e renderer/card publisher minimo.

**MUTATE**: mutation testing sui normalizer e renderer stato.

**KILL MUTANTS**: casi campo assente/vuoto, ID invalido, stato chiuso e messaggi multilinea.

**REFACTOR**: riusare i componenti/input pattern di `AdminDiscord` senza nuovo framework di configurazione.

**Done when**: l'admin configura la card e l'utente può distinguere application aperte e chiuse prima di poter creare canali.

### Slice 2: Un membro apre una sola application in un canale privato

**Value**: un membro può presentare la richiesta e solo i destinatari corretti possono leggerla.

**Actor**: membro Discord.

**Trigger**: click `Create Application`.

**Observable outcome**: application aperta → record persistito → canale creato nella categoria → overwrite privati → messaggio welcome con `Manage`/`Close`.

**Path**: button handler → backend create/idempotency → Discord channel create → application channel binding → welcome message.

**Acceptance criteria**: application chiusa rifiutata, una sola active per utente, nome sanificato, categoria obbligatoria, overwrite utente/ruolo/bot, nessun accesso `@everyone`, retry senza duplicato.

**RED**: test backend per unicità/stato e test bot con adapter Discord mockato per ordine create/bind/overwrite/send e cleanup compensativo.

**GREEN**: implementare tabella/API create, renderer welcome, factory canale e handler bottone.

**MUTATE**: mutation testing su guard open/closed, indice active, overwrite e cleanup.

**KILL MUTANTS**: doppio click concorrente, username con caratteri invalidi, categoria mancante, create/bind falliti.

**REFACTOR**: estrarre un adapter Discord applicazioni soltanto se riduce duplicazione reale con i flussi esistenti.

**Done when**: un membro apre una application privata e non può aprirne due attive.

### Slice 3: Un gestore accetta o rifiuta e l'application viene archiviata

**Value**: gli officer possono decidere la richiesta e il canale esce dall'area privata attiva.

**Actor**: gestore autorizzato; utente destinatario dell'esito.

**Trigger**: `Manage` → `Accept`/`Decline`, oppure `Close`.

**Observable outcome**: permission check → decisione persistita → eventuale cambio ruoli → overwrite archivio → spostamento categoria → messaggio finale configurato.

**Path**: interaction → backend conditional transition → Discord role operations/permission overwrites → move channel → final response/card update.

**Acceptance criteria**: unauthorized ephemeral, decline senza ruoli, accept rimuove auto role e assegna default role, doppio click idempotente, canale archive-only, archive category opzionale con fallback sicuro.

**RED**: test backend per autorizzazione/transizioni e test bot per permission, ordine ruoli, branch archive/no archive, errori parziali e retry.

**GREEN**: implementare manage/accept/decline/close e orchestratore condiviso.

**MUTATE**: mutation testing su permessi, stati terminali, ruolo accept e visibilità utente.

**KILL MUTANTS**: utente non autorizzato, application già risolta, ruolo mancante, ruolo bot troppo basso, archive non configurato e canale inesistente.

**REFACTOR**: centralizzare `resolveApplication` per evitare che `Close`, `Decline` e `Accept` divergano.

**Done when**: il workflow termina senza lasciare application falsamente aperte o canali visibili all'utente.

### Slice 4: L'admin apre/chiude le application e il bot annuncia ogni cambio

**Value**: la gilda controlla la disponibilità del recruiting e tutti ricevono un avviso chiaro.

**Actor**: admin e membri della gilda.

**Trigger**: toggle nel pannello admin.

**Observable outcome**: il toggle aggiorna la card e pubblica nel canale configurato un embed/messaggio con `@everyone`, testo corretto e mention controllata.

**Path**: Admin UI toggle → API setting → bot settings refresh/event trigger → panel updater → status channel announcement.

**Acceptance criteria**: apertura e chiusura, canale status mancante gestito, no duplicate announcements su save identico, allowed mentions limitate a everyone, card coerente dopo refresh/restart.

**RED**: test API/UI toggle, test bot per edge transition e payload mentions.

**GREEN**: aggiungere endpoint/azione di toggle, sincronizzazione card e annunci.

**MUTATE**: mutation testing su edge transition, dedup e `allowedMentions`.

**KILL MUTANTS**: true→false, false→true, salvataggio senza cambio, channel non configurato e retry.

**REFACTOR**: riusare il publisher/renderer della card della Slice 1.

**Done when**: l'admin può governare l'apertura delle application e la gilda riceve ogni cambio.

## Pre-PR Quality Gate

1. Mutation testing per ogni slice e report revisionato.
2. Refactoring assessment.
3. `cargo fmt --check`, `cargo clippy`, test backend.
4. `npm run type-check`, `npm test` nel bot e test/build frontend.
5. Verifica manuale in un guild Discord di permessi, categorie, ruolo, retry e mention.

---

*Il piano va mantenuto aggiornato; non iniziare il codice applicativo finché l'utente non approva i criteri della slice da implementare.*
