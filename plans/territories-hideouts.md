# Plan: Albion Territories and Hideouts Management

**Branch**: `feat/territories-hideouts`
**Status**: Draft — awaiting product decisions

## Goal

Consentire a officer e admin di gestire separatamente i Territories e gli Hideouts: vedere posizione, Tier e Quality della mappa, aggiornare il mantenimento con cibo o tempo manuale e ricostruire ogni variazione tramite un audit log affidabile.

## Glossary

- **Territory**: territorio gestito dalla gilda, con il proprio ciclo di upkeep.
- **Hideout**: hideout gestito dalla gilda, con il proprio ciclo di upkeep.
- **Map location**: nome/identificativo della mappa Albion in cui si trova il Territory o Hideout.
- **Map tier**: Tier della mappa, distinto dal livello della struttura.
- **Map quality**: Quality della mappa.
- **Upkeep balance**: tempo di mantenimento residuo, espresso in secondi e derivato dagli eventi registrati.
- **Upkeep event**: aggiunta di cibo, estensione manuale, correzione o eventuale consumo/aggiornamento futuro.

## Product decisions to confirm

1. Confermiamo due aree completamente separate nell’esperienza: `/territories` e `/hideouts`, con pagine di dettaglio distinte?
2. “Tier” e “Quality” sono attributi della mappa/cluster (proposta) oppure della singola entità?
3. Qual è la fonte ufficiale della conversione cibo → tempo per i Territories e per gli Hideouts? La proposta è una regola configurabile separata per dominio, così i valori non sono hardcoded.
4. L’inserimento di cibo deve registrare anche il lotto/item esatto (es. `50 × Omelette T7`) e il livello di qualità dell’item, se presente?
5. Chi può modificare: solo `officer_operations`/admin, o anche un nuovo permesso dedicato?
6. Un evento errato va annullato con un evento compensativo (proposta, audit-safe) oppure è ammessa la modifica fisica dell’evento?
7. Il tempo manuale può essere positivo e negativo? Proposta MVP: entrambi, con motivazione obbligatoria e conferma esplicita per la riduzione.
8. Serve una scadenza globale/notifica Discord quando il tempo scende sotto soglie, oppure è fuori scope iniziale?

## Acceptance Criteria

- [ ] Un utente autorizzato può vedere separatamente l’elenco dei Territories e l’elenco degli Hideouts, senza una tabella mista.
- [ ] Ogni area mostra solo i campi propri del relativo dominio, inclusi nome, mappa, map Tier, map Quality, livello se applicabile e tempo di upkeep residuo.
- [ ] Il tempo residuo è calcolato in modo deterministico a partire da un istante di riferimento e dagli upkeep event; non viene decrementato scrivendo ogni secondo nel database.
- [ ] Un utente autorizzato può registrare cibo nel dominio corretto; il sistema applica la regola di quel dominio e mostra il nuovo residuo.
- [ ] Un utente autorizzato può aggiungere o sottrarre tempo manualmente nel dominio corretto, indicando quantità, data/ora effettiva e motivazione.
- [ ] Ogni creazione, modifica dei dati di localizzazione e upkeep event mostra autore, timestamp, valori precedenti/nuovi e motivazione o dettaglio dell’operazione.
- [ ] Le correzioni sono tracciate come nuovi eventi compensativi; il log originale non viene sovrascritto.
- [ ] Il sistema valida quantità, Tier, Quality, durata e input incoerenti, senza consentire valori negativi non esplicitamente supportati.
- [ ] La pagina funziona su desktop e mobile, mantiene i pattern Angular esistenti, e rende stato e scadenza comprensibili anche senza affidarsi soltanto al colore.
- [ ] Gli endpoint sono protetti da autenticazione e permessi e le operazioni concorrenti non perdono aggiornamenti.

## Proposed domain model

I due domini restano separati nel database e nelle API. Non viene introdotta una tabella polimorfica `structures`: evita di mescolare regole, permessi e campi che potrebbero divergere.

### `territories` e `territory_upkeep_events`

