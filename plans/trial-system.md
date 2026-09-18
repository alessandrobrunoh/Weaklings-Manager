# Plan: Trial System

**Branch**: feat/trial-system
**Status**: Active (awaiting approval)

## Goal

Quando un manager accetta una candidatura può scegliere se entrare subito col ruolo main o entrare in Trial (ruolo standard **+** ruolo Discord Trial con una scadenza); i Trial sono visibili nel gestionale con il tempo rimanente e gestibili (promuovi / termina / estendi) da chi ha il permesso dedicato.

## Decisioni (confermate dall'utente)

- **Niente auto-rimozione alla scadenza**: nessun worker che toglie il ruolo. Il trial scaduto compare in lista come `expired` ed è il manager a decidere: lo promuove (resta in gilda col ruolo main) oppure lo rimuove dal trial.
- **Scelta al momento dell'accept su Discord**: l'embed di gestione candidatura offre tre esiti — `Accept as Member` (comportamento attuale), `Accept as Trial` (ruolo main + ruolo Trial), `Decline`.
- **Durata**: default globale configurabile dal gestionale; estendibile/accorciabile per singolo trial dalla pagina Trial.

## Design (derivato dal codice esistente)

- Flusso accept reale: bottone Discord → `POST /api/applications/{id}/accept` (`apps/backend/src/modules/applications/router.rs`) → il backend restituisce `default_role_discord_id` → **il bot** assegna/rimuove i ruoli (`apps/discord-bot/src/handlers/button.ts` L181-188).
- Il backend sa già assegnare/rimuovere ruoli Discord via bot token (`apps/backend/src/modules/albion/discord_guild_role.rs`, `assign_discord_role` / `revoke_discord_role`) — si riusa per le azioni dal gestionale (promuovi/termina), dove non c'è un'interazione bot.
- Le impostazioni vivono in `guild_settings` (pattern `discord_applications_accepted_role_id`): nuove colonne `trial_role_id` e `trial_duration_days`.
- Nuova tabella `trials` (per-tenant, come tutte): `discord_id`, `user_id` (opz.), `application_id` (opz.), `username_snapshot`, `ingame_name` (opz.), `started_at`, `ends_at`, `status` (`active` | `converted` | `removed`), `created_by_discord_id`, `ended_at`, `ended_by_discord_id`.
- Nuovi permessi: `trials.view` (lista) e `trials.manage` (azioni + estensione), seed migration per Admin/Officer/Moderator (pattern `m20260903_000007`).
- La scadenza ("quanto tempo gli manca") è **calcolata** (`ends_at - now`), mai salvata.

## Acceptance Criteria

- [ ] Un manager può accettare una candidatura su Discord come Trial: l'applicant riceve il ruolo main **e** il ruolo Trial; nel DB esiste una riga `trials` attiva con `ends_at = now + durata`.
- [ ] Un manager può accettare una candidatura come membro pieno: nessuna riga `trials`, comportamento identico a oggi.
- [ ] Se `Accept as Trial` viene usato senza ruolo Trial configurato, l'azione fallisce con messaggio chiaro (niente accept parziale).
- [ ] Dal gestionale, chi ha `trials.view` vede la lista dei trial (attivi, scaduti, conclusi) con username, nome in-game, inizio, fine e **tempo rimanente**; chi non ha il permesso non vede né pagina né API.
- [ ] Chi ha `trials.manage` può Promuovere (rimuove ruolo Trial su Discord, status `converted`), Terminare (rimuove ruolo Trial, status `removed`) ed Estendere/ridurre la scadenza di un trial attivo.
- [ ] Dal gestionale (Admin → Applications) si configurano ruolo Trial Discord e durata default in giorni.
- [ ] Promozioni, terminazioni ed estensioni finiscono nell'audit log.
- [ ] Nuovi permessi seedati per i ruoli staff esistenti; la permission matrix li espone.

## Slices

Ogni slice segue RED-GREEN-MUTATE-KILL MUTANTS-REFACTOR. Prima del codice: caricare `tdd`, `testing`, `mutation-testing`, `refactoring`. I test backend girano su SQLite in-memory con la suite di migration (pattern `applications/service.rs`).

### Slice 1: Accettare una candidatura come Trial (backend + bot)

