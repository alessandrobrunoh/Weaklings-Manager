# Guild Bank Reconciliation, Market Tax and Table Export

*   **Author:** alessandrobrunoh
*   **Status:** Draft
*   **Date:** 2026-11-17

--------------------------------------------------------------------------------

## Overview

This design covers three changes to the guild finance tools. They ship in order, one pull request
per phase:

1.  **Market tax per split.** Each guild gets a market tax setting (default 6%, editable), kept
    apart from the guild fee. The tax applies only to the loot value that the shared seller account
    (for Weaklings: `WeaklingsGM`) sells on the Albion market. Each split stores the tax it used,
    the same way it already stores its fee.
2.  **Albion bank log reconciliation.** Once a week, officers paste the in-game guild bank silver
    log (JSON, last 4 weeks, minute precision, UTC). The Manager stores the rows, proposes a category
    and a link for each one (paid withdrawal, split bags, loot sale, guild expense), and shows what
    does not line up. Officers confirm, link by hand, explain with a note, or create the missing
    transaction from the row. From day 5 without an import, the backend pings the guild's staff role
    once a day in a Discord channel chosen in the admin panel, until someone imports.
3.  **CSV export of tables.** Every page built on the shared `app-data-table` component can export
    all rows that match its current filters, not only the visible page.

The Manager stays the source of truth. The game log is a second check: it never changes a member's
balance, never creates income, and never overrides a split.

## The Problem

The guild bank in Albion and the bank in the Manager are kept by hand, in two places, by different
people. Today nothing compares them. Errors only surface when someone notices them by chance:

*   **Double payouts.** An officer withdraws silver in game and trades it to a member. If the same
    withdrawal is paid twice (the log shows two identical -1,036,150 withdrawals by LelouchVI at
    2026-11-14 18:42), or paid without a request in the Manager, nothing flags it.
*   **Missing deposits.** Bags are split between members in the Manager, then someone (usually
    staff, not always) deposits the silver in game. If the deposit never happens, or is short,
    nobody sees it.
*   **Unexplained sales.** `WeaklingsGM` deposits loot sales (100M, 45M, 32.5M in the pasted log).
    Nothing ties a deposit to the splits it pays for.
*   **Untracked guild spending.** Vault purchases and territory claim costs are paid from the guild
    bank in game and appear nowhere in the Manager.
*   **The log expires.** The game keeps 4 weeks. If nobody exports it in time, the oldest rows are
    lost for good.

Two related problems surfaced during the discussion:

*   **The market tax is hidden inside the guild fee.** Weaklings uses a 20% fee that silently
    includes about 6% of market tax. The tax depends on the seller (Premium or not, sell order or
    instant sale), so another guild may pay 3%. A single fee hides this and taxes the bags, which
    are never sold on the market.
*   **Tables cannot leave the Manager.** Officers want to work on the data in a spreadsheet. Most
    tables are paginated on the server, so copying the screen gives 25 rows, not the full list.

## Goals

*   **G1. Lossless weekly import.** Re-importing an overlapping 4-week export adds only new rows.
    Identical rows that really happened twice are both kept. Re-importing the same file twice
    changes nothing.
*   **G2. Every imported row ends in a known state.** Each row is `unmatched`, `suggested`,
    `matched` or `explained`. Rows whose reason is not `Deposit` or `Withdrawal` (vault purchase,
    territory claim) are categorised as guild expenses automatically.
*   **G3. Automatic suggestions, human confirmation.** The Manager proposes links for payouts (one
    withdrawal to one or more paid withdrawals of one member), bags (one or more deposits to one
    split) and loot sales (one or more seller deposits to one or more splits). It never confirms an
    ambiguous link by itself.
*   **G4. Period balance.** For a chosen period, show per category the game total, the linked
    Manager total, and the remainder that is not linked or explained.
*   **G5. Fix from the row.** From an unmatched row an officer can link it by hand, explain it with
    a required note, or create a bank transaction pre-filled from the row. A row can create at most
    one transaction, ever.
*   **G6. Import reminder.** Per guild: from day 5 after the last import, one ping per day to the
    staff role in the configured channel, until an import happens. The message states how many days
    remain before rows start falling out of the 4-week game window.
*   **G7. Market tax per split.** New splits use
    `(loot value × (1 − tax) − repairs + bags) × (1 − fee)`. Splits created before the release
    keep tax 0 and return exactly the same net value as today, including alliance copies and
    recalculated completed splits.
*   **G8. Settings per guild.** Market tax (default 6%), seller accounts, reminder channel and the
    feature flag are guild settings. Existing guilds keep their stored fee; the fee default for new
    guilds becomes 15%.
*   **G9. Full CSV export.** Any `app-data-table` page exports every row matching its filters, with
    the same permissions as the page, and with spreadsheet formula injection neutralised.
