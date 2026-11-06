# Programma di refactor: Weaklings Manager

Scrivo "gilda/gilde" per i tenant di tipo guild e "alleanza" per quelli di tipo alliance. Gli id (alliance-N, events-N, ...) rimandano all'appendice. Dove più aree descrivono lo stesso difetto li ho accorpati, ad esempio alliance-4 = events-3, alliance-3 = events-4, events-1 = bot-arch-6, auth-17 = battles-6 = backend-perf-21.

---

## 1. Stato attuale

**Baseline di build/test (da sistemare prima di tutto)**
- Il backend ha 444 test su 1011 che falliscono. La causa è una sola: `migration/m20261028_000003_add_event_discord_delivery.rs` fa un `ALTER TABLE` con 5 `add_column` concatenati, che SQLite non supporta. Finché non si corregge, nessuna migrazione successiva è testabile.
- Altri problemi di baseline:
  - 13 doctest falliscono perché usano `errors`, che è `pub(crate)`.
  - Clippy con `clippy::all = deny` dà 115+ errori.
  - 4 spec frontend sono stantie o regredite (`dashboard.spec`, `register-tenant.spec`, `admin-alliance.spec`, `data-table.spec`).
  - 1 test del bot dipende da `FRONTEND_URL`.
- C'è anche un rischio di sicurezza nei test: l'helper Postgres ricade su `DATABASE_URL`, cioè sul DB di sviluppo. I test d'integrazione possono quindi creare e cancellare schemi su quel DB.

**Sync alleanza -> gilde (obiettivo 3)**
- Esistono quattro motori di copia indipendenti, ognuno con idempotenza, retry e stato propri:
  - `alliance_shares`, per gli snapshot manuali;
  - `event_fanout_*`, per alleanza -> gilda;
  - `event_mirror_requests`, per gilda -> alleanza;
  - la copia one-shot al `/register`, più la distribuzione degli split.
- Sono sincronizzati solo gli eventi. Tutto il resto (regear, warns, XP, ranks, settings, battle, ruoli) non ha alcun sync alleanza.
- Ogni job di update/start/stop su un evento di alleanza ricopia le build del comp, perché la mappa build è per `job_id` (alliance-1, comps-1). Il risultato è un di questi due, dipende da `resolve_created_by`, da verificare con un test:
  - build duplicate nelle gilde;
  - violazione dell'indice unico, con update che non arrivano più dopo la prima pubblicazione.
- Le alleanze non hanno worker di lifecycle (`starts_sync_workers('alliance') = false`):
  - niente auto-stop;
  - la copia in gilda, fermata localmente, viene riportata a `live` al successivo converge (alliance-3, events-4).
- Il bot sulle copie di eventi alleanza tenta ogni 60s di creare un canale vocale e avviare l'evento. Il backend risponde 403 (`assert_manageable_source_event`), il canale viene cancellato e il ciclo si ripete (alliance-4, events-3).
- Quasi tutto il resto del sync è non durabile o assente:
  - La partecipazione self-service viene sincronizzata inline, senza outbox, e restituisce errore dopo il commit locale (alliance-6, events-5).
  - Le azioni degli officer non sincronizzano nulla: aggiunta/rimozione partecipanti, seat, ruoli roster. Gli officer-added non hanno attribuzione di gilda, e questo blocca il pagamento dello split (alliance-5).
  - Entrare in un'alleanza non fa backfill di eventi, utenti, link o ruoli (alliance-11, auth-9).
  - Uscire lascia ghost event, share e ruoli. I retry delle revoche girano solo dentro la richiesta di leave, e l'alleanza non può espellere una gilda (alliance-12, auth-10).
  - Build, comp e split sono snapshot one-shot senza refresh né propagazione di delete/archive (alliance-9, comps-2, comps-10).
  - La distribuzione degli split alleanza non ha worker, UI né vista di stato, quindi un batch fallito è invisibile (alliance-13, finance-6).
  - Le battle non esistono per le alleanze. La gilda non conosce le gilde sorelle come "friendly" (battles-1).

**Sync Discord <-> backend**
- Tutto lo stato Discord vive in `poller-state-<guild>.json`, scritto in modo non atomico: cursori, thread, signup card, calendario. Se il file manca, il bot si re-inizializza e ingoia silenziosamente tutto ciò che è stato creato nel frattempo (bot-arch-1, events-2).
- Bug distruttivo del poller: oltre 50 ping a 1h, `eventThreadIds` viene filtrato sugli id pingati. Si perdono thread, sync del roster, chiusura e comandi nei thread (events-1, bot-arch-6).
- La scoperta di nuovi record riscansiona fino a 50 pagine di storico ogni minuto per ogni tenant. Se la scansione è incompleta i cursori non avanzano e le battle vengono ri-postate (bot-arch-2/3/4).
- Mass, start e promemoria a 1h guardano solo la pagina 1 di una lista ordinata per data decrescente. Con più di 50 eventi futuri non scattano più (bot-arch-5, events-12).
- Il lifecycle (mass/start/voice/auto-stop) è deciso dal bot. Start/stop dal web non hanno effetti Discord: niente voce, niente notice, la card resta "LIVE" (events-7, events-8).
- Le notifiche DM restano `pending` per sempre: non esiste nessun consumer (members-1, bot-arch-8).
- Il bot non gestisce `GuildMemberRemove`/`Update`/ruoli, quindi `users.role` resta quello dell'ultima visita web (auth-3, members-16).
- Il poller dell'alleanza probabilmente non si inizializza mai, perché `adoptCheckpointBaseline` fallisce senza scope Albion (bot-arch-10). Va verificato.

**Parità web/Discord (obiettivo 2)**
- Il bot rifiuta ogni comando, `/register` incluso, finché l'utente non ha fatto login sul sito (auth-2).
- Discord non ha:
  - gestione di comp/build (solo `/build` in lettura, nessun autocomplete);
  - regear, split (create/complete/close), siphoned;
  - azioni su ping_alliance, share/unshare, vista dello stato sync.
- Il web non ha: flash mass, remind, entrata nei giveaway, VOD, review delle application (che nemmeno il backend elenca).
- Due bug web rompono lo scenario alleanza:
  - la lista `participation-guilds` viene "unwrappata" due volte, quindi nessuno si iscrive a un evento alleanza dal sito (parity-1);
  - "collega split a evento" chiama `PUT /api/splits/{id}`, che non esiste (405, parity-2).
- Nessun client chiama `mirror-status`, `mirror-retry`, `fanout-status` o `distribution-status`. Lo stato del sync è invisibile (parity-5, frontend-1).
- Le regole sono duplicate nei client: net pool split, shares, selezione prelievi, autorità di gestione, allowlist comandi alleanza, GUILD_NAME.

**Performance (obiettivo "app lenta")**
- La cache del catalogo battle non viene mai usata, perché `for_scope` ricrea la cache a ogni richiesta e a ogni tick. Ogni lista fa fino a 20 pagine AlbionBB seriali, più i dettagli (backend-perf-1, battles-2).
- Il `GET /battles/{id}` esegue tutta la pipeline di persistenza (battles-4). Il bot e la UI lo moltiplicano.
- `/fights` e `/fights/trends` caricano tutte le righe e tutti i JSON per poi paginare in memoria (backend-perf-3).
- L'extractor di auth fa 3-4 query e una chiamata Discord per richiesta, senza cache negativa né timeout (backend-perf-4).
- L'audit blocca la richiesta su HTTP Discord, con un `Client::new()` per chiamata (members-7).
- Il battle linker può scorrere fino a 100 pagine AlbionBB per evento ogni 30s. Inoltre fa `updated_at = now()` a ogni tick, quindi ogni evento live viene ri-renderizzato su Discord a ogni poll (backend-perf-2, events-10, events-11).
- Altri colli di bottiglia:
  - `users/me/metrics` carica tutti gli eventi e tutti gli snapshot (members-5);
  - liste con N+1 su comps ed eventi (comps-5, backend-perf-11);
  - pool per tenant senza limiti, e `evict` che rilancia le migrazioni senza single-flight (backend-perf-7);
  - il frontend ha 394 fetch manuali senza cache, un bundle i18n eager da 760KB e SSR che renderizza solo la pagina di login (frontend-6/7/8).

**UI**
- Due design system sono impilati in `styles.css`: Discord e Zed, con `!important` sulle ombre. I font IBM Plex non vengono mai caricati. Il tema parte dark ma il CSS è light, quindi c'è un flash (frontend-11/12).
- Altri problemi:
  - componenti da oltre 2.000 righe (`event-detail` ne ha 6.230) con un ticker a 1s;
  - nessun titolo di route, contrasto basso, testo sotto i 12px, stringhe hardcoded in IT/EN;
  - 54 `select` e 27 `table` raw;
  - tenant switch su /dashboard che mostra i dati del tenant precedente;
  - nessun interceptor HTTP (frontend-3/9/15).

