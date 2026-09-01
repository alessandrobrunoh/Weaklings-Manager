# Plan: Fill Discord e catena di espansione delle comp

**Branch**: `feat/event-fill-and-comp-expansion-chain`
**Status**: Proposed — awaiting approval

## Goal

Chi si iscrive dal messaggio Discord dell’evento può sempre scegliere `Fill` senza dichiarare una build; quando le iscrizioni superano la capacità della comp corrente, l’evento risolve automaticamente la prima comp di espansione adeguata lungo una catena infinita `10 → 15 → 20 → …`.

## Decisioni confermate

1. `Fill` è un **ruolo virtuale permanente**, sempre la prima scelta nel flusso Discord, con capacità illimitata e senza build obbligatoria.
2. `parent_id` mantiene la direzione relazionale standard: la comp più piccola è il padre/base e la comp più capiente è il figlio/espansione. Esempio: `10 (base) → 15 (figlia) → 20 (figlia della 15)`.
3. Una comp di espansione contiene una **snapshot completa**: eredita tutte le build e quantità del padre al momento della creazione e riceve solo le build/quantità aggiuntive inserite dall’officer. Perciò la 15 resta leggibile ed utilizzabile anche se in seguito la 10 viene modificata.
4. L’evento salva la comp base. La `active_comp` è una risoluzione dinamica basata sul numero totale di iscritti: sceglie la comp discendente con la capacità minima sufficiente; oltre l’ultima capacità nota conserva l’ultima comp attiva e gli ulteriori iscritti possono comunque usare `Fill`.
5. Le comp già presenti non vengono convertite automaticamente in delta o alterate. Il resolver è difensivo: segue solo discendenti con capacità strettamente maggiore e interrompe cicli/dati incoerenti, così dati legacy non cambiano significato né bloccano l’evento.
6. È vietato creare o aggiornare una relazione che formi un ciclo; le nuove comp collegate devono aumentare la capacità rispetto al padre immediato.
7. I ruoli extra per-evento già esistenti restano disponibili come build precise; non sostituiscono il ruolo virtuale `Fill`.

## Acceptance Criteria

- [ ] Nel messaggio interattivo del thread Discord, il primo menu di iscrizione contiene sempre `Fill — qualsiasi ruolo/build`, anche quando la comp non ha build.
- [ ] Se un membro seleziona `Fill`, l’iscrizione viene salvata senza una build primaria, il roster/embed si aggiorna e la UI mostra `Fill` invece di un ID build fittizio.
- [ ] `Fill` non richiede una build placeholder nel catalogo e non consuma né limita la capacità della comp.
- [ ] Una comp creata come espansione include automaticamente le build e le quantità della comp padre, quindi l’officer deve aggiungere solo l’incremento necessario.
- [ ] Per una catena `10 → 15 → 20`, con 1–10 iscritti l’evento espone la 10, con 11–15 la 15 e con 16–20 la 20; il comportamento continua per qualunque profondità.
- [ ] Il bot offre le build della comp prevista per la prossima iscrizione, non soltanto quelle della comp attiva prima del click. Un undicesimo membro può quindi scegliere una build aggiunta nella comp da 15.
- [ ] Dati legacy con relazioni non crescenti o cicliche non provocano loop né selezioni errate; un tentativo di creare un ciclo o un’espansione non più capiente riceve un errore di validazione chiaro.
- [ ] `/comps` visualizza tutte le radici e tutti i discendenti a profondità arbitraria, con indentazione a scaletta, capacità totale e incremento rispetto al padre.
- [ ] Backend, bot e frontend superano i test, typecheck/build e lint disponibili. Il progetto non ha mutation testing configurato: per ogni slice viene prodotto un manual mutation-review che copre i predicati di capacità, profondità, ciclo e `Fill`/build-null.

## Domain and API shape

### Fill participation

`event_participations.primary_build_id` diventa nullable. `NULL` è l’unica rappresentazione persistita di `Fill`; non viene aggiunta una build di sistema e non viene serializzato un ID sentinella.

- `ParticipateEventRequest.primary_build_id: Option<i64>`: `null` significa `Fill`; un ID significa una build primaria precisa.
- `EventParticipantView.primary_build_id: Option<i64>` e `primary_build_name: "Fill"` per la scelta virtuale.
- Event analytics e qualsiasi read path che parte dalla build primaria ignorano partecipazioni `Fill` per le statistiche specifiche della build, ma le contano nel roster e nella capacità dell’evento.
- Il bot invia un valore menu esplicito `fill`, che esegue il POST con `{ "primary_build_id": null }`; le altre opzioni mantengono il flusso ruolo → build.

### Expansion comp snapshot

Non serve una tabella nuova: `comp_builds` della figlia conserva la snapshot effettiva completa.

Quando `CreateCompRequest.parent_id` è presente, il service:

1. carica le build e quantità della comp padre;
2. interpreta le build della richiesta come **aggiunte**;
3. somma quantità della stessa build, inserisce le build nuove e persiste la snapshot risultante;
4. rifiuta il risultato se la capacità non supera quella del padre.

