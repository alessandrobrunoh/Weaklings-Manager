# Plan: operatività dell'Alleanza

**Branch**: `feat/alliance-operations`
**Status**: Proposed — in attesa di conferma degli acceptance criteria

## Goal

Un officer può gestire nell'Alleanza eventi e split propri, usando il roster unificato delle gilde membro e un catalogo di isole/tab sincronizzato dalle gilde senza doverlo ricreare manualmente.

## Decisioni di prodotto

Questa estensione supera il modello iniziale in cui gli split dell'Alleanza erano soltanto snapshot read-only. Le seguenti decisioni sono necessarie perché split ed eventi hanno stato e responsabilità proprie:

1. **Split dell'Alleanza**: è un nuovo split di proprietà del tenant Alleanza, non una copia di uno split gilda. Può essere creato, modificato, completato e liquidato nell'Alleanza.
2. **Gestore dello split**: ogni split Alleanza salva sia il Discord user manager sia la gilda manageriale (`manager_guild_tenant_id`). Il manager deve essere un membro registrato dell'Alleanza e la gilda deve essere una membership attiva.
3. **Isole**: il catalogo Alleanza è una sincronizzazione read-only dalle gilde membro. Ogni isola/tab mantiene la gilda sorgente (`source_guild_tenant_id`) e viene visualizzata/categorizzata per gilda. Non si modifica dal pannello Alleanza; la modifica si fa nella gilda e viene riflessa al successivo sync.
4. **Duplicati**: isole con stesso nome e città appartenenti a gilde diverse restano separate, perché possono indicare depositi diversi. I tab sono deduplicati solo all'interno della stessa isola sorgente.
5. **Eventi Alleanza**: sono eventi di proprietà del tenant Alleanza, con iscrizioni raccolte nel Discord Alleanza. Il roster mostra tutti i partecipanti aggregati e la loro gilda di appartenenza.
6. **Identità**: il Discord ID è la chiave primaria del partecipante; il backend deve sincronizzare/risolvere il profilo nel tenant Alleanza prima dell'iscrizione. Il nome Albion non viene usato per identificare un utente.
7. **Controlli finanziari**: un evento Alleanza può produrre uno split Alleanza; il completamento resta consentito solo agli officer autorizzati e non altera gli split snapshot pubblicati dalle gilde.

## Acceptance Criteria

- [ ] Un officer autorizzato apre il Discord Alleanza e può creare uno split Alleanza.
- [ ] Durante la creazione dello split sono obbligatori gestore e gilda manageriale; la gilda scelta è limitata alle membership attive.
- [ ] Il catalogo isole Alleanza mostra tutte le isole/tab delle gilde membro, con il nome della gilda sorgente visibile e senza inserimento manuale.
- [ ] Un sync ripetuto è idempotente: non crea duplicati e recepisce nuove isole/tab; le rimozioni dalla sorgente non cancellano uno split già registrato.
- [ ] Un officer crea un evento Alleanza e i membri di qualsiasi gilda membro possono iscriversi dal Discord Alleanza.
- [ ] Il roster dell'evento aggrega i partecipanti e mostra la gilda di appartenenza di ciascuno.
- [ ] Lo split generato da un evento Alleanza conserva gestore, gilda manageriale e isola/tab selezionati.
- [ ] Gli endpoint rifiutano gilde non appartenenti all'Alleanza, utenti non appartenenti all'Alleanza e mutation di snapshot read-only.
- [ ] Un tenant `guild` conserva il comportamento attuale senza migrazione manuale dei dati.

## Production path

```text
Gilda member settings
  → sync catalog isole/tab
  → schema tenant_<alliance_id> + source_guild_tenant_id
  → picker isola/tab nell'Alleanza

Membro di una gilda
  → entra nel Discord Alleanza o interagisce con evento
  → risoluzione Discord ID / link Albion nel tenant Alleanza
  → signup evento Alleanza
  → roster aggregato con guild_name

Officer Alleanza
  → POST /api/events (tenant alliance)
  → evento + signup aggregati
  → POST /api/splits (tenant alliance)
  → split con manager_user_id + manager_guild_tenant_id
  → completamento e ledger nel tenant Alleanza
```

## Slices

Ogni slice è un PR verticale, indipendentemente deployabile e con test RED-GREEN-MUTATE-KILL MUTANTS-REFACTOR. Prima di implementare una slice vanno caricati `tdd`, `testing`, `mutation-testing` e `refactoring`, e vanno confermati i relativi acceptance criteria.

### Slice 1: L'Alleanza vede il catalogo sincronizzato delle isole delle gilde

**Value**: l'admin Alleanza può scegliere qualsiasi deposito già configurato da una gilda senza ricrearlo.

**Path**: apertura catalogo/picker → membership attive dal control-plane → lettura isole/tab nelle gilde → upsert nel catalogo Alleanza con sorgente → risposta API/UI raggruppata per gilda.

**Acceptance criteria**:

- `GET /api/splits/islands` nel tenant Alleanza restituisce tutte le isole/tab delle membership `active`.
- Ogni risultato contiene la gilda sorgente e non collassa omonimi di gilde differenti.
- Il sync è idempotente e non rimuove riferimenti usati da split esistenti.
- Il catalogo Alleanza è consultabile ma i controlli di modifica restano nascosti/disabilitati.

**RED**: test service con due gilde, isole omonime e tab differenti; test idempotenza; test membership pending/inattiva esclusa; test frontend del raggruppamento.

**GREEN**: endpoint/service di sync e colonne/metadati sorgente; caricamento frontend senza azioni CRUD per l'Alleanza.

**Done when**: un admin Alleanza vede il catalogo reale delle gilde dopo refresh.

### Slice 2: Un officer crea e gestisce uno split nativo dell'Alleanza

**Value**: un officer può registrare il loot raccolto dall'Alleanza indicando chi lo gestisce, quale gilda è responsabile e dove è depositato.

**Path**: form split Alleanza → validazione gilda attiva/manager membro/isola sorgente → creazione split nativo nel tenant Alleanza → edit/completion/ledger con gli stessi controlli finanziari del tenant gilda.

**Acceptance criteria**:

- Il pulsante di creazione è disponibile solo con `splits.create` e tenant `alliance`.
- Gilda manageriale, manager e island tab sono obbligatori per uno split Alleanza.
- Una gilda rimossa/pending o un manager non sincronizzato produce un errore stabile senza scrittura parziale.
- Gli split snapshot pubblicati dalle gilde restano read-only; gli split nativi Alleanza sono mutabili secondo RBAC.
- Dettaglio e lista mostrano manager, gilda manageriale e sorgente dell'isola.

**RED**: test backend per autorizzazione, validazione membership, distinzione snapshot/native, create/update/complete; test frontend per form e payload.

**GREEN**: modello split/metadati manageriali, validazione router/service, UI create/edit e distinzione `origin_read_only`.

**Done when**: uno split Alleanza completo produce il ledger nel tenant Alleanza e non modifica dati della gilda sorgente.

### Slice 3: Evento Alleanza con roster aggregato

**Value**: l'ufficiale può creare una mass Alleanza e vedere insieme i partecipanti di tutte le gilde membro.

**Path**: form evento nel tenant Alleanza → creazione evento → join Discord/web tramite Discord ID → risoluzione membership/gilda → roster aggregato → collegamento opzionale a split Alleanza.

**Acceptance criteria**:

- Il tenant Alleanza può creare eventi e il tenant gilda mantiene il flusso attuale.
- Solo utenti appartenenti a una gilda `active` dell'Alleanza possono iscriversi; il loro nome gilda è mostrato nel roster.
- Due utenti provenienti da gilde diverse possono iscriversi allo stesso evento senza collisioni di user ID.
- Il roster e le notifiche Discord mostrano il totale aggregato e, quando richiesto, la gilda di ogni partecipante.
- L'evento Alleanza può essere collegato a uno split Alleanza e trasferisce il roster come partecipanti iniziali.

**RED**: test di risoluzione Discord ID multi-tenant, signup cross-gilda, esclusione outsider, roster aggregato e create-event guard; test frontend del roster.

**GREEN**: materializzazione/risoluzione utenti nel tenant Alleanza, metadati guild membership sul signup, policy event per tenant kind, UI e Discord event flow.

**Done when**: una mass Alleanza mostra un unico roster composto da più gilde e può alimentare uno split Alleanza.

### Slice 4: Sync operativo e consistenza

**Value**: il catalogo e le identità restano aggiornati senza intervento manuale.

**Path**: ingresso membro, membership accept e refresh/poller → sync catalogo + user/link → ruoli e dati disponibili nei picker → audit/log degli errori best-effort.

**Acceptance criteria**:

- L'accettazione di una gilda nell'Alleanza avvia il sync iniziale di isole/tab e utenti/link già registrati.
- L'ingresso di un nuovo membro mantiene il sync Discord ID/ruoli già implementato.
- Un errore su una gilda non impedisce il sync delle altre e viene osservabile nei log.
- Il sync può essere rilanciato senza duplicare isole, tab, utenti o partecipanti.

**RED**: test di retry/idempotenza e isolamento degli errori per gilda.

**GREEN**: job/trigger di sync e metriche/logging; eventuale comando admin di refresh.

**Done when**: aggiungere una nuova gilda membro rende disponibili catalogo e roster senza configurazione duplicata nell'Alleanza.

## Open questions before Slice 2

1. Il `manager_guild_tenant_id` deve essere selezionabile liberamente tra le gilde attive oppure deve coincidere con la gilda del manager Discord?
2. Lo split Alleanza deve usare il wallet/ledger dell'Alleanza (raccomandato) oppure deve essere inoltrato alla gilda manageriale per il pagamento?
3. Gli utenti possono iscriversi all'evento Alleanza solo dal Discord Alleanza, oppure anche dai Discord delle gilde membro con fan-out dello signup?
4. Le isole rimosse dalla gilda devono restare visibili nel catalogo Alleanza come “archiviate” oppure sparire se non sono referenziate da alcuno split?

Non va scritto codice finché questi criteri e le domande sopra non sono confermati.
