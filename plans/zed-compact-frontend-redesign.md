# Piano: redesign compatto del frontend

**Branch**: `feat/zed-compact-frontend-redesign`
**Status**: Active

## Obiettivo

Adottare in tutto il frontend il linguaggio visivo compatto descritto in
`DESIGN.md` e rafforzato dalla schermata di riferimento Delta allegata
(workbench chiaro a pannelli, divider hairline, tipografia sobria e chrome
operativo denso) senza cambiare le rotte, i permessi, i flussi dati o le
azioni disponibili.

## Riferimento visuale aggiuntivo

La schermata allegata non va interpretata come una nuova funzionalità di
subagents/chat/changes da aggiungere al prodotto. È un riferimento per la
composizione dell'interfaccia:

- shell a pieno viewport, non una landing page con grandi sezioni o card
  promozionali;
- barra superiore bassa con controlli compatti, titolo della vista e utility
  allineate;
- navigazione persistente a sinistra, contenuto principale al centro e
  superficie contestuale a destra solo quando la feature ha già un dettaglio,
  inspector o dialog equivalente;
- rail/sidebar con larghezza stabile e contenuto centrale `minmax(0, 1fr)`;
  quando serve, il pannello contestuale resta stretto e leggibile invece di
  rubare spazio alla vista primaria;
- pannelli separati da linee sottili, superfici quasi bianche/grigio chiaro,
  raggi minimi, ombre quasi assenti e gerarchia affidata a tipografia,
  spaziatura e divider;
- righe e toolbar dense ma leggibili, con label piccole e mono per metadati,
  senza trasformare ogni elemento in una card arrotondata;
- su viewport stretti i pannelli secondari diventano drawer, tab o sezioni
  impilate senza perdere l'ordine logico e le azioni.

Il canvas a griglia e i colori di `DESIGN.md` restano la base estetica; la
schermata Delta chiarisce che nel prodotto operativo il canvas deve sostenere
un workspace multi-pannello e non imitare una pagina marketing/editoriale. La
cornice del browser visibile nello screenshot non fa parte del prodotto e non
va ricreata.

## Decisioni di prodotto assunte

- Il tema chiaro Zed è il nuovo default visivo.
- Il toggle chiaro/scuro resta disponibile: il tema scuro mantiene la stessa
  gerarchia, densità e geometria, con token semantici equivalenti invece di
  rimuovere una funzionalità esistente.
- Il branding dinamico del tenant resta supportato. Il blu Zed è il fallback
  neutro; i colori configurati dal tenant possono ancora colorare gli elementi
  di brand, ma non devono rendere il layout rumoroso né compromettere il
  contrasto.
- La gerarchia e il filtraggio della navigazione restano quelli di `nav.ts`.
  Il redesign può cambiare presentazione e responsive behavior, non
  destinazioni, guard, permission gate o feature flag.
- Non si aggiungono dipendenze UI o un secondo sistema di componenti. I
  componenti Angular standalone e le utility già presenti restano la base.

## Criteri di accettazione

- [ ] La shell autenticata occupa il viewport con un workspace chiaro a
      pannelli; la griglia discreta e il contenuto centrato entro 1200px si
      applicano alle aree di lettura dove aiutano la leggibilità, non
      forzano una cornice stretta intorno all'intera applicazione.
- [ ] Barra superiore, navigazione sinistra, contenuto centrale e superfici
      contestuali già esistenti seguono il riferimento Delta: divider da 1px,
      spaziatura compatta, raggi massimi 6px (2px per card/input/tag/button)
      e ombre quasi assenti.
- [ ] La tipografia segue i ruoli di `DESIGN.md`: sans compatto per UI e body,
      serif leggero per titoli, mono tracciato per etichette/shortcut; nessun
      testo operativo essenziale dipende solo dal colore.
