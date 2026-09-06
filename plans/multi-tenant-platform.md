# Piano: trasformazione multi-tenant di Weaklings Manager

## Contesto

Weaklings Manager oggi è cablato per gestire **un solo server Discord** (una sola gilda Albion Online) end-to-end:

- `apps/backend/src/config.rs` carica un `Config` globale via `envy::from_env()` con `database_url` (una sola stringa di connessione Postgres), `discord_guild_id` (UN server), `super_admin_discord_id` (UN Discord ID in god-mode), `albion_guild_id`.
- `guild_settings` (`apps/backend/src/migration/m20260825_000001_create_guild_settings.rs`) è una tabella **singleton**: PK sempre `1`, un'unica riga per l'intero deployment, arricchita nel tempo con decine di colonne (canali Discord, testi delle candidature, impostazioni giveaway, fee di default degli split, ecc. — 15+ migrazioni successive fanno solo `ALTER TABLE guild_settings ADD COLUMN`).
- `roles`/`role_permissions` sono globali: nomi ruolo unici nel deployment, ognuno opzionalmente legato 1:1 a un ruolo Discord (`discord_role_id`) nell'unico server configurato.
- Nessuna delle ~30 tabelle di dominio (`events`, `splits`, `comps`, `users`, `battles`, `intel`, `progression`, `regear`, `giveaways`, `vods`, `warns`, `siphoned_energy_entries`, `discord_applications`, `audit_logs`, `notifications`, `fights`, `combat_scenarios`/`combat_runs`, ecc.) ha una colonna di scoping tenant — confermato via grep su tutti gli `entities.rs`.
- Il bot Discord (`apps/discord-bot/src/config.ts`) ha `DISCORD_GUILD_ID` come env var obbligatoria, usata per registrare gli slash command in un solo server (`services/registry.ts`) e per operazioni di lifecycle (`services/event-lifecycle.ts:80`); `SettingsService` è una cache singleton globale che interroga `GET api/admin/settings` senza alcun parametro di guild.
- Il frontend ha già un pannello `/admin` con RBAC (`is_superadmin`, `permissions: string[]`, guardie di route in `core/guards/auth.guard.ts`), ma **zero** nozione di server/tenant multipli in nessun punto (nessun selettore di server, `DiscordUserProfile` non porta alcun id di tenant).
- Non esiste nel codice alcuna nozione di "VIP", "piano", "feature flag", "regolamento" (grep a zero risultati in backend, bot e frontend).

**Obiettivo**: trasformare tutto questo in una piattaforma multi-tenant reale:
- più server Discord indipendenti (tenant), dati **completamente isolati** tra loro;
- un **ruolo di livello piattaforma** (superadmin) che gestisce tutti i tenant da un pannello dedicato, distinto dal pannello admin per-tenant già esistente;
- un **sistema di ruoli per-tenant** (almeno Base e VIP, estendibile) scoped al singolo server;
- **feature flag per-tenant**, per riservare funzionalità premium (sistema di regolamento, funzioni avanzate degli split) solo ai tenant/membri che le hanno sbloccate;
- il **bot Discord** reso capace di operare su più server contemporaneamente, in modo che l'aggiunta di un nuovo server Discord (nuovo cliente/tenant) sia un'operazione self-service e non un redeploy.

### Decisioni vincolanti (già discusse e confermate con l'utente)

| # | Decisione | Alternative scartate e perché |
|---|-----------|-------------------------------|
| 1 | **Isolamento dati**: uno **schema Postgres separato per tenant**, dentro lo stesso cluster/database Postgres (non una colonna `guild_id` condivisa, non un database fisico separato per tenant). | Colonna condivisa: scartata esplicitamente dall'utente (isolamento fisico voluto). Database fisico per tenant: scartato perché `CREATE DATABASE` richiede una connessione fuori-transazione con privilegi che molti Postgres gestiti (dietro PgBouncer in transaction-mode) non concedono, e molti hosting gestiti limitano aggressivamente il numero di *database* per istanza mentre sono permissivi sul numero di *schemi*. |
| 2 | **Login OAuth multi-tenant**: scope `guilds` + intersezione automatica con il registro tenant. | Tenant scelto a monte via sottodominio/query param: scartato per evitare lavoro di DNS/routing aggiuntivo quando il flusso "chiedi a Discord i server dell'utente" risolve lo stesso problema senza infrastruttura extra. |
| 3 | **"Split a pagamento"**: funzionalità **premium sopra il modulo split esistente** (che già gestisce `fee`, stato pending→richiesto→prelevato) — nessuna modifica di schema, solo gating via feature flag di funzioni già esistenti (sync forum Discord, gestione isole/tab). | Nuovo meccanismo di "pay-in"/contributo e split a rate: scartati come sovradimensionati rispetto a quanto richiesto: richiederebbero nuove colonne/stati su `splits`/`transactions` e (per le rate) infrastruttura di scheduling inesistente oggi. |
| 4 | **"Sistema di regolamento"**: visualizzazione **aperta a tutti i membri** (anche Base) una volta che il tenant ha attivato la feature; creazione/modifica riservata allo staff. | Visualizzazione riservata solo ai VIP: scartata, il regolamento di un server è per definizione qualcosa che *tutti* i membri devono poter leggere. |
| 5 | **Ruoli piattaforma**: nuova tabella dedicata (`platform_admins`/`platform_roles`) nel control-plane, non il singolo env var attuale. | Mantenere l'env var singolo: scartato, non permette a più persone di avere ruoli di livello piattaforma né un'interfaccia di gestione. |
| 6 | **Ampiezza**: il piano copre **tutti e 10 gli stadi** end-to-end (control-plane → tenant provisioning → OAuth → pannello piattaforma → ruoli/feature flag → regolamento → split premium → bot multi-guild → pulizia); l'esecuzione procede **stadio per stadio**, verificando ogni stadio prima di passare al successivo. | — |

