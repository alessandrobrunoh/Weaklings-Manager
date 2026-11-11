//! Named crash points for the engine's failure tests.
//!
//! [`check`] is a no-op in production. Under `cfg(test)` a point armed with
//! [`arm`] fires once and returns an error, which makes the surrounding
//! operation stop at exactly that step (as if the process had died there). Each
//! test uses its own point names because the armed set is process-wide.

use backend_core::errors::AppError;

/// Returns an error when the point called `name` is armed (once).
///
/// # Errors
///
/// Only under `cfg(test)`, when `name` was armed.
pub fn check(name: &'static str) -> Result<(), AppError> {
    #[cfg(test)]
    {
        if armed::take(name) {
            return Err(AppError::Internal(format!("failpoint {name} fired")));
        }
    }
    #[cfg(not(test))]
    let _ = name;
    Ok(())
}

#[cfg(test)]
pub mod armed {
    use std::sync::Mutex;

    static ARMED: Mutex<Vec<&'static str>> = Mutex::new(Vec::new());

    /// Arms `name` so the next [`super::check`] of it fails.
    pub fn arm(name: &'static str) {
        ARMED.lock().unwrap_or_else(|e| e.into_inner()).push(name);
    }

    /// Removes `name` from the armed set; true when it was armed.
    pub fn take(name: &'static str) -> bool {
        let mut armed = ARMED.lock().unwrap_or_else(|e| e.into_inner());
        match armed.iter().position(|armed| *armed == name) {
            Some(index) => {
                armed.swap_remove(index);
                true
            }
            None => false,
        }
    }
}
