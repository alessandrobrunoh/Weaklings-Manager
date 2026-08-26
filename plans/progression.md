# Piano: Progression (XP, livelli, season, VOD, warn)

**Branch**: `feat/progression` (branch nuovo, non `feat/intel-and-redesign`)
**Status**: Active — assunzioni aggiornate dopo il feedback (season modellabile, soglia warn, niente auto-kick).

## Goal

Ogni account gildato ha XP e livello legati a una **season modellabile** (allineata ad Albion, date spostabili). Guadagni XP dalle azioni reali (Discord + pannello), vedi rank/leaderboard/profilo, gli officer gestiscono curve/rate/XP/livello/moltiplicatori, e c'è un registro warn con audit: a N warn gli admin vengono avvisati di kickare a mano.

## Assunzioni di prodotto (in assenza di risposte)

Queste sono scelte di default, tutte visibili in admin dove ha senso. Se una è sbagliata, va cambiata prima dello slice che la tocca.

1. **Season = reset**. Quando una season chiude, XP e livello della season ripartono da 0. Le season passate restano in archivio (leaderboard storica). Sul profilo si mostra anche un **lifetime XP** (somma di tutte le season) solo come metrica, non come livello.
2. **Season modellabile**. Allineata di default alla season Albion, ma **non è fissa**: un admin crea/attiva una season e può **allungarla o accorciarla** in qualsiasi momento (`starts_at` / `ends_at` / nome). Chiudere prima = fine anticipata (niente più XP). Spostare `ends_at` in avanti = overtime. Fuori da una season attiva **non si assegna XP**. Niente scraping da albiononline.com.
3. **XP dal pannello ≠ ogni click**. Solo azioni di contributo, rate configurabili, default sotto. Login/viste/refresh = 0 XP (altrimenti si farma).
4. **VOD**: slash `/vod` lanciato **dentro** il thread forum della persona. Il bot verifica canale forum + ownership del thread, estrae/accetta un URL, assegna XP una volta per URL per season.
5. **Warn ≠ kick/ban automatico**. Registro disciplinare completo (tutti i warn, anche revocati), ogni issue/revoke va in `audit_logs`. Soglia configurabile in admin (`warn_threshold`, default **3**). Al raggiungimento: **non** si kicka/banna da soli — si **segnala agli admin** (ping Discord + badge persistente in pannello) che devono kickare dalla gilda Albion e rimuovere dal Discord. Un warn può (opzionale) attaccare un moltiplicatore XP con scadenza. Si può settare un moltiplicatore anche senza warn.
6. **Nessun reward di ruolo Discord** in v1 (niente auto-role a livello N). Solo XP, livello, leaderboard, profilo, admin. I ruoli si possono aggiungere dopo.

### Catalogo XP di default (tutto editabile in admin)

| Sorgente | Default | Note |
|---|---|---|
| Messaggio Discord | 1 | Cooldown 60s, min 2 char, ignora bot, idempotente su `message_id` |
| Crea evento | 25 | Una volta per `event_id` (chi lo crea) |
| Join evento | 10 | Una volta per `(user, event)` |
| Completa evento (era nello roster a stop) | 15 | Bonus presenza, non al posto del join |
| Pubblica VOD (`/vod`) | 40 | Una volta per URL per season |
| Altre azioni pannello | 0 | Rate a 0, accese in admin se servono dopo |

### Curva livelli (editabile)

- Livello 1 = 0 XP.
- XP **cumulativo** per raggiungere il livello `n` (n ≥ 2):

```
threshold(n) = round(base * (n - 1) ^ exponent)
```

Default: `base = 100`, `exponent = 1.5`, `max_level = 50`.

Esempi: L2 = 100, L5 ≈ 800, L10 ≈ 2700, L20 ≈ 8300. Più sali, più XP serve — come richiesto.

Admin può cambiare `base`, `exponent`, `max_level`. Al save si ricalcola il livello di tutti **nella season attiva** (XP restano, cambia solo la soglia).

Moltiplicatore 0.5 su 1 XP messaggio: si usa un **remainder** per-account così 2 messaggi a 0.5x = 1 XP, non si perde tutto per arrotondamento.

---

## Architettura