---

## Architettura

### 1. Control-plane vs tenant-plane

**Decisione**: *schema-per-tenant* in un unico database/cluster Postgres.

**Giustificazione tecnica** (verificata leggendo `apps/backend/src/main.rs:60`, che oggi fa un'unica `sea_orm::Database::connect(&cfg.database_url)`):
- Un URL Postgres supporta il parametro `options=-csearch_path=<schema>` per fissare lo `search_path` di una connessione al momento del connect — sea-orm/sqlx lo passano attraverso senza modifiche, quindi "connessione per tenant" diventa "stessa DSN, stesso host, stesse credenziali, solo `search_path` diverso per pool". **Da validare con uno spike rapido a inizio Stadio 1**: è comportamento standard libpq/sqlx, ma non è mai stato esercitato così in questo codebase.
- La tabella di bookkeeping di `sea_orm_migration` (`seaql_migrations`) viene creata dentro qualunque `search_path` sia attivo sulla connessione — il tracciamento delle migrazioni è quindi **già per-schema gratis**, cosa non vera per un design a colonna condivisa (richiederebbe bookkeeping custom multi-tenant) e vera solo con più cerimonia per un design a database fisico separato.
- `CREATE SCHEMA` funziona su una connessione pooled normale; `CREATE DATABASE` no (Postgres lo vieta dentro una transazione, e molti Postgres gestiti — es. dietro PgBouncer transaction-mode — bloccano l'operazione o richiedono un percorso di connessione superuser dedicato).
- Molti hosting Postgres gestiti limitano aggressivamente il numero di *database* per istanza (es. Supabase: 1 DB per progetto) mentre sono permissivi sul numero di *schemi* per database — schema-per-tenant mantiene l'intera piattaforma deployabile su una singola istanza Postgres gestita anche quando il numero di tenant cresce.
- Storia operativa più semplice: un'unica connection string radice, un'unica routine di backup/restore (con `pg_dump --schema=tenant_x` disponibile per-tenant se mai servisse), un unico budget di `max_connections` da gestire (con cura — vedi nota sull'eviction della cache di connessioni più sotto).

**Cosa vive nel control-plane** (nuovo schema piccolo e dedicato, es. `public`, con un migratore separato):

```
tenants
  id               text primary key   -- l'ID del server Discord stesso (snowflake)
  slug             text not null unique
  name             text not null
  schema_name      text not null unique   -- es. "tenant_<discord_guild_id>"
  status           text not null check (status in ('provisioning','active','suspended'))
  owner_discord_id text
  created_at       timestamptz not null default now()
  suspended_at     timestamptz

platform_roles
  id        uuid primary key
  name      text not null unique      -- es. "SuperAdmin"
  priority  int not null

platform_role_permissions
  role_id     uuid references platform_roles(id) on delete cascade
  permission  text not null           -- set piccolo e fisso: tenants.manage, platform_admins.manage, feature_flags.manage
  primary key (role_id, permission)

platform_role_assignments
  discord_id       text not null
  platform_role_id uuid references platform_roles(id) on delete cascade
  assigned_at      timestamptz not null default now()
  assigned_by      text
  primary key (discord_id, platform_role_id)

feature_catalog
  key           text primary key      -- "regolamento", "splits.paid"
  display_name  text not null
  description   text

tenant_feature_flags
  tenant_id    text references tenants(id) on delete cascade
  feature_key  text references feature_catalog(key) on delete cascade
  enabled      boolean not null default false
  enabled_at   timestamptz
  enabled_by   text
  primary key (tenant_id, feature_key)
```

**Cosa vive per-tenant** (uno schema Postgres per server, es. `tenant_<discord_guild_id>`, migrato con l'insieme di migrazioni **esistente**, invariato nella forma): tutte le ~30 tabelle attuali — `users`, `roles`, `role_permissions`, `guild_settings`, `events`/`event_participations`/`event_battles`/`event_discord_roles`/`event_roster_roles`/`event_roster_assignments`, `splits`/`split_participants`/`split_bags`/`split_islands`/`split_island_tabs`, `transactions`, `comps`/`comp_categories`/`comp_builds`/`builds`/`build_items`/`build_categories`/`build_item_spells`, `battles`/`guild_battle_snapshots`/`fights`, `scouted_comps` (intel), progressione, `regear_deaths`, `giveaways`, `vods`, `warns`, `siphoned_energy_entries`, `discord_applications`, `audit_logs`, `notifications`, `combat_scenarios`/`combat_runs`. **Nessuna colonna `guild_id` necessaria** — l'isolamento è fisico, a livello di schema.

Diagramma logico:

```
                          ┌────────────────────────────────┐
                          │   Control-plane (schema unico)   │
                          │   tenants                          │
                          │   platform_roles / _permissions /  │
                          │     _assignments                    │
                          │   feature_catalog                    │
                          │   tenant_feature_flags                │
                          └────────────────┬───────────────────┘
                                           │ letto dal middleware di
                                           │ risoluzione tenant a ogni
                                           │ richiesta (con cache)
                                           ▼
        ┌───────────────────┐    ┌───────────────────┐    ┌───────────────────┐
        │ schema tenant_abc   │    │ schema tenant_def   │    │ schema tenant_xyz   │
        │ users, roles,        │    │ users, roles,        │    │ users, roles,        │
        │ role_permissions,    │    │ role_permissions,    │    │ role_permissions,    │
        │ guild_settings,      │    │ guild_settings,      │    │ guild_settings,      │
        │ events, splits,      │    │ events, splits,      │    │ events, splits,      │
        │ bank/transactions,   │    │ bank/transactions,   │    │ bank/transactions,   │
        │ ... (~30 tabelle)    │    │ ... (~30 tabelle)    │    │ ... (~30 tabelle)    │
        └───────────────────┘    └───────────────────┘    └───────────────────┘
```

### 2. Risoluzione del tenant a runtime (backend)

Leva chiave: ogni handler di ogni modulo estrae oggi `Extension<DatabaseConnection>` come tipo dal type-map di Axum (verificato in `apps/backend/src/modules/splits/router.rs` e strutturalmente identico in tutti gli altri moduli). Un middleware che inserisce una `DatabaseConnection` fresca in `req.extensions_mut()` **sovrascrive** quella impostata da un layer globale più esterno, senza toccare **nessuna firma di handler in nessun modulo**. Questo tiene il raggio d'impatto della modifica sorprendentemente piccolo per una modifica di questa portata.

Modifiche concrete:

- **`apps/backend/src/main.rs`** (oggi righe 58-64 e 121-138):
  - Sostituire l'unica `let db = sea_orm::Database::connect(&cfg.database_url).await?;` con:
    - `let control_db = sea_orm::Database::connect(&cfg.control_database_url).await?;` + `control_migration::Migrator::up(&control_db, None).await?;`
    - Un `TenantRegistry`/cache: `Arc<DashMap<TenantId, Arc<TenantContext>>>` dove `TenantContext { db: DatabaseConnection, permissions: Permissions, features: HashSet<String> }`, popolata **lazy** alla prima richiesta per quel tenant (connect con `search_path`, esegui migrazioni tenant se non già a livello, carica `Permissions::load`, carica le feature abilitate da `tenant_feature_flags`).
  - Nuovo middleware di risoluzione tenant (`tower::Layer` custom o `axum::middleware::from_fn`), innestato **attorno** a `nest("/api", modules::router())` in modo da essere il layer più interno (eseguito per ultimo, così le sue `Extension` vincono su qualunque layer globale residuo). Compiti: (a) legge `tenant_id` dal cookie di sessione (già presente nel profilo dopo la login multi-tenant, vedi sotto) oppure dall'header `X-Guild-Id` (richieste bot); (b) recupera/costruisce il `TenantContext` dalla cache; (c) inserisce `Extension(ctx.db.clone())`, `Extension(ctx.permissions.clone())`, `Extension(TenantFeatures(ctx.features.clone()))`.
  - Rotte che **non** devono passare dalla risoluzione tenant restano fuori dallo scope di questo middleware: il nuovo router `/api/platform/**` (usa solo `ControlDb`), `/api/health`, gli endpoint di bootstrap OAuth (`discord/login`, `discord/callback`) prima ancora che un tenant sia stato scelto.
  - `event_sessions::spawn` (riga 97) e `battle_sync::spawn` (riga 109) oggi sono **worker globali unici** avviati una volta con `db.clone()`. Diventano **worker per-tenant**: uno spawn per ogni riga `tenants` con `status = 'active'` all'avvio (enumerata da `control_db`), e un nuovo spawn ogni volta che un tenant viene provisionato a runtime (vedi Stadio 5/9). Questo è strutturalmente il pezzo più delicato del middleware — va isolato come sotto-task dedicato nello Stadio 3.
  - Nota di scalabilità (da documentare, non bloccante per l'MVP): la cache di connessioni per-tenant va evitata/scaduta quando un tenant è inattivo da tempo, per non esaurire `max_connections` su Postgres man mano che i tenant crescono — rimandato a un miglioramento operativo successivo, non blocca lo Stadio 3.

- **`apps/backend/src/config.rs`**: `Config` si restringe ai soli segreti/di-deployment:
  - **Resta in `Config`**: `backend_port`, `control_database_url` (rinominato da `database_url`), `discord_client_id`/`discord_client_secret`/`discord_redirect_uri` (un'unica app Discord OAuth condivisa da tutti i tenant — il bot/app Discord resta uno, sono i *server* Discord a moltiplicarsi), `bot_api_secret`, `discord_bot_token`, `session_secret`, `frontend_url`, `mistral_api_key`, config AlbionBB/AlbionData (timeouts/base url, questi restano globali perché sono impostazioni di un servizio esterno condiviso, non dati di un singolo tenant).
  - **Migra a dato per-tenant** (dentro `guild_settings`, estendendo il pattern già usato da `apps/backend/src/modules/admin/service.rs` per i canali Discord): `discord_guild_id` (diventa implicito = l'id del tenant stesso), `albion_guild_id`, `albion_allied_guild_ids`, `albion_allied_guild_names`, `albion_api_region` (un tenant potrebbe giocare su un server Albion diverso da un altro).
  - **Migra al control-plane**: `super_admin_discord_id` → sostituito da `platform_role_assignments`.

- **`apps/backend/src/modules/auth/rbac.rs`**:
  - `UserContext::is_superadmin()` (righe 45-53) oggi confronta `self.super_admin_id` (popolato da `Config.super_admin_discord_id`, righe 106-109) con `self.id`. Diventa una lookup contro una cache in-memory dei platform admin (`Arc<RwLock<HashSet<String>>>`, analoga a `Permissions`, ricaricabile allo stesso modo con un endpoint `/api/platform/admins/reload`), iniettata come `Extension<PlatformAdmins>` **globale** (non tenant-scoped: un superadmin lo è su tutti i tenant).
  - `try_from_session_cookie` (righe 99-121) e `try_from_bot_headers` (righe 132-253): il grosso della logica **non cambia**, perché continuano a leggere `parts.extensions.get::<DatabaseConnection>()` / `get::<Permissions>()` — che ora sono già quelli giusti del tenant corrente, inseriti dal middleware di risoluzione tenant che gira prima nello stack. L'unico vero cambiamento: la sorgente di `super_admin_id`/`is_superadmin` passa da `Config` a `PlatformAdmins`.
  - `try_from_bot_headers`: il ramo "bot system" (righe 178-192, nessun `X-Discord-Id`) deve continuare a funzionare per-tenant — dato che ormai gira dopo la risoluzione tenant basata su `X-Guild-Id`, riceve comunque il `DatabaseConnection`/`Permissions` giusti senza modifiche al suo corpo.
  - `BotSecret`/`BotDiscordUser` (righe 259-378): stesso trattamento — `cfg.super_admin_discord_id` (riga 342) diventa una lookup su `PlatformAdmins`.

### 3. Login OAuth multi-tenant

`apps/backend/src/modules/auth/service.rs`/`router.rs` (OAuth2 exchange + fetch profilo oggi implementati qui):
1. Aggiungere lo scope `guilds` all'URL di autorizzazione Discord (oltre a `identify`/`email` già presenti).
2. Dopo `fetch_profile` (righe 87-156 di `service.rs`), chiamare `GET https://discord.com/api/v10/users/@me/guilds` con il token utente per ottenere la lista dei server Discord di cui è membro.
3. Incrociare quella lista con `tenants.id` (= id del server Discord) nel control-plane.
   - **Zero match**: l'utente non appartiene a nessun tenant registrato → schermata di errore ("il tuo server non è ancora configurato su questa piattaforma").
   - **Un match**: procede direttamente, `tenant_id` risolto.
   - **Più match**: redirect a una nuova pagina "scegli il tuo server" (frontend, nuova rotta pubblica post-login) prima di finalizzare il cookie di sessione.
4. `DiscordUserProfile` (oggi in `apps/backend/src/modules/auth/service.rs`, righe 30-70) guadagna un campo `tenant_id: String`, serializzato nel cookie `session_user` esattamente come oggi (cifrato con `PrivateCookieJar`), e letto dal middleware di risoluzione tenant su ogni richiesta successiva.
5. `fetch_guild_member_role_ids`/`resolve_linked_roles` (righe 158-338) continuano a funzionare come oggi, ma ora usano `tenant_id` risolto (non più `Config.discord_guild_id`) per sapere in quale guild Discord cercare i ruoli del membro.
6. `upsert_user` (righe 256-289) oggi trova/crea una riga `users` **keyed by email globalmente** — ora scrive nella tabella `users` dello **schema del tenant risolto**, quindi l'unicità email/discord_id torna naturalmente scoped al tenant (la stessa persona può esistere in tenant diversi senza collisioni, essendo tabelle fisicamente separate).

Frontend: `apps/frontend/src/app/features/auth/` (login esistente) guadagna una nuova vista "scegli server" per il caso multi-match, e `DiscordUserProfile`/`auth.service.ts` (core/models/api.models.ts, core/services/auth.service.ts) guadagnano `tenant_id`/`tenant_name` nel profilo.

### 4. Strategia di migrazione

Due migratori sea-orm distinti, entrambi nel backend:

- **`apps/backend/src/control_migration/`** (nuovo modulo, piccolo, stesso pattern di `apps/backend/src/migration/mod.rs` ma con un proprio `Migrator`): crea `tenants`, `platform_roles`, `platform_role_permissions`, `platform_role_assignments`, `feature_catalog`, `tenant_feature_flags`. Eseguito una sola volta all'avvio, contro `control_db`. File nominati seguendo la stessa convenzione temporale già in uso (`m<data>_000001_create_tenants_table.rs`, ecc.).
- **`apps/backend/src/migration/`** (le ~100 migrazioni esistenti, **contenuto invariato**): diventano "migrazioni tenant", con due punti di esecuzione:
  1. **Provisioning di un nuovo tenant**: dopo `CREATE SCHEMA tenant_<id>`, aprire una connessione con quel `search_path` e chiamare `migration::Migrator::up(&tenant_db, None)` — riusa letteralmente ogni file di migrazione esistente senza modifiche, dato che ognuno emette solo `CREATE TABLE`/`ALTER TABLE` scoped a qualunque `search_path` sia attivo sulla connessione.
  2. **Avvio/manutenzione continua**: per ogni riga `tenants` con `status = 'active'`, connettersi con quel `search_path` ed eseguire di nuovo `Migrator::up` — idempotente, perché `seaql_migrations` traccia il progresso per-schema. Sostituisce l'attuale chiamata singola `migration::Migrator::up(&db, None)` (`main.rs:64`) con un ciclo sui tenant attivi. Con N tenant piccoli questo significa N connessioni sequenziali di controllo migrazione all'avvio: accettabile a piccola/media scala; da rivedere (parallelizzare, o un sotto-comando CLI `migrate` eseguito fuori banda prima del deploy) quando il numero di tenant cresce — miglioramento operativo dello Stadio 10, non blocca l'MVP.

- **Backfill del deployment attuale come "tenant #1"** — passo scriptato, non solo documentazione:
  1. Nuovo binario one-shot `apps/backend/src/bin/backfill_tenant_one.rs` (eseguito con `cargo run --bin backfill_tenant_one`): si connette al `database_url` **attuale** (oggi contiene tutte le ~30 tabelle nello schema `public`), crea la riga `tenants` nel control-plane usando il valore corrente di `Config.discord_guild_id` come id, crea un nuovo schema (es. `tenant_<quel_guild_id>`), e usa `ALTER TABLE ... SET SCHEMA tenant_<id>` per ogni tabella esistente — operazione **metadata-only**, nessuna copia fisica di dati, quindi rapida anche su tabelle grandi.
  2. Semina `platform_role_assignments` con il valore corrente di `Config.super_admin_discord_id` (una riga, un'unica volta).
  3. Verifica automatica: conteggio righe per tabella prima/dopo lo spostamento, con `assert_eq!` nello script (non solo un log) — lo script fallisce rumorosamente se un conteggio non torna.
  4. **Distruttivo/irreversibile** contro lo schema `public` originale: eseguire prima su uno snapshot/staging, poi in produzione con un `pg_dump` immediatamente precedente come rete di sicurezza.

---

## Stadi di implementazione (dettaglio)

### Stadio 1 — Schema control-plane + split migrazioni
- Aggiungere `control_database_url` a `Config` (rinominando `database_url`).
- Creare `apps/backend/src/control_migration/` con `mod.rs` (Migrator) + le migrazioni per `tenants`, `platform_roles`, `platform_role_permissions`, `platform_role_assignments`, `feature_catalog`, `tenant_feature_flags`.
- Nel `main.rs`, aggiungere la connessione e l'esecuzione del migratore control-plane **in parallelo** a quella tenant esistente (che per ora resta quella singola, non ancora sostituita dal loop multi-tenant — questo arriva nello Stadio 3).
- **Verifica**: `cargo test` (nessuna regressione attesa, nessun handler toccato ancora); avvio locale con un Postgres pulito, controllo manuale che entrambi i migratori girino senza conflitti (schemi diversi, nessuna collisione di nomi tabella).

### Stadio 2 — Backfill del deployment attuale come tenant #1
- Scrivere `backfill_tenant_one.rs` come descritto sopra.
- Eseguirlo prima su uno snapshot/staging Postgres, verificare i conteggi, poi (con `pg_dump` di sicurezza) in produzione.
- **Verifica**: query manuale post-backfill che conta le righe di 4-5 tabelle rappresentative (`users`, `events`, `splits`, `roles`) nello schema `public` originale (deve essere vuoto/assente) vs. nel nuovo schema `tenant_<id>` (deve matchare i conteggi pre-backfill).

### Stadio 3 — Middleware di risoluzione tenant + cache connessioni
- Implementare `TenantContext`, la cache `DashMap<TenantId, Arc<TenantContext>>`, il middleware di risoluzione (lettura da cookie o `X-Guild-Id`).
- Sostituire nel `main.rs` la singola connessione/migrazione tenant con il ciclo sui tenant attivi (usando ora il control-plane popolato dallo Stadio 1-2).
- Convertire `event_sessions::spawn`/`battle_sync::spawn` in worker per-tenant.
- Spostare `UserContext::is_superadmin()` (e gli equivalenti in `BotDiscordUser`) dal confronto con `Config.super_admin_discord_id` alla lookup su `PlatformAdmins`.
- **Verifica**: l'intera suite `cargo test` esistente deve continuare a passare **senza modifiche alle firme degli handler** (è esattamente il punto di questo design basato su `Extension`-override); aggiungere nuovi test di integrazione con due schemi tenant reali fianco a fianco che dimostrino l'isolamento (una query sulla connessione del tenant A non deve mai vedere righe del tenant B).

### Stadio 4 — Login OAuth multi-tenant
- Scope `guilds`, chiamata a `/users/@me/guilds`, intersezione con `tenants`, pagina "scegli server" per multi-match.
- `DiscordUserProfile` + cookie + frontend (`auth.service.ts`, nuova vista scelta server) aggiornati.
- **Verifica**: login end-to-end manuale con almeno 2 tenant seed (es. tenant #1 dal backfill + un secondo tenant di test creato manualmente nel control-plane), controllando che ciascun utente finisca nello schema giusto.

### Stadio 5 — Pannello piattaforma/superadmin
- Nuovo modulo backend `apps/backend/src/modules/platform/` (`entities.rs`, `router.rs`, `service.rs`) montato su `/api/platform/**`, **fuori** dallo scope del middleware di risoluzione tenant (usa solo `ControlDb`), protetto da un nuovo extractor `PlatformAdmin` (parallelo a `UserContext` ma legge solo `PlatformAdmins`/`ControlDb`).
  - Rotte: `GET/POST /api/platform/tenants`, `PATCH /api/platform/tenants/{id}` (sospendi/riattiva), `GET/PUT /api/platform/tenants/{id}/features`, `GET/POST/DELETE /api/platform/admins`.
- Nuova rotta Angular `/platform` (sorella di `/admin`, non annidata) in `apps/frontend/src/app/app.routes.ts`, guardata da un nuovo `platformGuard` in `core/guards/auth.guard.ts` (analogo a `permissionGuard`, ma controlla `profile.is_platform_admin`).
- Nuova feature `apps/frontend/src/app/features/platform/` con la stessa convenzione flat-file di `features/admin/`: `platform-hub.ts`, `platform-tenants.ts`, `platform-tenant-detail.ts`, `platform-admins.ts`, `platform-feature-flags.ts`.
- Estensione di `apps/frontend/src/app/layout/nav.ts`: `PLATFORM_PANELS`/`PLATFORM_NAV_SECTIONS` (analoghi a `ADMIN_PANELS`/`ADMIN_NAV_SECTIONS`), `isPlatformUrl()` (analogo a `isAdminUrl()`), così la sidebar cambia set di nav quando si è sotto `/platform` esattamente come già fa sotto `/admin`.
- Estensione di `DiscordUserProfile`/`auth.service.ts` con `is_platform_admin: boolean`.
- **Verifica**: click-through manuale di lista/creazione/sospensione tenant e assegnazione/revoca ruolo piattaforma; test unitari nuovi lato frontend (vitest) per i componenti principali.

### Stadio 6 — Ruoli VIP/Base per-tenant + feature flag
- Estendere il flusso di provisioning tenant (dentro `platform/service.rs`) in modo che, subito dopo aver eseguito le migrazioni tenant, semini automaticamente due righe nella tabella `roles` di quel tenant:
  - `Base` — `is_default = true` (così `fallback_unmatched_roles` in `apps/backend/src/modules/auth/service.rs` la assegna automaticamente a chi entra nel server Discord senza un ruolo collegato manualmente), `discord_role_id = NULL` (l'admin del tenant potrà collegarlo in seguito dalla UI esistente `admin-roles.ts`).
  - `VIP` — `is_default = false`, assegnato manualmente (collegando un ruolo Discord, come già oggi per qualunque ruolo). Seminare in `role_permissions` i permessi premium (es. `splits.paid.use`).
- `TenantFeatures` (calcolato dal middleware leggendo `tenant_feature_flags` dal control-plane) combinato con il check di permesso esistente `UserContext::require(&perms, Permission::X)`: **feature spenta → 404/403 anche per chi avrebbe il permesso di ruolo**, **feature accesa → serve comunque il permesso VIP**. Nessuna modifica al pattern `require`: si aggiunge un check `TenantFeatures::contains("splits.paid")` prima, nello stesso handler.
- Endpoint `POST /api/platform/tenants/{id}/features/reload` per invalidare/ricaricare la entry `TenantContext` di quel tenant nella cache dopo un toggle.
- **Verifica**: provisionare un nuovo tenant tramite `/api/platform/tenants` e controllare (via test o query DB manuale) che le due righe `roles` esistano automaticamente; toggle di un flag da `/platform` e verifica che l'endpoint gated risponda 403/200 di conseguenza.

### Stadio 7 — Sistema di regolamento (nuovo modulo)
- Nuova migrazione tenant (aggiunta all'insieme esistente in `apps/backend/src/migration/`, stessa convenzione di naming):
  ```
  rule_sections
    id          uuid primary key
    title       text not null
    body        text not null
    sort_order  int not null default 0
    created_at  timestamptz not null default now()
    updated_at  timestamptz not null default now()

  rule_acknowledgements
    id               uuid primary key
    section_id       uuid references rule_sections(id) on delete cascade
    user_id          bigint references users(id) on delete cascade
    acknowledged_at  timestamptz not null default now()
    unique (section_id, user_id)
  ```
- Nuovo modulo `apps/backend/src/modules/regolamento/` (`entities.rs`, `router.rs`, `service.rs`), stesso stile minimale del modulo `applications` esistente.
- Nuovi permessi in `apps/backend/src/modules/auth/permissions.rs`: `regolamento.manage` (autoria/staff); la **visualizzazione non richiede un permesso specifico** — chiunque sia autenticato nel tenant e con la feature attiva può leggere e confermare (decisione #4).
- Rotte: `GET /api/regolamento` (lista sezioni, tutti i membri), `POST /api/regolamento/{section_id}/acknowledge` (conferma lettura), `GET /api/regolamento/acknowledgements` (vista staff di chi ha/non ha confermato), `POST/PATCH/DELETE /api/regolamento/sections` (CRUD, richiede `regolamento.manage`).
- Registrazione in `apps/backend/src/modules/mod.rs` (`pub mod regolamento;` + `.nest("/regolamento", regolamento::router())`).
- Frontend: `apps/frontend/src/app/features/regolamento/regolamento.ts` (vista membro: legge sezioni, bottone "ho letto"), `apps/frontend/src/app/features/admin/admin-regolamento.ts` (CRUD sezioni + vista conferme, sotto `/admin` come le altre pagine admin esistenti), voce di navigazione in `layout/nav.ts`.
- Tutto il modulo gated dal feature flag `regolamento` (sia lato backend — 404 se spento — sia lato frontend — voce di nav nascosta).
- **Verifica**: `cargo test` per i nuovi service/router; `npm run test` per il nuovo componente frontend; click-through manuale (crea sezione come staff → verifica come membro → conferma lettura → verifica come staff che compaia nella lista conferme).

### Stadio 8 — Split a pagamento (funzioni premium sugli split esistenti)
- **Nessuna modifica di schema** a `splits`/`bank` (decisione #3).
- Individuare le funzionalità esistenti da riservare (candidate concrete, da confermare con l'utente al momento dell'implementazione): sync automatico su forum Discord (`apps/backend/src/modules/splits/discord_sync.rs`), gestione isole/tab (`split_islands`/`split_island_tabs`, permesso esistente `splits.islands.manage`).
- Avvolgere i relativi handler con lo stesso pattern `TenantFeatures::contains("splits.paid")` + `UserContext::require(&perms, Permission::SplitsIslandsManage)` già usato per `regolamento` — nessuna nuova infrastruttura, solo applicazione del pattern dello Stadio 6.
- Frontend: le sezioni corrispondenti in `apps/frontend/src/app/features/splits/` si nascondono/disabilitano quando il flag `splits.paid` è spento sul tenant o l'utente non ha il ruolo VIP, con un messaggio esplicativo ("funzione VIP") invece di sparire silenziosamente.
- **Verifica**: toggle del flag `splits.paid` da `/platform` e conferma che le funzioni si abilitino/disabilitino sia lato API (403) sia lato UI (nascoste/disabilitate) per utenti VIP vs Base.

### Stadio 9 — Bot Discord multi-guild
- `apps/discord-bot/src/config.ts`: rimuovere `DISCORD_GUILD_ID` (env var obbligatoria oggi) e `GUILD_NAME` (branding globale) dallo schema `Env` — il processo bot serve ormai ogni server in cui è installato, senza un "il" server.
- `apps/discord-bot/src/services/registry.ts`: `registerCommands()` (oggi senza argomenti, hardcoded su `config.DISCORD_GUILD_ID`) diventa `registerCommands(guildId: string)`, chiamata una volta per ogni guild presente in `client.guilds.cache` dentro l'handler `ClientReady` (invece che una volta sola prima del login).
- `apps/discord-bot/src/index.ts`: nuovo handler `client.on(Events.GuildCreate, async (guild) => { await registerCommands(guild.id); await api.post('api/platform/tenants', {...}); })` — l'aggiunta del bot a un nuovo server registra i comandi **e** provisiona il tenant lato backend nello stesso evento.
- `apps/discord-bot/src/services/event-lifecycle.ts:80`: `client.guilds.fetch(config.DISCORD_GUILD_ID)` (unico bypass hardcoded rimasto) sostituito risolvendo la guild dall'`interaction.guildId`/dall'evento che ha originato la chiamata (il dato è già disponibile ai chiamanti, che oggi lo scartano).
- `apps/discord-bot/src/services/settings.ts`: `SettingsService` (oggi singleton globale, TTL-cached, `GET api/admin/settings` senza parametro guild) diventa per-guild — mappa `Map<guildId, SettingsService>` o singleton con `guildId` passato a ogni metodo e cache interna keyed per guild. Tutti i call site (13+) vanno aggiornati per risolvere prima il `guildId` dell'interazione.
- `apps/discord-bot/src/api/client.ts`: aggiungere un parametro `guildId` obbligatorio a ogni metodo pubblico (`get`/`post`/`patch`/`put`/`delete`), emesso sempre come header `X-Guild-Id` (letto dal middleware di risoluzione tenant lato backend). Aggiornare ogni call site in `commands/`, `handlers/`, e il poller in background (`services/poller.ts`, che deve iterare tutti i tenant attivi invece di uno solo).
- **Verifica**: suite bot (`npm run test`, aggiornando le env var di test che oggi impostano `DISCORD_GUILD_ID=test`); smoke test manuale con il bot installato su due server Discord di prova in parallelo, verificando che i comandi funzionino indipendentemente e che nessuna impostazione trapeli da un server all'altro.

### Stadio 10 — Pulizia finale
- Rimozione dei campi `Config` ormai morti: `discord_guild_id`, `super_admin_discord_id`, `albion_guild_id` e i campi alleati globali (tutti migrati a dato per-tenant o control-plane negli stadi precedenti).
- Rimozione del vecchio `database_url` (sostituito da `control_database_url` + connessioni tenant dinamiche).
- Aggiornamento di `README.md`/`apps/backend/README.md` con le nuove istruzioni di deploy (due connection string concettuali — control-plane e template per tenant —, procedura di provisioning di un nuovo tenant).
- Documentare esplicitamente i follow-up operativi rimandati (non bloccanti per l'MVP): eviction della cache di connessioni per-tenant quando il numero di tenant cresce; parallelizzazione/CLI dedicata per il ciclo di migrazione multi-tenant all'avvio; un vero hook di abbonamento/billing per l'assegnazione automatica di VIP (oggi resta manuale/legata a un ruolo Discord).

---

## File critici

- `apps/backend/src/main.rs`, `apps/backend/src/config.rs`
- `apps/backend/src/modules/auth/rbac.rs`, `permission_cache.rs`, `service.rs`
- `apps/backend/src/migration/mod.rs` (nuovo `control_migration/` parallelo)
- `apps/backend/src/modules/splits/entities.rs`, `discord_sync.rs`, `apps/backend/src/modules/bank/entities.rs` (solo lettura/wrapping nello Stadio 8, nessuna modifica di schema)
- `apps/backend/src/modules/admin/service.rs` (pattern da estendere per i nuovi campi per-tenant di `guild_settings`)
- `apps/discord-bot/src/config.ts`, `services/registry.ts`, `services/settings.ts`, `services/event-lifecycle.ts`, `services/poller.ts`, `api/client.ts`, `index.ts`
- `apps/frontend/src/app/app.routes.ts`, `apps/frontend/src/app/layout/nav.ts`, `apps/frontend/src/app/core/guards/auth.guard.ts`, `apps/frontend/src/app/core/services/auth.service.ts`, `apps/frontend/src/app/core/models/api.models.ts`

## Verifica end-to-end

- **Backend**: `cargo test` in `apps/backend` a ogni stadio (la suite esistente non deve rompersi, dato che le firme degli handler non cambiano fino allo Stadio 6-8 dove si aggiungono, non modificano, i check); nuovi test di integrazione per l'isolamento tra tenant (due schemi, query che non devono incrociarsi) introdotti nello Stadio 3.
- **Bot**: `npm run test` in `apps/discord-bot`, aggiornando le env var di test rimuovendo `DISCORD_GUILD_ID` allo Stadio 9.
- **Frontend**: `npm run test` (vitest) in `apps/frontend`.
- **Manuale, end-to-end completo**: provisioning di un secondo tenant reale — bot invitato su un secondo server Discord → tenant creato automaticamente (via `GuildCreate`) → login di un membro con scelta del server tra i due disponibili → ruoli Base/VIP seedati automaticamente → toggle dei feature flag `regolamento` e `splits.paid` da `/platform` → verifica che il regolamento sia visibile a tutti i membri del tenant e le funzioni split premium solo ai VIP, e che nulla di tutto questo sia visibile/accessibile dal primo tenant o viceversa.
