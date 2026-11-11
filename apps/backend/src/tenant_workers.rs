//! The per-tenant background workers the app starts for each guild tenant.

use std::sync::Arc;
use std::sync::atomic::AtomicBool;

use sea_orm::DatabaseConnection;

use backend_albion_data::albionbb::service::AlbionBbService;
use backend_albion_data::albiondata::service::AlbionDataService;
use backend_identity::tenant::TenantWorkerSpawner;

/// Starts `event_sessions` and `battle_sync` for a tenant, holding what starting
/// them takes. `run_server` hands one to [`backend_identity::tenant::TenantRegistry::set_workers`].
#[derive(Clone)]
pub struct TenantWorkers {
    /// AlbionBB client both workers use.
    pub albionbb_service: AlbionBbService,
    /// Albion Data client both workers use.
    pub albiondata_service: AlbionDataService,
}

impl TenantWorkerSpawner for TenantWorkers {
    fn spawn_for(
        &self,
        db: DatabaseConnection,
        tenant_id: &str,
        control: DatabaseConnection,
        stop: Arc<AtomicBool>,
    ) {
        crate::event_sessions::spawn(
            db.clone(),
            self.albionbb_service.clone(),
            self.albiondata_service.clone(),
            tenant_id.to_owned(),
            control.clone(),
            stop.clone(),
        );
        crate::battle_sync::spawn(
            db,
            self.albionbb_service.clone(),
            self.albiondata_service.clone(),
            tenant_id.to_owned(),
            control,
            stop,
        );
    }
}
