//! The app's set of background loops.
//!
//! This is the one place that names every feature's [`LoopTask`]s; `run_server`
//! hands the result to [`crate::runtime::spawn_all`].

use std::sync::Arc;

use crate::runtime::RuntimeDeps;
use crate::runtime::supervisor::SupervisorSettings;
use crate::runtime::tasks::LoopTask;

/// The production set: every loop in [`registered_tasks`].
#[must_use]
pub fn production_deps() -> RuntimeDeps {
    RuntimeDeps {
        settings: SupervisorSettings::default(),
        tasks: registered_tasks(),
    }
}

/// Every loop the server runs. Owner slices append their loop here.
#[must_use]
pub fn registered_tasks() -> Vec<Arc<dyn LoopTask>> {
    let mut tasks = crate::modules::events::loop_tasks::registered_tasks();
    tasks.extend(crate::modules::sync::engine::registered_tasks());
    tasks
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::*;

    #[test]
    fn registered_tasks_have_unique_names_and_wake_targets() {
        let tasks = registered_tasks();
        let mut names: Vec<_> = tasks.iter().map(|t| t.name()).collect();
        names.sort_unstable();
        names.dedup();
        assert_eq!(names.len(), tasks.len());
        let mut targets: Vec<_> = tasks.iter().filter_map(|t| t.wake_target()).collect();
        let before = targets.len();
        targets.dedup();
        assert_eq!(before, targets.len());
        // Both legacy loops keep their 15 s cadence; the sync loops have their own.
        assert!(
            tasks
                .iter()
                .filter(|t| !t.name().starts_with("sync_"))
                .all(|t| t.tick() == Duration::from_secs(15))
        );
    }
}
