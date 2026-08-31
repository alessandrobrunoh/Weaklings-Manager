# Plan: Discord thread per gli Split

**Status**: Slice 1 implemented — checkpoint in attesa di approvazione commit

## Obiettivo

Quando viene creato uno split, il bot crea un thread nel Forum Channel configurato da Admin → Discord integration, pubblica un riepilogo leggibile e aggiornabile dello split con player taggati, importi e stato, quindi mantiene nel thread i log relativi esclusivamente a quello split durante modifiche, chiusura e pagamento.

## Decisioni e assunzioni iniziali

- Il bot Discord resta l’unico adapter che chiama Discord; il backend espone dati e stato di sincronizzazione.
- Il target è un **Forum Channel** Discord, quindi ogni split genera un forum post/thread autonomo, non un messaggio figlio di un canale testuale.
- Il thread deve essere creato una sola volta e deve sopravvivere a riavvii del bot e a retry del poller.
- Gli utenti senza `discord_id` vengono mostrati con username ma non possono essere taggati; i mention vengono costruiti solo per ID validi e non usano `allowedMentions.parse`.
- Il messaggio iniziale viene aggiornato in-place, non duplicato a ogni modifica.
- I log applicativi pertinenti sono gli audit log con `entity_type`/`entity_id` dello split e le attività finanziarie con `split_id`; non vengono copiati nel thread i log di altri split.
- La sincronizzazione è best-effort: un errore Discord non deve bloccare creazione, modifica, completamento o pagamento nello stato applicativo; il bot registra l’errore e ritenta.
- Gli aggiornamenti saranno eventualmente compattati per rispettare i limiti Discord: riepilogo sempre aggiornato e log append-only, suddivisi in più messaggi se necessario.

## Acceptance Criteria

- [ ] Un amministratore autorizzato può impostare o cancellare un Forum Channel Discord dedicato agli split dalla pagina Admin → Discord integration; il valore è persistito in `guild_settings` e il bot lo rileva senza redeploy.
- [ ] Quando uno split viene creato e il Forum Channel è configurato, viene creato un solo forum thread con titolo deterministico e un messaggio riepilogativo contenente almeno: split ID, evento collegato, note/valore loot, isola, tab, stato, creatore e data.
- [ ] Il riepilogo contiene una tabella coerente `Player | Value | Status`, con player taggati quando possibile, importi esatti e stato individuale del credito/pagamento.
- [ ] Quando lo split viene modificato, accettato/chiuso o pagato, il messaggio riepilogativo viene aggiornato senza creare un secondo thread e riflette i dati più recenti.
- [ ] Nel thread compaiono solo i log che appartengono allo split corrente, inclusi cambi di stato, modifiche rilevanti e transazioni generate/richieste/pagate; i log di altri split non vengono inclusi.
- [ ] La sincronizzazione è idempotente: retry, polling sovrapposti e riavvio del bot non producono thread o log duplicati.
- [ ] Thread o messaggi non creabili/modificabili, Forum Channel mancante/non valido, permessi Discord insufficienti e payload oltre i limiti vengono gestiti con log diagnostici e senza interrompere il workflow dello split.
- [ ] Backend Rust, bot TypeScript, frontend type-check/build e test mirati passano; il contratto API del bot e quello frontend restano allineati.

## Slice verticali

### Slice 1: L’amministratore può configurare il Forum Channel degli split

**Status**: Implemented; validation completed with unrelated repository failures documented below.

**Valore**: l’amministratore controlla dove finiscono i thread senza modificare variabili d’ambiente o riavviare il bot.

**Percorso**: pagina Admin Discord → `PUT /api/admin/settings` → colonna `guild_settings` → `GET /api/admin/settings` dal `SettingsService` del bot.

**Criteri specifici**:
- il campo è nullable e il valore vuoto lo cancella;
- il campo appare con label/hint dedicati e mantiene loading, salvataggio ed errore coerenti con gli altri canali;
- il backend valida la forma dell’ID come per gli altri channel ID e include il campo nell’audit dell’aggiornamento impostazioni;
- il bot espone un accessor cached dedicato.

