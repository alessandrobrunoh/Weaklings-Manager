//! Proposes links between Albion bank log rows and Manager records, each with a score.
//!
//! Pure: rows and candidates in, proposals out, no database. The service turns proposals into
//! unconfirmed links (suggestions); only an officer confirms them.
//!
//! Every proposal gets a score from 0 to 100 built from how close the amounts are and how close
//! in time the two records are, so an officer sees the most likely match first and "fill all"
//! can take it. Rules:
//! * **Payout**: one `Withdrawal` row and one or more of a member's paid-out rows. Candidates are
//!   the rows accepted in one go, the rows of one request, or any few (up to 4) of the member's
//!   rows near the withdrawal. Same silver (within 1%), accepted between 7 days before and
//!   2 days after the game row. The player in the game row is the paying officer, so names are
//!   not compared.
//! * **Bags**: deposits (any player except the seller accounts) and one split's bags value. The
//!   split was created or finalized within 3 days of the deposit, before or after. Exact sums of
//!   one deposit or of nearby deposits (at most 60 minutes apart, up to 4 rows, or the whole
//!   burst) score highest; a single deposit smaller than the bags value is still proposed for
//!   the nearest splits, with a low score, as a partial payment.
//! * **Loot sale**: deposits by a seller account and the expected sale of splits,
//!   `loot × (1 − market tax)`. Within 5% of the expected value, from 1 day before to 45 days
//!   after the split: one deposit to one split, one deposit to up to 4 splits, or up to
//!   4 deposits to one split.
//!
//! At most [`MAX_PROPOSALS_PER_ROW`] proposals are kept per row, best first. The search is
//! bounded (10 candidates per member or burst, groups of 4 at most).

use std::collections::{BTreeMap, HashMap, HashSet};

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
const MAX_CANDIDATES: usize = 10;
/// Suggestions kept per log row, best first.
pub const MAX_PROPOSALS_PER_ROW: usize = 3;
/// Proposals below this score are not shown.
const MIN_SCORE: u8 = 20;
/// Highest score of a partial bag payment (a deposit smaller than the split's bags).
const PARTIAL_BAGS_MAX: f64 = 55.0;

/// Days a payout may be accepted before the game withdrawal.
pub const PAYOUT_DAYS_BEFORE: i64 = 7;
/// Days a payout may be accepted after the game withdrawal.
pub const PAYOUT_DAYS_AFTER: i64 = 2;
/// Days between a bag deposit and its split's creation or finalization, either way.
pub const BAGS_DAYS: i64 = 3;
/// Days after a split's creation its loot may still be sold.
pub const LOOT_SALE_DAYS: i64 = 45;

/// A log row that is neither in a confirmed link nor explained.
#[derive(Debug, Clone)]
pub struct Row {
    pub id: i64,
    pub at: DateTime<Utc>,
    pub amount: Decimal,
    pub category: String,
}

/// One bank row the Manager paid out to a member.
#[derive(Debug, Clone)]
pub struct Paid {
    pub transaction_id: i64,
    pub user_id: i64,
    pub amount: Decimal,
    /// When an officer accepted it.
    pub paid_at: DateTime<Utc>,
    /// When the member asked for it; rows of one request share it.
    pub requested_at: Option<DateTime<Utc>>,
}

/// What a split should still bring into the game bank.
#[derive(Debug, Clone)]
pub struct SplitCandidate {
    pub id: i64,
    pub created_at: DateTime<Utc>,
    pub finalized_at: Option<DateTime<Utc>>,
    /// Bags value not yet covered by confirmed links.
    pub bags_value: Decimal,
    /// `loot × (1 − market tax)` not yet covered by confirmed links.
    pub expected_sale: Decimal,
}

impl SplitCandidate {
    /// Time between `at` and the nearer of the split's creation and finalization.
    pub fn apart(&self, at: DateTime<Utc>) -> Duration {
        let created = (at - self.created_at).abs();
        self.finalized_at
            .map_or(created, |finalized| created.min((at - finalized).abs()))
    }
}

/// A proposed link.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Proposal {
    pub kind: &'static str,
    pub entry_ids: Vec<i64>,
    pub transaction_ids: Vec<i64>,
    pub split_ids: Vec<i64>,
    /// 0-100, higher is more likely.
    pub score: u8,
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

