# Plan: Ruoli Discord pingati per evento

**Branch**: `feat/event-discord-role-pings`
**Status**: Active — implementation complete; backend tests blocked by pre-existing fixtures

## Goal

Permettere a chi crea un evento di selezionare uno o più ruoli Discord e pubblicare l’annuncio nel formato `|| @Role1 @Role2 @Role3 ||`, usando esclusivamente i ruoli selezionati.

## Interpretazione confermata

Il comportamento da modificare è il mention attualmente generato dentro il blocco spoiler dell’annuncio evento:

```text
|| @Weak ||
```

Dovrà diventare:

```text
|| @Role1 @Role2 @Role3 ||
```

I ruoli sono ruoli Discord reali, non i ruoli applicativi come `Admin`, `Officer` o `User`.

## UI proposta

```text
┌────────────────────────────── Crea nuovo evento ──────────────────────────────┐
│                                                                              │
│  Nome                                                                        │
│  ┌────────────────────────────────────────────────────────────────────────┐  │
│  │ ZvZ Castle Fight                                                        │  │
│  └────────────────────────────────────────────────────────────────────────┘  │
│                                                                              │
│  Composizione                              Data                             │
│  ┌──────────────────────────────┐          ┌─────────────────────────────┐  │
│  │ Main ZvZ                  ▾  │          │ 31/08/2026 20:00            │  │
│  └──────────────────────────────┘          └─────────────────────────────┘  │
│                                                                              │
│  Ruoli Discord da pingare                                      3 selezionati │
│  Seleziona uno o più ruoli per l’annuncio dell’evento.                       │
│                                                                              │
│  ┌────────────────────────────────────────────────────────────────────────┐  │
│  │ Cerca un ruolo...                                                     🔍 │  │
│  ├────────────────────────────────────────────────────────────────────────┤  │
│  │ [x] @ZvZ                                                               │  │
│  │ [x] @CTA                                                               │  │
│  │ [x] @Regears                                                           │  │
│  │ [ ] @Gatherers                                                         │  │
│  │ [ ] @Officers                                                          │  │
│  └────────────────────────────────────────────────────────────────────────┘  │
│                                                                              │
│  Selezionati:  [ @ZvZ × ]  [ @CTA × ]  [ @Regears × ]                       │
│                                                                              │
│                                                    [Annulla]  [Crea evento]  │
└──────────────────────────────────────────────────────────────────────────────┘
```

La lista deve essere navigabile da tastiera, avere label/descrizione accessibili e distinguere caricamento, errore, lista vuota e selezioni già effettuate.

## Product decisions proposte

1. La selezione è **multi-select** e accetta zero o più ruoli Discord.
2. Sono selezionabili solo ruoli non gestiti da Discord; `@everyone` e ruoli integration/bot non vengono mostrati.
3. I ruoli selezionati sostituiscono `@Weak` **solo nel blocco spoiler dell’annuncio evento** generato da `build_event_announcement_content`.
4. L’annuncio Call to Arms che riusa lo stesso renderer usa gli stessi ruoli dell’evento.
5. I messaggi separati di reminder a un’ora e di avvio evento restano fuori da questa modifica e continuano a usare il ruolo globale configurato, salvo estensione futura.
6. Proposta di sicurezza: se non viene selezionato alcun ruolo, lo spoiler non contiene mention e Discord riceve `allowedMentions: { parse: [] }`; non viene fatto fallback automatico a `@Weak`.
7. Il comando Discord `/event-create` resta invariato nella prima versione; la selezione dei ruoli riguarda il form web di creazione evento.

## Acceptance Criteria

- [ ] Un utente con `events.manage` vede nel form “Crea nuovo evento” una selezione multipla dei ruoli Discord disponibili.
- [ ] Il form mostra nome dei ruoli e mantiene gli ID Discord come valore tecnico, senza chiedere all’utente di copiare snowflake manualmente.
- [ ] Un evento creato con un ruolo produce nello spoiler dell’annuncio `|| @Role1 ||` e consente il mention solo di quell’ID.
- [ ] Un evento creato con più ruoli produce un unico spoiler con tutti i mention, per esempio `|| @Role1 @Role2 @Role3 ||`, senza duplicati.
- [ ] L’ordine dei mention è stabile e coerente con l’ordine restituito/selezionato dalla UI.
- [ ] Un payload modificato manualmente non può salvare ID vuoti, duplicati, non numerici o ruoli Discord gestiti/non appartenenti al catalogo ammesso.
- [ ] Se nessun ruolo è selezionato, l’annuncio non ping-a `@Weak` né altri ruoli e usa `allowedMentions: { parse: [] }`.
- [ ] L’annuncio Call to Arms, quando presente, usa la stessa lista per-evento e non ricade sul singolo ruolo globale.
- [ ] Gli eventi esistenti continuano a funzionare senza migrazione manuale: per loro la lista è vuota e non viene introdotta una mention non prevista.
- [ ] Loading, errore del catalogo ruoli, catalogo vuoto, selezione/deselezione, submit e risposta server sono coperti nella UI.
- [ ] Backend, bot e frontend superano test, typecheck/build e lint già previsti dal progetto.