**RED**: test del service/admin per persistenza, update parziale e clear; test del DTO/serializzazione frontend e del `SettingsService` per il nuovo campo.

**GREEN**: migration SeaORM, entity/model/router/service, tipi frontend e bot, input nella pagina Admin e accessor settings.

**MUTATE / KILL MUTANTS**: verificare che il campo corretto sia aggiornato, che `None` non sovrascriva e che `""` cancelli; aggiungere casi per campo non configurato e valore conservato.

**REFACTOR**: riusare il pattern dei canali esistenti senza introdurre un endpoint Discord-specifico separato.

**Done when**: criteri della slice verificati e tutti i test/type-check relativi passano.

### Slice 2: Uno split nuovo crea un forum thread e un riepilogo iniziale

**Valore**: chi gestisce la distribuzione vede subito un archivio Discord dedicato allo split appena creato.

**Percorso**: poller del bot → endpoint autenticato bot per nuovi/aggiornati split → `SplitDetail` arricchito con Discord ID e dati necessari → fetch Forum Channel → `ForumChannel.threads.create` → primo messaggio riepilogativo → persistenza del thread/message ID.

**Criteri specifici**:
- uno split pending nuovo genera un solo thread con nome limitato a 100 caratteri e contenuto iniziale deterministico;
- il renderer mostra evento, note, valori stimati/netti, isola/tab, creatore, timestamp, stato e tabella dei partecipanti;
- mention e `allowedMentions` sono espliciti e sicuri; gli utenti senza Discord ID hanno fallback testuale;
- se il canale è assente o non è un forum il poller non crasha e lo split resta valido;
- un retry dello stesso split riconosce il record di sync già creato.

**RED**: test del formatter per dati completi/parziali, status pending e utenti senza Discord ID; test del servizio Discord per create-once, errore non fatale e payload del Forum Channel; test del backend endpoint con split detail e metadati Discord.

**GREEN**: introdurre un record di sincronizzazione persistente (minimo `split_id`, `thread_id`, `summary_message_id`, timestamps/versione), endpoint bot per leggere split da sincronizzare e adapter Discord forum.

**MUTATE / KILL MUTANTS**: testare ID split come chiave di idempotenza, canale errato, thread già presente, mention non autorizzate, e distinzione tra `pending` e stati finali.

**REFACTOR**: estrarre renderer/Discord adapter separati dal poller, mantenendo il poller come coordinatore.

**Done when**: uno split creato dal web path produce osservabilmente un forum thread con un riepilogo corretto, senza duplicati.

### Slice 3: Il riepilogo si aggiorna per modifiche, chiusura e pagamento

**Valore**: il thread rimane la vista aggiornata dello split, inclusi importi finali e stato di ogni player.

**Percorso**: modifica split o completamento → `updated_at`/versione monotona o evento di sincronizzazione → bot rileva il cambiamento → rilegge `SplitDetail` e transazioni → `message.edit` sul summary message.

**Criteri specifici**:
- modifiche a nota, evento, isola/tab, valori o roster aggiornano titolo/contenuto del thread e il riepilogo;
- `completed`, `not_completed` e `lost` sono riflessi nello stato globale;
- per ogni player lo status distingue almeno credito pending/requested, richiesto e pagato/withdrawn, senza ricalcolare importi finali già presenti nelle transazioni;
- il messaggio resta valido con roster lungo e contenuto entro i limiti Discord, usando sezioni o messaggi di continuazione deterministici;
- modifiche ripetute producono un edit, non nuovi messaggi di riepilogo.

**RED**: test di versionamento/diff, renderer per tutti gli stati e importi con rounding, aggiornamento in-place e gestione di messaggio cancellato/non trovato.

**GREEN**: aggiungere `updated_at` o versione al modello split e al DTO, endpoint di sincronizzazione incrementale, query delle transazioni per split e update del summary message.

