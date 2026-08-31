# Plan: Collegamento globale Albion e Ruolo Gilda base Discord

**Branch**: `feat/discord-albion-global-link-guild-role`  
**Status**: Proposed

## Goal

Un utente Discord può collegare il proprio personaggio cercandolo nell’intero database Albion; il nickname Discord viene sincronizzato al nome Albion e il Ruolo Gilda base configurato viene assegnato solo se il personaggio appartiene alla gilda configurata, senza escludere gli esterni da split e balance.

## Decisioni confermate

- L’attuale AutoRole viene **sostituita semanticamente** dal **Ruolo Gilda base**: non viene più assegnato al semplice ingresso nel server Discord.
- Il ruolo viene assegnato solo dopo un collegamento Albion riuscito e una verifica live che il personaggio è nella gilda configurata (`ALBION_GUILD_ID`).
- Un personaggio esterno può essere collegato normalmente, ottenere un record utente/link e quindi partecipare agli split e alle operazioni di balance, ma non riceve il Ruolo Gilda base.
- Il nickname Discord continua a essere una sincronizzazione best-effort: il link non fallisce se Discord rifiuta la modifica per permessi, gerarchia dei ruoli o indisponibilità. Il nome Albion è copiato senza alterazioni, entro il limite Discord di 32 caratteri.
- Il ruolo non viene rimosso automaticamente se il giocatore lascia la gilda Albion dopo il collegamento o se effettua unlink. Questa automazione non è richiesta e richiederebbe una policy separata per non rimuovere ruoli concessi manualmente.

## Stato attuale rilevato

- `POST /api/albion/link` e l’interfaccia in `apps/frontend/src/app/features/settings/settings.ts` usano il roster della gilda e quindi rifiutano tutti gli esterni.
- `GET /api/albion/search` supporta già la ricerca globale e restituisce i giocatori con ID e dati di gilda.
- Il backend sincronizza già il nickname in `apps/backend/src/modules/albion/discord_nick.rs` dopo un link, ma solo per giocatori del roster.
- La configurazione persistente `discord_auto_role_id`, l’admin UI e il listener `GuildMemberAdd` esistono già. Il listener assegna ora il ruolo indiscriminatamente e deve essere rimosso/sostituito nel flusso di link.

## Acceptance Criteria

- [ ] In Impostazioni, un utente non collegato cerca e seleziona un player tramite la ricerca Albion globale, non più soltanto tramite il roster della gilda.
- [ ] Il backend non si fida dei dati di gilda inviati dal browser: recupera il profilo live del player selezionato e confronta il suo `guild_id` con `ALBION_GUILD_ID`.
- [ ] Un player esterno alla gilda viene collegato con gli stessi vincoli 1:1 già esistenti; il suo Discord nickname è sincronizzato e non gli viene assegnato il Ruolo Gilda base.
- [ ] Un player nella gilda viene collegato, riceve il nickname Albion e, se configurato e assegnabile, il Ruolo Gilda base.
- [ ] Gli amministratori autorizzati possono scegliere o disabilitare il Ruolo Gilda base da Admin → Discord; l’attuale setting persistente viene riutilizzato e presentato con la nuova semantica.
- [ ] Il bot non assegna più il Ruolo Gilda base su `GuildMemberAdd`; un utente che entra nel Discord senza collegare un IGN non riceve tale ruolo.
- [ ] Ruolo assente, ruolo gestito/non assegnabile, bot senza `Manage Roles`, gerarchia insufficiente e API Discord non disponibile sono registrati senza annullare un collegamento valido.
- [ ] Rust backend test/check, TypeScript bot check e frontend test/typecheck/build rilevanti passano.

## Slices

Ogni slice segue **RED → GREEN → MUTATE → KILL MUTANTS → REFACTOR**. Prima di scrivere produzione vanno caricati `tdd`, `testing`, `mutation-testing`, `refactoring` e `rust-guidelines` per il backend Rust. I criteri della slice sono da presentare e confermare prima di iniziare il codice.

### Slice 1: L’amministratore configura il Ruolo Gilda base e nessun nuovo membro lo riceve al join

**Value**: gli amministratori controllano con chiarezza il ruolo riservato ai membri della gilda Albion, senza assegnarlo per errore agli esterni quando entrano nel Discord.

**Actor / Trigger / Outcome**: un amministratore apre Admin → Discord, seleziona o disabilita il Ruolo Gilda base; un utente entra nel server Discord senza effettuare il link; il valore resta persistito e il nuovo membro non riceve il ruolo.

**Path**: Admin Discord UI → endpoint/configurazione AutoRole esistente e `guild_settings.discord_auto_role_id` → Settings Service del bot; `GuildMemberAdd` non effettua più assegnazioni → log/runtime del bot.

