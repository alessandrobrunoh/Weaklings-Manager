# Revisione della codebase e parità tra sito e Discord

## Ambito e metodo

Revisione del checkout `9b093c14`, svolta tramite analisi indipendenti di backend, frontend, bot Discord, flussi condivisi e operatività, incluse due verifiche con modelli diversi. Questa è una fotografia del codice, non un audit di sicurezza esaustivo né una lettura riga per riga di tutti i moduli. Nessuna modifica funzionale è stata apportata.

Le priorità indicano l'impatto potenziale, non la certezza di sfruttamento. **Riprodotto** significa confermato da un test eseguito; **analisi statica** significa dedotto dal codice senza prova end-to-end; **condizionale** indica che dipende da configurazione o circostanze specifiche.

## Sintesi

Il backend Rust è già il punto comune di persistenza e API. Il problema non è la presenza di tre componenti separati: è che il bot e il sito non espongono gli stessi flussi e che alcune regole, presentazioni e automazioni vivono fuori dal backend. Spostare il gateway Discord nello stesso processo del backend non è necessario per ottenere una fonte di verità comune.

Le priorità immediate sono: verificare la revoca dei permessi, l'isolamento delle configurazioni Albion tra tenant e la consistenza dei prelievi concorrenti; correggere i test e le incongruenze del deployment; poi definire e colmare la parità funzionale per singolo flusso.

## Rischi prioritari

### 1. Ruoli revocati potenzialmente ancora validi — alta, analisi statica

Le richieste web ricostruiscono il contesto dai ruoli presenti nella sessione; il refresh dei ruoli in `/auth/me` mantiene i valori precedenti se Discord non restituisce i ruoli. Questo può mantenere privilegi dopo una rimozione di ruolo o dalla gilda. Alcuni percorsi bot e banca alleanza usano inoltre il ruolo salvato nel database, che può essere obsoleto. Verificare in particolare la distinzione tra membro assente, errore temporaneo Discord e revoca, e la durata effettiva della sessione.

