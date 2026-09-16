# Plan: gestione Alleanze

**Branch**: `feat/alliance-management`
**Status**: Active — in attesa di conferma decisioni e slice

## Goal

Un officer può registrare un Discord come **gilda** o come **alleanza**; l'alleanza raggruppa gilde già onboardate, condivide con loro builds/comps/eventi/split, e `/register <IGN>` collega il personaggio Albion su gilda e alleanza assegnando i ruoli Discord in automatico.

## Contesto nel codice oggi

- Un tenant **è** un server Discord (`tenants.id` = snowflake). Isolamento **schema-per-tenant** (`tenant_<id>`). Nessuna riga, colonna o `kind` per alleanza Manager.
- Onboarding unico: [`register-tenant.ts`](apps/frontend/src/app/features/auth/register-tenant.ts) + `POST /api/tenants/register` richiede `albion_guild_id` e crea sempre una gilda.
- `tenants.albion_allied_guild_ids` / `_names` sono CSV **Albion** per il lato battaglie, non membership tra tenant Manager. Non riusarli come registro alleanze.
- Link personaggio: `POST /api/albion/link` + slash `/link` con `player_id` **e** `player_name`. Ruolo Discord best-effort solo sul tenant corrente, solo se il player sta nella gilda Albion configurata ([`discord_guild_role.rs`](apps/backend/src/modules/albion/discord_guild_role.rs)).
- Builds, comps, events, splits vivono **solo** nello schema del tenant. Non esiste publish cross-tenant.
- Il client Albion ha già `AlbionAlliance` (`GET /alliances/<id>`) ma non è esposto via HTTP.

## Decisioni proposte (da confermare prima del codice)

Queste sono le scelte di prodotto/architettura su cui il piano poggia. Se una è sbagliata, si aggiorna il piano **prima** di implementare.

