//! The Guild Bank transaction lifecycle status.

use std::fmt;
use std::str::FromStr;

use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

/// The lifecycle status of a Guild Bank transaction.
///
/// Stored in the database as its lowercase string form (see [`FromStr`]/[`fmt::Display`]), since
/// the `transactions.status` column is a plain string rather than a native DB enum.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "lowercase")]
pub enum TransactionStatus {
    /// Owed to the recipient, not yet requested for withdrawal.
    Pending,
    /// The recipient has requested withdrawal; awaiting an officer to accept and pay it.
    Requested,
    /// An officer rejected the withdrawal request; the recipient must request it again.
    Rejected,
    /// An officer accepted the withdrawal request and paid it out.
    Withdrawn,
    /// The recipient donated the outstanding split share back to the Guild Bank.
    Donated,
}

impl TransactionStatus {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Requested => "requested",
            Self::Rejected => "rejected",
            Self::Withdrawn => "withdrawn",
            Self::Donated => "donated",
        }
    }
}

impl fmt::Display for TransactionStatus {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

impl FromStr for TransactionStatus {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "pending" => Ok(Self::Pending),
            "requested" => Ok(Self::Requested),
            "rejected" => Ok(Self::Rejected),
            "withdrawn" => Ok(Self::Withdrawn),
            "donated" => Ok(Self::Donated),
            other => Err(format!("unknown transaction status: {other}")),
        }
    }
}
