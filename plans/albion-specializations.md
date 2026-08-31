# Plan: Albion Online weapon and armor specializations

**Branch**: `feat/albion-specializations`
**Status**: Draft — awaiting product confirmation

## Goal

Consentire a ogni utente di registrare il livello 0–120 delle proprie specializzazioni di combattimento Albion Online nel profilo, visualizzarle in una UI ispirata alla Destiny Board e permettere agli amministratori di modificarle da `/users/:id`, rendendo queste informazioni utilizzabili nella scelta dei partecipanti al roster evento.

## Scope

- Solo combattimento: armi e armature.
- Esclusi crafting, gathering, refining, farming e altre categorie non-combat.
- Un livello per ogni nodo/arma o pezzo di equipaggiamento supportato.
- L’MVP usa un catalogo stabile applicativo basato sugli identificativi/nodi combat; il catalogo OpenAlbion esistente può fornire nomi e icone dove compatibile, ma non è la fonte del livello personale.

## Proposed layout (desktop)

```text
┌──────────────────────────────────────────────────────────────────────────────┐
│ Profilo: PlayerName                         [Salva modifiche] [Reset]         │
├──────────────────────────────────────────────────────────────────────────────┤
│ SPECIALIZZAZIONI COMBATTIMENTO                                               │
│ [ Cerca arma/armatura... ] [ Tutte ] [ Armi ] [ Armature ]   Totale: 18/54    │
│                                                                              │
│                           ┌──── TANK / ARMATURE ────┐                        │
│                           │      [ 8 ]              │                        │
│                    [ 6 ]──┴──────┼──────┴──[ 10 ]                          │
│                      ╲           │           ╱                              │
│                [ 4 ]───╲      [ 0 ]       ╱───[ 7 ]                         │
│                         ╲       │       ╱                                   │
│              ┌───────────┴──────┼──────┴───────────┐                        │
│              │          NODO COMBATTIMENTO         │                        │
│              └───────┬──────────┬──────────┬────────┘                        │
│                  ARMI 1H     ARMI 2H    ARCHI / MAGIE                       │
│                 [ 50 ]       [ 100 ]       [ 32 ]                          │
│                /  |  \       / | \        / | \                            │
│             [42][55][61]  [80][91][77]  [20][33][45]                        │
│                                                                              │
├──────────────────────────────────────────────────────────────────────────────┤
│ DETTAGLIO SELEZIONATO                                                        │
│ Bloodletter · Pugnali · livello 61/120     [-]  [ 61 ]  [+]                  │
│ Ultimo aggiornamento: 31/08/2026                                  [Salva]     │
└──────────────────────────────────────────────────────────────────────────────┘

Legenda: nodo = livello modificabile; linea = relazione visiva di categoria;
rosso/arancio = armi; blu/verde = armature; il colore non è l'unico indicatore.
```

## Proposed mobile behavior

```text
┌──────────────────────────────┐
│ Spec combattimento           │
│ [cerca...] [Armi] [Armature] │
│                              │
│ [ Bloodletter          61 ]  │
│ [ Dagger Pair          42 ]  │
│ [ Soldier Armor         8 ]  │
│                              │
│ Tocca un elemento per        │
│ aprire il dettaglio e        │
│ modificare il livello.       │
└──────────────────────────────┘
```

Il grafo resta navigabile con pan/zoom su desktop; su schermi piccoli la vista lista è il fallback principale, evitando un grafo illeggibile.

## Product decisions to confirm

1. **Livello massimo**: proposta `0–120`, coerente con le attuali specializzazioni Albion; confermare se si vuole `0–100`.
2. **Categorie**: proposta includere armi + armature di combattimento, non solo armi. Confermare che questa interpretazione di “armi/armature” sia corretta.
3. **Modifica utente**: proposta ogni utente può modificare solo le proprie spec; admin/superadmin possono modificare qualsiasi profilo. Confermare.
4. **Permesso admin**: proposta nuovo permesso `users.specializations.manage`, invece di concederlo implicitamente a ogni admin, per mantenere il modello permission-based esistente.
5. **Aggiornamento**: proposta salvataggio batch con validazione e audit; niente storico dei singoli livelli nel MVP, salvo audit log dell’operazione. Confermare se serve storico completo.
6. **Rosters**: proposta Slice 4 per mostrare una colonna/filtro “Spec arma” nel roster evento, solo dopo aver completato profilo e persistenza.

## Acceptance Criteria

- [ ] Un utente autenticato vede nel proprio profilo la sezione Specializzazioni combattimento con categorie armi e armature, stati vuoto, loading ed errore.
- [ ] Un utente può impostare e salvare il livello di ogni singolo nodo supportato, con validazione del range e feedback di successo/errore.
- [ ] I livelli salvati vengono ricaricati dopo refresh e non vengono persi aggiornando un’altra sezione del profilo.
- [ ] Un admin autorizzato può aprire `/users/:id`, vedere le spec dell’utente e modificarle; un utente non autorizzato non può modificare quelle altrui né aggirare il controllo via API.
- [ ] Le modifiche admin sono registrate nell’audit log con autore, utente target e valori modificati.
- [ ] Il roster di un evento può selezionare un’arma specifica e mostrare il livello della spec corrispondente accanto agli utenti, permettendo di ordinare/filtrare secondo quel livello.
- [ ] La UI comunica i livelli anche senza affidarsi soltanto al colore, è utilizzabile da tastiera e ha un fallback lista su mobile.
- [ ] Test backend, frontend, type-check e lint coprono autorizzazioni, validazione, persistenza e interazione principale.