| # | Decisione | Perché | Scartato |
|---|-----------|--------|----------|
| 1 | L'alleanza è un **tenant** `kind=alliance` (Discord alleanza = schema proprio), le gilde restano `kind=guild`. | Riusa onboarding, bot, settings, RBAC, rail server. Il Discord alleanza è un workspace vero, non un flag su una gilda. | Alleanza solo control-plane senza Discord: contraddice "setuppare il discord per l'alleanza". Un solo schema condiviso: rompe l'isolamento attuale. |
| 2 | Membership in control-plane: `alliances` + `alliance_members` (guild tenant ↔ alliance tenant). Una gilda è in **al massimo un'alleanza**. | Fonte unica senza toccare ogni tabella di dominio. |
| 3 | Creare un'alleanza richiede **almeno una gilda già `active`**. Join successivo: **invito dall'alleanza + accept dal owner/officer della gilda**. | "Devono essere setuppati tutti i discord delle singole gilde" + non si può attaccare il tenant di un altro senza consenso. | Attach immediato di tenant altrui. |
| 4 | Un Discord è **gilda XOR alleanza** al register. Non si cambia kind dopo. | Scelta al primo setup, come richiesto. |
| 5 | Tenant alleanza: `albion_alliance_id` (opzionale ma consigliato), **niente** `albion_guild_id`. Battle-sync/event-sessions **non** partono sul tenant alleanza (non c'è una gilda da pollare). | L'alleanza aggrega, non è una gilda Albion. |
| 6 | **Share = publish snapshot** nello schema alleanza, con puntatore di origine in control-plane (`alliance_shares`). Visibile nel workspace alleanza (web + Discord alleanza), **non** clonato nelle altre gilde. Unshare nasconde/revoca nel tenant alleanza. | Gli API esistenti restano tenant-scoped (`search_path`). Copia nello schema alleanza è il walking skeleton che un officer vede aprendo il server alleanza. | Live query cross-schema su ogni list (accoppia tutti gli handler). Fan-out copia in ogni gilda (sync infernale). |
| 7 | Prima artifact type: **builds**. Poi comps, events, splits nello stesso meccanismo. Split in alleanza = **read-only** (niente edit bag/fee dal tenant alleanza). Eventi pubblicati diventano eventi del tenant alleanza (join/roster là). | Uno slice osservabile per tipo; gli split hanno implicazioni di cassa. |
| 8 | Ruolo alleanza: ogni gilda configura `discord_alliance_role_id` sul **proprio** Discord; l'alleanza configura `discord_member_role_id` sul Discord alleanza. Assegnati da `/register` se il player sta in una gilda membro. | "Setuppare un ruolo nel mio discord dato agli utenti dell'alleanza". |
| 9 | `/register <ign>` (slash) risolve l'IGN via search Albion, match **esatto** e **unico**, poi link + ruoli. Fan-out: gilda di appartenenza **e** alleanza, da qualunque dei due Discord. `/link` resta per il flusso id+nome. | Richiesta esplicita; search giocatori esiste già. |
| 10 | Chi può share: permesso tenant gilda `alliance.share` (officer+). Chi invita gilde / gestisce membership: `alliance.manage` sul tenant alleanza. |

### Aperto (default se non rispondi diversamente)

- **Re-share su edit**: la copia in alleanza **non** si aggiorna da sola; l'officer ri-pubblica. (Meno magia, revertibile.)
- **Player non nel Discord gilda** quando registra in alleanza: link + ruolo alleanza ok; ruolo gilda best-effort (skip se non è membro Discord, come oggi).
- **Omonimi IGN**: se la search torna più match esatti → errore, non indovinare.
- **Gilda che lascia l'alleanza**: unshare di tutto ciò che ha pubblicato; i suoi membri perdono il ruolo alleanza (best-effort).

## Actor / path di produzione

```
Officer Discord (manage guild)
  → wizard /register-tenant?guild=…  (kind guild | alliance)
  → POST /api/tenants/register
  → control-plane tenants + (se alliance) alliance_members
  → schema tenant_<id>

Officer gilda
  → UI build/comp/evento/split → "Condividi con l'alleanza"
  → POST /api/alliance/shares
  → snapshot nello schema alleanza + riga alliance_shares
  → visibile aprendo il tenant alleanza / canali Discord alleanza

Membro
  → /register <IGN> su Discord gilda o alleanza
  → Albion search + get_player
  → link nello schema gilda + membership control-plane alleanza
  → ruoli Discord gilda + ruoli Discord alleanza
```

## Acceptance Criteria (epic)

- [ ] Al primo setup di un Discord non registrato, l'officer sceglie **Gilda** o **Alleanza**.
- [ ] Registrare un'alleanza è rifiutato se nessuna gilda membro è già un tenant `active` (o se le gilde scelte non sono registrate).
- [ ] Una gilda entra in alleanza solo dopo invite + accept; risulta nel raggruppamento (web alleanza + control-plane).
- [ ] Un officer gilda con `alliance.share` pubblica una build e la vede nel tenant alleanza senza ricrearla a mano.
- [ ] Stesso meccanismo per comps, events; split visibile in sola lettura.
- [ ] In settings gilda si imposta un ruolo Discord "membro alleanza".
- [ ] `/register <IGN>` su gilda o alleanza collega il personaggio e assegna i ruoli su **entrambi** i Discord quando la gilda è in un'alleanza.
- [ ] Un Discord alleanza non espone bank/warns/regear/applications come se fosse una gilda.

## Slices

Ogni slice = un PR. RED-GREEN-MUTATE-KILL MUTANTS-REFACTOR. Nessun codice di produzione senza test che fallisce. Prima di ogni slice: caricare `tdd`, `testing`, `mutation-testing`, `refactoring` e **far confermare gli AC** di quella slice.

---

### Slice 1: Al register, l'officer sceglie Gilda o Alleanza e solo la gilda completa l'onboarding attuale

**Value**: Chi aggiunge un Discord nuovo vede la biforcazione richiesta; il path gilda resta identico e deployabile.
**Path**: `/register-tenant` step 1 → `kind` nel body `POST /api/tenants/register` → colonna `tenants.kind` (`guild` default per i tenant esistenti) → status API espone `kind`. Path alleanza: UI blocca il submit con messaggio "prima registra le gilde" **senza** creare il tenant (slice 2 lo sblocca).
**Required implementation skills**: `tdd`, `testing`, `mutation-testing`, `refactoring`.
**Acceptance criteria**:
- Tenant esistenti si leggono come `kind=guild`.
- Register gilda con `kind=guild` (o omesso) si comporta come oggi.
- Register con `kind=alliance` senza membership restituisce 400 con problema stabile (`alliance_requires_guilds`), nessun schema creato.
- Lo step 1 del wizard mostra due scelte radio accessibili (Gilda / Alleanza) e il resto del wizard gilda è invariato.
**RED**: test `register_tenant` su kind ignoto / alliance senza membri / guild ok; test frontend del fork (stato step).
**GREEN**: migrazione control-plane `kind text not null default 'guild'` + check; validazione in `PlatformService::register_tenant`; radio nello wizard.
**MUTATE / KILL MUTANTS / REFACTOR**: come da skill.
**Done when**: AC ok, report mutazioni rivisto, commit approvato.

---

### Slice 2: Un officer crea il Discord alleanza collegando gilde già registrate (invito)

**Value**: Esiste un workspace alleanza che raggruppa gilde reali.
**Path**: wizard kind=alliance → elenco tenant `guild` `active` che il caller può gestire (stesso bar di `assert_can_manage_guild` **oppure** ricerca per id/nome tra tenant guild) → register crea tenant alliance + invite pending → owner gilda accetta `POST /api/alliances/{id}/members/{guild_id}/accept`.
**Walking skeleton membership**: per lo slice, se il caller **gestisce anche** ogni gilda selezionata, l'accept è implicito (stesso officer, zero round-trip). Se non le gestisce, resta pending.
**Acceptance criteria**:
- Alliance tenant `active` con `kind=alliance`, senza `albion_guild_id`, workers battle/event **non** avviati.
- Almeno 1 gilda richiesta; gilda inesistente / già in un'altra alleanza → 409/400, nessuna riga alliance orfana.
- GET membership: lista gilde con status `pending|active`.
- Accept dal owner della gilda (o chi ha `roles.manage` su quel tenant) passa a `active`.
- UI alleanza (dashboard minimo): elenco gilde membro.
**RED**: service tests su register alliance, invite, accept, doppio join, gilda non registrata.
**GREEN**: tabelle `alliance_memberships` (alliance_tenant_id, guild_tenant_id, status, invited_by, accepted_at); wizard step membri; endpoint accept.
**Done when**: un officer può aprire il Discord alleanza nel rail e vedere le gilde collegate.

---

### Slice 3: Settings gilda — ruolo Discord per i membri alleanza

**Value**: L'officer gilda punta il ruolo da dare a chi è dell'alleanza.
**Path**: Admin settings → campo ruolo (stesso picker ruoli Discord già usato per auto-role / accepted-role) → `guild_settings.discord_alliance_role_id` → GET/PUT settings lo round-trip-pano. **Nessuna assegnazione ancora** (slice 5).
**Acceptance criteria**:
- Round-trip snowflake valido; empty/null pulisce.
- Tenant `kind=alliance` ha invece `discord_member_role_id` (ruolo sul Discord alleanza). Se è più pulito un solo nome colonna per-schema, usarlo: sul tenant gilda = ruolo "sei dell'alleanza"; sul tenant alleanza = ruolo membro.
- Visibile in UI settings solo se il tenant gilda è `active` in un'alleanza, oppure sempre salvabile e ignorato se non c'è alleanza.
**RED**: test admin settings come `discord_auto_role_id`.
**GREEN**: migrazione tenant-schema + models + form.
**Done when**: l'officer salva il ruolo e lo rivede dopo reload.

---

### Slice 4: `/register <IGN>` sulla gilda linka il personaggio e assegna il ruolo gilda

**Value**: Un membro registra solo l'IGN, senza player id.
**Path**: slash `/register` → bot `POST /api/albion/register` `{ ign }` (header X-Guild-Id) → search + get_player → stesso `create_link` di oggi → nick + `assign_guild_role` se `guild_id` Albion = tenant.albion_guild_id.
**Acceptance criteria**:
- Match esatto unico → 200 e link 1:1 (stessi 409 di `/link`).
- Zero match / più match esatti / IGN vuoto → 400/404 parlante, niente link.
- Player di un'altra gilda Albion: link consentito (come `/link`) **ma** niente ruolo gilda.
- Risposta ephemeral con IGN, gilda Albion, ruoli assegnati (o skip).
- `/link` invariato.
**RED**: test register-by-ign (unico, ambiguo, missing, conflict).
**GREEN**: endpoint + comando bot; riuso `AlbionLinkService`.
**Done when**: `/register Kay` su un Discord gilda equivale a un link riuscito.

---

### Slice 5: `/register` fan-out su alleanza — membership + ruoli sui due Discord

**Value**: Un solo comando sistema gilda **e** alleanza.
**Path**: dopo link gilda, se la gilda ha membership `active`: upsert user nello schema alleanza (stesso discord id + link personaggio) + `user_tenant_memberships` per entrambi + `assign` ruolo alleanza sul Discord gilda + ruolo membro sul Discord alleanza. Simmetrico se il comando parte dal Discord alleanza: si risolve la gilda membro dal `player.guild_id` Albion.
**Acceptance criteria**:
- Register in gilda (membro alleanza) → ruoli su entrambi i server se l'utente è membro Discord lì; altrimenti skip loggato, link comunque ok.
- Register in alleanza con IGN di una gilda **non** membro → 403, nessun ruolo alleanza.
- Register in alleanza con IGN di gilda membro → link nel tenant gilda + alleanza.
- Unlink (esistente) revoca anche i ruoli alleanza (best-effort, come revoke gilda).
**RED**: test fan-out, reject non-membro, revoke.
**GREEN**: helper ruoli parametrizzato (role id + guild id Discord); orchestration control-plane.
**Done when**: un membro fa `/register` una volta e ha i ruoli giusti sui due Discord.

---

### Slice 6: Condividere una build con l'alleanza

**Value**: L'officer pubblica una build e l'alleanza la usa senza ricopiarla a mano.
**Path**: UI gilda (dettaglio build) → Condividi → `POST /api/alliance/shares` `{ type: "build", id }` → copia nello schema alleanza → `alliance_shares` → la build compare in `GET /api/builds` del tenant alleanza. Unshare: `DELETE` + hide/delete copia.
**Acceptance criteria**:
- Solo se la gilda è `active` in un'alleanza e il caller ha `alliance.share`.
- Copia include items/spells necessari a renderla usabile (stesso grafo letto dal GET build gilda).
- Metadati origine visibili (gilda source, id origine) in alleanza; in gilda badge "condivisa".
- Doppio share della stessa build: idempotente (aggiorna snapshot, non duplica).
- Tenant senza alleanza: 409; alleanza che chiama share su sé stessa: 400.
**RED**: service copy + idempotenza + authz.
**GREEN**: control-plane `alliance_shares`; copier build; bottone UI.
**Done when**: aprire il server alleanza nel rail mostra la build.

---

### Slice 7: Condividere una composition con l'alleanza

**Value**: Stesso publish per le comp.
**Path**: identico a slice 6, `type: "comp"`. Se la comp referenzia build già shared, riusare gli id copia alleanza; se no, o si bloccano con errore chiaro o si auto-pubblicano le build mancanti (preferenza: **auto-publish le build referenziate**, un solo click officer).
**Acceptance criteria**:
- Comp visibile e integro nel tenant alleanza.
- Unshare comp non cancella le build pubblicate (unshare esplicito).
**RED / GREEN**: estendere lo share service.
**Done when**: una main ZvZ shared si apre dal workspace alleanza.

---

### Slice 8: Condividere un evento con l'alleanza (annuncio + join sul Discord alleanza)

**Value**: L'alleanza vede e join-a l'evento sul proprio Discord.
**Path**: share evento → snapshot/create nel tenant alleanza (tempi, nome, comp se shared) → lifecycle Discord alleanza (`discord_events_channel_id` del tenant alleanza). Join/leave/roster usano lo schema alleanza (utenti già fan-out da `/register`).
**Acceptance criteria**:
- Evento shared compare in lista eventi alleanza e può essere joinato da un utente registrato dell'alleanza.
- Edit ore/nome in gilda **non** si propaga (re-share).
- Cancel/unshare: evento alleanza cancellato o nascosto, niente ghost ping.
- Se l'alleanza non ha canale eventi, lo share persiste in web e logga skip Discord (come oggi i canali unset).
**RED**: share/unshare event + join sul tenant alleanza.
**GREEN**: copier evento minimo (senza clonare participations gilda).
**Done when**: un membro nel Discord alleanza vede l'annuncio e fa join.

---

### Slice 9: Condividere uno split in sola lettura con l'alleanza

**Value**: L'alleanza vede loot/fee/stato senza poter muovere soldi.
**Path**: share split → snapshot read-model nel tenant alleanza (o GET speciale `shared=true`). PUT/POST mutativi sullo split copiato dal tenant alleanza → 403.
**Acceptance criteria**:
- Officer alleanza vede split e partecipanti; non può completare/prelevare/editare bag.
- Unshare toglie la vista.
- Nessun side-effect su forum split della gilda.
**RED**: mutate da tenant alleanza rifiutato; GET ok.
**GREEN**: flag `origin_read_only` sulla copia o endpoint dedicato.
**Done when**: lo split gilda è consultabile dal workspace alleanza e basta.

---

### Slice 10: Superficie bot/UI del tenant alleanza come raggruppamento, non come gilda

**Value**: L'alleanza non finge di avere banca, warns, candidature, regear.
**Path**: tenant `kind` nello status/session → frontend nasconde nav gilda-only → bot registra/esegue solo comandi ammessi in alleanza (`register`, events join/leave/list, me/player; **non** warn/bank/applications/vod…).
**Acceptance criteria**:
- Rail: icona/label alleanza distinta.
- Dashboard alleanza: membri gilde + libreria shared (builds/comps/events/splits).
- Comando `/warn` (o bank) in Discord alleanza → errore chiaro "solo gilda".
**RED**: gate `kind` su router bot + guardie route Angular.
**GREEN**: allowlist comandi; filtro nav.
**Done when**: usare il Discord/web alleanza non espone operazioni da gilda singola.

---

## Fuori scope (non in questo piano)

- Multi-alleanza per la stessa gilda.
- Cambio kind di un tenant esistente.
- Sync live bidirezionale degli artifact (ogni edit gilda aggiorna l'alleanza).
- Ruoli per-gilda sul Discord alleanza (es. `@GildaA`, `@GildaB`) — utile dopo, non nel walking skeleton.
- Billing / feature-flag dedicato (si può aggiungere al catalogo in uno slice orizzontale se serve gating VIP).
- Sostituire `albion_allied_guild_ids` (resta per il lato battaglie **della gilda**).

## Pre-PR Quality Gate

Prima di ogni PR:

1. Mutation testing — skill `mutation-testing`
2. Refactoring assessment — skill `refactoring`
3. Typecheck e lint pass (backend + bot + frontend toccati)
4. Nessun worker battle/event avviato su tenant `kind=alliance`
5. Tenant gilda esistenti invariati (`kind` default, register senza campo kind)

---
*Delete this file when the plan is complete. If `plans/` is empty, delete the directory.*