**Smallest deployable value**: riusa setting, endpoint, permesso e selettore esistenti, rinominandoli nella UI/testi come “Ruolo Gilda base”; rimuove il listener e il servizio di assegnazione al join. Non introduce un secondo setting né una migrazione di dati.

**Required implementation skills**: `tdd`, `testing`, `mutation-testing`, `refactoring`, `modern-web-guidance` (prima di modifiche Angular), `rust-guidelines` se sono toccati contratti backend.

**Acceptance criteria**:

- l’admin con `autorole.manage` può selezionare, salvare e disabilitare un ruolo Discord assegnabile con il testo “Ruolo Gilda base”;
- il valore salvato continua a essere letto dal backend/bot tramite il setting esistente;
- dopo il deploy un `GuildMemberAdd` di un umano non aggiunge il ruolo configurato;
- bot, ruoli Discord mancanti e permessi esistenti non generano regressioni o crash.

**RED**: test UI per label/save/clear mantenendo il contratto API; test del bootstrap bot che prova che l’evento `GuildMemberAdd` non chiama più `assignAutoRole`. Coprire mutanti che reinseriscono il listener, scambiano ruolo disabilitato/configurato o assegnano ai bot.

**GREEN**: aggiornare nomenclatura e i18n dell’admin panel, conservare endpoint e setting per compatibilità; rimuovere il wiring `GuildMemberAdd` e il codice diventato inutilizzato.

**MUTATE**: eseguire mutation testing sui test bot/UI applicabili e produrre il report.

**KILL MUTANTS**: rafforzare i test su disabilitazione, utenti umani/bot e assenza dell’assegnazione al join.

**REFACTOR**: eliminare import e tipi morti; mantenere una sola fonte di verità per ID e nome del ruolo.

**Done when**: criteri soddisfatti, check backend/frontend/bot rilevanti verdi, report mutazioni revisionato e approvazione umana al commit.

### Slice 2: Un utente collega qualunque IGN Albion e gli esterni restano registrati senza ruolo di gilda

**Value**: giocatori esterni possono entrare nel gestionale e comparire nei flussi esistenti di split e balance senza fingere l’appartenenza alla gilda.

**Actor / Trigger / Outcome**: un Discord user non collegato cerca un IGN globale e conferma; riceve un link 1:1 persistente e nickname Discord, mentre il risultato segnala correttamente che non è un membro della gilda e non riceve il ruolo.

**Path**: dialog di collegamento in Settings → `GET /api/albion/search` → selezione `{id, name}` → `POST /api/albion/link` → fetch live `GET /players/{id}` dal backend → `albion_links` → nickname Discord best-effort → risposta link/status → consumatori esistenti di split/balance risolvono il link normalmente.

**Smallest deployable value**: sostituire nel dialog il picker roster con ricerca globale con query minima, risultati giocatore, stato loading/empty/error e selezione; mantenere vincoli DB 1:1 e usare il nome restituito dal profilo live, non il nome del client.

**Required implementation skills**: `tdd`, `testing`, `mutation-testing`, `refactoring`, `modern-web-guidance`, `rust-guidelines`.

**Acceptance criteria**:

- il dialog di link cerca player globalmente e non presenta risultati guild come candidati al collegamento;
- l’endpoint accetta un player esistente interno o esterno, rifiuta ID inesistente/upstream failure e mantiene i conflitti 1:1;
- per un player esterno salva ID, nome autorevole e Discord ID esattamente come per uno interno, quindi `GET /api/albion/link/me` restituisce `linked: true`;
- nickname viene invocato con il nome autorevole in entrambi i casi e un fallimento Discord non annulla il record;
- nessuna nuova restrizione impedisce ai servizi già basati su `albion_links` di identificare un esterno negli split o nel balance.

**RED**: test handler/service per player interno, esterno, inesistente, nome client falsificato e conflitti; test unitari del componente per search globale, debounce/submit o trigger esplicito coerente con l’UI esistente, empty/error e conferma del player; test nickname best-effort per entrambi i rami. Coprire mutanti su confronto ID, inversione membro/non-membro, persistenza del nome client e rollback improprio del link.

**GREEN**: cambiare la validazione server dal roster al fetch live del player; esplicitare/derivare lo stato `is_guild_member` internamente per la slice successiva; aggiornare il dialog e i tipi frontend al contratto di search/link globale.

**MUTATE**: eseguire mutation testing sui moduli di link e sui test frontend applicabili e produrre il report.

**KILL MUTANTS**: aggiungere test per confronto esatto dell’ID gilda, assenza di gilda, valori `null` e comportamento best-effort Discord.