Nuovo modulo backend `apps/backend/src/modules/progression/` sullo stesso pattern di `regear` / `siphoned` (entities, models, router, service, migration, permissions). Il bot e gli altri moduli **non calcolano XP**: chiamano `ProgressionService::award`.

```
Discord message / slash / events.service / /vod
        │
        ▼
ProgressionService::award(user, source, idempotency_key)
        │  1. season attiva? else no-op
        │  2. già visto idempotency_key? else no-op
        │  3. rate da settings per source (0 = skip)
        │  4. applied = floor(base * multiplier + remainder)
        │  5. ledger + update xp/level/remainder
        │  6. audit_logs
        ▼
GET profilo / leaderboard / Discord embed
```

Hook eventi: dentro `events::service::create_event` e `participate` (e lo stop roster) — un `award` fire-and-log, **non** deve far fallire create/join se l'XP fallisce.

Il bot oggi ha solo intent `Guilds`. Per 1 XP/messaggio servono **GuildMessages + MessageContent** (intent privilegiato da accendere nel Discord Developer Portal).

Utente senza `users.discord_id` collegato: il messaggio si ignora (niente account fantasma).

---

## Domain model

### `progression_seasons`

| Campo | Note |
|---|---|
| `id` | PK |
| `name` | es. `Albion Season 25` |
| `starts_at` / `ends_at` | timestamptz, **editabili anche a season in corso** (allunga/accorcia) |
| `is_active` | al più una attiva (partial unique index) |
| `updated_at` / `updated_by_user_id` | chi ha spostato le date; audit su ogni edit |

### `progression_settings` (singleton, come `guild_settings`)

Curve: `xp_base`, `xp_exponent`, `max_level`.
Rate: `xp_message`, `xp_event_create`, `xp_event_join`, `xp_event_complete`, `xp_vod`.
Anti-farm: `message_cooldown_secs`, `message_min_chars`.
VOD: `vod_forum_channel_id`.
Warn: `warn_threshold` (default 3, ≥ 1).
Opzionale deny-list canali messaggi (JSON array di snowflake).
Canale/role ping per escalation warn: riusa `discord_audit_log_channel_id` + eventuale `discord_event_role_id`, oppure un campo dedicato `discord_staff_channel_id` se l'audit è troppo rumoroso — default audit channel.

### `progression_accounts`

Una riga per `(user_id, season_id)`.

| Campo | Note |
|---|---|
| `xp` | i64 ≥ 0 |
| `level` | denormalizzato da `xp` + curva |
| `lifetime_xp` | no — lifetime = SUM sulle season, query |
| `xp_multiplier` | `Decimal`, default 1.0, clamp `[0, 5]` |
| `multiplier_expires_at` | se scaduto, award resetta a 1.0 |
| `xp_remainder` | frazione 0..1 per i mezzi XP |
| `last_message_xp_at` | cooldown messaggi |

### `progression_xp_ledger`

Append-only. Unique `(season_id, idempotency_key)`.

| Campo | Note |
|---|---|
| `source` | `message` / `event_create` / `event_join` / `event_complete` / `vod` / `admin_adjust` |
| `base_amount` | rate prima del moltiplicatore |
| `applied_amount` | dopo moltiplicatore (può essere negativo solo per admin) |
| `multiplier_at_time` | snapshot |
| `idempotency_key` | es. `msg:{discord_message_id}`, `event_join:{event_id}:{user_id}`, `vod:{url_hash}` |
| `actor_user_id` | chi ha forzato (admin) oppure null |

### `vod_reviews`

| Campo | Note |
|---|---|
| `user_id`, `season_id` | |
| `url` | normalizzata |
| `discord_thread_id`, `discord_message_id` | |
| `created_at` | Unique `(season_id, url)` |

### `user_warns`

| Campo | Note |
|---|---|
| `user_id` | target |
| `issued_by_user_id` | officer |
| `reason` | testo obbligatorio |
| `severity` | `note` / `warn` / `strike` |
| `multiplier` | opzionale, se presente scrive anche `progression_accounts.xp_multiplier` |
| `multiplier_expires_at` | opzionale |
| `revoked_at` / `revoked_by` | unwarn **non cancella**, revoca; toglie 1 dal conteggio soglia |
| `created_at` | |

Conteggio soglia = warn **non revocati** (lifetime visibile a parte). Niente auto-kick/ban.