/// Whether a payout accepted at `paid_at` can be the game withdrawal at `row_at`.
pub fn in_payout_window(row_at: DateTime<Utc>, paid_at: DateTime<Utc>) -> bool {
    paid_at >= row_at - Duration::days(PAYOUT_DAYS_BEFORE)
        && paid_at <= row_at + Duration::days(PAYOUT_DAYS_AFTER)
}

/// 100 when the two moments coincide, 50 when they are 12 hours apart, about 14 at 3 days.
pub fn time_score(apart: Duration) -> f64 {
    let hours = apart.num_seconds().unsigned_abs() as f64 / 3600.0;
    100.0 / (1.0 + hours / 12.0)
}

/// Loot is sold over days: 100 on the spot, 50 a week later.
pub fn sale_time_score(apart: Duration) -> f64 {
    let days = apart.num_seconds().unsigned_abs() as f64 / 86_400.0;
    100.0 / (1.0 + days / 7.0)
}

fn ratio(numerator: Decimal, denominator: Decimal) -> f64 {
    (numerator / denominator).to_string().parse().unwrap_or(f64::MAX)
}

/// 100 for the same silver (Albion amounts are whole silver, Manager amounts carry cents, so one
/// silver of rounding per Manager row is allowed), falling to 0 at `tolerance` relative
/// difference, `None` beyond it. Anything but the same silver stays below 90.
pub fn amount_score(actual: Decimal, expected: Decimal, rows: usize, tolerance: f64) -> Option<f64> {
    if expected <= Decimal::ZERO || actual <= Decimal::ZERO {
        return None;
    }
    let difference = (actual - expected).abs();
    if difference <= Decimal::from(rows.max(1) as u64) {
        return Some(100.0);
    }
    let relative = ratio(difference, expected);
    (relative <= tolerance).then(|| 90.0 * (1.0 - relative / tolerance))
}

/// Weighted mix of an amount score and a time score, less a small penalty per extra record.
pub fn combine(amount: f64, time: f64, amount_weight: f64, extra_records: usize) -> u8 {
    let mixed = amount * amount_weight + time * (1.0 - amount_weight) - 3.0 * extra_records as f64;
    mixed.round().clamp(0.0, 100.0) as u8
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

/// Proposes links for `rows` against the Manager's paid-out rows and splits, best first, at most
/// [`MAX_PROPOSALS_PER_ROW`] per row.
pub fn propose(rows: &[Row], paid: &[Paid], splits: &[SplitCandidate]) -> Vec<Proposal> {
    let mut all = Vec::new();
    propose_payouts(rows, paid, &mut all);
    propose_bags(rows, splits, &mut all);
    propose_loot_sales(rows, splits, &mut all);
    keep_best(all)
}

/// Sorts by score, drops duplicates and weak proposals, and caps the proposals per row.
fn keep_best(mut all: Vec<Proposal>) -> Vec<Proposal> {
    all.sort_by(|a, b| {
        b.score
            .cmp(&a.score)
            .then(a.entry_ids.len().cmp(&b.entry_ids.len()))
            .then(a.entry_ids.cmp(&b.entry_ids))
            .then(a.transaction_ids.cmp(&b.transaction_ids))
            .then(a.split_ids.cmp(&b.split_ids))
    });
    let mut seen = HashSet::new();
    let mut per_row: HashMap<i64, usize> = HashMap::new();
    let mut out = Vec::new();
    for proposal in all {
        if proposal.score < MIN_SCORE {
            continue;
        }
        let key = (
            proposal.kind,
            proposal.entry_ids.clone(),
            proposal.transaction_ids.clone(),
            proposal.split_ids.clone(),
        );
        if seen.contains(&key) {
            continue;
        }
        if proposal
            .entry_ids
            .iter()
            .any(|id| per_row.get(id).copied().unwrap_or(0) >= MAX_PROPOSALS_PER_ROW)
        {
            continue;
        }
        for id in &proposal.entry_ids {
            *per_row.entry(*id).or_default() += 1;
        }
        seen.insert(key);
        out.push(proposal);
    }
    out
}

/// Rows of one member that the Manager handled as one payment: accepted together (at most
/// 2 minutes apart) or requested together.
pub fn payment_batches<'a>(rows: &[&'a Paid]) -> Vec<Vec<&'a Paid>> {
    let mut by_time: Vec<&Paid> = rows.to_vec();
    by_time.sort_by_key(|row| (row.paid_at, row.transaction_id));
    let mut out: Vec<Vec<&Paid>> = Vec::new();
    let mut current: Vec<&Paid> = Vec::new();
    for row in by_time {
        if current
            .last()
            .is_some_and(|last| row.paid_at - last.paid_at > Duration::minutes(2))
        {
            out.push(std::mem::take(&mut current));
        }
        current.push(row);
    }
    if !current.is_empty() {
        out.push(current);
    }
    let mut by_request: BTreeMap<i64, Vec<&Paid>> = BTreeMap::new();
    for row in rows {
        if let Some(at) = row.requested_at {
            by_request.entry(at.timestamp()).or_default().push(row);
        }
    }
    out.extend(by_request.into_values());
    out
}