`territories` contiene `id`, `name`, `map_name`/`map_id`, `map_tier`, `map_quality`, eventuale `territory_level`, stato e metadati di creazione/modifica.

`territory_upkeep_events` contiene `territory_id`, tipo evento (`food | manual_adjustment | reversal`), `delta_seconds`, dettagli cibo, regola applicata, `effective_at`, autore, motivazione e riferimento all’evento compensato.

### `hideouts` e `hideout_upkeep_events`

`hideouts` contiene gli stessi campi solo dove applicabili, con eventuali proprietà specifiche dello Hideout aggiunte senza compromettere Territories.

`hideout_upkeep_events` ha lo stesso comportamento del ledger Territory, ma con `hideout_id` e regole proprie.

### `territory_upkeep_rules` e `hideout_upkeep_rules`

Due cataloghi versionabili distinti delle conversioni cibo → secondi. La regola applicata viene copiata nell’evento al momento dell’inserimento, così una futura modifica del catalogo non altera il passato.

I componenti condivisi sono solo infrastrutturali: funzione pura per il calcolo, formatter, audit adapter e primitive UI.

Il residuo è `max(0, base_balance + somma(delta_seconds degli eventi validi))`, con il tempo trascorso sottratto dal riferimento definito dal dominio. La formula esatta e il comportamento quando il saldo arriva a zero vanno fissati prima dello Slice 2.

### Audit

Riutilizzare l’infrastruttura `audit_logs` già presente nel backend, correlando `entity_type`, `entity_id`, `user_id` e `details`. L’upkeep ledger resta la fonte per il calcolo; `audit_logs` è la vista operativa/di conformità, non la fonte numerica.

## Slices

Every slice follows RED-GREEN-MUTATE-KILL MUTANTS-REFACTOR. Before implementation, load `tdd`, `testing`, `mutation-testing`, and `refactoring`, plus the Rust and Angular guidance relevant to the slice. Acceptance criteria must be confirmed before production code is written.

### Slice 1: Un officer può vedere il catalogo separato dei Territories

**Value**: la gilda ottiene una vista read-only dedicata ai Territories, senza confonderli con gli Hideouts.

**Path**: route Angular `/territories` → API Territories → query SeaORM → DTO → tabella responsive. In questa slice il catalogo è read-only e il residuo può partire da zero/da un valore iniziale esplicito; non si implementano ancora inserimenti cibo o modifiche.

**Acceptance criteria**: con fixture di Territories, la pagina mostra nome, mappa, Tier, Quality, eventuale livello e stato `unknown/expired/active` con tempo formattato; non mostra Hideouts; loading, errore, empty state e permesso di lettura sono coperti.

**RED**: test API/query del listing e test Angular della tabella/empty/error states; coprire anche mapping dei valori enum e ordinamento stabile.

**GREEN**: migrazione/domain entity, endpoint GET, modello API, route lazy e pagina minimale riusando `DataTable`, `PageHeader`, `PageStack`.

**MUTATE**: mutation testing sui mapping enum, filtri permission e rendering degli stati.

**KILL MUTANTS**: aggiungere test per valori sconosciuti, structure inattive e confusione territory/hideout.

**REFACTOR**: estrarre solo formatter e tipi condivisi se realmente riutilizzati.

**Done when**: elenco leggibile end-to-end, test e static analysis verdi.

### Slice 2: Un officer può vedere il catalogo separato degli Hideouts

**Value**: la gilda ottiene una vista read-only dedicata agli Hideouts, separata dal ciclo operativo dei Territories.

**Path**: route Angular `/hideouts` → API Hideouts → query SeaORM → DTO → tabella responsive.

**Acceptance criteria**: con fixture di Hideouts, la pagina mostra solo le entità Hideout e i loro campi applicabili; loading, errore, empty state e permesso di lettura sono coperti.

**RED/GREEN/MUTATE/KILL MUTANTS/REFACTOR**: stessi controlli dello Slice 1, con test esplicito che impedisce di restituire dati Territory.

**Done when**: esistono due listing indipendenti e verificabili.

### Slice 3: Un officer può creare e aggiornare i Territories con audit