### `warn_escalations`

Una riga quando il conteggio attivo raggiunge `warn_threshold`. Resta aperta finché un admin non la marca handled (dopo il kick manuale).

| Campo | Note |
|---|---|
| `user_id` | |
| `threshold_at_time` | snapshot della soglia (se poi la cambiate in admin) |
| `warn_count_at_time` | |
| `opened_at` | |
| `acknowledged_at` / `acknowledged_by` | admin conferma “kicked / handled” |
| Unique aperto | al più una escalation **aperta** per user |

---

## Permissions (nuove chiavi)

| Key | Default |
|---|---|
| `progression.view` | Member+ (proprio XP; leaderboard pubblica gilda) |
| `progression.settings.manage` | Admin+ |
| `progression.adjust` | Officer+ (add/set XP, set livello, set moltiplicatore) |
| `warns.view` | Officer+ |
| `warns.issue` | Officer+ |
| `vod.submit` | Member+ |

Seed migration come `m20260812_000003_seed_regear_permissions`. Aggiornare `Permission::all().len()` nel test esistente.

---

## Superfici

### Backend API (`/api/progression`, `/api/warns`, `/api/vods`)

- `GET /progression/me` — season, xp, level, xp_to_next, multiplier, rank
- `GET /progression/leaderboard?season_id=` — paginato, default season attiva
- `GET /progression/users/{id}` — stesso shape (member: solo self; officer: chiunque)
- `GET /progression/users/{id}/ledger`
- `POST /progression/award/message` — **solo bot** (`X-Bot-Secret`), body `{ discord_id, message_id, channel_id, length }`
- `POST /vods` — body `{ url, discord_thread_id, discord_message_id }` (bot o user)
- `GET /vods/me` e listing officer
- `PUT /progression/settings` + `GET` (include `warn_threshold`)
- `POST /progression/seasons` — crea
- `PUT /progression/seasons/{id}` — **modella** nome/`starts_at`/`ends_at` anche se attiva (allunga o accorcia; `ends_at` nel passato chiude di fatto gli award)
- `PUT /progression/seasons/{id}/activate` — unica attiva
- `POST /progression/users/{id}/adjust` — `{ set_xp? , add_xp?, set_level?, set_multiplier?, multiplier_expires_at?, reason }`
- `POST /warns`, `GET /warns` (lista **globale**, filtri user/severity/attivi/revocati), `GET /warns?user_id=`, `POST /warns/{id}/revoke`
- `GET /warns/escalations` — aperte + storiche; `POST /warns/escalations/{id}/ack`

### Discord

| Comando | Chi | Cosa |
|---|---|---|
| `/rank` `[member]` | tutti | embed livello, XP, barra, rank, moltiplicatore se ≠ 1 |
| `/leaderboard` | tutti | top 10 season |
| `/vod` `url:` | tutti | da lanciare nel proprio thread forum |
| `/xp add` `user amount reason` | officer | |
| `/xp set` / `/level set` / `/xp multiplier` | officer | |
| `/warn` `user reason [severity] [multiplier] [days]` | officer | audit + eventuale escalation |
| `/warns` `[user]` | officer | senza user: ultimi / escalation aperte; con user: storico completo |
| `/unwarn` `id` | officer | revoca (non cancella) |

`/me` esistente: aggiunge un field Season (livello + XP).

`MessageCreate`: POST award/message. Rate-limit lato bot (non await la reply).

Intent: `Guilds | GuildMessages | MessageContent`. Documentare il toggle nel Developer Portal.

### Pannello Angular

