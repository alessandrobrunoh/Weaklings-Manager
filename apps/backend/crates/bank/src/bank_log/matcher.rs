//! Proposes links between Albion bank log rows and Manager records.
//!
//! Pure: rows and candidates in, proposals out, no database. The service turns proposals into
//! unconfirmed links (suggestions); only an officer confirms them.
//!
//! Rules:
//! * **Payout**: one `Withdrawal` row and one payout (the rows one member had accepted at the
//!   same moment, summed). Same silver amount; the game row lies between 2 days before and
//!   7 days after the acceptance. The player in the game row is the paying officer, so names are
//!   not compared.
//! * **Bags**: one or more deposits (any player except the seller accounts) and one split's bags
//!   value. The exact sum, after the split was created and within 30 days. Groups are deposits
//!   made close together (at most 60 minutes between two of them), up to 4 rows.
//! * **Loot sale**: deposits by a seller account and the expected sale of splits,
//!   `loot × (1 − market tax)`. Within 5% of the expected value, within 45 days after creation:
//!   one deposit to one split, one deposit to up to 4 splits, or up to 4 deposits to one split.
//!
//! Every pair that fits is proposed, so an ambiguous row carries several suggestions and an
//! officer picks one. The search is bounded (12 candidates, groups of 4 at most).

use chrono::{DateTime, Duration, Utc};
use sea_orm::prelude::Decimal;

/// Log row categories.
pub const CATEGORY_PAYOUT: &str = "payout";
pub const CATEGORY_BAGS: &str = "bags";
pub const CATEGORY_LOOT_SALE: &str = "loot_sale";
pub const CATEGORY_GUILD_EXPENSE: &str = "guild_expense";
pub const CATEGORY_DONATION: &str = "donation";
pub const CATEGORY_OTHER: &str = "other";
pub const CATEGORIES: [&str; 6] = [
    CATEGORY_PAYOUT,
    CATEGORY_BAGS,
    CATEGORY_LOOT_SALE,
    CATEGORY_GUILD_EXPENSE,
    CATEGORY_DONATION,
    CATEGORY_OTHER,
];

/// Link kinds.
pub const KIND_PAYOUT: &str = "payout";
pub const KIND_BAGS: &str = "bags";
pub const KIND_LOOT_SALE: &str = "loot_sale";
pub const KIND_MANUAL: &str = "manual";

const MAX_GROUP: usize = 4;
const MAX_CANDIDATES: usize = 12;
const MAX_PROPOSALS_PER_ROW: usize = 5;

/// A log row that is neither in a confirmed link nor explained.
#[derive(Debug, Clone)]
pub struct Row {
    pub id: i64,
    pub at: DateTime<Utc>,
    pub amount: Decimal,
    pub category: String,
}

/// A payout the Manager recorded: the withdrawal rows one member had accepted at one moment.
#[derive(Debug, Clone)]
pub struct Payout {
    pub transaction_ids: Vec<i64>,
    pub amount: Decimal,
    pub at: DateTime<Utc>,
}

/// What a split should have produced in the game bank.
#[derive(Debug, Clone)]
pub struct SplitCandidate {
    pub id: i64,
    pub created_at: DateTime<Utc>,
    pub bags_value: Decimal,
    /// `loot × (1 − market tax)`.
    pub expected_sale: Decimal,
}

/// A proposed link.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Proposal {
    pub kind: &'static str,
    pub entry_ids: Vec<i64>,
    pub transaction_ids: Vec<i64>,
    pub split_ids: Vec<i64>,
}

/// The category a freshly imported row gets.
///
/// `Withdrawal` is a payout, a `Deposit` by a seller account is a loot sale, any other deposit
/// is bags, and any other reason (vault purchase, territory claim) is a guild expense.
pub fn initial_category(reason: &str, player: &str, seller_accounts: &[String]) -> &'static str {
    match reason.trim().to_ascii_lowercase().as_str() {
        "withdrawal" => CATEGORY_PAYOUT,
        "deposit" => {
            if seller_accounts
                .iter()
                .any(|seller| seller.eq_ignore_ascii_case(player.trim()))
            {
                CATEGORY_LOOT_SALE
            } else {
                CATEGORY_BAGS
            }
        }
        _ => CATEGORY_GUILD_EXPENSE,
    }
}

/// Same silver amount: Albion amounts are whole silver, Manager amounts carry cents.
fn same_silver(a: Decimal, b: Decimal) -> bool {
    (a - b).abs() < Decimal::ONE
}

fn within_tolerance(actual: Decimal, expected: Decimal) -> bool {
    if expected <= Decimal::ZERO {
        return false;
    }
    (actual - expected).abs() <= expected * Decimal::new(5, 2)
}