- [ ] Il blu Hero Violet/Signal Blue è l'accento principale; superfici,
      divider e stati secondari restano neutri e tutti i token mantengono
      contrasto WCAG 2.2 AA in chiaro e scuro.
- [ ] La shell conserva tenant rail, sidebar filtrata, gruppi comprimibili,
      collapse persistente, topbar, notifiche, lingua, tema, profilo,
      logout, mobile drawer e navigazione da tastiera.
- [ ] Tutte le rotte esistenti continuano a raggiungere la stessa pagina e
      conservano caricamento, errori, empty state, ricerca, filtri,
      paginazione, ordinamento, dialog, submit, retry e link di azione.
- [ ] Restano invariati autenticazione OAuth, selezione/cambio tenant,
      guard/permessi, feature flag, traduzioni, branding tenant, refresh e
      integrazioni API/WebSocket.
- [ ] Il layout resta utilizzabile senza scroll orizzontale sui viewport
      mobile; su desktop sfrutta la densità compatta e pannelli con
      larghezze minmax senza ridurre i target interattivi sotto una
      dimensione accessibile.
- [ ] Focus visibile, ordine DOM/logico, nomi accessibili, stati non-colorati,
      `prefers-reduced-motion` e dialog/modal restano conformi alle regole
      Angular del progetto e a WCAG 2.2 AA.
- [ ] `npm test` e `npm run build` in `apps/frontend` passano; i test esistenti
      continuano a verificare comportamento e testo, mentre i nuovi test
      coprono almeno shell responsive, stato attivo/permessi e una pagina
      rappresentativa per ogni famiglia.
- [ ] La verifica manuale confronta desktop largo con pannelli affiancati,
      desktop stretto con superfici contestuali ridotte, mobile con drawer o
      stack, tema chiaro, tema scuro, stato loading/error/empty e almeno un
      utente con permessi ridotti. Nessuna modifica al backend è necessaria
      per il redesign.

## Superfici osservate

- La struttura persistente è in `apps/frontend/src/app/layout/`: `Shell`,
  `Topbar`, `Sidebar`, `TenantRail` e `nav.ts`. È il punto in cui tradurre
  l'immagine in un workspace Delta-like: rail/sidebar a sinistra, topbar
  sottile e contenuto principale flessibile.
- I token globali e molte primitive sono in
  `apps/frontend/src/styles.css`; attualmente contengono ancora assunzioni
  Discord (chrome scuro, blurple, grandi radius) che contraddicono
  `DESIGN.md`.
- Le primitive condivise che moltiplicano l'impatto visivo sono
  `PageHeader`, `PageStack`, `DataTable`, `Dialog`, `Loading`, `ErrorState`,
  `EmptyState`, `StatusChip`, `StatCard`, `Chart`, `SearchDialog`,
  `SearchableSelect`, `ViewToggle` e i controlli globali.
- Le famiglie di pagine da migrare sono dashboard; economia/gilda
  (`bank`, `splits`, `regears`, `users`, `warns`, `guild`); operazioni e
  combattimento (`events`, `comps`, `battles`, `fights`, `tests`, `intel`,
  `season`, `siphoned`); amministrazione e control plane (`admin/*`,
  `platform/*`, `settings`, `albion-settings`); autenticazione e onboarding.

Ogni slice segue `RED → GREEN → MUTATE → KILL MUTANTS → REFACTOR`. Prima di
scrivere codice per una slice vanno caricati gli skill di TDD, testing,
mutation testing e refactoring richiesti dal progetto; i criteri della slice
devono essere confermati dall'utente.

## Slice

### Slice 1: La shell autenticata presenta un workbench multi-pannello compatto senza perdere navigazione

**Valore**: ogni membro può entrare nel prodotto, cambiare tenant e aprire la
stessa destinazione in un workspace chiaro e denso, con la gerarchia
visiva della schermata Delta senza introdurre funzionalità estranee.