fn propose_payouts(rows: &[Row], paid: &[Paid], out: &mut Vec<Proposal>) {
    let mut by_user: BTreeMap<i64, Vec<&Paid>> = BTreeMap::new();
    for row in paid {
        by_user.entry(row.user_id).or_default().push(row);
    }
    for row in rows
        .iter()
        .filter(|row| row.category == CATEGORY_PAYOUT && row.amount < Decimal::ZERO)
    {
        let target = -row.amount;
        let mut seen: HashSet<Vec<i64>> = HashSet::new();
        for member_rows in by_user.values() {
            let mut near: Vec<&Paid> = member_rows
                .iter()
                .copied()
                .filter(|paid| in_payout_window(row.at, paid.paid_at))
                .collect();
            if near.is_empty() {
                continue;
            }
            near.sort_by_key(|paid| ((paid.paid_at - row.at).num_seconds().abs(), paid.transaction_id));
            let mut groups = payment_batches(&near);
            let top = &near[..near.len().min(MAX_CANDIDATES)];
            for size in 1..=MAX_GROUP.min(top.len()) {
                for combo in combinations(top.len(), size) {
                    groups.push(combo.iter().map(|&i| top[i]).collect());
                }
            }
            for group in groups {
                let mut ids: Vec<i64> = group.iter().map(|paid| paid.transaction_id).collect();
                ids.sort_unstable();
                if !seen.insert(ids.clone()) {
                    continue;
                }
                let sum: Decimal = group.iter().map(|paid| paid.amount).sum();
                let Some(amount) = amount_score(target, sum, group.len(), 0.01) else {
                    continue;
                };
                let apart = group
                    .iter()
                    .map(|paid| (paid.paid_at - row.at).abs())
                    .min()
                    .unwrap_or_else(Duration::zero);
                out.push(Proposal {
                    kind: KIND_PAYOUT,
                    entry_ids: vec![row.id],
                    transaction_ids: ids,
                    split_ids: Vec::new(),
                    score: combine(amount, time_score(apart), 0.6, group.len() - 1),
                });
            }
        }
    }
}