- **Profilo** (`features/settings`): card livello, barra XP, rank, lifetime, warn count se officer guarda altri.
- **Leaderboards**: nuovo tab `Season XP` accanto a payout/kills/… (stesso layout podio).
- **Users**: colonne Level, XP, Multiplier; drawer/dettaglio officer con ledger, warn, azioni adjust.
- **Admin**: sezione Progression — curva (preview L1–L20), rate XP, cooldown, forum VOD id, `warn_threshold`, **editor season** (crea, attiva, sposta inizio/fine per allungare/accorciare, rinomina).
- **Warns** (pagina `/warns`, officer+): lista **tutti** i warn (attivi e revocati), filtri, dettaglio user. Banner/coda **Action required** per chi ha toccato la soglia e non è ancora ack. Da lì si ack dopo il kick manuale. Niente bottone “kick Discord” in v1 (l'admin lo fa a mano, come richiesto).

i18n: `en.ts` / `it.ts` / `es.ts` (il resto del pannello è già trilingue).

---

## Slices (verticali, 1 PR ciascuno)

Ogni slice lascia i test verdi e il binario avviabile. Niente layer-cake “prima tutto il DB”.

### Slice 1 — Walking skeleton: award XP e vedi il proprio livello

**Value**: Un member autenticato guadagna XP (via API interna/test) e vede livello/XP della season.
**Path**: `POST` award (admin/test o servizio) → `ProgressionService` → tabelle season/account/ledger → `GET /progression/me`.
**AC**:
- Esiste una season attiva seedabile.
- `award` incrementa XP, ricalcola livello con la formula default, è idempotente sulla stessa key.
- Senza season attiva, `award` è no-op (nessuna riga ledger).
- `GET /me` torna `{ level, xp, xp_to_next, rank, multiplier }`.
**RED**: test service su formula, idempotency, no-op senza season, remainder 0.5×1 XP.
**GREEN**: migration + entities + service + router me/award minimo.
**Done**: test pass, OpenAPI aggiornato.

### Slice 2 — Admin: curva, rate, season

**Value**: Un admin cambia curva/rate e **modella la season** (allunga, accorcia, rinomina, chiude, ne apre un'altra) senza redeploy.
**Path**: pagina Admin → `PUT /progression/settings` + `PUT /progression/seasons/{id}` → i prossimi award usano i nuovi numeri/date; ricalcolo livelli sulla season attiva se cambia la curva.
**AC**:
- preview soglie; `base > 0`, `exponent ≥ 1`, `max_level ≥ 1`, rate ≥ 0, `warn_threshold ≥ 1`
- una sola season attiva
- edit `ends_at` in avanti mentre è attiva = si continua a dare XP oltre la data originale
- edit `ends_at` nel passato (o disattiva) = stop immediato degli award
- ogni cambio date/nome finisce in `audit_logs`
**RED**: test validazione, ricalcolo livello dopo cambio curva, award no-op se `now > ends_at` anche con `is_active`, award riprende se si sposta `ends_at` in avanti.
**GREEN**: settings UI admin (pattern `guild_settings`) + form date season.

### Slice 3 — 1 XP per messaggio Discord + `/rank`

**Value**: Scrivere in gilda fa salire il livello; `/rank` lo mostra.
**Path**: `MessageCreate` → `POST /progression/award/message` (bot secret) → ledger → `/rank` legge `/progression/me`.
**AC**: cooldown, min chars, bot ignorati, user non linkato ignorato, stesso `message_id` non doppio XP; intent documentati.
**RED**: test cooldown e idempotency message_id.
**GREEN**: intent sul client, handler, comando `/rank`, field su `/me`.

### Slice 4 — XP eventi (create / join / complete)

**Value**: Organizzare e presentarsi agli event paga XP, da Discord e dal pannello (stesso service).
**Path**: `create_event` / `participate` / stop-con-roster → `award` con key stabile.
**AC**: leave **non** toglie XP; doppio join non doppia; complete solo se ancora nello roster a stop; fallimento XP non rollbacka l'evento.
**RED**: test hook con db di service events (o test ProgressionService + mock caller).
**GREEN**: tre chiamate `award` nei punti esistenti.

### Slice 5 — VOD reviews

**Value**: Un member pubblica una VOD nel suo thread forum, lancia `/vod`, prende XP.
**Path**: `/vod` nel thread → bot verifica `channel.parentId == vod_forum_channel_id` e `thread.ownerId == user` → `POST /vods` → award `vod:{url}`.
**AC**: fuori dal forum → errore chiaro; URL duplicato in season → 409 senza XP; forum id mancante in settings → errore “non configurato”.
**RED**: test unique URL, reject channel sbagliato (service riceve thread metadata dal bot).
**GREEN**: tabella `vod_reviews`, comando, setting canale in admin.

### Slice 6 — Leaderboard + profilo + roster

**Value**: Tutti vedono chi sta grindando; sul profilo e in Users si vede XP/livello.
**Path**: `GET /progression/leaderboard` → tab Leaderboards; card profilo; colonne Users.
**AC**: default season attiva; filtro season passata; rank 1 = più XP; parità → `user_id` stabile; member non vede ledger altrui, officer sì.
**RED**: test ordinamento e rank.
**GREEN**: tab + card + colonne + `/leaderboard` Discord.

### Slice 7 — Officer adjust XP / livello / moltiplicatore

**Value**: Un officer può premiare, penalizzare o correggere un account.
**Path**: Users drawer / slash `/xp` `/level` → `POST .../adjust` → ledger `admin_adjust` + audit.
**AC**: `set_level` scrive l'XP **minimo** di quel livello; `add_xp` può essere negativo ma XP non scende sotto 0; `set_multiplier` clamp `[0, 5]`; reason obbligatorio; permesso `progression.adjust`.
**RED**: test clamp, floor 0, set_level → threshold(n).
**GREEN**: UI officer + comandi.

### Slice 8 — Warn + soglia + audit + alert admin

**Value**: Gli officer registrano i warn; a N warn (default 3, editabile) gli admin vengono **avvisati** di kickare a mano. Storico completo, niente auto-kick.
**Path**: `/warn` o `/warns` pannello → `user_warns` + `audit_logs` → se count attivo ≥ `warn_threshold` apre `warn_escalations` + ping canale staff → admin kicka Discord/gilda a mano → ack in pannello.
**AC**:
- reason obbligatorio; issue e revoke sempre in `audit_logs`
- pagina globale con **tutti** i warn (attivi e revocati), filtri user/severity
- `warn_threshold` in admin, default 3
- al crossing della soglia: escalation aperta (idempotente), ping Discord, badge “action required”
- **nessun** kick/ban/API Discord di rimozione
- revoke decrementa il conteggio; se si torna sotto soglia l'escalation aperta resta (serve comunque ack) — meglio: se revoke porta sotto soglia e non è ancora ack, si chiude in automatico come `revoked_under_threshold` così non resta un falso allarme
- target vede i propri warn sul profilo; officer vedono tutto
- multiplier opzionale sul warn; expiry → prossimo award resetta a 1
**RED**: test count solo non-revocati, crossing soglia crea 1 escalation, secondo warn oltre soglia non ne apre un'altra, revoke sotto soglia chiude l'aperta, audit rows su issue/revoke/ack.
**GREEN**: pagina `/warns`, setting soglia, comandi `/warn` `/warns` `/unwarn`, ping bot sul canale staff.

---

## Fuori scope v1

- Auto-role Discord per fascia di livello
- Shop / ricompense
- XP per kill/death Albion o per regear
- Warn → kick/ban/remove-role **automatico** (solo alert + coda “action required”)
- Scraping date season da albiononline.com (le date le modellate voi, anche a season in corso)
- Auto-creazione del thread forum al primo `/vod` (v1: il thread deve già esistere, nome = display name gilda)

---

## Rischi e vincoli

- **Message Content intent** è privilegiato: senza toggle sul bot, 1 XP/messaggio non parte.
- **Farm messaggi**: cooldown + min length + remainder; in admin si può deny-listare canali spam.
- **`/vod` farm**: unique URL + deve stare nel forum configurato. Non si verifica che il link sia davvero una VOD (fiducia + officer).
- **Cambio curva a season in corso**: ricalcola i livelli, può far scendere il livello visibile. Va detto in UI (“i livelli si ricalcolano, l'XP no”).
- **Volume ledger messaggi**: una gilda attiva genera tante righe. Indici `(season_id, user_id, created_at)` e `(idempotency_key)`. Non aggregare in v1.
- XP hooks non devono rompere events: `award` cattura l'errore e logga.

---

## Pre-PR quality gate

Per ogni slice: test modulo + `cargo test` backend toccato, typecheck frontend se UI, i18n en/it/es, permission seed + test `all().len()`, OpenAPI se nuovi path.

---

*Assunzioni lockate: branch `feat/progression`, season reset + date modellabili, catalogo XP, VOD con `/vod` verificato, warn con soglia alert (default 3) e audit, niente auto-kick/auto-role. Correggi prima dello Slice 1 se qualcosa non torna.*
