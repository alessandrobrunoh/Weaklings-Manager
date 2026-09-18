//! Trial tracking: members accepted with a time-boxed Trial role on top of the standard role.
//!
//! The list and the manager actions (promote / end / extend) land in later slices; today the
//! module only records trials created through the applications accept flow.

pub mod entities;
pub mod service;