## Data and API shape

Aggiungere una relazione ordinata tra evento e ruolo Discord, con vincolo univoco su `(event_id, discord_role_id)`:

- `event_discord_roles.event_id`
- `event_discord_roles.discord_role_id`
- `event_discord_roles.sort_order`
- timestamp/metadati solo se richiesti dai pattern esistenti

Estendere il contratto di creazione:

```text
CreateEventRequest.discord_role_ids: string[]
```

Estendere `EventView` con la lista degli ID in ordine stabile:

```text
EventView.discord_role_ids: string[]
```

Aggiungere un endpoint read-only per il catalogo usato dal form, protetto da `events.manage`, così un Officer che può creare eventi non deve necessariamente avere `roles.manage`:

```text
GET /api/events/discord-roles
```

Il backend deve filtrare `@everyone`/ruoli gestiti e validare nuovamente gli ID ricevuti, senza fidarsi della UI. Il catalogo può riusare il client Discord e il DTO `DiscordRoleView` già esistente nell’area admin.

## Slices

Every slice follows RED-GREEN-MUTATE-KILL MUTANTS-REFACTOR. Before implementation, load `tdd`, `testing`, `mutation-testing`, `refactoring`, `rust-guidelines`, and the Angular guidance relevant to the slice. Acceptance criteria for the slice must be confirmed before production code is written.

### Slice 1: Un evento può salvare e restituire un singolo ruolo Discord selezionato

**Value**: un officer può creare un evento assegnandogli un ruolo specifico, e il contratto prodotto conserva il dato che il bot dovrà pingare.

**Actor**: officer/admin con `events.manage`.

**Trigger**: invio del form di creazione evento con un ruolo selezionato.

**Observable outcome**: la risposta dell’API contiene `discord_role_ids: ["<role-id>"]` e il dettaglio dell’evento restituisce lo stesso valore.

**Path**: form web → `POST /api/events` → validazione/relazione SeaORM → `EventView` → dettaglio evento. In questa slice il bot può ancora usare il renderer legacy; si completa prima il percorso di persistenza reale.

**Acceptance criteria**: migration applicata a database nuovo, evento creato con un solo role ID valido, evento esistente senza righe relazione restituito con lista vuota, duplicato rifiutato o normalizzato in modo deterministico, permesso insufficiente rifiutato.

**RED**: test backend per creazione, caricamento e validazione della relazione; test del DTO TypeScript per il nuovo contratto; includere mutanti probabili su lista vuota, deduplicazione, ordine e filtro permission.

**GREEN**: migration, entity/relation, request/view model, query di caricamento e wiring minimo nel create flow. Nessuna modifica ancora alla UI estetica oltre al campo tecnico necessario.

**MUTATE**: eseguire mutation testing su validazione ID, ordine, vincolo univoco e mapping della lista.

**KILL MUTANTS**: aggiungere casi per ID vuoto, formato non numerico, duplicato, evento legacy e role ID scambiato tra eventi.

**REFACTOR**: centralizzare solo il mapping relazione → `Vec<String>` se viene usato da più query.

**Done when**: il contratto backend persiste e restituisce correttamente un ruolo senza rompere gli eventi esistenti.

### Slice 2: L’annuncio usa tutti i ruoli dell’evento nello spoiler

**Value**: chi riceve Discord vede e può essere pingato da tutti i ruoli scelti, in un singolo blocco `|| ... ||`.

**Actor**: membri Discord destinatari dell’annuncio.

**Trigger**: poller rileva un nuovo evento oppure il backend pubblica un annuncio Call to Arms.

**Observable outcome**: il contenuto è `|| @Role1 @Role2 @Role3 ||` e `allowedMentions.roles` contiene esattamente gli stessi ID, senza `parse` generico.

