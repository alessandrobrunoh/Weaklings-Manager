//! Splits module.
//!
//! Provides the routes, services, and schemas for creating and finalizing loot splits.

pub mod alliance_distribution;
pub mod city;
#[cfg(test)]
mod copy_matrix_tests;
pub mod discord_sync;
pub mod entities;
pub mod models;
pub mod router;
pub mod schemas;
pub mod service;
pub mod status;

pub use router::router;