fn propose_bags(rows: &[Row], splits: &[SplitCandidate], out: &mut Vec<Proposal>) {
    let mut deposits: Vec<&Row> = rows
        .iter()
        .filter(|row| row.category == CATEGORY_BAGS && row.amount > Decimal::ZERO)
        .collect();
    deposits.sort_by_key(|row| (row.at, row.id));
    let window = Duration::days(BAGS_DAYS);
    let mut exact_rows: HashSet<i64> = HashSet::new();

    for split in splits.iter().filter(|split| split.bags_value > Decimal::ZERO) {
        let near: Vec<&Row> = deposits
            .iter()
            .copied()
            .filter(|row| split.apart(row.at) <= window)
            .collect();
        let mut push = |members: &[&Row], amount: f64| {
            let apart = members
                .iter()
                .map(|row| split.apart(row.at))
                .min()
                .unwrap_or_else(Duration::zero);
            out.push(Proposal {
                kind: KIND_BAGS,
                entry_ids: members.iter().map(|row| row.id).collect(),
                transaction_ids: Vec::new(),
                split_ids: vec![split.id],
                score: combine(amount, time_score(apart), 0.5, members.len() - 1),
            });
        };
        for cluster in clusters(&near, Duration::minutes(60)) {
            let members: Vec<&Row> = cluster.iter().map(|&i| near[i]).collect();
            let bounded = &members[..members.len().min(MAX_CANDIDATES)];
            for size in 1..=MAX_GROUP.min(bounded.len()) {
                for combo in combinations(bounded.len(), size) {
                    let group: Vec<&Row> = combo.iter().map(|&i| bounded[i]).collect();
                    let sum: Decimal = group.iter().map(|row| row.amount).sum();
                    if let Some(amount) = amount_score(sum, split.bags_value, 1, 0.0) {
                        exact_rows.extend(group.iter().map(|row| row.id));
                        push(&group, amount);
                    }
                }
            }
            // A burst of more deposits than a combination holds, paying the bags together.
            if members.len() > MAX_GROUP {
                let sum: Decimal = members.iter().map(|row| row.amount).sum();
                if let Some(amount) = amount_score(sum, split.bags_value, 1, 0.0) {
                    exact_rows.extend(members.iter().map(|row| row.id));
                    push(&members, amount);
                }
            }
        }
    }

    // A deposit with no exact fit: part of some split's bags, most likely the nearest one.
    for row in deposits.iter().filter(|row| !exact_rows.contains(&row.id)) {
        for split in splits.iter().filter(|split| {
            split.bags_value > row.amount && split.apart(row.at) <= window
        }) {
            out.push(Proposal {
                kind: KIND_BAGS,
                entry_ids: vec![row.id],
                transaction_ids: Vec::new(),
                split_ids: vec![split.id],
                score: (time_score(split.apart(row.at)) * PARTIAL_BAGS_MAX / 100.0).round() as u8,
            });
        }
    }
}