**Correttezza e sicurezza**
- Login: il fallback per email riassegna `discord_id` di un altro utente. L'email Discord non viene verificata (auth-1).
- Le membership dei tenant non vengono mai revocate, quindi un utente cacciato può rientrare con il ruolo di default (auth-4).
- Il link Albion non ha prova di proprietà e assegna ruoli di gilda e alleanza (auth-7).
- Le email di tutti sono esposte a ogni membro (auth-12, members-17).
- Il creatore di uno split può completarlo da solo, con fee e valore scelti da lui (finance-1).
- Il net pool dello split nel bot somma stringhe decimali, quindi il valore è sbagliato su ogni post (finance-2).
- Il sync del roster riscrive gli split già chiusi (finance-3). Gli split restano bloccati in `awaiting_event` se l'evento viene cancellato (finance-4).
- Race condition:
  - i crediti regear vengono spesi con read-modify-write senza lock (finance-7);
  - le GET `balance` e `transactions` riscrivono il ledger senza transazione (finance-11).
- `fights.rs` classifica il lato amico dall'env globale invece che dal tenant. I player id sono vuoti, quindi i rollup collassano tutti in una sola riga (battles-6/7).
- `AuditService::log` può andare in panic su un troncamento UTF-8 dopo che la mutazione è già stata committata (members-6).
- Il proprietario di un'alleanza non ha bypass né un Admin seedato (auth-6).

---

## 2. Matrice sync alleanza -> gilde

Nella colonna "Atteso" propongo un default. Le scelte aperte sono nelle domande di sezione 6.