## Vertical slices

Every slice follows RED-GREEN-MUTATE-KILL MUTANTS-REFACTOR. Before implementation, load the project's testing/TDD, mutation-testing, refactoring, Rust and Angular guidance. Acceptance criteria for each slice must be confirmed before production code is written.

### Slice 1: Un utente vede le proprie specializzazioni combat nel profilo

**Actor**: utente autenticato.

**Trigger**: apre il profilo personale.

**Observable outcome**: vede il catalogo dei nodi combat, organizzato per categorie, con livello corrente o 0.

**Path**: `/users/:id` → endpoint profilo/spec → query catalogo + livelli utente → DTO → componente Angular; inizialmente read-only.

**RED**: test API per risposta vuota e popolata; test Angular per categorie, livello 0, loading/error/empty e fallback lista.

**GREEN**: migration/catalogo e tabella livelli se necessarie, endpoint GET self/target autorizzato, modelli frontend e sezione read-only del profilo.

**MUTATE**: verificare mutazioni su mapping categorie, default a zero e selezione del target.

**KILL MUTANTS**: coprire nodi mancanti, catalogo vuoto, utente inesistente e dati duplicati.

**REFACTOR**: estrarre solo il modello condiviso e il formatter realmente riusabili.

**Done when**: un profilo reale mostra l’albero/lista combat con dati persistiti o livelli 0.

### Slice 2: L’utente modifica e salva il livello di ogni nodo

**Actor**: proprietario del profilo.

**Trigger**: modifica un livello e preme Salva.

**Observable outcome**: il livello è validato, persistito e resta presente dopo un nuovo caricamento.

**Path**: input nodo → form/draft batch → `PUT/PATCH /api/users/me/specializations` → validazione dominio + upsert transactionale → risposta aggiornata → UI.

**RED**: test validation range, payload parziale/completo, upsert idempotente e test Angular di edit/save/cancel/error.

**GREEN**: endpoint self-write, service/repository, UI input nel dettaglio nodo e stato dirty/saving/saved.

**MUTATE**: coprire bound inclusivi, livelli negativi/non numerici, nodo non supportato e salvataggi ripetuti.

**KILL MUTANTS**: testare che un errore non sostituisca i valori locali e che gli aggiornamenti non cancellino nodi omessi.

**REFACTOR**: ridurre duplicazione tra editor singolo e batch solo se emerge dal codice.

**Done when**: l’utente può impostare una spec per arma/armatura e verificarla dopo refresh.

### Slice 3: L’admin modifica le specializzazioni da `/users/:id`

**Actor**: admin/superadmin con permesso dedicato.

**Trigger**: apre il dettaglio di un altro utente e abilita l’editing.

**Observable outcome**: può aggiornare le spec target; utenti senza permesso ricevono UI read-only e API 403.

**Path**: pagina user detail → permission guard/UI capability → `PUT/PATCH /api/users/{id}/specializations` → authorization target + transaction → audit log → UI.

**RED**: test 403 self/other policy, permission grant, target not found, audit payload e test Angular visibility/submit.

**GREEN**: nuovo permesso e migration seed, endpoint admin, service condiviso, integrazione nel pannello esistente.

**MUTATE**: verificare sostituzione dell’id target, bypass del permission check, audit mancante e update cross-user.

**KILL MUTANTS**: testare esplicitamente che l’id nel body non possa sovrascrivere il path e che l’audit indichi editor e target distinti.

**REFACTOR**: consolidare la policy di autorizzazione senza duplicare quella self-write.

**Done when**: admin autorizzato modifica `/users/:id`, operazione auditata; gli altri non possono farlo.

### Slice 4: Il roster mostra e filtra la spec dell’arma scelta

**Actor**: organizzatore dell’evento.

**Trigger**: nel roster seleziona un’arma o una categoria combat.

**Observable outcome**: ogni membro mostra il livello della spec relativa e il roster può essere ordinato/filtrato per livello.

**Path**: event roster → selettore catalogo combat → API roster con `specialization_level` o join locale → colonna/filtro → scelta partecipanti.

**RED**: test query/DTO per arma selezionata, utenti senza valore, ordinamento tie-break stabile; test Angular selettore e filtro.

**GREEN**: endpoint/query esteso e integrazione minima nella tabella roster esistente.

**MUTATE**: coprire arma non valida, valore nullo/zero, filtro min e ordinamento asc/desc.

**KILL MUTANTS**: impedire che il livello di un’arma venga mostrato per un’altra e che utenti non collegati vengano scartati erroneamente.

**REFACTOR**: estrarre un selector/formatter condiviso tra profilo e roster solo dopo il secondo uso reale.

**Done when**: l’organizzatore può scegliere una weapon spec e usarla come informazione concreta per comporre il roster.

## Pre-PR quality gate

1. Test backend e frontend verdi.
2. Mutation testing sulle regole di validazione e autorizzazione.
3. Rust `cargo fmt --check`, `cargo clippy --workspace --all-targets --all-features` e test mirati.
4. Frontend type-check, lint e build.
5. Verifica manuale desktop/mobile, tastiera, profilo proprio, profilo di altro utente e roster.
6. Nessun commit senza approvazione esplicita dell’utente.

---
*Delete this plan when the feature is complete; remove `plans/` if empty.*
