//! Albion guild bank log: weekly import of the in-game silver log, reconciliation with the
//! Manager's own records, and the daily import reminder.
//!
//! The Manager is the source of truth. The game log is a second check: it never changes a
//! balance or creates income; an officer may create one transaction from a row.

pub mod matcher;
pub mod models;
pub mod reminder;
pub mod router;
pub mod service;

pub use service::BankLogService;
