# Plan: Event Mass, Auto-start and Cancel

**Status**: Active

## Goal

Separare il momento operativo del Mass dall'orario di avvio automatico, gestire il ciclo Discord dell'evento senza supervisione manuale e permettere di annullarlo dal gestionale o dal thread Discord.

## Assumptions confirmed

- `Mass time` invia il ping ai partecipanti e crea il canale vocale, lasciando l'evento `scheduled`.
- `Start time` avvia automaticamente l'evento e lo porta a `live`.
- `Cancel` usa uno stato distinto `cancelled`, chiude il thread e rimuove il canale vocale se vuoto.
- L'auto-stop scatta dopo 2 controlli consecutivi vuoti, solo quando l'evento è `live`.
- Il form usa una sola data con due orari separati; `Mass <= Start` è obbligatorio.
- Per gli eventi esistenti la migrazione inizializza `Mass = Start - 30 minuti`.

## Acceptance Criteria

- [ ] Creazione e modifica evento persistono e restituiscono data, Mass time e Start time distinti.
- [ ] La lista e il dettaglio eventi mostrano chiaramente Data, Mass e Inizio.
- [ ] Il bot, al Mass time, pinga gli iscritti e crea/binda il canale vocale una sola volta.
- [ ] Il bot, allo Start time, rende l'evento `live` senza ricreare il canale già creato.
- [ ] Il worker controlla i canali degli eventi live e auto-stoppa dopo due tick consecutivi senza membri.
- [ ] `Cancel` dal gestionale e dal bottone Discord è autorizzato, idempotente, marca l'evento `cancelled`, aggiorna il messaggio/thread e pulisce il canale quando vuoto.
- [ ] Gli eventi cancellati non vengono riavviati, non accettano nuove iscrizioni e non vengono trattati come eventi stoppati normali.
- [ ] Migrazioni, API types, test backend/bot/frontend e build restano verdi.

## Slices

### Slice 1: Persistenza e API degli orari/stati

**Value**: Ufficiali e bot ricevono un contratto unico con Mass e Start separati e possono cancellare un evento in modo esplicito.

**Path**: migration -> SeaORM entity -> DTO/service -> REST endpoints -> API models/types.

**Acceptance criteria**: create/update/get/list espongono entrambi i timestamp; `POST /api/events/{id}/cancel` produce `cancelled`; start/stop/cancel hanno transizioni valide e testate.

**RED**: test per parsing/validazione `mass <= start`, transizioni terminali e idempotenza cancel.

**GREEN**: aggiungere colonne, DTO, stato e endpoint con il minimo codice necessario.

**Done when**: test backend e migration compile passano.

### Slice 2: Flusso Discord Mass -> Start -> auto-stop

**Value**: Il ciclo dell'evento non richiede più che un ufficiale prema Start e si chiude quando il canale resta vuoto.

**Path**: poller -> lifecycle service -> Discord channel/ping -> API lifecycle -> thread message.

**Acceptance criteria**: Mass crea il canale e invia ping una sola volta; Start automatico porta a live; il controllo vuoto richiede due tick; il canale viene eliminato solo se vuoto; errori Discord/API vengono ritentati senza duplicazioni.

**RED**: test per payload/azioni, deduplicazione, countdown e due controlli vuoti.

**GREEN**: implementare poller state e lifecycle separati per Mass, Start e auto-stop.

**Done when**: test Discord passano e il bot compila.

### Slice 3: UI gestionale e bottone Cancel Discord

**Value**: Gli utenti vedono i due orari e possono annullare l'evento dal gestionale o dal thread.

**Path**: frontend form/list/detail -> API -> refresh state; Discord action row -> button handler -> API -> message/thread update.

**Acceptance criteria**: form con data, Mass e Inizio; validazione visibile; bottone Cancel solo per eventi cancellabili; stato/controlli aggiornati dopo l'azione; il bottone Discord rispetta la permission backend e mostra esito/errori.

**RED**: test component/form e test embed/handler per custom id, disabled states e aggiornamento messaggio.

**GREEN**: aggiungere i campi, l'azione gestionale e il bottone Discord.

**Done when**: test frontend/bot e build frontend/backend/bot passano.

## Quality gate

- Eseguire test mirati dopo ogni slice e test completi alla fine.
- Verificare migration su database di test.
- Non creare commit senza approvazione esplicita.