**REFACTOR**: centralizzare la risoluzione autorevole del player, senza duplicare chiamate Albion o regole di appartenenza fra handler admin e self-service.

**Done when**: criteri soddisfatti, test/check mirati verdi, report mutazioni revisionato e approvazione umana al commit.

### Slice 3: Il Ruolo Gilda base viene assegnato soltanto quando il link verifica un membro della gilda

**Value**: i membri Albion della gilda ottengono automaticamente il ruolo Discord corretto al primo link, mentre gli esterni restano registrati senza privilegi di gilda.

**Actor / Trigger / Outcome**: un utente conferma il collegamento di un IGN; se il profilo live è nella gilda configurata, Discord aggiunge il Ruolo Gilda base configurato; se è esterno, non viene effettuata alcuna richiesta di assegnazione ruolo e il link resta valido.

**Path**: `POST /api/albion/link` (e, dopo decisione esplicita, eventuale endpoint admin di link) → fetch player/live membership → persistenza link → adapter Discord role assignment → risposta HTTP; configurazione ruolo da `guild_settings` → audit/log diagnostico.

**Smallest deployable value**: un adapter backend best-effort, vicino a `discord_nick`, legge il setting configurato e usa le API Discord per aggiungere un solo ruolo dopo un link self-service interno. L’assegnazione avviene dopo la persistenza per non bloccare il valore principale.

**Required implementation skills**: `tdd`, `testing`, `mutation-testing`, `refactoring`, `rust-guidelines`.

**Acceptance criteria**:

- con `guild_id == ALBION_GUILD_ID` e Ruolo Gilda base configurato, il backend richiede l’aggiunta di quel ruolo al membro Discord appena collegato;
- con guild differente, assente oppure Ruolo Gilda base disabilitato, non richiede l’assegnazione ma restituisce comunque il link riuscito;
- il ruolo viene aggiunto una sola volta/idempotentemente e Discord error, 403, 404, 429 o rete non trasformano il link in errore;
- log strutturati distinguono: ruolo disabilitato, player esterno, successo e fallimento Discord;
- l’assegnazione rispetta le limitazioni Discord (ruolo gestito, ruolo `@everyone`, `Manage Roles` e gerarchia) e documenta nell’UI/configurazione i permessi del bot necessari.

**RED**: test della decisione `should_assign_guild_role` per membro/esterno/nessuna gilda/setting vuoto; mock HTTP dell’adapter per endpoint, payload e insuccessi best-effort; test handler che dimostra ordine persistenza → side effect e che un errore del side effect non rollbacka. Coprire mutanti che assegnano agli esterni, confrontano `!=`, ignorano setting vuoto, eseguono side effect prima del DB o propagano l’errore Discord.

**GREEN**: implementare la decisione con il profilo live già risolto nella slice 2 e un adapter Discord riusabile, senza reintrodurre il listener di join. Aggiornare testi di aiuto per `Manage Roles` e gerarchia.

**MUTATE**: eseguire mutation testing sul servizio di decisione/adapter e produrre il report.

**KILL MUTANTS**: rafforzare le asserzioni su nessuna chiamata per esterni, idempotenza e preservazione del link in ogni errore Discord.

**REFACTOR**: estrarre il contratto comune delle side effect Discord (token/config, richiesta, log) solo se riduce la duplicazione con `discord_nick` senza mischiare la business rule.

**Done when**: criteri soddisfatti, backend/frontend/bot type-check/build e test pertinenti verdi, report mutazioni revisionato e approvazione umana al commit.

## Decisione esplicitamente rinviata

L’assegnazione ruolo per `POST /api/albion/link/users/{user_id}` (link amministrativo) va confermata prima della Slice 3. Il piano di default limita l’automatismo al **primo collegamento self-service**, esattamente come richiesto; aggiungerlo al link amministrativo è semplice, ma modifica un workflow privilegiato già esistente e merita una scelta separata.

## Pre-PR Quality Gate

Prima di ogni PR:

1. Mutation testing tramite skill `mutation-testing`, con report dei mutanti uccisi/sopravvissuti.
2. Refactoring assessment tramite skill `refactoring`.
3. Test backend Rust mirati, `cargo fmt --check`, Clippy/typecheck applicabili.
4. Test/typecheck/build frontend e `npm` typecheck/build del bot applicabili.
5. Controllo manuale in Discord con bot sotto il Ruolo Gilda base e permessi `Manage Nicknames` e `Manage Roles`.

---
*Eliminare questo file quando tutte le slice sono complete. Se `plans/` rimane vuota, eliminare la directory.*
