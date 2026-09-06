//! One-shot: move `public` tenant tables into `tenant_<DISCORD_GUILD_ID>`.
//!
//! Destructive against schema `public`. Run against a snapshot or staging
//! database first; take a `pg_dump` immediately before production.

use backend::backfill::{self, BackfillOutcome, BackfillParams};
use backend::config::Config;
use sea_orm::Database;
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    dotenvy::dotenv().ok();
    tracing_subscriber::registry()
        .with(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "backend=info".into()),
        )
        .with(tracing_subscriber::fmt::layer())
        .init();

    let cfg = Config::from_env();
    tracing::info!("connecting to database");
    let admin = Database::connect(&cfg.database_url).await?;
    backfill::prepare_control_plane(&admin, cfg.control_plane_url()).await?;

    let params = BackfillParams::from_config(&cfg);
    tracing::info!(
        tenant_id = %params.tenant_id,
        source = %params.source_schema,
        "starting tenant #1 backfill"
    );
    match backfill::backfill_tenant_one(&admin, &params).await? {
        BackfillOutcome::Moved(report) => {
            tracing::info!(
                schema = %report.schema_name,
                tables = report.counts.len(),
                "backfill moved tables"
            );
            for (table, count) in report.counts {
                tracing::info!(%table, count, "moved");
            }
        }
        BackfillOutcome::AlreadyDone {
            tenant_id,
            schema_name,
        } => {
            tracing::info!(
                tenant_id,
                schema = schema_name,
                "already backfilled; nothing to do"
            );
        }
    }
    Ok(())
}
