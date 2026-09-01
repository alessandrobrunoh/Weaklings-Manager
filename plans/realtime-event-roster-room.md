# Plan: Room roster realtime per evento

**Branch proposta**: `feat/realtime-event-roster-room`  
**Status**: Implementazione completata — in attesa delle verifiche manuali di rilascio

## Obiettivo

Trasformare il tab **Roster** dell'evento in una room live, stile lobby Kahoot: l'organizzatore assegna in modo affidabile ogni membro a un posto della comp e tutti i membri presenti sulla pagina vedono immediatamente ruolo, build e abilità assegnati, con una scheda personale sempre evidente.

## Situazione attuale verificata

Il progetto ha già una base molto utile:

- `apps/frontend/src/app/features/events/event-detail.ts` ha già tab Roster, vista per party/ruolo/tabella, panchina, assegnazione, auto-fill, spostamento e tooltip della build.
- `apps/backend/src/modules/events/router.rs` espone già `PUT`/`DELETE /api/events/{id}/participants/{user_id}` per l'organizzatore o chi possiede `events.manage`.
- Build, loadout principale/swap e abilità sono già disponibili nel dominio comps; `BuildDetail.items[].spells` può alimentare la scheda briefing.
- Esiste `event_roster_roles`, ma oggi espone solamente build extra per evento e non rappresenta il posto occupato da un membro.
- Oggi il posto viene dedotto lato client dal `primary_build_id`. Non è uno stato persistito: due posti della stessa build non hanno un'identità server-side e lo spostamento di due persone usa due richieste indipendenti. Questo non è sufficiente per concorrenza, reload o sincronizzazione realtime.
- Il backend Axum non ha ancora supporto WebSocket e il deploy corrente è una singola istanza Docker Compose.

## Decisioni di prodotto e architettura

### Vocabolario canonico

| Termine | Significato |
| --- | --- |
| **Iscrizione** | La scelta del membro: build primaria e, facoltativamente, secondaria. Resta il suo input/preferenza. |
| **Posto (seat)** | Posizione concreta della comp: party, posizione e build richiesta. È l'unità che l'admin assegna. |
| **Assegnazione** | Legame persistito tra un membro iscritto e un posto. Determina il suo incarico effettivo. |
| **Ruolo** | Il `BuildRole` della build richiesta dal posto, per esempio healer, tank, dps, support. Non è un nuovo ruolo RBAC né modifica la build globale. |
| **Build** | La build/versione richiesta dal posto, inclusi loadout e abilità scelti nel modulo Comps. |
| **Bench/Panchina** | Membro iscritto senza un posto assegnato. Non equivale a uscire dall'evento. |

**Conseguenza importante:** l'organizzatore non sovrascrive più la scelta primaria del membro per metterlo in posizione. Crea o cambia una `assegnazione`; la preferenza originale resta visibile per decidere velocemente chi collocare.

### Trasporto realtime scelto