**Percorso**: `Shell` → token/layout globali → `TenantRail`/`Sidebar`/`Topbar`
→ `RouterOutlet`. Si modifica solo presentazione, dimensionamento e
responsive behavior; `nav.ts`, route config, guard e API restano la fonte di
verità. Non si aggiunge una colonna globale "Changes": le superfici a destra
si realizzano solo dove esiste già un dettaglio, inspector o dialog funzionale.

**Superfici principali**:
`apps/frontend/src/styles.css`,
`apps/frontend/src/app/layout/shell/shell.ts`,
`apps/frontend/src/app/layout/topbar/topbar.ts`,
`apps/frontend/src/app/layout/sidebar/sidebar.ts`,
`apps/frontend/src/app/layout/tenant-rail/tenant-rail.ts`.

**Criteri specifici**:

- La shell chiara usa topbar sottile, bordi da 1px, griglia del canvas e
  workspace a pieno viewport; il contenuto leggibile può avere max-width
  1200px, mentre i pannelli operativi sfruttano lo spazio disponibile. Non
  usa gradienti o chrome Discord scuro.
- La geometria dei pannelli segue il riferimento: navigazione persistente a
  sinistra, area centrale `minmax(0, 1fr)` e superfici contestuali esistenti
  che non comprimono la lettura quando sono aperte.
- Le righe di navigazione, le toolbar e i metadati hanno altezza/spaziatura
  compatta, ma conservano target accessibili; la densità non viene ottenuta
  riducendo il testo sotto i token del design.
- Rail, sidebar espansa/collassata, gruppi e voce attiva restano distinguibili
  con testo, bordo/inset e stato non basato solo sul colore.
- Il drawer mobile mantiene overlay, chiusura con Escape/backdrop, focus
  accessibile e chiusura dopo navigazione.
- Cambio tenant, add-server, collapse persistente, notifiche, lingua, tema,
  profilo e logout mantengono gli stessi eventi e destinazioni.

**RED**: estendere i test di `Sidebar` e `TenantRail` con stato attivo,
collapse, permessi/feature, label accessibili e interazioni da tastiera;
aggiungere un test di `Shell`/`Topbar` per drawer, route title e utility.
Prevedere mutanti su breakpoint, classi active, `aria-current`,
`aria-expanded`, chiusura Escape e persistenza localStorage.

**GREEN**: introdurre i token Zed semantici e applicarli alla shell,
preservando la struttura Angular e gli output esistenti.

**MUTATE**: eseguire la mutation testing suite sulla shell e produrre il
report.

**KILL MUTANTS**: rafforzare i test per ogni mutante sopravvissuto che possa
rompere destinazione, permission filtering, focus o mobile drawer.

**REFACTOR**: eliminare solo duplicazioni di CSS/token emerse durante la
migrazione; non introdurre un nuovo abstraction layer di navigazione.

**Done when**: criteri specifici verificati, test/mutation report rivisti,
`npm test` e `npm run build` passano e l'utente approva il checkpoint prima
del commit.

### Slice 2: Dashboard e primitive condivise mostrano il comando personale in modo compatto

**Valore**: il membro legge identità, progressione, KPI, attenzione e prossima
mass senza card sovradimensionate, mantenendo tutti i dati e i link operativi.

**Percorso**: `Dashboard` → servizi/API già esistenti → primitive visuali
(`PageHeader`, superfici, pulsanti, chip, progress bar, stati) → link verso
le stesse rotte.

**Superfici principali**:
`apps/frontend/src/app/features/dashboard/dashboard.ts`,
`apps/frontend/src/app/shared/components/page-header/page-header.ts`,
`apps/frontend/src/app/shared/components/page-stack/page-stack.ts`,
`apps/frontend/src/app/shared/components/stat-card/stat-card.ts`,
`apps/frontend/src/app/shared/components/status-chip/status-chip.ts`,
componenti loading/error/empty e la sezione primitives di `styles.css`.

**Criteri specifici**:

- Greeting, identità, Albion link, ruolo, season progress, KPI, attention
  items, caught-up state e next mass restano presenti e semanticamente
  invariati.
- KPI e link sono compatti, allineati su griglia responsive e leggibili anche
  quando un dato è vuoto, in errore o in caricamento.
- Pulsanti, chip, progress e stati adottano bordi hairline, testo editoriale
  e focus visibile senza rimuovere tooltip o label accessibili.
- Il test di dashboard continua a verificare contenuto, formattazione silver,
  selezione mass e condizioni caught-up; i test visivi DOM verificano la
  presenza dei landmark e dei link.

**RED**: aggiungere asserzioni di landmark/azioni e stati loading/empty/error
alla suite `dashboard.spec.ts` e testare i nuovi token/primitive al livello
più basso utile. Coprire mutanti su dati mancanti, link, progress percentuale
e stato live.

**GREEN**: migrare markup e CSS del dashboard e delle primitive senza toccare
segnali, chiamate API, computed o traduzioni.

**MUTATE / KILL MUTANTS / REFACTOR**: eseguire il report, aggiungere test per
mutanti che alterano dati o azioni, poi consolidare token condivisi senza
perdere override locali necessari.

**Done when**: la dashboard è il primo percorso end-to-end visibile con il
design Zed, mantiene tutte le azioni e il checkpoint è approvato.

### Slice 3: Le code economia e gilda conservano filtri e azioni nel nuovo layout

**Valore**: membri e officer gestiscono denaro, split, regear, utenti e warn
in tabelle dense ma leggibili, senza perdere controlli o guard.

**Percorso**: pagine `bank`, `splits`, `split-detail`, `regears`,
`regear-new-request`, `regear-detail`, `users`, `user-detail`, `warns` e
`guild` → `DataTable`/form/dialog → API e azioni esistenti.

**Criteri specifici**:

- Ricerca, filtri per colonna, tab, ordinamento, paginazione, page size,
  row-click, submit, retry, export/link e dialog restano disponibili dove
  oggi presenti.
- Header, toolbar, tabelle, righe responsive e dettagli usano il ritmo
  compatto Zed senza nascondere dati essenziali; su mobile le tabelle hanno
  una strategia esplicita (stack/scroll con label).
- Stati permission denied, loading, empty ed error sono distinguibili e
  accessibili.
- I test comportamentali esistenti delle pagine restano verdi e vengono
  aggiunti test mirati alla struttura responsive della tabella.

**RED / GREEN / MUTATE / KILL MUTANTS / REFACTOR**: seguire il ciclo completo
per ogni famiglia, partendo dai test esistenti e dai mutanti su filtri,
ordinamento, pagina corrente, submit e permission gate; rifattorizzare solo
CSS ripetuto dopo aver preservato la semantica delle tabelle.

**Done when**: un officer può completare almeno un percorso di richiesta e un
percorso di revisione con gli stessi dati/azioni, su desktop e mobile.

### Slice 4: Operazioni, combattimento e intel mantengono workflow densi e leggibili

**Valore**: chi prepara o analizza attività di gilda può creare/aprire eventi,
composizioni, test, battaglie, fight e report intel con la stessa rapidità e
senza cambiare il modello operativo.

**Percorso**: `events`, `event-detail`, `comps` e build detail, `tests` e
timeline, `battles` e detail/group/outcome, `fights` e trends, `intel` e
opponents/detail, `season`, `siphoned` → grafici, editor, equipment,
ability, destiny board e dialog → API/WebSocket esistenti.

**Criteri specifici**:

- Editor/timeline, chart, tooltip, filtri, tab, version switcher e azioni
  primarie mantengono input, salvataggio, selezione, condivisione e link.
- Le schermate dense usano griglie/tabelle responsive senza riordinare
  visivamente i controlli in modo diverso dall'ordine DOM della tastiera.