/// Every combination of `k` indices out of `0..n`, in lexicographic order.
fn combinations(n: usize, k: usize) -> Vec<Vec<usize>> {
    fn walk(start: usize, n: usize, k: usize, current: &mut Vec<usize>, out: &mut Vec<Vec<usize>>) {
        if current.len() == k {
            out.push(current.clone());
            return;
        }
        for i in start..n {
            current.push(i);
            walk(i + 1, n, k, current, out);
            current.pop();
        }
    }
    let mut out = Vec::new();
    if k <= n {
        walk(0, n, k, &mut Vec::with_capacity(k), &mut out);
    }
    out
}

/// Splits rows (sorted by time) into runs where consecutive rows are at most `gap` apart.
fn clusters(rows: &[&Row], gap: Duration) -> Vec<Vec<usize>> {
    let mut out: Vec<Vec<usize>> = Vec::new();
    for (i, row) in rows.iter().enumerate() {
        match out.last_mut() {
            Some(cluster)
                if cluster
                    .last()
                    .is_some_and(|&last| row.at - rows[last].at <= gap) =>
            {
                cluster.push(i);
            }
            _ => out.push(vec![i]),
        }
    }
    out
}

/// Proposes links for `rows` against the Manager's payouts and splits.
pub fn propose(rows: &[Row], payouts: &[Payout], splits: &[SplitCandidate]) -> Vec<Proposal> {
    let mut out = Vec::new();
    propose_payouts(rows, payouts, &mut out);
    propose_bags(rows, splits, &mut out);
    propose_loot_sales(rows, splits, &mut out);
    out
}

fn propose_payouts(rows: &[Row], payouts: &[Payout], out: &mut Vec<Proposal>) {
    for row in rows
        .iter()
        .filter(|row| row.category == CATEGORY_PAYOUT && row.amount < Decimal::ZERO)
    {
        let paid = -row.amount;
        let mut fits: Vec<&Payout> = payouts
            .iter()
            .filter(|payout| {
                same_silver(payout.amount, paid)
                    && row.at >= payout.at - Duration::days(2)
                    && row.at <= payout.at + Duration::days(7)
            })
            .collect();
        fits.sort_by_key(|payout| (payout.at - row.at).num_seconds().abs());
        for payout in fits.into_iter().take(MAX_PROPOSALS_PER_ROW) {
            out.push(Proposal {
                kind: KIND_PAYOUT,
                entry_ids: vec![row.id],
                transaction_ids: payout.transaction_ids.clone(),
                split_ids: Vec::new(),
            });
        }
    }
}

fn propose_bags(rows: &[Row], splits: &[SplitCandidate], out: &mut Vec<Proposal>) {
    let mut deposits: Vec<&Row> = rows
        .iter()
        .filter(|row| row.category == CATEGORY_BAGS && row.amount > Decimal::ZERO)
        .collect();
    deposits.sort_by_key(|row| (row.at, row.id));
    for split in splits.iter().filter(|split| split.bags_value > Decimal::ZERO) {
        let window: Vec<&Row> = deposits
            .iter()
            .copied()
            .filter(|row| {
                row.at >= split.created_at && row.at <= split.created_at + Duration::days(30)
            })
            .collect();
        let mut found = 0;
        for row in &window {
            if same_silver(row.amount, split.bags_value) {
                out.push(Proposal {
                    kind: KIND_BAGS,
                    entry_ids: vec![row.id],
                    transaction_ids: Vec::new(),
                    split_ids: vec![split.id],
                });
                found += 1;
            }
        }
        for cluster in clusters(&window, Duration::minutes(60)) {
            let members: Vec<&Row> = cluster
                .iter()
                .take(MAX_CANDIDATES)
                .map(|&i| window[i])
                .collect();
            for size in 2..=MAX_GROUP.min(members.len()) {
                for combo in combinations(members.len(), size) {
                    if found >= MAX_PROPOSALS_PER_ROW {
                        break;
                    }
                    let sum: Decimal = combo.iter().map(|&i| members[i].amount).sum();
                    if same_silver(sum, split.bags_value) {
                        out.push(Proposal {
                            kind: KIND_BAGS,
                            entry_ids: combo.iter().map(|&i| members[i].id).collect(),
                            transaction_ids: Vec::new(),
                            split_ids: vec![split.id],
                        });
                        found += 1;
                    }
                }
            }
        }
    }
}