1. Le scritture restano REST, autorizzate e auditabili. Il browser non invia comandi di mutazione nel WebSocket.
2. Il WebSocket invia solo una notifica piccola con la revisione del roster. Ogni client ricevente rilegge lo snapshot da `GET /api/events/{id}` (o dall'equivalente endpoint roster) usando la session cookie e le normali autorizzazioni.
3. Il database resta l'unica fonte di verità. Un evento mancato, una riconnessione o un client lento si correggono con un refetch, senza mantenere stato critico nel socket.
4. Ogni cambiamento del roster incrementa `events.roster_version` nella **stessa transazione** della mutazione. Le operazioni amministrative ricevono `expected_roster_version`; una revisione non più corrente restituisce `409 Conflict`, non sovrascrive silenziosamente il lavoro altrui.
5. Il server pubblica la notifica solo **dopo il commit**. I membri non vedono mai uno stato che il database ha rifiutato.

Questa scelta evita messaggi enormi, riduce il rischio di leak di dati, riusa i controlli di sessione già esistenti e rende la room resiliente alle disconnessioni.

### Contratto dati proposto

Nuova migrazione, senza alterare le iscrizioni esistenti:

```text
events
  + roster_version BIGINT NOT NULL DEFAULT 0

event_roster_assignments
  event_id       BIGINT NOT NULL FK events ON DELETE CASCADE
  user_id        BIGINT NOT NULL FK users ON DELETE CASCADE
  seat_key       TEXT NOT NULL
  assigned_by    BIGINT NOT NULL FK users ON DELETE RESTRICT
  assigned_at    TIMESTAMPTZ NOT NULL
  updated_at     TIMESTAMPTZ NOT NULL

  PRIMARY KEY (event_id, user_id)
  UNIQUE (event_id, seat_key)
  INDEX (event_id, seat_key)
```

`seat_key` è una chiave canonica derivata dalla comp attiva, per esempio `build:42:2` (secondo posto della build 42). Il server genera e valida le chiavi, il client non può inventarle.

Quando l'auto-scaling dell'evento seleziona una variante di comp differente:

- i posti ancora presenti mantengono la loro assegnazione;
- un'assegnazione il cui posto non esiste più torna in panchina in modo esplicito;
- il payload `roster_changed` segnala `reconciled` e la UI spiega quali membri devono essere ricollocati;
- nessun membro viene spostato in silenzio verso un'altra build.

Gli eventi esistenti restano compatibili: le iscrizioni restano tali e partono tutte in panchina finché un manager non le assegna o non esegue l'auto-fill.

### Endpoint e messaggi proposti

I nomi possono seguire gli helper/router del progetto, ma il comportamento è contrattuale.

```text
GET    /api/events/{event_id}/roster
PUT    /api/events/{event_id}/roster/seats/{seat_key}
DELETE /api/events/{event_id}/roster/seats/{seat_key}
POST   /api/events/{event_id}/roster/swaps
POST   /api/events/{event_id}/roster/auto-fill
GET    /api/events/{event_id}/roster/live       # WebSocket Upgrade
```

`GET /roster` restituisce uno snapshot compatto:

```json
{
  "event_id": 123,
  "roster_version": 17,
  "active_comp_id": 9,
  "seats": [
    {
      "key": "build:42:2",
      "party_number": 1,
      "position": 2,
      "build_id": 42,
      "build_name": "Holy Healer",
      "build_version": 2,
      "role": "healer",
      "participant": { "user_id": 7, "username": "Luna" }
    }
  ],
  "bench": [
    {
      "user_id": 11,
      "username": "Moro",
      "preferred_primary_build_id": 42,
      "preferred_primary_build_name": "Holy Healer"
    }
  ]
}
```

Le mutazioni includono sempre `expected_roster_version`. `PUT seat` assegna o sposta un membro; `DELETE seat` lo riporta in panchina; `POST swaps` scambia due posti in una singola transazione; `POST auto-fill` applica il matching deterministico prima scelta, poi seconda scelta, senza toccare posti già assegnati.

Messaggio server → browser:

```json
{
  "type": "roster_changed",
  "event_id": 123,
  "roster_version": 18,
  "change_kind": "assigned",
  "changed_seat_keys": ["build:42:2"]
}
```

Altri messaggi consentiti: `ready`, `resync_required`, `ping` e `pong`. Non vengono inviati token, sessioni, dati di build completi o comandi di scrittura nel socket.

### Sicurezza e consistenza

- L'upgrade WebSocket estrae lo stesso `UserContext` della REST API, quindi richiede la session cookie già usata dall'app; non passa credenziali nella query string.
- Il server controlla un `Origin` esatto contro `FRONTEND_URL` prima dell'upgrade, poiché un WebSocket autenticato da cookie non ha la protezione CSRF delle richieste HTTP tradizionali.
- Qualunque utente che può già leggere il dettaglio evento può sottoscrivere la room. Solo creatore dell'evento, `events.manage` o SuperAdmin può mutare il roster, riusando `require_event_management_authority`.
- La validazione del posto, disponibilità membro, comp attiva, autorizzazione e versione attesa avviene nel service Rust, mai soltanto nella UI.
- Ogni cambiamento registra un audit event con `event_id`, attore, revisione precedente/successiva, tipo di cambiamento e posti coinvolti. Non inserire informazioni ridondanti o sensibili nel log.
- `tokio::sync::broadcast` in memoria è adeguato alla singola istanza attuale. La documentazione di deploy deve dichiarare **replicas = 1** per il backend. Non introdurre Redis o una nuova astrazione di pub/sub finché il deploy multi-replica non è una necessità reale.

## Esperienza utente proposta

### Scenario fisico e tono

Un membro consulta il roster durante il form-up, spesso su secondo schermo o telefono, con poco tempo e molte istruzioni vocali. Per questo la pagina resta un pannello operativo scuro e compatto, non una dashboard “gaming”: testo leggibile, gerarchia forte, un solo CTA rosso per l'azione primaria dell'admin e informazioni personali sempre reperibili senza caccia al proprio nome.

Si applicano `PRODUCT.md` e `DESIGN.md`: superfici scure discrete, bordi sottili, Inter, densità operativa, rosso Weaklings solo per l'azione primaria/stato di selezione. Gli stati non dipendono mai dal solo colore.

### Per tutti i membri

- Il roster è la tab iniziale come oggi e mostra `● In tempo reale` con testo di stato, non solo un pallino colorato.
- La colonna laterale sticky **Il tuo incarico** identifica il membro con il suo nome e mostra grande: numero party/posto, ruolo, build e versione. Sotto mostra le abilità Q/W/E, D/R/F e passive già configurate, con nome testuale accessibile oltre all'icona.
- La descrizione della build appare tramite disclosure nativa “Dettagli build”, non impone un modal. Se la build non ha descrizione o abilità, la UI lo dichiara chiaramente senza placeholder vuoti.
- Se il membro è in panchina, la scheda mostra “In attesa di assegnazione”, le proprie preferenze e la posizione in coda, senza fingere che abbia un ruolo.
- Tutti possono vedere l'intera comp, chi occupa ciascun posto, quali posti sono vuoti e la panchina. Un membro può ispezionare una build altrui senza poterla modificare.
- Un cambiamento ricevuto evidenzia brevemente i posti modificati. Se cambia il proprio incarico, una sola live region `polite` annuncia “Il tuo incarico è stato aggiornato: Party 2, Healer, Holy Healer v2.”, senza spostare il focus.

### Per creator, officer e admin

- I controlli non riempiono ogni card: appaiono su hover e `:focus-visible`, ma restano disponibili dalla tastiera.
- L'admin seleziona un membro dalla panchina e poi un posto libero, oppure sceglie “Sposta” su un posto occupato. Il drag and drop è un miglioramento opzionale desktop, mai l'unico modo di agire.
- Lo scambio è una singola azione “Scambia con…”, con anteprima testuale dei due nomi/build e commit atomico lato server.
- `Auto-fill` riporta prima quante assegnazioni sono possibili. Il risultato mostra il conteggio assegnati, saltati e conflitti. Non cancella manualmente gli incarichi già presenti.
- In caso di conflitto `409`, il draft viene annullato, viene ricaricato lo snapshot e un messaggio esplicito informa chi ha modificato il roster se il dato è disponibile dall'audit. L'admin può ripetere l'azione sullo stato corrente.
- Le build extra già supportate da `event_roster_roles` vengono visualizzate in una sezione **Flex**, separata dai posti obbligatori. L'aggiunta/rimozione di ruolo extra è una estensione successiva: la prima room non inventa ruoli testuali ad hoc.

### Responsive e accessibilità

- **Desktop ≥ 1024px**: board della comp a sinistra, scheda personale sticky a destra, panchina sotto o accanto alla board in base allo spazio.
- **Tablet**: scheda personale sopra la board, panchina a larghezza intera dopo le party.
- **Mobile**: prima “Il tuo incarico”, poi summary e party come sezioni comprimibili; i controlli manager usano bottoni espliciti, non drag and drop.
- Landmark: un unico `<main>`, `section` con heading sequenziali e `<aside aria-labelledby>` per briefing/panchina. Le liste ripetute sono vere `<ul>`; la vista tabellare usa caption e header semantici.
- Una sola live region `polite` per connessione e cambiamenti rilevanti all'utente, con debounce. Non annunciare tutti gli aggiornamenti degli altri membri, sarebbe rumore.
- Focus non si sposta quando arriva un evento realtime. Tutti i bottoni hanno nomi univoci (“Assegna Luna a Party 1, posto 2”), focus visibile, target adeguati e stato disabled/errore/loading leggibile.
- Rispettare `prefers-reduced-motion`; l'evidenza del posto diventa statica. Verificare WCAG 2.2 AA e Axe su desktop/mobile.

## Acceptance Criteria di prodotto

- [ ] Un evento con membri iscritti mostra un roster con party, posti, ruolo, build richiesta, occupante, posti vuoti e panchina; un reload conserva esattamente le assegnazioni fatte dall'admin.
- [ ] L'organizzatore o chi ha `events.manage` assegna, sposta, libera e scambia membri senza modificare le loro preferenze primaria/secondaria, mentre un membro normale non può mutare il roster né bypassare il controllo costruendo una richiesta manuale.
- [ ] Uno scambio non espone mai a un osservatore uno stato intermedio e non può lasciare due membri sullo stesso posto o un membro su due posti.
- [ ] Con due browser autenticati sulla stessa pagina evento, un'assegnazione riuscita in A appare in B senza refresh manuale; B recupera anche dopo disconnessione, tab in background o messaggio perso.
- [ ] Ogni mutazione ha versione attesa; una richiesta fatta su un roster non aggiornato riceve `409`, non sovrascrive l'assegnazione più recente e porta la UI allo snapshot corrente.
- [ ] Ogni membro vede in modo prominente il proprio incarico, ruolo, build/versione, equipaggiamento e abilità selezionate. Se non assegnato, vede chiaramente panchina e preferenze.
- [ ] Ruolo, posto, testo e icone comunicano lo stato insieme: nessuna informazione critica dipende dal colore o dal solo hover.
- [ ] La room resta utilizzabile da tastiera, a zoom 200%, con screen reader e su viewport mobile; gli aggiornamenti non rubano focus né producono annunci continui.
- [ ] L'upgrade WebSocket rifiuta sessioni assenti e origin non consentite. Nessun token appare nell'URL, nei messaggi socket o nei log.
- [ ] Audit, tracing e metriche consentono di diagnosticare cambiamenti, conflitti, connessioni, riconnessioni, lag e errori senza loggare il payload completo della room.

## Stato di implementazione e verifica

Completato nel worktree:

- stato roster persistito, revisioni ottimistiche e vincolo partecipazione/assegnazione;
- snapshot REST, comandi atomici e invalidazioni WebSocket post-commit;
- room Angular con riconnessione, sospensione in background, briefing personale e comandi admin;
- test frontend, build frontend, `cargo fmt --check`, `cargo check -p backend` e test mirato cancel/rejoin.

Completata anche la documentazione del reverse-proxy WebSocket e del requisito backend a replica singola in `README.md`. Da completare prima del rilascio: smoke test con due sessioni browser contro Postgres e verifica a11y (tastiera, zoom 200%, screen reader/Axe). La suite backend completa ha eseguito 327 test con successo; resta un test estraneo al roster da correggere in `modules::auth::permissions::tests::all_contains_every_variant` (elenco atteso 32, enum attuale 33).

## Slices

Ogni slice è una PR indipendente e segue **RED → GREEN → MUTATE → KILL MUTANTS → REFACTOR**. Prima del codice caricare `tdd`, `testing`, `mutation-testing`, `refactoring`, `rust-guidelines`, `modern-web-guidance`, `impeccable` e la guida a11y quando viene toccata l'interfaccia. I criteri della singola slice vanno presentati e approvati dall'utente prima di scrivere codice.

### Slice 1: Un manager assegna un membro a un posto persistito e il membro vede il proprio incarico dopo reload

**Value**: il roster smette di dedurre posti in modo fragile; creator/officer possono effettuare un'assegnazione verificabile e il membro ha un ordine affidabile.

**Actor / trigger / outcome**: creator/officer assegna Luna al posto `Holy Healer #2`; il server persiste quell'associazione e sia il reload sia la scheda personale mostrano Party 1, posto 2, Healer, Holy Healer v2.

**Path**: UI room statica → `PUT /api/events/{id}/roster/seats/{seat_key}` → guard owner/permission → transazione service → `event_roster_assignments` + incremento `roster_version` → snapshot `GET /roster` → signals Angular → card posto + “Il tuo incarico”. Le iscrizioni esistenti restano input di preferenza.

**Acceptance criteria**:
- migration compatibile con DB nuovi/esistenti, vincoli `(event_id,user_id)` e `(event_id,seat_key)` effettivi;
- seat key generata e validata lato server contro la comp attiva, inclusa la seconda occorrenza della stessa build;
- utente non iscritto, posto inesistente, posto già occupato e caller non autorizzato vengono rifiutati senza mutazioni parziali;
- una nuova assegnazione non modifica `event_participations.primary_build_id` né la scelta secondaria;
- snapshot legge i dati dal database, non da stato frontend; eventi legacy restituiscono panchina senza errore;
- primo layout include card personale per assegnato e non assegnato.

**RED**: test Rust migration/service con due posti della stessa build, due utenti, caller non autorizzato, posto già occupato, key non valida e preservazione delle preferenze. Test Vitest per la derivazione “mio incarico” e stati assegnato/panchina. Mutanti da coprire: uguaglianza `event_id`, indice del posto, vincoli unique, permesso OR e incremento revisione.

**GREEN**: migrazione/entity/DTO/endpoint service e minimale componente/signal roster; eliminare dal percorso gestito le deduzioni client `slotAssignments` per il nuovo snapshot, lasciando invariata la visualizzazione degli altri tab.

**MUTATE / KILL MUTANTS**: revisione manuale documentata finché non viene installato un tool mutation; test espliciti per due seat identici, stesso user, stesso seat e primario invariato.

**REFACTOR**: estrarre solo un generatore server-side di seat canonici condiviso da snapshot e validazione.

**Done when**: l'assegnazione è durevole, autorizzata e visibile dopo reload, con test backend/frontend verdi.

### Slice 2: Due membri nella stessa event room vedono un cambio roster in tempo reale

**Value**: la room diventa live senza mettere i dati critici nel WebSocket.

**Actor / trigger / outcome**: un manager assegna un posto in browser A; browser B, già nella room, ricarica lo snapshot e vede lo stesso occupante automaticamente.

**Path**: commit Slice 1 → `RosterHub.publish` → `GET /api/events/{id}/roster/live` WebSocket autenticato → `roster_changed` → `RealtimeRosterService` → refetch coalescente `GET /roster` → signal snapshot → board aggiornata.

**Acceptance criteria**:
- handshake richiede `UserContext`, evento esistente e `Origin` autorizzato;
- il messaggio contiene solo type, evento, versione, tipo e seat keys, e viene emesso solo dopo commit;
- client ignora messaggi per versione minore/uguale e raggruppa più notifiche in un solo refetch serializzato;
- la UI mostra “Connesso in tempo reale”, “Riconnessione…” e “Snapshot aggiornato”, con testo e non solo colore;
- chiudendo o distruggendo la pagina il socket e heartbeat sono chiusi; tab nascosta interrompe la connessione, tab visibile effettua refetch e riconnessione;
- il backend resta dichiaratamente single replica.

**RED**: test hub per topic isolati e subscriber lento; test router WebSocket per 401/origin/evento; test service frontend con mock WebSocket per ready, aggiornamento, versione vecchia, burst e teardown. Test di integrazione Axum che collega due client e osserva il messaggio dopo la mutazione completata.

**GREEN**: attivare feature `axum` WebSocket, `RosterHub` locale in `Extension`, route WS e `RealtimeRosterService` strettamente tipizzato. Aggiornare Vite/proxy e reverse proxy applicabili per supportare Upgrade WebSocket.

**MUTATE / KILL MUTANTS**: coprire inversione confronti di versione, pubblicazione prima del commit, event ID scambiato, origin permissivo e mancato teardown.

**REFACTOR**: mantenere il socket separato da `ApiService`: HTTP resta il client autorevole dello snapshot.

**Done when**: il test a due client e una verifica manuale con due finestre mostrano aggiornamento automatico, senza polling continuo.

### Slice 3: Il manager sposta, libera, scambia e auto-riempie il roster con comandi atomici

**Value**: l'organizzatore può comporre rapidamente la lineup senza stati intermedi o sovrascritture silenziose.

**Actor / trigger / outcome**: l'admin seleziona un membro/panchina e un posto, scambia due posti o esegue auto-fill; tutti i client ricevono un unico roster coerente.

**Path**: controlli board → REST command con `expected_roster_version` → transazione di assegnazione/scambio/auto-fill → audit + versione → publish post-commit → room aggiornata.

**Acceptance criteria**:
- il move libera implicitamente il vecchio posto dello stesso utente e assegna il nuovo in una sola transazione;
- swap di due posti è un solo endpoint/transaction e non riusa due `PUT` parallele;
- clear sposta in panchina senza cancellare l'iscrizione;
- auto-fill è deterministico, non cambia i posti manuali, usa prima la preferenza primaria poi la secondaria e ritorna assegnati/saltati;
- richieste con revisione obsoleta ricevono `409` con revisione corrente; UI chiude lo stato temporaneo, rilegge e spiega il conflitto;
- drag/drop desktop, se mantenuto, invoca gli stessi comandi; ogni azione ha alternativa a bottoni e tastiera.

**RED**: test service transazionali per move, swap, clear, doppio click/concorrenza, stale revision, due posti con stessa build e auto-fill a parità di input. Test Angular di selezione, conferma, errore 409 e disabilitazione durante invio.

**GREEN**: endpoints comando, lock/transaction adeguati nel DB, audit e toolstrip UI essenziale. Sostituire l'attuale swap a doppia richiesta e l'auto-fill con molte richieste individuali.

**MUTATE / KILL MUTANTS**: testare entrambi i rami target libero/occupato, ordine source/target, `>=`/`>` della revisione e filtro posti manuali.

**REFACTOR**: una sola funzione di comando con invarianti condivisi; non creare un state manager frontend parallelo al server.

**Done when**: nessuna operazione lascia assegnazioni impossibili e una room remota osserva solamente il risultato atomico.

### Slice 4: Ogni membro riceve un briefing leggibile della propria build e delle abilità

**Value**: il roster non comunica soltanto “dove sei”, ma “cosa devi giocare”.

**Actor / trigger / outcome**: un membro riceve un'assegnazione o apre la room; vede prominentemente ruolo, party/posto, build/versione, item principali, Q/W/E, D/R/F, passive e dettagli disponibili.

**Path**: roster snapshot → build ID assegnata → dati `BuildDetail` esistenti → componente read-only `RosterAssignmentBrief` → card personale e ispezione build nel board.

**Acceptance criteria**:
- il briefing seleziona la build **assegnata**, non soltanto la preferenza primaria;
- icone hanno nome testuale/accessibile e fallback quando CDN/icona fallisce;
- abilità non selezionate/non applicabili non producono chip vuoti; loadout swap è chiaramente etichettato e non confuso col main;
- descrizione e dettagli estesi usano disclosure accessibile, non tooltip hover-only;
- membro non assegnato vede il proprio stato e le preferenze, senza falsa card build assegnata;
- build di tutti resta consultabile read-only dalla board senza introdurre una seconda fonte dati.

**RED**: test di rendering per healer con abilità, build senza abilità, swap, icona fallita, utente assegnato ad una build diversa dalla preferenza e panchina. Test accessibilità per nomi icone/disclosure.

**GREEN**: componente piccolo OnPush con signals/input e riuso dei DTO/cataloghi esistenti; visualizzazione compatta nel posto e briefing espanso personale.

**MUTATE / KILL MUTANTS**: coprire guard `assignedBuildId ?? preferredBuildId`, filtro ability vuota e differenza main/swap.

**REFACTOR**: condividere il renderer read-only delle abilità con i componenti Comp solo se riduce effettiva duplicazione.

**Done when**: l'ordine personale è comprensibile in pochi secondi e non richiede navigazione alla pagina Build.

### Slice 5: La room è efficiente, accessibile e pronta alla gestione durante il form-up

**Value**: membri e admin possono usare il roster sotto pressione da desktop, tablet o telefono senza regressioni causate dal realtime.

**Actor / trigger / outcome**: un utente naviga il roster con tastiera/screen reader oppure da mobile, mentre il roster cambia; conserva contesto, focus e accesso ai comandi.

**Path**: componenti room → markup semantico e breakpoint → live announcer centralizzato → `prefers-reduced-motion`/visibility → test Axe e browser → deploy checklist.

**Acceptance criteria**:
- layout desktop board + aside, tablet in flusso e mobile briefing-prima con party comprimibili; zoom 200% non perde comandi;
- righe/card roster usano elementi semantici, heading sequenziali, nomi di azione univoci e focus visibile ad alto contrasto;
- cambiamenti altrui non spostano focus né vengono tutti annunciati; cambiamento proprio e stato socket sono annunciati al massimo una volta per aggiornamento rilevante;
- `aria-live` non annuncia spinner/heartbeat; motion rispetta reduced motion;
- offline, errore socket, retry e snapshot stale hanno messaggi operativi chiari e un refetch/reconnect sicuro;
- test Axe è disponibile nel workspace e gira sui principali stati della room; controlli della UI hanno default, hover, focus, active, disabled, loading ed error.

**RED**: test Vitest/Axe per assegnato, bench, admin, errore socket e mobile; test di keyboard flow per seleziona membro → seleziona posto → conferma; test di visibility/reconnect e no focus steal.

**GREEN**: rafforzare markup, responsive CSS/Tailwind, annunci e gestione lifecycle. Aggiungere il più piccolo harness Axe compatibile con Vitest se il progetto non ne possiede già uno.

**MUTATE / KILL MUTANTS**: testare rimozione `aria-live`, inversione reduced-motion, reconnect senza refetch, azioni solo hover e breakpoint invertiti.

**REFACTOR**: semplificare solo dopo aver mantenuto invariati contratti REST/WS e flow tastiera.

**Done when**: Axe, test mirati e verifica manuale keyboard/mobile sono verdi; la room è pronta per l'uso reale.

### Slice 6: Il team può diagnosticare e rilasciare la room live in sicurezza

**Value**: un problema realtime è individuabile e l'infrastruttura non viene scalata in modo incompatibile.

**Actor / trigger / outcome**: un operatore osserva errore di connessione o conflitto; log/metriche indicano room, fase e revisione senza esporre payload, e il deploy dichiara la limitazione single-replica.

**Path**: hub/route/service → tracing strutturato + metriche esistenti o leggere → documentazione config/proxy/deploy → runbook di verifica.

**Acceptance criteria**:
- tracing include `event_id`, user ID interno (quando lecito), connection lifecycle, close code, revision e failure kind, ma non serializza payload/socket cookie;
- metriche o contatori equivalenti distinguono connessioni attive, broadcast, receiver lag, reconnect e 409; soglie/log sono ragionevoli;
- README/deploy spiegano WebSocket Upgrade nel proxy e backend a una replica; un tentativo di multi replica è bloccato/documentato;
- runbook descrive verifica: due browser, origin rifiutato, network offline/online, refresh e conflitto concorrente;
- nessuna metrica/tracing modifica la semantica della room o causa un broadcast fallito.

**RED**: test sul formato log/contatori dove il progetto consente dependency injection, e checklist riproducibile del runbook.

**GREEN**: strumentazione minima e documentazione operativa, senza introdurre un nuovo stack di osservabilità.

**MUTATE / KILL MUTANTS**: assicurare che errori/lag non siano trattati come successi e che un broadcast fallito non rollbacki dati già commitati.

**REFACTOR**: mantenere la strumentazione al bordo del trasporto, non nel modello domain.

**Done when**: rilascio e diagnosi sono ripetibili, con vincolo single-replica esplicito.

## Ordine, dipendenze e rischi

| Rischio | Mitigazione nel piano |
| --- | --- |
| Seat dedotti in modo ambiguo per build duplicate | Seat key canonico e persistenza univoca in Slice 1. |
| Due admin sovrascrivono la lineup | Versione monotona e 409, swap/move atomici in Slice 3. |
| Messaggio WebSocket perso o client in background | Snapshot REST autorevole, versione e reconnect/refetch in Slice 2 e 5. |
| WebSocket cookie cross-origin | Controllo `Origin`, auth sul handshake, nessun token URL. |
| Roster cambia dopo auto-scaling comp | Reconciliation esplicita: mantiene seat validi, riporta solo quelli invalidi in bench. |
| Spam per screen reader o batteria | Annunci limitati, no polling, socket sospeso in tab non visibile. |
| Più backend replica | Vincolo esplicito a una replica; introdurre un bus distribuito solo con requisito reale. |
| UI sovraccarica durante il form-up | Scheda personale prioritaria, controlli admin progressivi, hover mai come unico canale. |

## Fuori scope della prima release

- Chat, voice, presence “chi è online” o cursori live: aumentano privacy, moderazione e complessità senza migliorare l'assegnazione core.
- Modifica delle build globali, abilità o categorie dalla room evento.
- Ruoli testuali ad hoc non legati a una build; i ruoli sono quelli dei build seat della comp.
- Pub/sub distribuito, Redis e supporto multi-backend replica.
- Sincronizzazione di roster live in Discord. Il bot può essere integrato con un piano separato, dopo aver stabilizzato la fonte di verità web.
- Notifiche push/Discord automatiche per ogni movimento nel roster.

## Pre-PR Quality Gate

1. Approvare i criteri della slice prima del RED.
2. Report MUTATE, manuale documentato finché non viene scelto/configurato un tool mutation.
3. Backend: `cargo fmt --check`, `cargo clippy --workspace --all-targets`, test mirati e `cargo test` disponibile.
4. Frontend: `npm test`, typecheck/build disponibili e test del client WebSocket mockato.
5. Test di integrazione del protocollo per Slice 2/3 e verifica manuale con due sessioni browser.
6. Axe/WCAG 2.2 AA per gli stati modificati, keyboard flow, 200% zoom e reduced motion.
7. Controllo sicurezza: origin, sessione assente, no token URL/log, 409 concorrente, retry dopo offline.
8. Presentare risultato e report MUTATE; attendere approvazione esplicita prima di ogni commit.

---
*Eliminare questo file quando tutte le slice sono completate. Se `plans/` resta vuota, eliminare anche la directory.*