*   **G10. Audit.** Every import, link, explanation, category change and created transaction writes
    an audit row.

## Non-Goals

*   Fetching the log from the game automatically. There is no API; the import stays manual.
*   Letting the game log change balances, create income, or close splits. Income comes only from
    splits that officers create.
*   Writing guild expenses into the member bank ledger. A bank row always has a member recipient;
    expenses live only on the imported row.
*   Reconciling anything older than a guild's first import.
*   Matching withdrawals by player name. The name in the log is the paying officer, not the member.
*   Changing the tax or fee of splits that already exist, or rewriting any guild's stored fee.
*   XLSX or other binary export formats. Excel opens CSV.
*   Exporting tables that are not built on `app-data-table`.

## Open Questions

These are settled in the Detailed Implementation section; they are listed here so they are not
asked again:

*   **Payout window**: how many days after a withdrawal request is accepted can the game withdrawal
    appear and still be suggested?
*   **Loot sale tolerance**: how far can a seller deposit be from the expected
    `loot value × (1 − tax)` and still be suggested (absolute silver or percent)?
*   **Group size limit**: the maximum number of rows combined in one many-to-one suggestion.
*   **Permission**: a new reconciliation permission, or reuse of `SiphonedIngest` plus
    `BankTransactionsCreate`?
*   **CSV size**: maximum rows per export, and what the page does above it.

## Critical User Journeys (CUJs)

### CUJ 1: Weekly import with overlap and a real duplicate

*   **Given**: The guild imported last week. The new export covers 4 weeks, so about 3 weeks of rows
    are already stored. It contains the two identical -1,036,150 withdrawals of 2026-11-14 18:42.
*   **When**: An officer pastes the JSON on the reconciliation page and imports it.
*   **Then**: Only rows not already stored are added. Both identical withdrawals exist once each.
    The reply shows new rows, rows already stored, and duplicates kept. The import date resets the
    reminder counter.

### CUJ 2: Reviewing a payout

*   **Given**: A member requested "withdraw all" in the Manager and an officer accepted it for
    7,414,881. The import contains a Galvdon withdrawal of -7,414,881 the same evening.
*   **When**: The officer opens the reconciliation page.
*   **Then**: The row is `suggested`, showing the paying officer (Galvdon) and the receiving member.
    One click confirms it as `matched`. If two members were paid the same amount that day, the row
    shows both candidates and the officer chooses.

### CUJ 3: Bags paid in pieces

*   **Given**: A split has `bags_value` 1,484,000. Three deposits arrive in the same minute after
    the split was created: 64,000, 1,300,000 and 120,000, from two players.
*   **When**: The officer opens the reconciliation page.
*   **Then**: The three rows are suggested together as the bags of that split. Confirming links all
    three. If the sum does not equal the bags value, no suggestion is made and the rows stay
    `unmatched`.

### CUJ 4: A row nobody can explain

*   **Given**: A deposit with no plausible link.
*   **When**: The officer opens its detail panel.
*   **Then**: They can link it by hand to a split or a paid withdrawal (with a running total), mark
    it `explained` with a required note, or create a bank transaction pre-filled with amount, date
    and player. Creating a transaction a second time from the same row is refused, also after the
    created transaction is rejected or deleted.

### CUJ 5: Guild expense

*   **Given**: The import contains "Purchase of guild vault in Weaklings's Island -1,875,000".
*   **When**: The import completes.
*   **Then**: The row is categorised as a guild expense without officer action, counts in the
    period's outflows, and is not written to the bank ledger. The officer can change the category.

### CUJ 6: Missed import

*   **Given**: A guild set a reminder channel and has a staff role. The last import was 5 days ago
    in the guild's timezone.
*   **When**: The backend reminder check runs.
*   **Then**: One message is posted in the channel pinging the staff role, saying 5 days since the
    last import and 23 days before rows start to be lost. The same happens once per day after that.
    The pings stop on the day after an import. If the channel or role is missing, nothing is sent
    and the admin panel shows why.

### CUJ 7: Market tax on a new split

*   **Given**: A guild with stored fee 20% and the new market tax at its default 6%. An admin lowers
    the fee to 15%.
*   **When**: An officer creates a split with 100M loot, 10M bags and no repairs.
*   **Then**: The split stores tax 6% and fee 15%, and members share
    `(100M × 0.94 + 10M) × 0.85 = 88.4M`. A split created before the release still shows its old
    net value, tax 0. The finance settings show a one-time notice explaining the new setting.

### CUJ 8: Exporting a filtered table

*   **Given**: The admin transactions page filtered to one month, showing page 1 of 12.
*   **When**: The officer clicks Export CSV.
*   **Then**: The file contains every row of the 12 pages with the same filters, only the columns
    the page shows, and no row the officer could not see on screen. A player name starting with `=`
    is written as text, not as a formula.

--------------------------------------------------------------------------------

*Drafted with EGM*