fn propose_loot_sales(rows: &[Row], splits: &[SplitCandidate], out: &mut Vec<Proposal>) {
    let sales: Vec<&Row> = rows
        .iter()
        .filter(|row| row.category == CATEGORY_LOOT_SALE && row.amount > Decimal::ZERO)
        .collect();
    let in_window = |row: &Row, split: &SplitCandidate| {
        row.at >= split.created_at && row.at <= split.created_at + Duration::days(45)
    };
    for row in &sales {
        // Nearest splits created before the sale.
        let mut open: Vec<&SplitCandidate> = splits
            .iter()
            .filter(|split| split.expected_sale > Decimal::ZERO && in_window(row, split))
            .collect();
        open.sort_by_key(|split| (row.at - split.created_at).num_seconds());
        open.truncate(MAX_CANDIDATES);
        let mut found = 0;
        for split in &open {
            if found < MAX_PROPOSALS_PER_ROW && within_tolerance(row.amount, split.expected_sale) {
                out.push(Proposal {
                    kind: KIND_LOOT_SALE,
                    entry_ids: vec![row.id],
                    transaction_ids: Vec::new(),
                    split_ids: vec![split.id],
                });
                found += 1;
            }
        }
        for size in 2..=MAX_GROUP.min(open.len()) {
            for combo in combinations(open.len(), size) {
                if found >= MAX_PROPOSALS_PER_ROW {
                    break;
                }
                let expected: Decimal = combo.iter().map(|&i| open[i].expected_sale).sum();
                if within_tolerance(row.amount, expected) {
                    let mut split_ids: Vec<i64> = combo.iter().map(|&i| open[i].id).collect();
                    split_ids.sort_unstable();
                    out.push(Proposal {
                        kind: KIND_LOOT_SALE,
                        entry_ids: vec![row.id],
                        transaction_ids: Vec::new(),
                        split_ids,
                    });
                    found += 1;
                }
            }
        }
    }
    // Several deposits paying one split (a sale spread over a few days).
    for split in splits.iter().filter(|split| split.expected_sale > Decimal::ZERO) {
        let mut window: Vec<&Row> = sales
            .iter()
            .copied()
            .filter(|row| in_window(row, split))
            .collect();
        window.sort_by_key(|row| (row.at, row.id));
        window.truncate(MAX_CANDIDATES);
        let mut found = 0;
        for size in 2..=MAX_GROUP.min(window.len()) {
            for combo in combinations(window.len(), size) {
                if found >= MAX_PROPOSALS_PER_ROW {
                    break;
                }
                let sum: Decimal = combo.iter().map(|&i| window[i].amount).sum();
                if within_tolerance(sum, split.expected_sale) {
                    out.push(Proposal {
                        kind: KIND_LOOT_SALE,
                        entry_ids: combo.iter().map(|&i| window[i].id).collect(),
                        transaction_ids: Vec::new(),
                        split_ids: vec![split.id],
                    });
                    found += 1;
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(s: &str) -> DateTime<Utc> {
        DateTime::parse_from_rfc3339(s).unwrap().with_timezone(&Utc)
    }

    fn row(id: i64, when: &str, amount: i64, category: &str) -> Row {
        Row {
            id,
            at: at(when),
            amount: Decimal::from(amount),
            category: category.to_string(),
        }
    }

    #[test]
    fn initial_categories_follow_the_reason_and_the_seller_accounts() {
        let sellers = vec!["WeaklingsGM".to_string()];
        assert_eq!(initial_category("Withdrawal", "Galvdon", &sellers), CATEGORY_PAYOUT);
        assert_eq!(initial_category("Deposit", "weaklingsgm", &sellers), CATEGORY_LOOT_SALE);
        assert_eq!(initial_category("Deposit", "Stinapse", &sellers), CATEGORY_BAGS);
        assert_eq!(
            initial_category("Purchase of guild vault in Weaklings's Island", "raikiry", &sellers),
            CATEGORY_GUILD_EXPENSE
        );
        assert_eq!(
            initial_category("Claim cost for territory Hightree Dale Show", "raikiry", &sellers),
            CATEGORY_GUILD_EXPENSE
        );
    }

    #[test]
    fn a_withdrawal_matches_a_payout_of_the_same_amount_regardless_of_cents() {
        let rows = vec![row(1, "2026-11-16T23:10:00Z", -7_414_881, CATEGORY_PAYOUT)];
        let payouts = vec![Payout {
            transaction_ids: vec![10, 11],
            amount: "7414881.40".parse().unwrap(),
            at: at("2026-11-16T22:00:00Z"),
        }];
        let proposals = propose(&rows, &payouts, &[]);
        assert_eq!(
            proposals,
            vec![Proposal {
                kind: KIND_PAYOUT,
                entry_ids: vec![1],
                transaction_ids: vec![10, 11],
                split_ids: vec![],
            }]
        );
    }

    #[test]
    fn a_payout_outside_the_window_is_not_proposed() {
        let rows = vec![row(1, "2026-11-20T00:00:00Z", -1_000, CATEGORY_PAYOUT)];
        let payouts = vec![Payout {
            transaction_ids: vec![10],
            amount: Decimal::from(1_000),
            at: at("2026-11-10T00:00:00Z"),
        }];
        assert!(propose(&rows, &payouts, &[]).is_empty());
    }

    #[test]
    fn two_identical_withdrawals_both_point_at_the_single_payout() {
        // Only one can be confirmed; the other stays open and shows a possible double payment.
        let rows = vec![
            row(1, "2026-11-14T18:42:00Z", -1_036_150, CATEGORY_PAYOUT),
            row(2, "2026-11-14T18:42:00Z", -1_036_150, CATEGORY_PAYOUT),
        ];
        let payouts = vec![Payout {
            transaction_ids: vec![7],
            amount: Decimal::from(1_036_150),
            at: at("2026-11-14T18:40:00Z"),
        }];
        let proposals = propose(&rows, &payouts, &[]);
        assert_eq!(proposals.len(), 2);
        assert!(proposals.iter().all(|p| p.transaction_ids == vec![7]));
    }

    #[test]
    fn bags_paid_in_three_deposits_are_grouped() {
        let rows = vec![
            row(1, "2026-11-13T11:17:00Z", 64_000, CATEGORY_BAGS),
            row(2, "2026-11-13T11:17:00Z", 1_300_000, CATEGORY_BAGS),
            row(3, "2026-11-13T11:17:00Z", 120_000, CATEGORY_BAGS),
            row(4, "2026-11-13T15:00:00Z", 571_000, CATEGORY_BAGS),
        ];
        let splits = vec![SplitCandidate {
            id: 42,
            created_at: at("2026-11-12T20:00:00Z"),
            bags_value: Decimal::from(1_484_000),
            expected_sale: Decimal::ZERO,
        }];
        let proposals = propose(&rows, &[], &splits);
        assert_eq!(
            proposals,
            vec![Proposal {
                kind: KIND_BAGS,
                entry_ids: vec![1, 2, 3],
                transaction_ids: vec![],
                split_ids: vec![42],
            }]
        );
    }

    #[test]
    fn bags_before_the_split_existed_are_ignored() {
        let rows = vec![row(1, "2026-11-01T10:00:00Z", 500, CATEGORY_BAGS)];
        let splits = vec![SplitCandidate {
            id: 1,
            created_at: at("2026-11-02T10:00:00Z"),
            bags_value: Decimal::from(500),
            expected_sale: Decimal::ZERO,
        }];
        assert!(propose(&rows, &[], &splits).is_empty());
    }

    #[test]
    fn a_seller_deposit_matches_the_expected_sale_within_five_percent() {
        let rows = vec![row(1, "2026-11-06T19:54:00Z", 100_000_000, CATEGORY_LOOT_SALE)];
        let splits = vec![
            SplitCandidate {
                id: 1,
                created_at: at("2026-11-01T10:00:00Z"),
                bags_value: Decimal::ZERO,
                // 104M loot × 0.94
                expected_sale: Decimal::from(97_760_000),
            },
            SplitCandidate {
                id: 2,
                created_at: at("2026-11-01T10:00:00Z"),
                bags_value: Decimal::ZERO,
                expected_sale: Decimal::from(50_000_000),
            },
        ];
        let proposals = propose(&rows, &[], &splits);
        assert_eq!(proposals.len(), 1);
        assert_eq!(proposals[0].split_ids, vec![1]);
    }

    #[test]
    fn one_seller_deposit_can_cover_several_splits() {
        let rows = vec![row(1, "2026-11-06T19:54:00Z", 100_000_000, CATEGORY_LOOT_SALE)];
        let splits = vec![
            SplitCandidate {
                id: 1,
                created_at: at("2026-11-01T10:00:00Z"),
                bags_value: Decimal::ZERO,
                expected_sale: Decimal::from(60_000_000),
            },
            SplitCandidate {
                id: 2,
                created_at: at("2026-11-02T10:00:00Z"),
                bags_value: Decimal::ZERO,
                expected_sale: Decimal::from(39_000_000),
            },
        ];
        let proposals = propose(&rows, &[], &splits);
        assert_eq!(proposals.len(), 1);
        assert_eq!(proposals[0].split_ids, vec![1, 2]);
    }

    #[test]
    fn expenses_are_never_proposed() {
        let rows = vec![row(1, "2026-11-02T13:06:00Z", -1_875_000, CATEGORY_GUILD_EXPENSE)];
        let payouts = vec![Payout {
            transaction_ids: vec![1],
            amount: Decimal::from(1_875_000),
            at: at("2026-11-02T13:00:00Z"),
        }];
        assert!(propose(&rows, &payouts, &[]).is_empty());
    }
}