fn propose_loot_sales(rows: &[Row], splits: &[SplitCandidate], out: &mut Vec<Proposal>) {
    let sales: Vec<&Row> = rows
        .iter()
        .filter(|row| row.category == CATEGORY_LOOT_SALE && row.amount > Decimal::ZERO)
        .collect();
    let in_window = |row: &Row, split: &SplitCandidate| {
        row.at >= split.created_at - Duration::days(1)
            && row.at <= split.created_at + Duration::days(LOOT_SALE_DAYS)
    };
    let score = |amount: f64, rows: &[&Row], splits: &[&SplitCandidate]| {
        let apart = rows
            .iter()
            .flat_map(|row| splits.iter().map(move |split| split.apart(row.at)))
            .min()
            .unwrap_or_else(Duration::zero);
        combine(amount, sale_time_score(apart), 0.6, rows.len() + splits.len() - 2)
    };
    for row in &sales {
        // Nearest splits around the sale.
        let mut open: Vec<&SplitCandidate> = splits
            .iter()
            .filter(|split| split.expected_sale > Decimal::ZERO && in_window(row, split))
            .collect();
        open.sort_by_key(|split| (split.apart(row.at), split.id));
        open.truncate(MAX_CANDIDATES);
        for size in 1..=MAX_GROUP.min(open.len()) {
            for combo in combinations(open.len(), size) {
                let group: Vec<&SplitCandidate> = combo.iter().map(|&i| open[i]).collect();
                let expected: Decimal = group.iter().map(|split| split.expected_sale).sum();
                if let Some(amount) = amount_score(row.amount, expected, 1, 0.05) {
                    let mut split_ids: Vec<i64> = group.iter().map(|split| split.id).collect();
                    split_ids.sort_unstable();
                    out.push(Proposal {
                        kind: KIND_LOOT_SALE,
                        entry_ids: vec![row.id],
                        transaction_ids: Vec::new(),
                        split_ids,
                        score: score(amount, &[row], &group),
                    });
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
        for size in 2..=MAX_GROUP.min(window.len()) {
            for combo in combinations(window.len(), size) {
                let group: Vec<&Row> = combo.iter().map(|&i| window[i]).collect();
                let sum: Decimal = group.iter().map(|row| row.amount).sum();
                if let Some(amount) = amount_score(sum, split.expected_sale, 1, 0.05) {
                    out.push(Proposal {
                        kind: KIND_LOOT_SALE,
                        entry_ids: group.iter().map(|row| row.id).collect(),
                        transaction_ids: Vec::new(),
                        split_ids: vec![split.id],
                        score: score(amount, &group, &[split]),
                    });
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

    fn paid(transaction_id: i64, user_id: i64, amount: &str, when: &str) -> Paid {
        Paid {
            transaction_id,
            user_id,
            amount: amount.parse().unwrap(),
            paid_at: at(when),
            requested_at: None,
        }
    }

    fn split(id: i64, created: &str, bags: i64, sale: i64) -> SplitCandidate {
        SplitCandidate {
            id,
            created_at: at(created),
            finalized_at: None,
            bags_value: Decimal::from(bags),
            expected_sale: Decimal::from(sale),
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
        let payouts = vec![
            paid(10, 5, "4000000.40", "2026-11-16T23:08:00Z"),
            paid(11, 5, "3414881.00", "2026-11-16T23:08:00Z"),
        ];
        let proposals = propose(&rows, &payouts, &[]);
        assert_eq!(proposals.len(), 1);
        assert_eq!(proposals[0].transaction_ids, vec![10, 11]);
        assert!(proposals[0].score >= 90, "score {}", proposals[0].score);
    }

    #[test]
    fn rows_accepted_one_by_one_still_add_up_to_the_withdrawal() {
        // The officer accepted the two requests a few minutes apart and withdrew once.
        let rows = vec![row(1, "2026-11-12T20:08:00Z", -50_751_000, CATEGORY_PAYOUT)];
        let payouts = vec![
            paid(1, 7, "30000000", "2026-11-12T20:01:00Z"),
            paid(2, 7, "20751000", "2026-11-12T20:06:30Z"),
            paid(3, 8, "50751000", "2026-11-06T10:00:00Z"),
        ];
        let proposals = propose(&rows, &payouts, &[]);
        assert_eq!(proposals[0].transaction_ids, vec![1, 2]);
        // The lone payout of the same amount a week earlier ranks below.
        assert_eq!(proposals[1].transaction_ids, vec![3]);
        assert!(proposals[0].score > proposals[1].score);
    }

    #[test]
    fn the_nearest_payout_ranks_first() {
        let rows = vec![row(1, "2026-11-14T18:43:00Z", -9_278_388, CATEGORY_PAYOUT)];
        let payouts = vec![
            paid(1, 1, "9278388", "2026-11-12T18:00:00Z"),
            paid(2, 2, "9278388", "2026-11-14T18:40:00Z"),
        ];
        let proposals = propose(&rows, &payouts, &[]);
        assert_eq!(proposals.len(), 2);
        assert_eq!(proposals[0].transaction_ids, vec![2]);
    }

    #[test]
    fn a_payout_outside_the_window_is_not_proposed() {
        let rows = vec![row(1, "2026-11-20T00:00:00Z", -1_000, CATEGORY_PAYOUT)];
        let payouts = vec![paid(10, 1, "1000", "2026-11-10T00:00:00Z")];
        assert!(propose(&rows, &payouts, &[]).is_empty());
    }

    #[test]
    fn a_different_amount_is_not_a_payout() {
        let rows = vec![row(1, "2026-11-20T00:00:00Z", -1_000_000, CATEGORY_PAYOUT)];
        let payouts = vec![paid(10, 1, "900000", "2026-11-20T00:00:00Z")];
        assert!(propose(&rows, &payouts, &[]).is_empty());
    }

    #[test]
    fn two_identical_withdrawals_both_point_at_the_single_payout() {
        // Only one can be confirmed; the other stays open and shows a possible double payment.
        let rows = vec![
            row(1, "2026-11-14T18:42:00Z", -1_036_150, CATEGORY_PAYOUT),
            row(2, "2026-11-14T18:42:00Z", -1_036_150, CATEGORY_PAYOUT),
        ];
        let payouts = vec![paid(7, 1, "1036150", "2026-11-14T18:40:00Z")];
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
        let splits = vec![split(42, "2026-11-13T10:00:00Z", 1_484_000, 0)];
        let proposals = propose(&rows, &[], &splits);
        assert_eq!(proposals[0].entry_ids, vec![1, 2, 3]);
        assert_eq!(proposals[0].split_ids, vec![42]);
        assert!(proposals[0].score >= 80, "score {}", proposals[0].score);
    }

    #[test]
    fn bags_deposited_before_the_split_was_created_are_matched() {
        let rows = vec![row(1, "2026-11-09T23:12:00Z", 3_440_000, CATEGORY_BAGS)];
        let splits = vec![split(9, "2026-11-10T00:30:00Z", 3_440_000, 0)];
        let proposals = propose(&rows, &[], &splits);
        assert_eq!(proposals.len(), 1);
        assert_eq!(proposals[0].split_ids, vec![9]);
    }

    #[test]
    fn a_partial_bag_deposit_points_at_the_nearest_split_with_a_low_score() {
        let rows = vec![row(1, "2026-11-08T22:06:00Z", 360_000, CATEGORY_BAGS)];
        let splits = vec![
            split(1, "2026-11-08T21:30:00Z", 1_080_000, 0),
            split(2, "2026-11-06T21:30:00Z", 1_080_000, 0),
        ];
        let proposals = propose(&rows, &[], &splits);
        assert_eq!(proposals[0].split_ids, vec![1]);
        assert!(proposals[0].score <= PARTIAL_BAGS_MAX as u8);
        assert!(proposals.iter().all(|p| p.score <= PARTIAL_BAGS_MAX as u8));
    }

    #[test]
    fn bags_far_from_any_split_are_not_proposed() {
        let rows = vec![row(1, "2026-11-01T10:00:00Z", 500, CATEGORY_BAGS)];
        let splits = vec![split(1, "2026-11-10T10:00:00Z", 500, 0)];
        assert!(propose(&rows, &[], &splits).is_empty());
    }

    #[test]
    fn a_seller_deposit_matches_the_expected_sale_within_five_percent() {
        let rows = vec![row(1, "2026-11-06T19:54:00Z", 100_000_000, CATEGORY_LOOT_SALE)];
        let splits = vec![
            // 104M loot × 0.94
            split(1, "2026-11-01T10:00:00Z", 0, 97_760_000),
            split(2, "2026-11-01T10:00:00Z", 0, 50_000_000),
        ];
        let proposals = propose(&rows, &[], &splits);
        assert_eq!(proposals.len(), 1);
        assert_eq!(proposals[0].split_ids, vec![1]);
    }

    #[test]
    fn one_seller_deposit_can_cover_several_splits() {
        let rows = vec![row(1, "2026-11-06T19:54:00Z", 100_000_000, CATEGORY_LOOT_SALE)];
        let splits = vec![
            split(1, "2026-11-01T10:00:00Z", 0, 60_000_000),
            split(2, "2026-11-02T10:00:00Z", 0, 39_000_000),
        ];
        let proposals = propose(&rows, &[], &splits);
        assert_eq!(proposals.len(), 1);
        assert_eq!(proposals[0].split_ids, vec![1, 2]);
    }

    #[test]
    fn expenses_are_never_proposed() {
        let rows = vec![row(1, "2026-11-02T13:06:00Z", -1_875_000, CATEGORY_GUILD_EXPENSE)];
        let payouts = vec![paid(1, 1, "1875000", "2026-11-02T13:00:00Z")];
        assert!(propose(&rows, &payouts, &[]).is_empty());
    }

    #[test]
    fn at_most_three_proposals_per_row() {
        let rows = vec![row(1, "2026-11-14T18:43:00Z", -1_000, CATEGORY_PAYOUT)];
        let payouts: Vec<Paid> = (1..=6)
            .map(|id| paid(id, id, "1000", "2026-11-14T18:40:00Z"))
            .collect();
        assert_eq!(propose(&rows, &payouts, &[]).len(), MAX_PROPOSALS_PER_ROW);
    }

    #[test]
    fn scores_fall_with_time_and_amount_distance() {
        assert!(time_score(Duration::minutes(3)) > 99.0);
        assert!((time_score(Duration::hours(12)) - 50.0).abs() < 0.01);
        assert_eq!(amount_score(Decimal::from(100), Decimal::from(100), 1, 0.05), Some(100.0));
        assert!(amount_score(Decimal::from(103), Decimal::from(100), 1, 0.05).unwrap() < 90.0);
        assert_eq!(amount_score(Decimal::from(110), Decimal::from(100), 1, 0.05), None);
    }
}