Il clone generico con capacità identica diventa una comp indipendente (`parent_id = null`) oppure l’officer usa la nuova azione di espansione e aggiunge capacità prima del salvataggio. La creazione di una versione conserva il padre soltanto se la capacità della versione continua a essere maggiore della capacità del padre.

Un helper backend percorre in modo iterativo/ricorsivo tutti i discendenti raggiungibili dal `event.comp_id`, con `visited` per sicurezza. Ordina le candidate valide per capacità e seleziona la minima che soddisfa il roster target. Le candidate non strettamente maggiori del proprio padre e quelle in cicli vengono ignorate e loggate.

### Prospective signup options

Aggiungere un endpoint letto dal bot, ad esempio:

```text
GET /api/events/{id}/signup-options
```

Esso calcola la dimensione **dopo** l’eventuale nuova iscrizione dell’utente chiamante (la dimensione invariata se è già iscritto), risolve la comp adeguata e restituisce:

- il riferimento e la capacità della comp prevista;
- l’insieme delle build della sua snapshot;
- gli extra roster role dell’evento;
- la voce virtuale `Fill`.

`participate` ricalcola la stessa comp sul server usando il roster corrente, quindi l’endpoint serve unicamente a un menu corretto e non è un’autorizzazione affidata al client.

### Hierarchy view

Il frontend costruisce una struttura ricorsiva e non più `CompTreeItem { children: CompSummary[] }` a un solo livello. Ogni nodo espone:

- `depth` per rientro, connettori e accessibilità;
- discendenti ordinati in modo stabile;
- capacità totale della snapshot;
- `+incremento` dalla capacità del padre per i nodi figli;
- stato expand/collapse individuale a ogni profondità.

Ricerca e filtro mantengono il percorso degli antenati dei risultati, evitando figli orfani nella vista filtrata.

## Slices

Ogni slice segue **RED → GREEN → manual MUTATE review → KILL MUTANTS → REFACTOR**. Prima del codice si caricano `rust-guidelines`, `modern-web-guidance` quando viene modificato Angular, più le skill `tdd`, `testing`, `mutation-testing` e `refactoring` se disponibili. I criteri della slice saranno ripresentati per conferma prima di scrivere codice.

### Slice 1: Un membro Discord può iscriversi come Fill senza build

**Value**: un giocatore può dichiararsi disponibile a qualsiasi ruolo senza inventare o scegliere una build precisa.

**Path**: menu `Join / Change Build` nel thread → selezione `Fill` → API partecipazione con build primaria null → persistenza e read model → aggiornamento embed/risposta ephemeral.

**Acceptance criteria**:

- Il menu mostra `Fill` come prima scelta e lo gestisce come un’azione distinta dalle categorie di build.
- La migration rende nullable la FK della build primaria senza perdere iscrizioni esistenti.
- Il backend accetta soltanto una build valida o `null` per Fill; aggiorna una partecipazione già esistente in modo idempotente.
- Le viste bot/frontend indicano `Fill`; i percorsi di statistiche/regear che richiedono una build gestiscono `None` senza panic né attribuzione fittizia.
- Il conteggio partecipanti include Fill, mentre i posti di build non vengono consumati o falsificati.

**RED**:

- Test Rust: iscrizione con `primary_build_id: None`, aggiornamento build→Fill e Fill→build, serializzazione della vista, e regressione analytics su build-null.
- Test bot: `Fill` prima delle categorie e POST con `primary_build_id: null`.
- Mutanti manuali: invertire `is_none`, sostituire `null` con `0`, omettere la voce Fill, e trattare Fill come ID build.

**GREEN**: migration/entity/model nullable, read/write path robusti, tipi TypeScript sincronizzati e ramo di selezione Discord.

**MUTATE / KILL MUTANTS**: documentare gli equivalenti manuali eseguiti e aggiungere test che fallirebbero con ciascun mutante rilevante.

**REFACTOR**: estrarre un piccolo predicato/nome di dominio per l’assegnazione Fill solo se evita controlli `Option` duplicati.

**Done when**: i criteri sono verificati e le suite backend/bot mirate sono verdi.

### Slice 2: Un officer crea una comp di espansione e l’evento risolve tutta la catena

**Value**: l’officer configura rapidamente una comp da 15 partendo dalla 10 e l’evento passa automaticamente alla comp adatta al crescere del roster.

**Path**: creazione comp con padre → service unisce snapshot padre + aggiunte → validazione crescita/ciclo → evento legge roster → resolver attraversa discendenti → `EventDetailView.active_comp_*` espone la capacità corretta.

**Acceptance criteria**:

- La creazione di una figlia parte dalle build del padre e salva una snapshot con le aggiunte.
- La capacità di ogni nuova figlia è strettamente maggiore di quella del padre; self-parent e cicli diretti/indiretti vengono rifiutati.
- La risoluzione copre almeno tre livelli e sceglie il minimo sufficiente; oltre l’ultimo livello mantiene il più capiente.
- Una catena legacy incoerente viene saltata in sicurezza e non modifica righe esistenti.
- La UI di creazione chiarisce che la comp è un’espansione e mostra le build ereditate rispetto alle sole aggiunte.

**RED**:

- Test Rust per ereditarietà/addizione, 10→15→20, esatta soglia, overflow, rami, ciclo e figlio non crescente.
- Test Angular unitario per il draft di espansione con capacità/base mostrati correttamente.
- Mutanti manuali: `>`/`>=`, scelta della capacity massima invece della minima, query soltanto dei figli diretti, rimozione di `visited`, e somma anziché merge delle build duplicate.

**GREEN**: helper di traversamento e validazione nel dominio comps/events, endpoint/detail invarianti, e flusso di creazione Angular coerente.

**MUTATE / KILL MUTANTS**: eseguire la matrice soglie/ciclo/rami contro gli equivalenti dei mutanti descritti.

**REFACTOR**: centralizzare la lettura della capacità per evitare che comps ed events applichino regole diverse.

**Done when**: una comp 10/15/20 è configurabile e il dettaglio evento mostra 10, 15 e 20 alle rispettive soglie.

### Slice 3: Il menu Discord offre le build della comp che verrà attivata

**Value**: il membro che fa superare la soglia può scegliere anche un ruolo/build aggiunto nella nuova comp, senza un errore o un secondo tentativo.

**Path**: bottone Join → endpoint prospective signup options → menu ruolo/build o Fill → partecipazione → resolver server-side → embed della card aggiornato con comp/capacità effettive.

**Acceptance criteria**:

- Per un undicesimo membro di una catena 10→15, il bot legge e presenta le build della 15, incluse le aggiunte non presenti nella 10.
- Per un membro già iscritto il menu è basato sul roster invariato, per evitare salti artificiali di tier durante il cambio build.
- La partecipazione ricalcola sempre lato server; una richiesta manuale per una build non consentita dalla comp effettiva viene rifiutata.
- Dopo l’iscrizione la card nel thread mostra comp, capacità e roster aggiornati.

**RED**:

- Test service/router per dimensione prospettica di utente nuovo/esistente e shape dell’endpoint.
- Test bot per la sequenza di menu al confine 10→15 e l’edit dell’embed.
- Mutanti manuali: usare `current` anziché `prospective`, contare due volte l’utente esistente, fidarsi del comp ID del client, o aggiornare il messaggio senza i componenti.

**GREEN**: endpoint tipizzato e handler bot senza `any`, più aggiornamento del messaggio originale preservando action row.

**MUTATE / KILL MUTANTS**: verificare manualmente casi 10/11/15/16 e i due stati utente descritti.

**REFACTOR**: condividere i tipi delle signup options tra handler button e select per prevenire deriva.

**Done when**: l’undicesimo membro completa una scelta introdotta dalla comp 15 in un solo flusso Discord.

### Slice 4: `/comps` mostra una scaletta espandibile a profondità illimitata

**Value**: officer e shotcaller leggono facilmente tutte le espansioni di una comp e capiscono quale capacità aggiunge ogni livello.

**Path**: lista comps → costruzione albero ricorsivo → filtri/ricerca → rendering annidato e controlli expand/collapse → navigazione al dettaglio.

**Acceptance criteria**:

- Una catena 10→15→20→25 appare su quattro livelli, con connettori/rientro e indicatori `10`, `+5 = 15`, `+5 = 20`, `+5 = 25`.
- Expand/collapse funziona indipendentemente per ogni ramo e il comando globale opera su tutti i nodi espandibili visibili.
- Filtri e ricerca mantengono gli antenati necessari a capire il percorso del risultato.
- Una relazione legacy mancante/ciclica non blocca il rendering: viene resa come radice di recupero una sola volta.
- La tabella resta navigabile con tastiera, ha controlli con label/tooltip comprensibili e supera le verifiche Angular/Axe disponibili.

**RED**:

- Test Angular puri per costruzione albero, profondità, ricerca con antenati, cicli e expand state.
- Test del template/componente per nested rows e dati di incremento.
- Mutanti manuali: eliminare la guardia `visited`, azzerare `depth`, filtrare gli antenati, espandere solo il primo livello e usare il delta invertito.

**GREEN**: view model ricorsivo tipizzato, template con rendering ricorsivo/flattened accessibile e stili responsivi esistenti.

**MUTATE / KILL MUTANTS**: registrare copertura dei cinque mutanti manuali e gli esiti test.

**REFACTOR**: mantenere il modello dell’albero puro e separato dal componente se ciò migliora testabilità.

**Done when**: `/comps` visualizza correttamente una catena arbitraria e gli strumenti frontend disponibili sono verdi.

## Pre-PR Quality Gate

Per ogni slice:

1. test mirati RED/GREEN e suite applicabile (`cargo test`, `npm test`/`npm run type-check`);
2. review manuale di mutation adequacy, poiché non è configurato `cargo-mutants`/Stryker;
3. `cargo fmt --check`, `cargo clippy` quando il backend compila, e build/typecheck bot/frontend;
4. controllo dei contratti Rust ↔ TypeScript (`Option<i64>`/`number | null`) e dei dati legacy;
5. nessun commit senza approvazione esplicita dell’utente.

---
*Il piano resta attivo fino al completamento delle slice; sarà eliminato a feature completata.*