**Value**: il catalogo diventa mantenibile senza SQL o interventi manuali.

**Path**: `/territories/:territoryId` → dialog create/edit → API Territories → transazione Territory + audit log → refresh lista/dettaglio.

**Acceptance criteria**: create/edit valida mappa, Tier, Quality e livello Territory; la risposta mostra il nuovo stato; il log contiene autore, timestamp e before/after; utenti senza permesso ricevono 403.

**RED**: test di dominio/handler per validazione, autorizzazione, transazione e audit; test Angular del dialog e degli errori server.

**GREEN**: CRUD minimo con audit atomico e form reactive con signals secondo le convenzioni del progetto.

**MUTATE**: mutation testing su boundary numerici, permessi e mancata scrittura audit.

**KILL MUTANTS**: coprire Tier/Quality fuori range, stringhe vuote e update concorrenti.

**REFACTOR**: consolidare policy di autorizzazione solo se differisce da quelle già esistenti.

**Done when**: officer può mantenere il catalogo e ogni modifica è ricostruibile.

### Slice 4: Un officer può creare e aggiornare gli Hideouts con audit

**Value**: il catalogo Hideouts diventa mantenibile senza SQL e senza riutilizzare accidentalmente il flusso Territory.

**Path**: `/hideouts/:hideoutId` → dialog create/edit → API Hideouts → transazione + audit log → refresh.

**Acceptance criteria**: create/edit valida i campi Hideout, usa permessi Hideout dedicati e scrive audit con dominio `hideout`; un utente senza permesso riceve 403.

**RED/GREEN/MUTATE/KILL MUTANTS/REFACTOR**: test separati dagli handler Territory per validazione, autorizzazione, transazione e audit.

**Done when**: officer può mantenere gli Hideouts e ogni modifica è ricostruibile.

### Slice 5: Un officer può registrare cibo per un Territory e vedere il tempo calcolato

**Value**: inserendo `50 × Omelette T7`, il tempo residuo viene calcolato automaticamente e resta spiegabile.

**Path**: `/territories/:territoryId` → action “Add food” → regola Territory/item, quantità, `effective_at` → `territory_upkeep_events` + audit → dettaglio con breakdown e nuovo countdown.

**Acceptance criteria**: una regola `seconds_per_unit` produce esattamente `quantity × seconds_per_unit`; l’evento conserva item, Tier, quantità e valore applicato; il dettaglio mostra “aggiunto X, equivalente a Y”; quantità zero/negative, item senza regola e input ambiguo sono rifiutati.

**RED**: test puro della formula e del calcolo saldo, test di handler/transazione, test UI del form e del breakdown.

**GREEN**: upkeep rule catalog, endpoint di registrazione cibo e componente dettaglio con aggiornamento temporale locale senza polling di scrittura.

**MUTATE**: mutation testing su moltiplicazione, arrotondamento, unità secondi e selezione della regola effective-at.

**KILL MUTANTS**: casi quantity 1/50, regola mancante, cambio regola nel tempo e timestamp passato/futuro.

**REFACTOR**: mantenere la formula in una funzione di dominio pura, separata da Axum/SeaORM.

**Done when**: caso reale “50 Omelette T7” calcola il valore configurato, visualizza il residuo e produce il log.

### Slice 6: Un officer può registrare cibo per un Hideout e vedere il tempo calcolato

**Value**: il cibo degli Hideouts usa regole e storico indipendenti da quelli dei Territories.

**Path**: `/hideouts/:hideoutId` → Add food → regola Hideout → `hideout_upkeep_events` + audit → nuovo countdown.

**Acceptance criteria**: una regola Hideout produce `quantity × seconds_per_unit`; l’evento conserva item, Tier, quantità e valore applicato; un evento Territory non può alterare il saldo Hideout.

**RED/GREEN/MUTATE/KILL MUTANTS/REFACTOR**: stessi casi dello Slice 5, con test di isolamento tra i due ledger.

**Done when**: il flusso food upkeep Hideout è completo e separato.

### Slice 7: Un officer può aggiungere tempo manualmente a un Territory senza perdere la storia