**MUTATE / KILL MUTANTS**: verificare che ogni stato e ogni campo rilevante invalidi la versione, che i transazioni di un altro split siano escluse e che il bot non perda aggiornamenti dopo restart.

**REFACTOR**: centralizzare le funzioni di formattazione valuta/stato e la costruzione degli allowed mentions.

**Done when**: una modifica e un completamento verificabili aggiornano lo stesso forum thread e la tabella mostra dati correnti.

### Slice 4: Il thread conserva solo i log dello split con deduplicazione

**Valore**: il thread diventa una cronologia audit consultabile senza rumore proveniente da altri split.

**Percorso**: audit/transazioni backend → endpoint bot incrementale filtrato da `split_id` → poller → renderer log → messaggi append-only nel thread, con cursore/versione persistente.

**Criteri specifici**:
- ogni log viene selezionato tramite associazione esplicita allo split (`entity_id`/`split_id`), mai tramite timestamp o canale globale;
- vengono inclusi almeno creazione, modifica, transizioni di stato, creazione credito e avanzamento del pagamento quando il dato è disponibile;
- ogni log appare una sola volta, anche dopo retry/restart, e mantiene ordine temporale stabile;
- payload lunghi vengono divisi in messaggi entro i limiti Discord e non espongono dettagli di altri split;
- se l’audit endpoint fallisce, il riepilogo continua a sincronizzarsi e il bot ritenta i log in seguito.

**RED**: test backend dei filtri per split e ordinamento; test bot per cursore, deduplica, esclusione di altri split, chunking Discord e retry non fatale.

**GREEN**: endpoint bot/audit con filtro `split_id` e paginazione/cursore, normalizzazione degli eventi di pagamento, stato di sincronizzazione dell’ultimo log pubblicato e pubblicazione append-only.

**MUTATE / KILL MUTANTS**: provare split ID scambiato, pagina duplicata, log fuori ordine, evento senza dettagli, messaggio al limite e fallimento a metà batch; i test devono rilevare inclusione/esclusione errata.

**REFACTOR**: usare un unico contratto di `SplitDiscordSyncState` per summary e log, senza duplicare checkpoint locali incompatibili.

**Done when**: il thread contiene il riepilogo aggiornato più una cronologia esclusiva e deduplicata dello split.

## Rischi e decisioni da confermare

1. **Forum Channel reale**: il canale configurato deve essere validato come tipo `GuildForum`; non va trattato come un normale `TextChannel`.
2. **Persistenza dei log**: il piano preferisce un endpoint incrementale backend con filtro `split_id` e cursore/versione, invece di affidarsi a un semplice confronto locale del poller.
3. **Semantica “accettato”**: nel modello attuale gli stati sono `pending`, `completed`, `not_completed`, `lost`; la tabella userà questi stati e quelli delle transazioni (`pending`, `requested`, `withdrawn`) salvo richiesta di un nuovo stato `accepted`.
4. **Un thread per split**: se si desiderano più thread per riaperture o pagamenti parziali, serve una regola diversa; questo piano mantiene un thread canonico.
5. **Retroattività**: di default il poller sincronizza i nuovi split e quelli modificati dopo il rilascio; la backfill degli split esistenti richiede una slice/command amministrativa separata.

## Quality gate

- Test Rust mirati per migration, settings, split sync DTO/query, filtri audit/transazioni e idempotenza.
- `cargo fmt --check`, `cargo check` e test backend.
- `npm run type-check`, `npm run build` e test del bot.
- Frontend lint/type-check/build e test del componente Admin Discord.
- Verifica manuale su un Forum Channel: create, edit, complete, request/withdraw payout, restart del bot e retry con permessi Discord insufficienti.
- Prima di implementare ogni slice: RED-GREEN-MUTATE-KILL MUTANTS-REFACTOR e conferma dei criteri della slice.

---

**Prossimo passo richiesto**: confermare i criteri e le decisioni sopra, in particolare la semantica di “accettato”, la retroattività e l’uso di un endpoint incrementale backend per i log. Dopo la conferma si può iniziare dalla Slice 1 senza scrivere codice delle slice successive.