Evidenze: [contesto da sessione](apps/backend/src/modules/auth/rbac.rs#L125-L134), [refresh ruoli](apps/backend/src/modules/auth/router.rs#L856-L883), [ruolo salvato per il bot](apps/backend/src/modules/auth/rbac.rs#L382-L387), [permessi banca alleanza](apps/backend/src/modules/bank/alliance.rs#L118-L137).

### 2. Configurazione Albion globale in un sistema multi-tenant — alta, analisi statica

Il control plane registra gilda e regione per tenant, ma servizi e worker esaminati sono inizializzati da una configurazione globale. Con tenant collegati a gilde diverse, richieste e sincronizzazioni potrebbero usare la gilda sbagliata e scrivere risultati nello schema del tenant corrente. Serve una prova con due tenant e configurazioni distinte.

Evidenze: [modello tenant](apps/backend/src/modules/platform/models.rs#L27-L41), [inizializzazione servizi e worker](apps/backend/src/lib.rs#L89-L147), [contesto worker](apps/backend/src/event_sessions/mod.rs#L73-L89).

### 3. Prelievi concorrenti e saldo aggregato — alta, analisi statica

La richiesta verifica un totale calcolato dalle righe disponibili, ma l'analisi non ha individuato una serializzazione del saldo complessivo per utente. Richieste simultanee su righe distinte potrebbero superare insieme il credito disponibile. I controlli sulle singole righe non dimostrano da soli l'invariante aggregata. Serve un test concorrente su PostgreSQL.

Evidenze: [calcolo saldo](apps/backend/src/modules/bank/service.rs#L272-L290), [richiesta di prelievo](apps/backend/src/modules/bank/service.rs#L743-L831).

### 4. Credenziale bot con privilegi globali — alta, rischio architetturale

`BOT_API_SECRET` è una chiave master: senza identità attore la richiesta diventa `bot_system`, con privilegi elevati sul tenant selezionato. Non è un bypass senza segreto, ma la sua compromissione ha un impatto potenzialmente cross-tenant. Il proxy pubblico inoltra gli header: la protezione dipende quindi dalla riservatezza della chiave e dai confini di rete. Alcune azioni avviate da utenti possono inoltre essere attribuite al sistema invece che all'attore.

Evidenze: [contratto della chiave](apps/backend/src/config.rs#L36-L49), [principal di sistema](apps/backend/src/modules/auth/rbac.rs#L137-L204), [selezione tenant](apps/backend/src/tenant.rs#L483-L514). Valutare credenziali limitate per tenant e operazione e attribuzione esplicita dell'attore.

### 5. Identificazione ambigua nei comandi Discord — alta, analisi statica

Se non riesce la risoluzione per identità Discord, il bot accetta anche un singolo risultato di ricerca parziale per nome. La ricerca backend è per sottostringa: `/warn` o `/xp` potrebbero quindi colpire un'altra persona. Per mutazioni amministrative l'identità dovrebbe essere deterministica; testare anche gli account non collegati.

Evidenze: [resolver](apps/discord-bot/src/api/resolve-user.ts#L10-L45), [ricerca utenti](apps/backend/src/modules/users/router.rs#L204-L236), [comando warn](apps/discord-bot/src/commands/warn.ts#L43-L78).

### 6. Versioni delle build separate dal gruppo — alta, riprodotto

Il gruppo delle versioni dipende anche dal creatore, ma la nuova versione viene attribuita all'utente che la crea. Se è diverso dal creatore originale, dettaglio e rinomina possono non includerla. Due test backend falliscono su questi contratti.

Evidenze: [ricerca del gruppo](apps/backend/src/modules/comps/service.rs#L281-L303), [creazione versione](apps/backend/src/modules/comps/service.rs#L1209-L1266), [test versioni](apps/backend/src/modules/comps/service.rs#L3343-L3363), [test rinomina](apps/backend/src/modules/comps/service.rs#L3405-L3425).

### 7. Eventi Discord potenzialmente non visibili — alta, analisi statica

Il poller crea thread privati per eventi ordinari e vi invia la scheda, senza che il percorso esaminato inviti i membri o pubblichi un annuncio nel canale padre. La visibilità dipende anche dai permessi Discord effettivi: confermare in un server di prova.

Evidenze: [creazione thread](apps/discord-bot/src/services/event-announcement-thread.ts#L69-L98), [annuncio evento](apps/discord-bot/src/services/poller.ts#L785-L819).

### 8. Avvio Compose con configurazione d'esempio incoerente — alta, configurazione verificata

L'esempio imposta la porta backend a `8081`, mentre Compose e i client puntano alla porta container `3000`. Inoltre l'esempio non fornisce alcune variabili Postgres richieste da Compose. `docker compose --env-file .env.example config` termina con successo ma segnala variabili mancanti e produce un `DATABASE_URL` vuoto; non è stato eseguito un avvio reale.

Evidenze: [configurazione d'esempio](.env.example#L1), [Compose](docker-compose.yml#L2-L42), [client in Compose](docker-compose.yml#L49-L85).

## Parità funzionale e flussi

| Area | Sito | Discord | Differenza da affrontare |
| --- | --- | --- | --- |
| Eventi | Gestione, partecipazione e roster live | Comandi, pulsanti, annunci e canali | Il lifecycle e le automazioni Discord sono separati; avvio o arresto via web richiedono verifica degli effetti Discord. |
| Split e banca | Gestione split, ledger e prelievi | Saldo, richiesta prelievo e sincronizzazione forum split | Non risulta gestione split equivalente; i pulsanti di accettazione/rifiuto hanno handler ma non è stato trovato un produttore nel bot. |
| Build e battaglie | Gestione composizioni/build e pagine battaglie | Consultazione tramite comandi | Gestione più ampia sul sito. |
| Candidature e ticket | Impostazioni amministrative | Interazioni e thread | Il flusso utente Discord non ha una pagina web equivalente individuata nella mappa delle route. |
| Giveaway | Pannello amministrativo | Annunci e pulsanti | Le azioni sono distribuite tra i due client. |
| Siphoned, regear, intel e amministrazione | Pagine dedicate | Nessun equivalente slash individuato | Verificare anche interazioni non slash prima di dichiarare assenza completa. |

Evidenze: [route frontend](apps/frontend/src/app/app.routes.ts#L21-L394), [registro comandi bot](apps/discord-bot/src/commands/index.ts#L55-L88), [router backend](apps/backend/src/modules/mod.rs#L41-L81), [handler banca bot](apps/discord-bot/src/handlers/button.ts#L1018-L1129).

Il README del bot lo descrive come specchio 1:1, ma questa promessa non è sostenuta dalle superfici esaminate ([README bot](apps/discord-bot/README.md#L1-L4)). La parità richiesta va verificata per **azione, ruolo, stato, risultato ed effetti collaterali**, non contando soltanto pagine e comandi.

### Regole e presentazioni discordanti

- **Calcolo split pending:** il bot usa una formula diversa da backend e frontend; il fallback può mostrare importi diversi prima della finalizzazione. [Backend](apps/backend/src/modules/splits/service.rs#L446-L454), [bot](apps/discord-bot/src/services/split-summary.ts#L77-L79).
- **Warn:** `/warns` mostra soglia e kick hardcoded, mentre la soglia backend è configurabile e il percorso esaminato apre un'escalation. [Bot](apps/discord-bot/src/commands/warns.ts#L113-L128), [backend](apps/backend/src/modules/warns/service.rs#L420-L452).
- **Contratto API:** tipi e client sono mantenuti separatamente e OpenAPI elenca manualmente gli handler, senza coprire ad esempio tutti i percorsi applications e tickets. Completare il contratto prima di usarlo come fonte per generare client. [OpenAPI](apps/backend/src/openapi.rs#L7-L31), [applications](apps/backend/src/modules/applications/router.rs#L54-L63), [tickets](apps/backend/src/modules/tickets/router.rs#L45-L50).
- **Autenticazione non equivalente:** `/auth/me` è basato su cookie, ma un helper del bot lo chiama con credenziali bot; anche altre rotte di piattaforma sono cookie-only. Distinguere le operazioni che devono essere equivalenti da quelle legate al login web. [Helper bot](apps/discord-bot/src/api/client.ts#L74-L86), [handler](apps/backend/src/modules/auth/router.rs#L783-L806).

## Altri problemi e rischi

### Sicurezza e accesso

- **Alta, analisi statica:** il proprietario di un nuovo tenant potrebbe restare con ruolo `User` se non esistono associazioni ai ruoli Discord, senza poter completare la configurazione dei ruoli. [Registrazione](apps/backend/src/modules/platform/service.rs#L202-L245), [risoluzione ruoli](apps/backend/src/modules/auth/service.rs#L526-L559).
- **Media, analisi statica:** la registrazione di tenant può affidarsi a un'informazione `can_manage` memorizzata in sessione, non necessariamente aggiornata dopo una revoca Discord. Verificare il comportamento di [registrazione](apps/backend/src/modules/platform/service.rs#L202-L245) e controllo della membership.
- **Media, analisi statica:** la lista membri di un'alleanza richiede autenticazione ma nel percorso esaminato non verifica l'appartenenza all'alleanza. [Handler](apps/backend/src/modules/platform/public.rs#L147-L167).
- **Media, condizionale:** un'origine non fidata sullo stesso sito potrebbe inviare form POST verso mutazioni senza body; CORS non è di per sé una protezione CSRF. Verificare l'effettiva topologia dei domini e i controlli Origin/CSRF. [Cookie](apps/backend/src/modules/auth/router.rs#L729-L738), [azione evento](apps/backend/src/modules/events/router.rs#L1441-L1451).
- **Privacy da valutare:** la directory utenti espone email agli utenti autenticati. Confermare se questo livello di accesso è voluto. [Router utenti](apps/backend/src/modules/users/router.rs#L204-L236).

### Affidabilità e operatività

- **Media, analisi statica:** errori durante l'inizializzazione del poller possono essere trattati come liste vuote e fissare checkpoint iniziali, con possibile invio di arretrati al recupero. [Baseline](apps/discord-bot/src/services/poller.ts#L501-L559).
- **Media, analisi statica:** pagine limitate e avanzamento dei cursori possono saltare annunci dopo interruzioni o volumi superiori alla pagina; un invio fallito della scheda evento può non essere ritentato. [Eventi](apps/discord-bot/src/services/poller.ts#L603-L705), [battaglie](apps/discord-bot/src/services/poller.ts#L1601-L1632), [scheda](apps/discord-bot/src/services/poller.ts#L817-L838).
- **Media, analisi statica:** sospensione e riattivazione tenant non sembrano coordinare arresto e ripartenza dei worker. [Transizione](apps/backend/src/modules/platform/service.rs#L787-L815), [loop worker](apps/backend/src/event_sessions/mod.rs#L41-L55).
- **Media, analisi statica:** errori durante provisioning possono lasciare tenant incompleti o in stato `provisioning` senza un normale retry di creazione. [Sequenza](apps/backend/src/modules/platform/service.rs#L88-L117).
- **Media, analisi statica:** con `CONTROL_DATABASE_URL` separato, lo schema `control` sembra creato sulla connessione sbagliata. Richiede verifica con due database. [Bootstrap](apps/backend/src/lib.rs#L51-L64), [selezione DSN](apps/backend/src/config.rs#L177-L189).
- **Media, analisi statica:** un prelievo può essere committato e poi restituire errore se fallisce l'audit, lasciando al client un esito ambiguo. [Commit e audit](apps/backend/src/modules/bank/service.rs#L889-L976).
- **Media, analisi statica:** nell'onboarding cambiare regione non invalida la gilda selezionata e risposte di ricerca lente possono sovrascrivere risultati più recenti. [Selezione](apps/frontend/src/app/features/auth/register-tenant.ts#L152-L169), [ricerca](apps/frontend/src/app/features/auth/register-tenant.ts#L431-L461).
- **Media, analisi statica:** errori di rete o server su `/auth/me` vengono trattati come mancata autenticazione; un logout fallito può lasciare il cookie valido. [Profilo](apps/frontend/src/app/core/services/auth.service.ts#L152-L172), [logout](apps/frontend/src/app/core/services/auth.service.ts#L96-L104).
- **Bassa, analisi statica:** alcune stringhe evento sono fisse in italiano nonostante il supporto multilingua; un errore nel conteggio notifiche viene mostrato come zero. [Dialogo](apps/frontend/src/app/features/events/event-detail.ts#L2215-L2258), [notifiche](apps/frontend/src/app/core/services/notification.service.ts#L64-L73).

## Verifiche eseguite

Risultati comunicati dai revisori; le esecuzioni sono avvenute nel medesimo workspace e alcune in parallelo:

| Comando | Esito |
| --- | --- |
| `cargo test --workspace` | Fallito: 950 passati, 3 falliti; due test versioni build e uno sul contratto dei permessi eventi. I test che richiedono PostgreSQL possono essere stati saltati in assenza di URL database. |
| Test mirato `a_build_detail_lists_every_version_in_its_group` | Fallito, riproduce il difetto di versionamento. |
| `npm test --prefix apps/frontend` | Fallito: errore di tipo nel mock di `bank.spec.ts`. In un'esecuzione separata 71 suite sono passate e una non ha compilato; un'altra esecuzione concorrente ha avuto anche timeout. |
| `npm run build --prefix apps/frontend` | Passato. |
| `npm test --prefix apps/discord-bot` | Passato: 141 test. |
| `docker compose --env-file .env.example config` | Comando riuscito con avvisi e configurazione database vuota; non prova l'avvio dello stack. |
| `npm audit --omit=dev`, frontend e bot | Segnalate 8 vulnerabilità frontend e 3 high bot. Le advisory e l'effettiva raggiungibilità vanno verificate prima di attribuire sfruttabilità. |
| Audit dipendenze Rust | Non eseguito: `cargo-audit` non disponibile. |

Non sono stati eseguiti test end-to-end con Discord, browser e backend reali, né una verifica delle migrazioni su PostgreSQL. Il test di migrazione esaminato sembra inoltre aspettarsi un numero di migrazioni diverso da quello registrato ([migrator](apps/backend/src/control_migration/mod.rs#L47-L68), [test](apps/backend/src/control_migration/mod.rs#L225-L250)). Non risultano workflow CI versionati sotto `.github`; questo non esclude CI esterna.

## Sequenza consigliata

1. Riprodurre e circoscrivere revoca ruoli, isolamento Albion, race di prelievo e visibilità thread su ambienti di prova; correggere prima i problemi confermati con impatto su accesso o dati.
2. Ripristinare test verdi, correggere il deployment d'esempio e aggiungere test PostgreSQL, test tra tenant e prove end-to-end dei flussi critici.
3. Costruire una matrice dettagliata delle azioni web e Discord con permessi e risultati attesi; dare priorità a eventi, banca, split, candidature e ticket.
4. Rendere il backend fonte unica per calcoli, validazione, autorizzazioni e stato di dominio; mantenere il bot come adapter Discord, con consegne durevoli e ripetibili dove necessario.
5. Completare il contratto API, ridurre le duplicazioni tra client e affrontare le dipendenze segnalate con aggiornamenti verificati.

La parità totale può richiedere interazioni diverse tra web e Discord: la verifica deve garantire lo stesso risultato e le stesse regole, senza assumere che ogni schermata si traduca in un comando identico.