**Value**: permette di correggere o estendere l’upkeep quando il tempo non deriva da cibo.

**Path**: `/territories/:territoryId` → action “Adjust time” → delta, data/ora, motivazione → `territory_upkeep_events` + audit → saldo e timeline Territory aggiornati.

**Acceptance criteria**: delta positivo e, se approvato, negativo aggiornano il saldo; la motivazione è visibile; il saldo non scende sotto zero; non è possibile modificare o cancellare direttamente eventi già registrati; una correzione conserva il riferimento all’evento compensato.

**RED**: test del ledger per add/subtract/clamp/reversal, test di autorizzazione e test UI per conferma delle riduzioni.

**GREEN**: endpoint manual adjustment, timeline e dialog con preview del nuovo residuo.

**MUTATE**: mutation testing su segno del delta, clamp a zero, obbligatorietà motivazione e reversal.

**KILL MUTANTS**: casi saldo zero, riduzione maggiore del saldo e doppio submit/idempotenza.

**REFACTOR**: introdurre idempotency key o vincolo equivalente solo se richiesto dal percorso HTTP esistente.

**Done when**: correzioni manuali sono spiegabili, reversibili e auditabili.

### Slice 8: Un officer può aggiungere tempo manualmente a un Hideout senza perdere la storia

**Value**: permette di correggere o estendere l’upkeep di uno Hideout senza mescolarlo al ledger Territory.

**Path**: `/hideouts/:hideoutId` → action “Adjust time” → delta, data/ora, motivazione → `hideout_upkeep_events` + audit → saldo e timeline Hideout aggiornati.

**Acceptance criteria**: delta positivo e, se approvato, negativo aggiornano solo il saldo Hideout; la motivazione è visibile; il saldo non scende sotto zero; non è possibile modificare o cancellare direttamente eventi già registrati.

**RED/GREEN/MUTATE/KILL MUTANTS/REFACTOR**: stessi controlli dello Slice 7, con test esplicito che un evento Territory non modifica un Hideout.

**Done when**: le correzioni manuali Hideout sono spiegabili, reversibili e auditabili.

### Slice 9: Timeline, filtri e qualità di gestione separati per dominio

**Value**: officer può capire chi ha cambiato cosa e trovare rapidamente Territories o Hideouts in scadenza, restando nella sezione corretta.

**Path**: dettaglio Territory o Hideout → timeline del relativo ledger/audit, filtri per stato/mappa/scadenza → endpoint paginato del relativo dominio → UI responsive/accessibile.

**Acceptance criteria**: timeline ordinata e paginata mostra ogni evento con autore, timestamp, delta e motivazione; filtri e refresh non alterano il saldo; stati `active`, `expiring`, `expired` hanno testo/icone oltre al colore; axe/focus/keyboard checks superano i criteri del progetto.

**RED**: test paginazione/filtri e browser-level component tests per interazioni tastiera, dialog focus e refresh.

**GREEN**: endpoint timeline, filtri e rifinitura UI.

**MUTATE**: mutation testing sui confini delle soglie e sull’ordinamento temporale.

**KILL MUTANTS**: test per eventi con stesso timestamp, pagine vuote e permessi di lettura vs modifica.

**REFACTOR**: rimuovere duplicazioni UI senza creare un componente generico prematuro.

**Done when**: il flusso operativo è completo e verificato con typecheck, lint, test e accessibilità.

## Pre-PR Quality Gate

1. Migration dry-run e test backend.
2. `cargo fmt --check`, `cargo clippy --all-targets --all-features -- -D warnings` secondo il workflow del repository.
3. `npm test` e `npm run build` in `apps/frontend`.
4. Mutation testing per ogni slice e revisione dei mutant sopravvissuti.
5. Axe/WCAG 2.2 AA per i flussi UI.
6. Verifica che i termini `territory`, `hideout`, `map tier`, `map quality`, `upkeep` siano usati in modo coerente nelle API e nella UI.

---

*Questo piano è una bozza: confermare le decisioni di dominio e i criteri prima di iniziare lo Slice 1.*
