//! Extractor for control-plane operators.

use axum::extract::FromRequestParts;
use axum::http::request::Parts;
use axum_extra::extract::cookie::Key;

use crate::auth::SessionStore;
use crate::auth::session_store::require_session;
use backend_core::errors::AppError;
use backend_core::platform_admins::PlatformAdmins;

/// Authenticated Discord user who holds a platform role.
#[derive(Debug, Clone)]
pub struct PlatformAdmin {
    /// Discord snowflake.
    pub discord_id: String,
    /// Display name from the session cookie.
    pub username: String,
}

impl<S> FromRequestParts<S> for PlatformAdmin
where
    S: Send + Sync,
{
    type Rejection = AppError;

    async fn from_request_parts(parts: &mut Parts, _state: &S) -> Result<Self, Self::Rejection> {
        let key = parts
            .extensions
            .get::<Key>()
            .cloned()
            .ok_or_else(|| AppError::Internal("session key missing".to_owned()))?;
        let store = parts
            .extensions
            .get::<SessionStore>()
            .cloned()
            .ok_or_else(|| AppError::Internal("session store missing".to_owned()))?;
        let profile = require_session(&parts.headers, &key, &store).await?.profile;
        let admins = parts
            .extensions
            .get::<PlatformAdmins>()
            .ok_or_else(|| AppError::Internal("platform admin cache missing".to_owned()))?;
        if !admins.contains(&profile.id) {
            return Err(AppError::Forbidden(
                "a platform role is required".to_owned(),
            ));
        }
        Ok(Self {
            discord_id: profile.id,
            username: profile.username,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::Request;

    /// A request carrying a live session for `profile`, with key and store attached.
    async fn session_request(profile: &serde_json::Value, admins: PlatformAdmins) -> Parts {
        let key = Key::generate();
        let store = crate::auth::session_store::test_store().await;
        let sid = store
            .create(profile["id"].as_str().unwrap())
            .await
            .expect("session");
        let cookie = crate::auth::session_store::test_cookie_header(&key, &sid, profile);
        let req = Request::builder()
            .header("Cookie", cookie)
            .body(())
            .unwrap();
        let (mut parts, ()) = req.into_parts();
        parts.extensions.insert(key);
        parts.extensions.insert(store);
        parts.extensions.insert(admins);
        parts
    }

    #[tokio::test]
    async fn rejects_missing_session() {
        let req = Request::builder().body(()).unwrap();
        let (mut parts, ()) = req.into_parts();
        parts.extensions.insert(Key::generate());
        parts
            .extensions
            .insert(crate::auth::session_store::test_store().await);
        parts.extensions.insert(PlatformAdmins::new_empty());
        let err = PlatformAdmin::from_request_parts(&mut parts, &())
            .await
            .expect_err("no cookie");
        assert!(matches!(err, AppError::Unauthorized(_)));
    }

    fn ada() -> serde_json::Value {
        serde_json::json!({
            "id": "111", "username": "ada", "email": null, "avatar": null,
            "roles": [], "highest_role": "User", "user_id": 1,
        })
    }

    #[tokio::test]
    async fn rejects_user_without_platform_role() {
        let mut parts = session_request(&ada(), PlatformAdmins::new_empty()).await;
        let err = PlatformAdmin::from_request_parts(&mut parts, &())
            .await
            .expect_err("not a platform admin");
        assert!(matches!(err, AppError::Forbidden(_)));
    }

    #[tokio::test]
    async fn accepts_listed_platform_admin() {
        let admins = PlatformAdmins::new_empty();
        admins.insert_for_test("111");
        let mut parts = session_request(&ada(), admins).await;
        let admin = PlatformAdmin::from_request_parts(&mut parts, &())
            .await
            .expect("extract");
        assert_eq!(admin.discord_id, "111");
        assert_eq!(admin.username, "ada");
    }

    #[tokio::test]
    async fn revoked_session_loses_platform_access() {
        let admins = PlatformAdmins::new_empty();
        admins.insert_for_test("111");
        let mut parts = session_request(&ada(), admins).await;
        parts
            .extensions
            .get::<SessionStore>()
            .cloned()
            .unwrap()
            .revoke_all("111")
            .await
            .expect("revoke");
        let err = PlatformAdmin::from_request_parts(&mut parts, &())
            .await
            .expect_err("revoked");
        assert!(matches!(err, AppError::Unauthorized(_)));
    }
}