**Path**: `EventView.discord_role_ids` → `buildEventAnnouncementContent`/renderer backend → messaggio Discord con `allowedMentions` espliciti. Il ruolo globale non viene usato per il blocco spoiler degli eventi con il nuovo contratto.

**Acceptance criteria**: uno, più ruoli e lista vuota producono rispettivamente un mention, mention concatenati e nessun mention; nessun ID appare nel testo senza essere presente in `allowedMentions.roles`; il renderer non genera `@Weak` quando la lista è vuota.

**RED**: test unitari del renderer frontend/backend/bot per formato esatto, trimming, ordine, duplicati, lista vuota e `allowedMentions`; test di integrazione del poller e del percorso CTA.

**GREEN**: sostituire il parametro singolo `eventRoleId` con una lista nel bot e nel backend, aggiornare i tipi condivisi e il payload Discord.

**MUTATE**: eseguire mutation testing su `join`, filtro lista vuota, deduplicazione, associazione testo/allowed mentions e fallback legacy.

**KILL MUTANTS**: coprire ordine alterato, un solo elemento, tre elementi, ID duplicato, ruolo non autorizzato e mention accidentale tramite `parse: ["roles"]`.

**REFACTOR**: avere una sola funzione condivisa per costruire mention e `allowedMentions` per il bot; non duplicare la logica tra poller e CTA se il codicebase lo consente.

**Done when**: un annuncio reale usa soltanto i ruoli dell’evento e il comportamento di mention è verificato senza ping generici.

### Slice 3: Il form web permette di consultare e selezionare più ruoli

**Value**: l’organizzatore completa il requisito senza copiare ID Discord e può verificare visivamente cosa verrà pingato.

**Actor**: officer/admin che apre “Crea nuovo evento”.

**Trigger**: apertura del dialog e selezione/deselezione dei ruoli.

**Observable outcome**: il form carica i ruoli, mostra le selezioni come chip/checkbox, invia `discord_role_ids` e dopo il salvataggio l’annuncio usa i ruoli scelti.

**Path**: apertura dialog → `GET /api/events/discord-roles` → lista filtrata → stato signal della selezione → `POST /api/events` → chiusura/navigazione come oggi → poller/CTA.

**Acceptance criteria**: loading e errore sono leggibili, la lista esclude ruoli non selezionabili, ricerca e selezione multipla funzionano, le deselezioni arrivano al backend, il reset del dialog non conserva ruoli dell’evento precedente, il submit resta disabilitato durante il salvataggio e focus/label/keyboard sono accessibili.

**RED**: test Angular/browser-level del dialog per caricamento, selezione multipla, ricerca, reset, errore e submit; test axe/focus per il controllo multi-select.

**GREEN**: aggiungere modello `DiscordRoleView`, stato locale con signals, caricamento catalogo, UI ASCII tradotta nei componenti esistenti e inclusione degli ID nella request.

**MUTATE**: eseguire mutation testing su toggle selezione, filtro ricerca, reset, conversione ID e stato loading/saving.

**KILL MUTANTS**: testare selezione di due ruoli, click ripetuto, ruolo non presente nel catalogo, lista vuota, errore API e submit doppio.

**REFACTOR**: estrarre un componente multi-select solo se il controllo ha una seconda reale riutilizzazione; mantenere il form evento piccolo.

**Done when**: un officer può aprire il form, selezionare `Role1`, `Role2`, `Role3`, creare l’evento e osservare l’annuncio con i tre mention.

## Out of scope della prima versione

- Modifica dei ruoli pingati dopo la creazione dell’evento.
- Selezione ruoli nel comando slash Discord `/event-create`.
- Sostituzione del ruolo globale nei reminder a un’ora e nei messaggi `/event-start`.
- Nuova gestione amministrativa dei ruoli Discord: viene riusato il catalogo già disponibile tramite bot/backend.

## Pre-PR Quality Gate

1. Mutation testing per ogni slice e report dei mutanti sopravvissuti.
2. Refactoring assessment.
3. Backend `cargo fmt`, `cargo clippy` e test.
4. Frontend typecheck, lint, build e test/browser checks disponibili.
5. Bot typecheck/build/test.
6. Verifica manuale del payload Discord: mention espliciti e nessun `allowedMentions.parse` generico.

---
*Quando il lavoro sarà completo, eliminare questo file. Se `plans/` resta vuota, eliminare anche la directory.*