- Colori di ruolo, stato fight e metriche mantengono un indicatore testuale o
  iconografico oltre al colore.
- Sono coperti almeno un list/detail pair, un editor/timeline e un grafico
  con test di non-regressione dei dati.

**RED / GREEN / MUTATE / KILL MUTANTS / REFACTOR**: ciclo completo sugli
handler e sulle view già testate, con attenzione a mutanti che eliminano
selezioni, cambiano stato live, alterano percentuali o disabilitano CTA.

**Done when**: i workflow operativi rappresentativi sono migrati, i report
restano interpretabili e gli aggiornamenti realtime non cambiano semantica.

### Slice 5: Admin, platform, settings e onboarding usano la stessa grammatica visiva

**Valore**: officer, platform admin e nuovi membri trovano configurazione,
registrazione, scelta server e impostazioni coerenti con l'area operativa.

**Percorso**: `admin/*`, `platform/*`, `settings`, `albion-settings`,
`auth/*`, `onboarding/*` → form, permission gate, confirm dialog e API
esistenti.

**Criteri specifici**:

- Tutti i pannelli amministrativi restano filtrati per permission/feature e
  conservano save, delete, reload, toggle, import/export e conferme.
- Login, choose-server, needs-tenant, register-tenant e add-server conservano
  redirect `next`, OAuth, errori, lingua e tema.
- Form e select mostrano validazione, disabled/loading e messaggi di errore
  senza affidarsi solo alla cromia.
- I test esistenti di admin/auth/onboarding restano verdi e coprono almeno un
  gate autorizzativo e un submit.

**RED / GREEN / MUTATE / KILL MUTANTS / REFACTOR**: ciclo completo per
form/guard/submit, includendo mutanti su redirect, errore, disabled state,
permission e conferma distruttiva.

**Done when**: un admin può completare un salvataggio autorizzato e un utente
non autorizzato/non ancora associato vede lo stesso percorso di recupero,
con la sola differenza visiva.

### Slice 6: La verifica trasversale certifica responsive, accessibilità e parity

**Valore**: il redesign è distribuibile senza regressioni nascoste nelle
decine di pagine lazy-loaded e nei componenti condivisi.

**Percorso**: matrice di rotte + utenti/permessi + temi + viewport → test
Angular/Vitest, build SSR e verifica browser manuale/a11y → checklist finale.

**Criteri specifici**:

- Ogni rotta della configurazione è visitata almeno una volta nella matrice
  di smoke test; redirect e route protette sono inclusi.
- Sono verificati focus, tastiera, dialog, drawer, tabella overflow,
  reduced-motion, contrasto, nomi/ruoli e assenza di overflow orizzontale.
- `npm test`, `npm run build` e la suite di mutation testing passano oppure
  ogni mutante sopravvissuto è documentato e approvato.
- La review finale conferma che non sono stati modificati backend,
  contratti API, guard, servizi di dati o testo funzionale salvo correzioni
  necessarie per accessibilità.

**RED / GREEN / MUTATE / KILL MUTANTS / REFACTOR**: aggiungere solo test per
buchi reali emersi dalla matrice; non usare screenshot come unico oracle di
comportamento.

**Done when**: criteri globali verificati, report archiviato nella review,
utente approva il risultato e il piano può essere eliminato dopo il merge.

## Quality gate pre-PR

1. Eseguire mutation testing e rivedere i mutanti sopravvissuti.
2. Eseguire la valutazione di refactoring senza introdurre astrazioni
   speculative.
3. Eseguire `npm test` e `npm run build` in `apps/frontend`.
4. Verificare static analysis/TypeScript e formattazione secondo gli script
   disponibili.
5. Completare la matrice responsive/a11y e controllare che le traduzioni e il
   glossario dei termini di dominio non siano cambiati accidentalmente.

---

*Eliminare questo file quando tutte le slice sono complete. Se `plans/` resta
vuota, eliminare anche la directory.*