**Value**: il manager decide in Discord se l'accettato entra come Trial o come membro pieno.
**Path**: bottone `application:accept_trial:{id}` → bot chiama `POST /api/applications/{id}/accept` con body `{ as_trial: true }` → il service crea la riga `trials` (usa `trial_role_id` + `trial_duration_days` da guild settings) e restituisce nella view `trial_role_discord_id` + `trial_ends_at` → il bot aggiunge anche il ruolo Trial.
**Required implementation skills**: `tdd`, `testing`, `mutation-testing`, `refactoring`.
**Acceptance criteria**:
- `accept` con `as_trial: true` e trial configurato → riga `trials` attiva, view contiene ruolo Trial e scadenza; senza `as_trial` → nessuna riga, output invariato (retrocompatibilità, i client che non mandano body continuano a funzionare).
- `as_trial: true` senza `trial_role_id` configurato → `409 Conflict`, l'applicazione resta `open`.
- Il bot mostra tre bottoni (Accept as Member / Accept as Trial / Decline); `accept_trial` aggiunge ruolo main + ruolo Trial.
- Unit test service (scadenza calcolata da durata, confine `duration_days` mancante → errore) e test embed bot (terzo bottone, custom ID stabile).
**RED**: test service "accepting as trial creates an active trial ending after the configured duration"; test router "accept as trial without configured role conflicts".
**GREEN**: migration (`trials` + colonne settings), `TrialService::start_from_accept`, estensione `accept_application` con body opzionale, bottone e ramo bot.
**Done when**: criteri verdi, report mutation revisionato, approvazione commit.

### Slice 2: Configurazione Trial nel gestionale

**Value**: l'admin imposta ruolo Trial e durata default senza toccare il DB.
**Path**: Admin → Applications (`admin-applications.ts`) → due nuovi campi nel form esistente (select ruolo + numero giorni) → `PUT /api/admin/settings`.
**Required implementation skills**: `tdd`, `testing`, `refactoring`.
**Acceptance criteria**:
- `GuildSettingsView` e `UpdateGuildSettingsRequest` espongono `trial_role_id` e `trial_duration_days`; update con valore vuoto cancella il ruolo; `trial_duration_days` accetta 1–365.
- La pagina Admin → Applications mostra i due campi con hint; salvataggio round-trip.
- i18n it/en per label, hint e placeholder.
**RED**: test service "updating trial settings persists role and duration".
**GREEN**: modelli admin + campi frontend (pattern `discord_applications_accepted_role_id`).
**Done when**: criteri verdi, approvazione commit.

### Slice 3: Lista Trial nel gestionale con tempo rimanente

**Value**: chi ha `trials.view` vede tutti i trial e quanto manca alla scadenza.
**Path**: `GET /api/trials` (permesso `trials.view`) → pagina `/admin/trials` con guard `permissionGuard('trials.view')`, voce nel nav admin e nell'Admin Hub.
**Required implementation skills**: `tdd`, `testing`, `mutation-testing`, `refactoring`.
**Acceptance criteria**:
- Endpoint risponde solo con `trials.view`; ordinati per `ends_at` crescente tra gli attivi, poi conclusi; include `remaining_seconds` calcolato (negativo = scaduto) e status.
- La pagina mostra le colonne concordate (membro, nome in-game, iniziato, scade tra X, stato badge `active`/`expired`/`converted`/`removed`) e stato vuoto.
- `trials.view` e `trials.manage` aggiunti a `Permission` (backend), `PermissionKey` (frontend), tipi bot, seed migration staff, e alla permission matrix UI.
**RED**: test router "trials list requires trials.view and returns computed remaining time".
**GREEN**: `modules/trials` (entities/service/router), pagina Angular + i18n.
**Done when**: criteri verdi, approvazione commit.

### Slice 4: Azioni Promuovi / Termina / Estendi + audit

**Value**: il manager chiude il cerchio dal gestionale: promuove chi merita, toglie chi no, allunga chi ha bisogno di più tempo.
**Path**: bottoni pagina Trial → `POST /api/trials/{id}/promote`, `POST /api/trials/{id}/end`, `PATCH /api/trials/{id}` (nuova `ends_at`) → backend marca la riga e chiama `revoke_discord_role` per il ruolo Trial → audit log.
**Required implementation skills**: `tdd`, `testing`, `mutation-testing`, `refactoring`.
**Acceptance criteria**:
- Promuovi/Termina richiedono `trials.manage`, agiscono solo su trial `active` o `expired`, sono idempotenti al retry (riga già conclusa → `409`), rimuovono il ruolo Trial su Discord (best-effort, non fanno fallire la richiesta se Discord è giù).
- Estendi richiede `trials.manage`, accetta solo trial attivi e una nuova data futura.
- Ogni esito scrive una riga di audit (actor, target, azione).
- Frontend: bottoni con conferma, messaggio d'errore su `409`.
**RED**: test service "promoting an active trial removes the Discord role and marks it converted".
**GREEN**: endpoint + azioni frontend + i18n.
**Done when**: criteri verdi, approvazione commit.

## Pre-PR Quality Gate

1. `cargo test` backend (workspace) + `cargo clippy`
2. `npm test` frontend e bot; `npm run build` frontend
3. Mutation testing report per le slice toccate
4. Glossario: "Trial", "promuovere", "terminare" coerenti tra API, UI e i18n

## Fuori scope (per ora)

- Kick automatico o manuale dalla gilda da gestionale (si fa a mano su Discord).
- Notifiche Discord a scadenza trial.
- Statistiche trial nella dashboard.
