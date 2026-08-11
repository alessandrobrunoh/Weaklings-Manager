//! The origin of a `siphoned_energy_entries` row.
//!
//! Stored in the database as its lowercase snake-case string form (see [`FromStr`] /
//! [`fmt::Display`]), since the `source` column is a plain string rather than a native DB enum.
//! Only [`Self::AlbionExport`] is used in v1; `Manual` is reserved for a future officer-corrected
//! entry flow.

use std::fmt;
use std::str::FromStr;

use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

/// Where a siphoned energy ledger row came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum SiphonedEntrySource {
    /// Row imported verbatim from the Albion Online in-game export via `POST /api/siphoned/ingest`.
    AlbionExport,
    /// Row recorded manually by an officer (out-of-game correction). Reserved for future use.
    Manual,
}

impl SiphonedEntrySource {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::AlbionExport => "albion_export",
            Self::Manual => "manual",
        }
    }
}

impl fmt::Display for SiphonedEntrySource {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

impl FromStr for SiphonedEntrySource {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "albion_export" => Ok(Self::AlbionExport),
            "manual" => Ok(Self::Manual),
            other => Err(format!("unknown siphoned entry source: {other}")),
        }
    }
}
