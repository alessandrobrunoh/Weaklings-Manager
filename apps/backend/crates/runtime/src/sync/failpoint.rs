//! Named crash points for the engine's failure tests.
//!
//! [`check`] is a no-op in production. Under `cfg(test)` a point armed with
//! [`arm`] fires once and returns an error, which makes the surrounding
//! operation stop at exactly that step (as if the process had died there). The
//! armed set is per thread: each `#[tokio::test]` runs on its own thread with a
//! current-thread runtime, so a test running in parallel can never consume a
//! point another test armed.

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
    use std::cell::RefCell;

    thread_local! {
        static ARMED: RefCell<Vec<&'static str>> = const { RefCell::new(Vec::new()) };
    }

    /// Arms `name` so the next [`super::check`] of it on this thread fails.
    pub fn arm(name: &'static str) {
        ARMED.with_borrow_mut(|armed| armed.push(name));
    }

    /// Removes `name` from this thread's armed set; true when it was armed.
    pub fn take(name: &'static str) -> bool {
        ARMED.with_borrow_mut(
            |armed| match armed.iter().position(|armed| *armed == name) {
                Some(index) => {
                    armed.swap_remove(index);
                    true
                }
                None => false,
            },
        )
    }
}