| Entità | Oggi | Atteso (default proposto) | Gap |
|---|---|---|---|
| Evento create (A->G) | Outbox con retry e stato; copie con comp+build; elaborazione inline nella request | Come oggi, ma con worker asincrono, mapping stabile e tetto tentativi | alliance-1/2/16 |
| Evento update/lifecycle (A->G) | Job `update`/`archive`; ricopia le build a ogni job; converge non tocca comp, ruoli, battle; auto-stop locale e resurrezione a `live` | Converge completo (comp, ruoli roster, cap); le transizioni terminali non regrediscono; il lifecycle gira anche sulle alleanze | alliance-1/3, events-14 |
| Evento G->A | Solo se `ping_alliance`; mirror inline; update inline senza retry; nessun ritiro se il flag va a false | Stessa pipeline outbox, bidirezionale; ritiro del mirror; un solo annuncio Discord | alliance-8/10, events-18 |
| Auto-stop / start / voce | Nessun worker alleanza; 403 sulle copie, loop del bot ogni tick | Scheduler backend per ogni tipo di tenant; azioni tenant-local consentite sulle copie | alliance-3/4 |
| Iscrizione self-service | Sincrona, filtrata per attribuzione, senza retry, errore dopo il commit; peer non notificati via WebSocket | Outbox di partecipazione; successo locale sempre; stato peer visibile; `hub.publish` sui peer | alliance-6/17, events-5 |
| Partecipanti officer, seat, ruoli roster | Mai sincronizzati; nessuna attribuzione per aggiunte manuali; l'attribuzione non viene mai cancellata | Roster canonico sull'alleanza; propagazione verso le copie; attribuzione esplicita; cleanup alla rimozione | alliance-5/20, events-6 |
| Build / comp | Snapshot manuale G->A; nessun refresh, nessuna propagazione di delete/archive; nessun A->G (solo copia incidentale con l'evento) | Origin tracking (`origin_tenant/id/version`), refresh automatico dal proprietario, copie read-only | alliance-9, comps-2/10/17 |
| Split (struttura) | Snapshot una tantum alla creazione del mirror; poi diverge; secondo thread Discord | Refresh su create/complete/amend/close/archive; copia read-only | finance-5 |
| Split payout A->G | Solo manuale su `/complete`; nessun worker di resume; nessuna UI/bot; il batch blocca tutto | Worker di resume, pannello di stato web+bot, riga ledger con link allo split, audit, notifica, esclusa da `outflow_other` | alliance-13, finance-6/13 |
| Bank | Letture live e proxy su ledger gilde (read-through); N pagine seriali; il bot non gestisce il multi-guild | Read-through va bene; k-way merge concorrente; il backend risolve la gilda target | backend-perf-6, parity-4 |
| Utenti / link / ruoli Discord | Copia one-shot al `/register`, errori ignorati; nessun backfill; revoche ritentate solo nel leave | Job durevole con reconcile periodico; backfill all'accept; worker di revoca | alliance-14, auth-9/10 |
| Membership join / leave | Join: solo flip di stato. Leave: disabilita i link, resta tutto il resto; nessuna espulsione | Join: backfill (eventi, utenti, ruoli). Leave: archivia le copie future, scollega le share. Expel dall'alleanza | alliance-11/12 |
| Battle / fights / intel | Nessun dato alleanza; lato amico solo da CSV manuale | Lettura aggregata dalle gilde membro; friendly = gilde attive dell'alleanza | battles-1 |
| Regear, warns, XP, ranks, settings, VOD, trials, applications, giveaway | Nessun sync | Decisione per dominio (domanda 1); default: guild-private | alliance-18 |
| Stato / retry del sync | Endpoint esistenti, nessuna UI né comando | API unica di stato + badge/retry su web e bot | parity-5, frontend-1 |

---

## 3. Matrice parità web/Discord (operazioni quotidiane)

| Capacità | Web | Discord | Gap / azione |
|---|---|---|---|
| Iscrizione evento alleanza | Rotta (parity-1) | OK | Fix del double-unwrap |
| Crea evento | Form completo | Ridotto: ISO UTC, `comp_id` numerico, niente ping_alliance/regear/cap/ruoli | Contratto unico, autocomplete, timezone di tenant |
| Modifica evento | Sì | No | Aggiungere comando/modal |
| Flash mass | Solo lettura | Sì | Creare da web; mostrare lo stato |
| Start/stop/cancel | Senza effetti Discord | Con voce e notice | Effetti guidati dal backend (outbox) |
| Remind (ping) | No | Sì | Esporre da web |
| Roster seat / ruoli roster / battle link | Sì | No (`/event-roster` in lettura) | Accettabile web-only; vedere i seat nella card |
| Condividere evento con l'alleanza | Checkbox | No | Aggiungere opzione |
| Stato mirror/fanout e retry | No | No | Pannello + comando |
| Comp / build | CRUD, prezzi, versioni | Solo `/build` in lettura | `/comp` con autocomplete; share/unshare |
| Split create / complete / close | Sì (creator o `splits.edit`) | No (solo forum mirror) | Comandi/pulsanti nel post forum; restringere le permission |
| Split alleanza: distribuzione | Read-only (UI bloccata) | No | Azione + stato + retry |
| Bank balance / prelievo | Selezione righe (logica client) | `/balance`, `/balance-request` (multi-guild rotto) | Endpoint backend `withdrawable` e `withdraw {amount}` |
| Accept / reject prelievo | Sì | Pulsanti (senza `guild_tenant_id`) | Il backend risolve la gilda per transazione |
| Regear request / review | Sì | No | Aggiungere (richiesta e review) |
| Warn / escalation | Sì (ack web-only) | `/warn`, `/warns` (senza ack) | Ack su Discord; DM dal backend |
| Warn visibili al membro | No | No | `GET /warns/me` |
| XP / rank / leaderboard | Sì | `/rank`, `/xp`, leaderboard | `guild_rank` anche nel bot |
| Application / ticket | Solo settings | Flusso completo | Endpoint di lista e review web; ruoli assegnati dal backend |
| Trials | Nessuno | Nessuno | Router, scadenza, UI (WP13) |
| VOD | No | `/vod` | Lista VOD sul web; verifica server-side |
| Giveaway enter | No (admin-only) | Sì | Pagina membro |
| Link Albion | link + unlink | register / link (no unlink) | `LinkOrchestrator` unico; `/unlink` |
| Battle | Fights, dettaglio, trends | Solo `/battles` (sorgente diversa) | `/fight` sullo stesso endpoint; outcome dal backend |
| Alleanza (admin) | admin-alliance | Nessuno | Capability per tipo di tenant dal backend |
| Autorità di gestione evento | Duplicata nel client | `management-authority` | Azioni descritte dal backend |

---

## 4. Architettura target

**Principi**
1. Il backend possiede stato, regole, scheduling, sync e stato di consegna. Web e bot sono renderer ed esecutori di effetti.
2. Un unico meccanismo di sync, guidato da outbox transazionale, sostituisce i quattro attuali.
3. Ogni azione utente è un comando backend. Web e bot usano gli stessi comandi e gli stessi descrittori di permesso.

**4.1 Motore di sync unico (sostituisce `fanout_outbox`, `mirror_retry` e gli hook best-effort)**
- **Origin tracking.** Ogni entità sincronizzata (event, comp, build, split) ha nello schema di destinazione `origin_tenant_id`, `origin_id`, `origin_version`, oppure una tabella control-plane `sync_mappings(source_tenant, type, source_id, target_tenant, target_id, version)` con chiave stabile. Riusa la logica di `alliance_shares` e `event_fanout_assets`, ma non per job. Risolve alliance-1/2/7/9 e comps-1/9/17.
- **Outbox transazionale.** Ogni scrittura di dominio accoda un evento nella stessa transazione.
  - Il tenant ha il proprio schema, quindi propongo una tabella `outbox` nello schema del tenant, scritta insieme al dato.
  - Un relay già presente nei worker (stile `event_sessions`, svegliato da `LISTEN/NOTIFY`) la sposta in una tabella control-plane `sync_jobs(direction, kind, entity, source_tenant, target_tenant, state, attempts, next_at, last_error)`.
  - La pubblicazione è inline solo come ottimizzazione di latenza, mai come garanzia.
- **Handler per tipo** (event, participation, comp, build, split, member, role), tutti idempotenti e con:
  - tetto ai tentativi e stato terminale `exhausted`;
  - backoff condiviso e rilevamento degli errori non ritentabili;
  - re-arm manuale.
- **Riconciliazione di membership.** I job `backfill` (all'accept) e `detach` (al leave/expel) usano gli stessi handler. Aggiungere un reconcile periodico per utenti, link e ruoli.
- **API di stato unica.** `GET /api/sync/status?entity=event:123` e `POST /api/sync/{id}/retry`. Web e bot mostrano badge per gilda con ok/pending/failed/inactive.
- **Eventi e partecipazione.**
  - Il canonico dell'alleanza detiene il roster; le copie ricevono signup e seat.
  - Le azioni tenant-local sulle copie (voce Discord, thread, messaggi) sono consentite. Il contenuto e il lifecycle restano della sorgente.
  - `converge_copy_to_source` diventa uno stato completo; le transizioni terminali non regrediscono.
- **Worker di lifecycle backend per ogni tipo di tenant.** Scheduler mass_due, start_due, reminder_1h e auto-stop, per guild e alliance. Dopo ogni auto-stop si chiama `sync_owner_change_to_copies`.

**4.2 Consegna Discord: bot stateless**
- **Tabelle.**
  - `discord_bindings(tenant_id, entity_type, entity_id, channel_id, message_id, thread_id, signup_message_id, revision, state)`, generalizzando il contratto già usato dagli split (`api/splits/*/discord-sync`).
  - `discord_outbox(id, tenant_id, kind, entity, revision, payload, lease, attempts, state, last_error)`.
- **Endpoint bot** sotto `/api/bot`:
  - `GET /outbox/stream` (SSE, riprendibile con `Last-Event-ID`) con fallback `GET /outbox?after=`;
  - `POST /outbox/{id}/ack` e `/fail`;
  - `GET /bindings?thread_id=` al posto di `findEventIdForThread`.
- **Cosa passa dall'outbox.**
  - annunci di eventi, aggiornamenti card, chiusure;
  - mass, start e reminder (voce e messaggi) emessi dallo scheduler;
  - battle, giveaway e DM (`notifications.discord_dm_status`);
  - messaggi verso la Discord dell'alleanza, come outbox item con tenant target.
- **Il bot esegue solo.** Un reducer per kind (event.upsert, event.close, giveaway.post, dm.send, split.upsert, voice.provision). Spariscono `Poller`, `listSinceCheckpoint`, il JSON di stato, i gate locali e `pollNow`.
- **Stato di consegna nel backend.** Compare in `event-detail` e nelle impostazioni Discord admin, con retry per gli item `ambiguous`.
- **Lease.** Il lease dà un solo consumatore attivo e la crash recovery, ed è pronto per la scalabilità orizzontale.
- **Eventi Gateway.** `GuildMemberAdd/Remove/Update` e `GuildRoleUpdate/Delete` -> `POST /api/members/sync`, con auto-provisioning degli utenti (`identity::upsert_discord_user`) e soft-deactivate degli ex membri.

**4.3 Azioni condivise web/bot (descrittori backend)**
- `GET /api/{entity}/{id}/actions` restituisce `[{id, label_key, allowed, reason, requires_confirm, params_schema}]`. Generalizza `management-authority`, che oggi usa solo il bot.
- `POST /api/{entity}/{id}/actions/{action}` restituisce il nuovo stato più la lista degli effetti Discord accodati. Le regole di stato per evento e split (tabelle di transizione) vivono solo nel backend.
- `GET /api/me/capabilities` per tenant kind: moduli, comandi e voci di nav consentiti. Sostituisce `ALLOWED_COMMANDS`, `hiddenForAlliance`, `guildOnlyGuard` e le regole `FEATURE_GATES` duplicate. Il backend applica lo stesso elenco.
- Endpoint di aggregazione già previsti come dati: `/api/me/overview`, `/api/admin/overview`, `/api/events/summary`, `/api/bank/withdrawable`, `POST /api/splits/preview`, e `quick create` con timezone di tenant.
- Tipi condivisi via OpenAPI codegen (frontend e bot).

**4.4 Modello di lettura per le alleanze**
- Contesto di scope alleanza, sul modello di `EventReadScope`: l'insieme "friendly" (le gilde attive dell'alleanza) si calcola da `alliance_memberships`.
- Battle, fights e bank letti da aggregazioni sulle gilde, con tabelle denormalizzate (`fight_stats`, `battle_player_stats`) invece che dai JSON. Scope Albion per-tenant ovunque, senza `Config` globale.

**4.5 Struttura frontend**
- `core/data`: store/resource tenant-keyed con dedupe, SWR e invalidazione. Una `TenantContext` signal azzera tutto al cambio tenant.
- Canale `/api/live` unico (generalizza il WebSocket del roster) per invalidare le chiavi.
- Interceptor HTTP: 401 -> logout, errori normalizzati, toast persistenti.
- Primitive condivise:
  - `ListPage`, `DetailPage`, `ConfirmDialog`, `FormField`;
  - `MoneyPipe` e `DateTimePipe`;
  - `AllianceScopeBar` (filtro gilda + badge di sync);
  - `ShareWithAllianceButton`.
- Spezzare `event-detail`, `comp-detail`, `battle-detail` e `admin-finance` in child route con `@defer`.
- i18n con caricamento lazy per lingua.
- SPA al posto di SSR, se confermato.
- Un solo design system (Zed completato).

---

## 5. Piano di lavoro

Ogni WP è una branch/PR indipendente (`<type>/<descrizione>` da `origin/main`). Ordine: baseline, correttezza e sicurezza, sync rotti, architettura di sync, parità, performance, UI.

**WP0: Baseline verde (`chore/baseline-green`)**
- Obiettivo: test e lint affidabili prima di ogni altra modifica.
- Scope:
  - `migration/m20261028_000003...` diviso in un `alter_table` per colonna (up e down); verificare le migrazioni successive;
  - doctest (`pub(crate) mod errors` -> `ignore` o esporre i tipi);
  - clippy deny: collapsible-if, too-many-arguments con parameter struct, ecc.;
  - `postgres.rs`: togliere il fallback `DATABASE_URL` -> richiedere `TEST_DATABASE_URL`;
  - spec frontend (`dashboard.spec` con `guild_rank`, `register-tenant`, `admin-alliance`, `data-table`);
  - `FRONTEND_URL` nel `npm test` del bot.
- Dipendenze: nessuna. Rischio: basso, ma emergeranno bug nascosti nelle migrazioni successive.
- Verifica: `cargo test` (con DB di test dedicato), `cargo clippy --all-targets`, `npm test` in frontend e bot.

**WP1: Sicurezza identità (`fix/auth-hardening`)**
- Obiettivo: chiudere le falle di account e permessi.
- Scope:
  - auth-1: `finalize_session` usa `identity::upsert_discord_user`; `verified` letto da Discord;
  - auth-4/16: `Absent` -> 403 e cancellazione della membership; switch tenant rifiutato;
  - auth-12 / members-17: email fuori dal profilo pubblico;
  - auth-19: bypass per il proprietario nel priority check; auth-6: bypass proprietario anche sulle alleanze;
  - members-6: troncamento UTF-8 dell'audit;
  - members-2: verifica server-side del thread VOD, host allowlist, tetto giornaliero.
- Dipendenze: WP0. Rischio: medio (cambia il comportamento del login).
- Verifica: test "due Discord id con la stessa email = due righe", test sulla membership assente, test dell'audit con emoji.

**WP2: Correttezza finanziaria (`fix/finance-correctness`)**
- Obiettivo: nessun pagamento sbagliato.
- Scope:
  - finance-1: complete/lost/archive richiedono `splits.edit`; fee e valori su create ristretti; UI allineata;
  - finance-2: il backend restituisce i campi di pool/fee/net preview; il bot li mostra e coerce con `Number()`;
  - finance-3: `sync_event_participants` salta gli split non `pending`; si introduce un flag di roster gestito da officer; errore non bloccante dopo `stop_event`;
  - finance-4: `close_split` ammesso anche da `awaiting_event`; ricalcolo dello stato su cancel/uncancel/unlink;
  - finance-7/10: regear con `UPDATE ... WHERE balance>0` e indice parziale unico; giveaway con flip condizionale prima dei side effect;
  - finance-11: le GET non scrivono; consolidamento in transazione con guardie di stato;
  - finance-12: ordinamento per `user_id` e share non negative; finance-16: audit in transazione.
- Dipendenze: WP0. Rischio: medio-alto (modifica il ledger; migrazione dati per gli indici).
- Verifica: test di integrazione su Postgres per le concorrenze, test di pari-centesimo, fixture del bot con decimali stringa.

**WP3: Scope Albion per tenant (`fix/tenant-albion-scope`)**
- Obiettivo: outcome e friendly side corretti per ogni tenant.
- Scope:
  - `fights.rs` e `lib.rs` (`friendly_side` da `AlbionScope`), `GUILD_NAME` del bot (bot-arch-20, battles-16);
  - chiave di rollup per player = nome+gilda quando l'id è vuoto, oppure lettura di `battle_player_stats` (battles-7);
  - `is_friendly`/`is_own` nelle API battle (battles-17).
- Dipendenze: WP0. Rischio: medio.
- Verifica: fixture reale senza id, test multi-tenant con due gilde.

**WP4: Hotfix web (`fix/web-broken-calls`)**
- Obiettivo: far funzionare quello che oggi non funziona nel sito.
- Scope:
  - parity-1 (array senza `.data`) e parity-2 (PATCH split);
  - comps-7 (204 -> build null);
  - frontend-3 (reset al cambio tenant, `NotificationService.reset`);
  - frontend-9 (interceptor HTTP: 401/403, toast persistenti);
  - events.ts stats a 100 (frontend-10) con endpoint `events/summary`;
  - frontend-12 (script di tema pre-boot).
- Dipendenze: WP0. Rischio: basso.
- Verifica: spec che passano dall'envelope reale di `ApiService`, test del metodo HTTP.

**WP5: Hotfix bot (`fix/bot-poller-hotfix`)**
- Obiettivo: fermare le perdite e i loop del poller attuale, in attesa di WP12.
- Scope:
  - events-1/bot-arch-6: eliminare il filtro su `eventThreadIds`; la chiusura non deve leggere "assente" come "cancellato";
  - bot-arch-7 (race `ensure`), bot-arch-4 (cursore per item, `postedGiveawayIds`), bot-arch-5/events-12 (`?status=scheduled&order=asc` o `/events/calendar`);
  - events-8/9 (card finale prima della chiusura), bot-arch-16 (calendar solo in modalità calendar);
  - finance-8/bot-arch-17 (head-of-line split), finance-20 (giveaway);
  - bot-arch-14 (timeout `AbortSignal`, `pollNow` accoda), bot-arch-15 (defer prima del gate);
  - scrittura atomica dello stato (tmp + rename) e rifiuto del reseed se il file è illeggibile.
- Dipendenze: WP0. Rischio: medio.
- Verifica: test di unità sul poller con API finta; scenario con più di 51 pinged.

**WP6: Sync eventi alleanza: correttezza (`fix/alliance-event-sync`)**
- Obiettivo: far convergere davvero gli eventi alleanza -> gilda.
- Scope:
  - alliance-1/comps-1: mapping stabile (tabella control-plane o origin ids), un secondo job di update non deve creare né rompere nulla;
  - alliance-2: copia delle build dei ruoli roster; link prima dei ruoli;
  - alliance-3/events-4: worker di lifecycle per le alleanze, `sync_owner_change_to_copies` dopo l'auto-stop, converge senza regressione di stato;
  - alliance-4/events-3: azioni tenant-local consentite sulle copie, il bot salta mass/start sulle copie;
  - alliance-7/16/20: filtro per alleanza in share e link, tetto tentativi e terminale `exhausted`, errori non ritentabili;
  - alliance-8/events-18: via `postAllianceAnnouncement`, delivery dell'alleanza;
  - events-14: converge di comp, cap, ruoli.
- Dipendenze: WP0, WP5. Rischio: alto (tocca il fanout in produzione; migrazione dei dati duplicati).
- Verifica: test integrazione publish + 2 update = stesso numero di build; ruolo roster fuori comp; auto-stop con converge.

**WP7: Partecipazione e roster sincronizzati (`feat/participation-outbox`)**
- Obiettivo: iscrizioni durevoli, azioni officer incluse.
- Scope:
  - outbox di partecipazione, `hub.publish` sui peer, successo locale sempre (alliance-6, events-5);
  - add/set/remove partecipanti e seat propagati, con attribuzione esplicita (alliance-5, events-6);
  - attribuzione cancellata alla rimozione, `NotFound` in leave trattato come successo (alliance-20);
  - `GET /sync/status` per partecipazioni.
- Dipendenze: WP6. Rischio: alto (modello dati nuovo).
- Verifica: test a due tenant con peer che fallisce poi riprende; split payout con partecipante aggiunto da officer.

**WP8: Ciclo di vita della membership (`feat/alliance-membership-lifecycle`)**
- Obiettivo: join, leave ed expel completi.
- Scope:
  - backfill all'accept (eventi non terminali, utenti/link, ruoli) e al cambio di ruolo hub (alliance-11, auth-9);
  - leave/expel: archiviare le copie future, scollegare le share, worker per le revoche dei ruoli (alliance-12, auth-10);
  - endpoint di espulsione dall'alleanza;
  - invito con controllo Albion e decline nella UI (auth-11, parity-15);
  - `reset_alliance_setup` chiama il revoker.
- Dipendenze: WP6 (e WP9 per i dettagli). Rischio: medio-alto.
- Verifica: test del flusso join -> backfill -> leave; verifica dei grants.

**WP9: Motore di sync generico (`feat/sync-engine`)**
- Obiettivo: unificare i meccanismi e coprire build/comp/split.
- Scope:
  - tabella `sync_jobs`, tabella dei mapping, relay dall'outbox del tenant;
  - fusione di `fanout_outbox.rs` e `mirror_retry.rs`;
  - hook su update/delete/archive di build, comp, split (alliance-9, comps-2/10/17, finance-5);
  - `ensure_build_published` con refresh, copie read-only, parent_id mappato;
  - publish A->G esplicito per build e comp (policy dalla domanda 1);
  - rimozione di `alliance_discord_message_id` dal bot.
- Dipendenze: WP6, WP7. Rischio: alto (rifacimento centrale, migrazione).
- Verifica: test di convergenza end-to-end per ogni tipo; test di migrazione con dati esistenti.

**WP10: Visibilità del sync e payout alleanza (`feat/sync-visibility`)**
- Obiettivo: ogni stato di sync è visibile e riparabile da web e Discord.
- Scope:
  - `AllianceSyncBadge` su `event-detail`, liste, split e admin-alliance (parity-5, frontend-1);
  - pannello distribuzione split con retry; worker di resume del batch (alliance-13, finance-6);
  - ordinamento deterministico dei partecipanti e preflight meno rigido;
  - riga ledger con split e audit, esclusa da `outflow_other` (finance-13);
  - comandi/pulsanti nel bot per mirror-status e retry.
- Dipendenze: WP9. Rischio: medio.
- Verifica: spec dei componenti, test integrazione del resume dopo crash simulato.

**WP11: Identità e sync membri da Discord (`feat/member-sync`)**
- Obiettivo: la Discord è il riferimento per membri e ruoli.
- Scope:
  - `GuildMember*` e `GuildRole*` -> `POST /api/members/sync`;
  - auto-provisioning degli utenti, via il gate "login web" (auth-2, auth-3, members-16);
  - flag `active/left_at`, filtro nelle liste e nei leaderboard;
  - ruoli con staleness massima (`roles_checked_at`, auth-5);
  - `LinkOrchestrator` unico (auth-8, parity-16);
  - verifica di proprietà del link Albion (domanda 10).
- Dipendenze: WP1. Rischio: alto (impatta onboarding e permessi).
- Verifica: test del bot con `/register` senza login web; test `GuildMemberRemove`.

**WP12: Bindings e outbox Discord, bot stateless (`feat/discord-outbox`)**
- Obiettivo: eliminare il polling e il JSON di stato. Va a fasi, ognuna mergeable.
  - 12a: `discord_bindings` + endpoint di ack, migrazione dallo stato JSON;
  - 12b: outbox per eventi, battle e giveaway; stream SSE con fallback a polling;
  - 12c: scheduler backend (mass/start/reminder/auto-stop) che emette effetti anche per le alleanze;
  - 12d: DM e notifiche dall'outbox (members-1).
- Scope: nuove tabelle, `/api/bot/*`, riscrittura del Poller.
- Dipendenze: WP5, WP6, WP9. Rischio: alto (cambia il contratto bot/backend).
- Verifica: test di lease e crash recovery, test di replay, scenario "bot spento due ore".

**WP13: Parità web/Discord e capability (`feat/action-descriptors`)**
- Obiettivo: stesse azioni, stesse regole.
- Scope:
  - `GET /api/me/capabilities` e `.../actions`; allowlist alleanza dal backend (auth-16, parity-3);
  - contratto `event-create` unico con timezone di tenant (parity-8, frontend-4);
  - `/comp` + autocomplete, share/unshare; `/unlink` (comps-3, parity-17);
  - bank multi-guild (parity-4); `withdrawable` + `withdraw {amount}` (frontend-2);
  - applications: lista, review e ruoli assegnati dal backend (members-14, parity-7);
  - trials: router, scadenza e UI (members-4);
  - warns: `GET /warns/me`, ack su Discord (members-10).
- Dipendenze: WP11, WP12. Rischio: medio.
- Verifica: test contrattuali su OpenAPI; test del bot per ogni comando nuovo.

**WP14: Performance backend (`perf/backend-hotpaths`)**
- Obiettivo: eliminare i colli di bottiglia misurabili.
- Scope:
  - cache del catalogo AlbionBB condivisa (single-flight, TTL per finalità) (battles-2, backend-perf-1), semaforo upstream + retry/429;
  - `GET /battles/{id}` di sola lettura con persistenza nel worker (battles-4, backend-perf-15); battle_sync con query `IN` (backend-perf-8);
  - `/fights` e trends da `fight_stats` in SQL (backend-perf-3, battles-8/19); `/battles/me` da `battle_player_stats`;
  - linker: stop per finestra temporale, `link_updated_at` separato, escludere cancellati (backend-perf-2, events-10/11);
  - extractor di auth con cache di ruoli/owner, negative cache e timeout (backend-perf-4); audit asincrono (members-7);
  - pool per tenant con limiti, refresh invece di `evict`, single-flight (backend-perf-7);
  - N+1 di roster e VOD (backend-perf-11/18); `users/me/metrics` in SQL (members-5);
  - `CompressionLayer`, `TimeoutLayer`, indici (backend-perf-16/20); `AlbionApiClient` condiviso con cache.
- Dipendenze: WP3. Rischio: medio.
- Verifica: benchmark prima/dopo su dataset realistico, test di cache hit, log delle chiamate upstream.

**WP15: Performance e correttezza comps (`perf/comps-batching`)**
- Obiettivo: liste veloci e prezzi affidabili.
- Scope:
  - batch di categorie/utenti/conteggi; endpoint con statistiche in lista (comps-5);
  - `update_comp` valida prima e in transazione (comps-6);
  - prezzi: non cachare i fallimenti, `unpriced_item_count`, invalidazione sugli edit (comps-8);
  - `group_id` per le versioni, `is_latest` e filtro (comps-4);
  - validazione server-side di nome/icona/tier, allowlist host nel bot (comps-11);
  - ETag per catalogo e abilities (comps-15), combat N+1 (comps-16), `main_item_count` (comps-13).
- Dipendenze: WP0 (comps-9 dopo WP9). Rischio: medio.
- Verifica: conteggio query nei test, snapshot dei prezzi.

**WP16: Data layer frontend e aggregati (`refactor/frontend-data-layer`)**
- Obiettivo: meno richieste e dati sempre freschi.
- Scope:
  - `core/data` tenant-keyed, `/api/live`, servizi root (`AlbionLinkService`, `AllianceContextService`);
  - endpoint `/api/me/overview` e `/api/admin/overview`;
  - i18n lazy per lingua; decisione SPA vs SSR (frontend-8);
  - codegen di `api.models.ts` e dei tipi del bot da OpenAPI.
- Dipendenze: WP4, WP13. Rischio: medio-alto.
- Verifica: bundle size, numero di richieste al caricamento, spec con dati invalidati.

**WP17: UI e accessibilità (`refactor/ui-zed-a11y`)**
- Obiettivo: un solo design system e una UI usabile.
- Scope:
  - eliminare i token Discord, caricare IBM Plex, regola lint sui raggi (frontend-11);
  - titoli di route, contrasti, dimensione minima del testo, focus trap del drawer (frontend-15);
  - spezzare `event-detail`, `comp-detail`, `battle-detail`, `admin-finance`;
  - sostituire `select`/`table`/`confirm()` raw con `FormField`, `ConfirmDialog` e `DataTable`;
  - landing e tenant rail per alleanze, `AllianceScopeBar` (frontend-16); chiavi i18n al posto delle stringhe hardcoded.
- Dipendenze: WP16. Rischio: basso-medio (regressioni visive).
- Verifica: AXE in CI, test di contrasto, snapshot visivi.

**WP18: Pulizia (`chore/dead-code-and-docs`)**
- Obiettivo: ridurre superficie e debito.
- Scope:
  - rotte morte (`parity-14`, `albionbb/*`, `economy/*`, `attention/*`), `albion-settings`, `audit/middleware.rs`;
  - README e OpenAPI allineati (comps-19), `bot-arch-18` e `bot-arch-19` (batch del message XP);
  - `trials` e `guild_ranks` -> ruoli Discord alla promozione (members-12), warn multiplier legato al warn (members-9), `progression/me` con scadenza (members-11);
  - suddivisione dei "god files" (backend-perf-22).
- Dipendenze: WP13. Rischio: basso.
- Verifica: `cargo check`, test, grep dei consumer.

---

## 6. Domande sulle logiche

Per ognuna indico le opzioni e il default che propongo.

1. **Cosa deve sincronizzare l'alleanza con le gilde, e in che direzione?**
   - (a) Solo eventi, come oggi. (b) Eventi e build/comp con refresh automatico dal proprietario. (c) Come (b) più altri domini.
   - Default: (b). Gli eventi dell'alleanza vanno a tutte le gilde. Un evento di gilda con `ping_alliance` resta solo nell'alleanza (non viene ri-distribuito alle altre gilde). Build e comp si propagano in modo one-way con copie read-only. Warns, regear, ranks, settings e trials restano privati della gilda; bank in lettura live; battle in aggregato read-only.
2. **Chi gestisce il roster di un evento dell'alleanza (seat, ruoli roster, aggiunte manuali)?**
   - (a) Solo l'alleanza (roster canonico, copie in sola lettura). (b) Ogni gilda per i propri membri.
   - Default: (a). I signup fluiscono in entrambe le direzioni con attribuzione di gilda; gli officer aggiungono con attribuzione esplicita o ricavata dalla gilda unica del membro.
3. **Le copie in gilda possono avere azioni locali (voce Discord, thread, notice mass/start)?**
   - Default: sì. Sono tenant-local, e `lifecycle.rs` già lo documenta. Contenuto e lifecycle restano della sorgente.
4. **Chi decide quando un evento parte, e l'avvio automatico è opt-in?**
   - Default: il backend, per ogni tipo di tenant. Mass/start automatici restano come oggi, configurabili per gilda. La voce vuota resta un segnale riportato dal bot.
5. **Cosa succede alle copie e ai dati condivisi quando una gilda esce o viene espulsa?**
   - (a) Cancellare. (b) Archiviare/nascondere e mantenere lo storico. (c) Lasciare tutto com'è.
   - Default: (b). Le copie future vengono archiviate e le share scollegate. L'alleanza può espellere una gilda.
6. **Il percorso legacy `ping_alliance` (post diretto della gilda nel canale dell'alleanza) va rimosso?**
   - Default: sì. Resta solo il mirror, annunciato dal sistema di consegna con le impostazioni di delivery dell'alleanza.
7. **Chi può completare, chiudere o archiviare uno split, e chi può impostare fee e valore?**
   - (a) Solo `splits.edit`/`splits.delete`. (b) Anche il creatore.
   - Default: (a). I membri possono proporre; la fee viene forzata dal default della gilda se non si hanno i permessi. Gli officer non approvano i propri prelievi, come regola configurabile.
8. **Cosa succede a uno split `awaiting_event` quando l'evento viene cancellato, e fino a quando il roster segue le iscrizioni?**
   - Default: torna `pending`, completabile o chiudibile. Il roster segue l'evento solo fino al primo edit manuale o al completamento; da lì nessun cambio ai pagamenti.
9. **Distribuzione split alleanza: dove si lancia e cosa fare con partecipanti non risolvibili?**
   - (a) Il batch si blocca finché un umano interviene. (b) Pagamento parziale con quote non risolte in sospeso.
   - Default: (a) per ora, con UI di stato, resume automatico e messaggi chiari. (b) come evoluzione.
10. **Identità e fiducia:**
    - **Onboarding.** Auto-provisioning degli utenti al primo contatto con il bot, oppure resta l'obbligo di login web? Default: auto-provisioning.
    - **Link Albion.** Come si prova la proprietà? Default: approvazione officer o challenge in-game. I ruoli di gilda/alleanza non si assegnano per sola dichiarazione, e l'unlink self-service va allineato alla policy.
    - **Ex membri.** Soft-deactivate, con revoca delle membership (storico conservato).
    - **Proprietario dell'alleanza.** Ha il bypass dei permessi, come il proprietario di una gilda.
11. **I membri di una gilda ricevono XP, presenze e regear per gli eventi dell'alleanza?**
    - (a) No, solo XP a livello alleanza. (b) Sì, tramite la copia di gilda, per i partecipanti attribuiti.
    - Default: (b). La copia assegna XP ai membri attribuiti alla propria gilda. Oggi le copie "non sono award authority" e nemmeno il retry dell'XP gira sulle alleanze.
12. **Decisioni tecniche trasversali** (da confermare insieme):
    - **Repliche.** Una sola replica backend, documentata, con advisory lock per i worker. Redis o equivalente solo se serve scalare.
    - **Frontend.** SPA invece di SSR (ogni route richiede sessione) e design Zed come target unico.
    - **Timezone eventi.** Quella configurata nella gilda (`discord_event_timezone`), mostrata accanto agli input.
    - **Identità delle versioni di build/comp.** `(name, category)` per tenant con `group_id`, non per creatore. Da decidere se unire i gruppi omonimi esistenti.
    - **Battle.** Soglia `min_players` configurabile per tenant, con una battaglia considerata "finale" dopo una finestra di assestamento prima dell'annuncio.

---

## 7. Appendice: findings tenuti per area

Formato: `[severità][verdetto] id - titolo (path:riga)`. Baseline:
- [high][confirmed] BASE-1 - Migrazione `m20261028_000003` con ALTER multi-colonna su SQLite, 444 test rossi (`migration/m20261028_000003_add_event_discord_delivery.rs:34-63`)
- [medium][confirmed] BASE-2 - Doctest su moduli privati (`lib.rs:17`)
- [medium][confirmed] BASE-3 - Clippy deny, 115+ errori
- [medium][confirmed] BASE-4 - 4 spec frontend falliscono (`dashboard.spec.ts:53`)
- [low][confirmed] BASE-5 - Test del bot dipende da `FRONTEND_URL` (`website-account.test.ts:65`); test Postgres con fallback a `DATABASE_URL` (`postgres.rs`)

**alliance**
- [high][confirmed] alliance-1 - Update/start job ricopiano le build come righe nuove (`events/fanout_worker.rs:431-448`)
- [medium][confirmed] alliance-2 - Ruoli roster con build fuori comp: copia mai linkata, ritenta all'infinito (`events/fanout_worker.rs:364-390`)
- [high][confirmed] alliance-3 - Auto-stop non sincronizzato; update risuscita le copie (`events/lifecycle.rs:56-96`)
- [high][confirmed] alliance-4 - Mass/start/voce su copie rifiutati 403, loop del bot (`events/router.rs:1942`)
- [high][confirmed] alliance-5 - Partecipanti officer e seat non sincronizzati, nessuna attribuzione (`events/router.rs:651-760`)
- [high][confirmed] alliance-6 - Sync partecipazione non durabile, errore dopo il commit (`events/router.rs:1507-1550`)
- [medium][confirmed] alliance-7 - Cambio alleanza riusa share/link stantii (`alliance_share/service.rs:519-552`)
- [medium][confirmed] alliance-8 - Annuncio duplicato ping_alliance + mirror (`discord-bot/src/services/poller.ts:2163-2186`)
- [medium][confirmed] alliance-9 - Build/comp/split snapshot one-shot (`alliance_share/service.rs:700-754`)
- [medium][confirmed] alliance-10 - Mirror gilda->alleanza solo schedule/status, senza retry (`events/lifecycle.rs:56-96`)
- [medium][confirmed] alliance-11 - Join alleanza senza backfill (`platform/service.rs:871-905`)
- [low][confirmed] alliance-12 - Leave lascia copie/ghost; nessun expel (`platform/service.rs:1046-1140`)
- [medium][confirmed] alliance-13 - Distribuzione split senza worker/UI (`splits/alliance_distribution.rs:92-300`)
- [medium][confirmed] alliance-14 - Utenti/ruoli: hook one-shot best-effort (`albion/alliance_fanout.rs:107-175`)
- [medium][confirmed] alliance-15 - Il bot non fa operazioni alleanza e nessuno mostra la salute del sync (`discord-bot/src/commands/event-create.ts`)
- [medium][confirmed] alliance-16 - Outbox fanout senza tetto tentativi, lavoro inline (`events/fanout_outbox.rs:131-150`)
- [medium][confirmed] alliance-17 - Roster live e stato split non aggiornati sui peer (`events/sync.rs:376-460`)
- [low][plausible] alliance-18 - Interi domini senza sync (`regear/service.rs:344`)
- [low][plausible] alliance-19 - Tre meccanismi sovrapposti, scritture cross-DB senza contratto (`alliance_share/service.rs`)
- [low][confirmed] alliance-20 - Attribuzione permanente; mirror non ritentabili lenti (`events/attribution.rs:95-125`)

**events**
- [high][confirmed] events-1 - Il poller azzera i mapping thread degli eventi (`poller.ts:2007-2014`)
- [medium][confirmed] events-2 - Stato Discord solo in JSON locale (`poller.ts:98-135`)
- [high][confirmed] events-3 - Copie di eventi alleanza senza voce/start; crea e cancella canale ogni minuto (`events/router.rs:1942`)
- [medium][confirmed] events-4 - Nessun worker event_sessions sulle alleanze (`tenant.rs:81-86`)
- [medium][confirmed] events-5 - Join/leave: commit locale prima del sync cross-tenant (`events/router.rs:1492-1550`)
- [medium][confirmed] events-6 - Add/set/remove partecipante officer non sincronizza (`events/router.rs:1698-1735`)
- [high][confirmed] events-7 - Start/stop/cancel web senza effetti Discord (`event-detail.ts:5283-5290`)
- [medium][confirmed] events-8 - Card stantia dopo stop/auto-stop (`poller.ts:1484-1525`)
- [low][plausible] events-9 - Pulsante Stop archivia il thread prima di editare la card (`handlers/button.ts:985-1005`)
- [medium][confirmed] events-10 - Linker polla tutti i pending/cancellati per sempre (`events/service.rs:4243-4262`)
- [medium][confirmed] events-11 - Linker aggiorna `updated_at` ogni 30s e forza i re-render (`events/service.rs:4303-4308`)
- [medium][confirmed] events-12 - Mass/start/1h leggono solo la pagina 1 (`poller.ts:1717`)
- [medium][confirmed] events-13 - Scoperta riscansiona tutto; GET detail scrive (`poller.ts:751-782`)
- [medium][confirmed] events-14 - Converge salta comp, ruoli Discord, roster roles, seat (`events/lifecycle.rs:56-96`)
- [medium][confirmed] events-15 - Realtime web solo sul roster (`events/router.rs:2020-2160`)
- [medium][confirmed] events-16 - Gap di parità web/Discord sugli eventi (`commands/event-create.ts:12-44`)
- [low][confirmed] events-17 - Orchestrazione lifecycle duplicata in 4 percorsi (`handlers/button.ts:880-940`)
- [medium][confirmed] events-18 - Due meccanismi gilda->alleanza e `discord_delivery` dato morto (`poller.ts:2163-2190`)
- [low][confirmed] events-19 - Lifecycle/fanout inline, ricopia la comp a ogni operazione (`events/lifecycle.rs:119-160`)
- [low][confirmed] events-20 - Edit non cancella la descrizione; flash senza stato (`event-detail.ts:5386-5397`)

**finance**
- [medium][confirmed] finance-1 - Un membro crea e completa il proprio split (`splits/router.rs:24-66`)
- [high][confirmed] finance-2 - Pool dello split nel bot calcolato sommando stringhe (`split-summary.ts:49-62`)
- [high][confirmed] finance-3 - Sync roster riscrive split chiusi (`splits/service.rs:1353-1429`)
- [medium][confirmed] finance-4 - Cancel evento lascia gli split in `awaiting_event` (`events/service.rs:3876-3905`)
- [medium][confirmed] finance-5 - Split gilda->alleanza snapshot unico (`events/sync.rs:51-70`)
- [high][confirmed] finance-6 - Distribuzione split alleanza irraggiungibile dal web, senza stato (`split-detail.ts:1052-1058`)
- [medium][confirmed] finance-7 - Crediti regear spesi senza lock (`regear/credits.rs:64-134`)
- [medium][confirmed] finance-8 - Sync forum split: head-of-line, cursore locale (`poller.ts:1915-1940`)
- [medium][confirmed] finance-9 - Auto-draw giveaway accoppiato al worker eventi (`event_sessions/mod.rs:54-92`)
- [low][confirmed] finance-10 - Draw giveaway doppio bonus regear (`giveaways/service.rs:358-490`)
- [medium][confirmed] finance-11 - GET balance/transactions riscrivono il ledger (`bank/service.rs:149-293`)
- [low][plausible] finance-12 - Resto delle quote su query non ordinata (`splits/service.rs:455-485`)
- [medium][confirmed] finance-13 - Crediti alleanza senza link split/audit, contati come outflow (`splits/alliance_distribution.rs:497-535`)
- [low][plausible] finance-14 - Siphoned collassa righe identiche (`siphoned/service.rs:576-605`)
- [low][plausible] finance-15 - Definizioni di "income" contraddittorie (`economy/service.rs:111-165`)
- [medium][confirmed] finance-16 - Azioni split non auditate (`splits/service.rs:1111-1180`)
- [medium][confirmed] finance-17 - Caricamenti dell'intero ledger (`bank/service.rs:455-561`)
- [low][confirmed] finance-18 - Frontend ricalcola quote e fee (`splits/splits.ts:1196-1225`)
- [medium][plausible] finance-19 - Discord non fa split/regear/siphoned (`commands/index.ts`)
- [low][confirmed] finance-20 - Annunci giveaway duplicati/persi (`poller.ts:2063-2116`)
- [low][confirmed] finance-21 - Auto-approvazione, manual con split_id, edit admin (`bank/service.rs:894-1019`)

**auth**
- [high][confirmed] auth-1 - Upsert di login riassegna il discord_id via email (`auth/service.rs:475-517`)
- [high][confirmed] auth-2 - Il bot rifiuta tutto finché non c'è un login web (`services/command-gate.ts:64-80`)
- [high][confirmed] auth-3 - Nessun sync Discord->DB di membri/ruoli (`discord-bot/src/index.ts:218-248`)
- [high][confirmed] auth-4 - Membership tenant mai revocate (`platform/service.rs:1199-1213`)
- [medium][confirmed] auth-5 - Revoca ruoli fail-open; cookie scorrevole (`auth/service.rs:392-459`)
- [high][confirmed] auth-6 - Il proprietario di un'alleanza non ha bypass né Admin (`platform/service.rs:2103-2105`)
- [high][confirmed] auth-7 - Link Albion senza prova di proprietà (`albion/router.rs:295-350`)
- [high][confirmed] auth-8 - Link/unlink admin e POST /users saltano fan-out e ruoli (`albion/router.rs:540-565`)
- [high][confirmed] auth-9 - Accept alleanza senza backfill di link e ruoli (`platform/service.rs:871-902`)
- [medium][confirmed] auth-10 - Retry delle revoche solo nel leave (`platform/service.rs:995-1044`)
- [low][plausible] auth-11 - Invito senza controllo Albion (`platform/service.rs:828-862`)
- [medium][confirmed] auth-12 - Email di tutti visibili a ogni membro (`users/service.rs:27-36`)
- [medium][confirmed] auth-13 - Overhead di auth per richiesta (`auth/rbac.rs:131-153`)
- [low][plausible] auth-14 - Chiavi permesso legacy nel frontend (`app.routes.ts:271-275`)
- [low][plausible] auth-15 - Platform admin senza tenant; gate Albion non chiudibile (`app.routes.ts:19-24`)
- [medium][confirmed] auth-16 - Disponibilità moduli per tenant kind in 3 posti (`command-gate.ts:16-25`)
- [medium][confirmed] auth-17 - Fights/battle usano ALBION_GUILD_ID globale (`fights.rs:716-724`)
- [low][plausible] auth-18 - ID di impostazioni non validati (`admin/service.rs:113-167`)
- [low][confirmed] auth-19 - Il proprietario senza ruolo non può assegnare ruoli (`users/member_roles.rs:279-296`)
- [low][confirmed] auth-20 - Codice morto (albion-settings, fallback bot) (`albion-settings.ts`)

**comps**
- [high][confirmed] comps-1 - Fanout reinserisce le build a ogni update: unique violation (`events/fanout_worker.rs:431-447`)
- [medium][confirmed] comps-2 - Share one-shot, build stantie (`alliance_share/service.rs:700-731`)
- [high][confirmed] comps-3 - Discord vede solo /build; comp_id numerico (`commands/build.ts:15-96`)
- [medium][confirmed] comps-4 - Gruppo versioni per creatore; /build ambiguo (`comps/service.rs:285-324`)
- [high][confirmed] comps-5 - Liste e dettagli N+1; 500 chiamate performance (`comps/service.rs:658-690`)
- [medium][confirmed] comps-6 - `update_comp` fonde il parent prima di validare (`comps/service.rs:1892-1904`)
- [medium][confirmed] comps-7 - Rimuovere un item azzera la build nella UI (`comps/router.rs:652-683`)
- [medium][confirmed] comps-8 - Fallimenti di prezzo cachati come zero (`comps/pricing.rs:406-420`)
- [medium][confirmed] comps-9 - Share collide sull'indice creator-scoped (`alliance_share/service.rs:932-976`)
- [medium][confirmed] comps-10 - Delete/rename non tocca la copia in alleanza (`comps/service.rs:1318-1382`)
- [low][confirmed] comps-11 - Nome/icona/tier fidati dal client; fetch icone arbitrario (`comps/service.rs:83-94`)
- [low][confirmed] comps-12 - Il frontend duplica le regole (`comp-detail.ts:1690-1711`)
- [low][confirmed] comps-13 - Tabella build ri-ordinata a pagina, slot sbagliati (`comps/comps.ts:1202-1204`)
- [low][confirmed] comps-14 - Salvataggio slot non atomico (`comp-build-detail.ts:1146-1167`)
- [low][confirmed] comps-15 - Catalogo OpenAlbion non cachato (`openalbion/service.rs:94-96`)
- [low][confirmed] comps-16 - Combat: query per utente/osservazione (`combat/service.rs:156-190`)
- [low][confirmed] comps-17 - Copie alleanza modificabili, parent perso (`alliance_share/service.rs:638-659`)
- [low][confirmed] comps-18 - Immagine build del bot senza tier/enchant (`services/build-image.ts:123-149`)
- [low][confirmed] comps-19 - Drift minori (`comps/service.rs:568`)

**battles**
- [high][confirmed] battles-1 - Alleanze senza battle/fights/intel (`tenant.rs:84`)
- [high][confirmed] battles-2 - Cache del catalogo mai colpita (`battles/service.rs:100`)
- [high][confirmed] battles-3 - Il poller moltiplica il carico e ri-annuncia (`poller.ts:751`)
- [high][confirmed] battles-4 - GET battle esegue la pipeline di persistenza (`battles/service.rs:239`)
- [medium][plausible] battles-5 - Battaglie in corso cachate 24h (`albionbb/service.rs:19`)
- [high][confirmed] battles-6 - Fights classifica da Config globale (`fights.rs:719`)
- [high][confirmed] battles-7 - Player id/guild_id vuoti collassano i rollup (`albionbb/client.rs:139`)
- [high][confirmed] battles-8 - /fights e trends caricano tutto (`fights.rs:475`)
- [medium][confirmed] battles-9 - Filtro outcome su payload di lista senza id (`battles/service.rs:121`)
- [medium][confirmed] battles-10 - Stima perdite vuota oltre 120 id (`battles/service.rs:974`)
- [medium][confirmed] battles-11 - battle_sync: N+1, nessun backfill (`battle_sync.rs:118`)
- [medium][confirmed] battles-12 - Client AlbionBB senza retry/429/limitatore (`albionbb/client.rs:469`)
- [low][confirmed] battles-13 - Passthrough albionbb/albiondata senza permesso (`albionbb/router.rs:84`)
- [medium][confirmed] battles-14 - /battles/me seriale su 5 pagine (`battles/service.rs:444`)
- [low][confirmed] battles-15 - Intel riscansiona (`intel/auto_scout.rs:44`)
- [medium][confirmed] battles-16 - Embed bot con GUILD_NAME di env (`embeds/battle.embed.ts:34`)
- [medium][confirmed] battles-17 - Il frontend indovina "la nostra gilda" dal nome (`fights/fight-detail.ts:1254`)
- [medium][confirmed] battles-18 - Discord lista solo battle (`commands/index.ts:67`)
- [medium][confirmed] battles-19 - Due implementazioni di fight analytics (`fights.rs:738`)
- [low][confirmed] battles-20 - Payload giganti (`battles/models.rs:150`)

**members**
- [high][confirmed] members-1 - DM mai consegnati, sempre `pending` (`notifications/service.rs:251-270`)
- [medium][confirmed] members-2 - Claim VOD con thread/owner fidati dal client (`vods/service.rs:47-84`)
- [medium][plausible] members-3 - Directory alleanza solo al /register (`albion/alliance_fanout.rs:111-196`)
- [medium][confirmed] members-4 - Trials a metà (`trials/service.rs:55-92`)
- [high][confirmed] members-5 - users/me/metrics carica tutto due volte (`users/service.rs:330-395`)
- [medium][confirmed] members-6 - Panic nel troncamento UTF-8 dell'audit (`audit/service.rs:231-234`)
- [medium][confirmed] members-7 - Audit attende HTTP Discord (`audit/service.rs:143-160`)
- [medium][confirmed] members-8 - Warn senza effetti Discord (`warns/service.rs:407-453`)
- [medium][confirmed] members-9 - Revoca warn non annulla il moltiplicatore XP (`warns/service.rs:230-273`)
- [medium][confirmed] members-10 - I membri non vedono i propri warn (`warns/router.rs:111-127`)
- [low][confirmed] members-11 - Moltiplicatore scaduto ancora mostrato (`progression/service.rs:78-82`)
- [medium][confirmed] members-12 - `guild_ranks` ruoli Discord mai assegnati (`progression/service.rs:96`)
- [low][confirmed] members-13 - `/warns` del bot etichetta male (`commands/warns.ts:35-45`)
- [high][confirmed] members-14 - Application/ticket/VOD solo Discord (`applications/router.rs:56-66`)
- [low][plausible] members-15 - Esclusione alleanza solo nei client (`tenant.rs:467-500`)
- [medium][confirmed] members-16 - Nessun offboarding da Discord (`discord-bot/src/index.ts:209-250`)
- [medium][confirmed] members-17 - Email esposte su /users (`users/router.rs:226-243`)
- [medium][confirmed] members-18 - Pagina warn: picker limitato a 100 (`warns/warns.ts:472-478`)
- [low][confirmed] members-19 - Claim VOD non atomico (`vods/service.rs:97-126`)
- [low][confirmed] members-20 - `/attention/findings` senza consumer, scrive in GET (`attention/router.rs:50-58`)
- [low][confirmed] members-21 - Broadcast e mark-all-read O(n) (`notifications/service.rs:141-153`)
- [low][confirmed] members-22 - Nessun controllo di gerarchia/self sui warn (`warns/service.rs:51-65`)

**bot-arch**
- [high][confirmed] bot-arch-1 - Stato e cursori in JSON locale non atomico (`poller.ts:87-143`)
- [medium][confirmed] bot-arch-2 - Scansione parziale congela cursori (`poller.ts:751-781`)
- [high][confirmed] bot-arch-3 - Ogni poller riscansiona lo storico (`poller.ts:751-781`)
- [high][confirmed] bot-arch-4 - Post duplicati su batch fallito (`poller.ts:2049-2057`)
- [medium][confirmed] bot-arch-5 - Lifecycle sulla sola pagina 1 (`poller.ts:1717-1745`)
- [high][confirmed] bot-arch-6 - Pruning thread e cap 200 nelle revisions (`poller.ts:2007-2015`)
- [medium][confirmed] bot-arch-7 - Race in `PollerManager.ensure` (`services/poller-manager.ts:108-122`)
- [high][confirmed] bot-arch-8 - Segnali backend->Discord senza consumer (`notifications/service.rs:251-267`)
- [medium][confirmed] bot-arch-9 - Policy di lifecycle nel bot (`poller.ts:1714-1780`)
- [high][confirmed] bot-arch-10 - Sync alleanza si ferma al DB; poller alleanza forse mai inizializzato (`poller.ts:476-504`)
- [medium][confirmed] bot-arch-11 - Fallimenti di consegna invisibili (`poller.ts:913-925`)
- [medium][confirmed] bot-arch-12 - /event-create ridotto; superficie diversa per tenant kind (`commands/event-create.ts:7-67`)
- [low][confirmed] bot-arch-13 - Regole di business duplicate nel bot (`services/split-summary.ts:46-60`)
- [medium][confirmed] bot-arch-14 - Poll sequenziale, `pollNow` no-op, fetch senza timeout (`poller.ts:472-508`)
- [medium][confirmed] bot-arch-15 - Round trip prima del defer (`services/command-gate.ts:47-87`)
- [medium][confirmed] bot-arch-16 - Pannello calendario mantenuto fuori da modalità calendar (`poller.ts:1208-1275`)
- [medium][confirmed] bot-arch-17 - Head-of-line nel sync split (`poller.ts:1907-1942`)
- [low][confirmed] bot-arch-18 - Crescita illimitata dello stato (`poller.ts:329-336`)
- [low][confirmed] bot-arch-19 - Message XP senza batch (`index.ts:261-298`)
- [medium][confirmed] bot-arch-20 - GUILD_NAME globale per ogni tenant (`config.ts:26`)
- [medium][plausible] bot-arch-21 - Architettura target outbox + push (`events/fanout_outbox.rs:1-60`)

**parity**
- [high][confirmed] parity-1 - Iscrizione web agli eventi alleanza bloccata (`event-detail.ts:5515-5521`)
- [high][confirmed] parity-2 - Link split a evento chiama PUT inesistente (`event-detail.ts:5153`)
- [medium][confirmed] parity-3 - La Discord alleanza non gestisce eventi (`services/command-gate.ts:22-31`)
- [medium][confirmed] parity-4 - Bank del bot ignora il multi-guild alleanza (`commands/balance-request.ts:17-22`)
- [medium][confirmed] parity-5 - Endpoint di salute del sync senza superficie (`events/router.rs:195-197`)
- [low][plausible] parity-6 - Autorità di gestione duplicata nel client (`event-detail.ts:3229-3248`)
- [medium][confirmed] parity-7 - Applications senza lista, trials senza ciclo di vita (`applications/router.rs:56-62`)
- [medium][confirmed] parity-8 - /event-create ridotto (`commands/event-create.ts:7-84`)
- [low][confirmed] parity-9 - Flash solo da Discord (`events/events.ts:911-925`)
- [low][confirmed] parity-10 - Risoluzione utente del bot in 3 chiamate (`api/resolve-user.ts:10-48`)
- [medium][confirmed] parity-11 - Gap self-service (donate, giveaway, VOD, regear) (`splits/router.rs:124`)
- [low][plausible] parity-12 - Flussi officer in un solo client (`commands/applications-panel.ts:6-34`)
- [low][plausible] parity-13 - Permessi diversi per client (`auth/rbac.rs:290-304`)
- [low][plausible] parity-14 - Circa 45 rotte senza consumer (`modules/mod.rs:46-80`)
- [low][confirmed] parity-15 - Invito alleanza non rifiutabile (`admin/admin-alliance.ts`)
- [low][plausible] parity-16 - `link_player` e `register_by_ign` copia-incolla (`albion/router.rs:295-350`)
- [low][confirmed] parity-17 - Giveaway detail senza guard; bot senza unlink (`app.routes.ts:288-299`)

**backend-perf**
- [high][confirmed] backend-perf-1 - `for_scope` crea una cache vuota a ogni richiesta (`battles/service.rs:93`)
- [high][confirmed] backend-perf-2 - Linker: fino a 100 pagine per evento ogni 30s (`events/service.rs:4277-4302`)
- [high][confirmed] backend-perf-3 - /fights carica tutto e parsa JSON (`fights.rs:485-577`)
- [medium][confirmed] backend-perf-4 - Extractor di auth costoso, senza cache negativa (`auth/rbac.rs:116-155`)
- [medium][confirmed] backend-perf-5 - Audit sincrono, `Client::new()` senza timeout (`audit/service.rs:112-155`)
- [medium][confirmed] backend-perf-6 - Lista bank alleanza seriale e in memoria (`bank/alliance.rs:265-290`)
- [medium][confirmed] backend-perf-7 - Pool per tenant senza limiti; `evict` rilancia migrazioni (`postgres.rs:109-117`)
- [medium][confirmed] backend-perf-8 - battle_sync: snapshot completi per i check (`battle_sync.rs:132-145`)
- [medium][confirmed] backend-perf-9 - Worker in lockstep, nessun limitatore upstream (`lib.rs:114-130`)
- [medium][confirmed] backend-perf-10 - Guild report carica JSON completi (`intel/report.rs:496-565`)
- [medium][confirmed] backend-perf-11 - Roster/partecipanti N+1 (`events/service.rs:1580-1635`)
- [low][confirmed] backend-perf-12 - Prezzi di mercato senza cache (`battles/service.rs:262-270`)
- [low][confirmed] backend-perf-13 - `AlbionApiClient` ricostruito a ogni chiamata (`albion/client.rs:200-209`)
- [medium][confirmed] backend-perf-14 - `list_my_battles` seriale (`battles/service.rs:444-505`)
- [low][confirmed] backend-perf-15 - Aprire una battle esegue tutta la persistenza (`battles/evidence_writer.rs:173-222`)
- [low][confirmed] backend-perf-16 - Nessuna compressione/timeout/limiti; catalogo clonato (`lib.rs:153-205`)
- [low][confirmed] backend-perf-17 - Deep copy della comp a ogni target (`events/fanout_worker.rs:163-190`)
- [low][confirmed] backend-perf-18 - Altri N+1 (`events/service.rs:1407-1445`)
- [low][confirmed] backend-perf-19 - Tre query di conteggio per lista e LIKE senza indice (`events/service.rs:2699-2706`)
- [low][confirmed] backend-perf-20 - Indice mancante su `event_battles.albionbb_battle_id` (`migration/m20260713_000002_create_event_battles.rs:63-70`)
- [high][confirmed] backend-perf-21 - Fights classifica da Config globale (`fights.rs:719-725`)
- [low][confirmed] backend-perf-22 - File "god" e helper duplicati (`events/service.rs:1`)

**frontend**
- [medium][confirmed] frontend-1 - Stato sync alleanza invisibile nella UI (`events/router.rs:196`)
- [medium][confirmed] frontend-2 - Selezione prelievi calcolata nel browser (`bank/bank.ts:909`)
- [medium][confirmed] frontend-3 - Cambio tenant su /dashboard mostra dati vecchi (`layout/tenant-rail/tenant-rail.ts:233`)
- [low][plausible] frontend-4 - Orari evento nel fuso del browser (`events/events.ts:898`)
- [low][confirmed] frontend-5 - Fee, net e quote split ricalcolate nel client (`splits/split-detail.ts:1148`)
- [medium][confirmed] frontend-6 - Nessun data layer: 394 fetch manuali (`core/services/api.service.ts:57`)
- [medium][confirmed] frontend-7 - Dizionari i18n tutti nel bundle (`core/services/translate.service.ts:3`)
- [low][plausible] frontend-8 - SSR renderizza solo il login e fa hop su Nitro (`core/services/auth.service.ts:160`)
- [medium][confirmed] frontend-9 - Nessuna gestione errori HTTP globale (`app.config.ts:23`)
- [low][confirmed] frontend-10 - Conteggi e "attention" derivati dalle liste (`events/events.ts:809`)
- [low][confirmed] frontend-11 - Due design system impilati (`styles.css:1722`)
- [low][confirmed] frontend-12 - Flash del tema; font bloccanti (`core/services/theme.service.ts:79`)
- [low][confirmed] frontend-13 - `event-detail` da 6.230 righe con ticker a 1s (`events/event-detail.ts`)
- [low][confirmed] frontend-14 - Stringhe hardcoded fuori dall'i18n (`events/event-detail.ts:4984`)
- [medium][confirmed] frontend-15 - Lacune di accessibilità (`app.routes.ts:19`)
- [low][plausible] frontend-16 - Nessuna esperienza dedicata per le alleanze (`dashboard/dashboard.ts:707`)
- [low][confirmed] frontend-17 - Realtime solo sul roster (`core/services/realtime-roster.service.ts:25`)
- [low][confirmed] frontend-18 - Tipi API scritti a mano (`core/models/api.models.ts`)
- [low][confirmed] frontend-19 - Primitive incoerenti (`admin/admin-alliance.ts:347`)