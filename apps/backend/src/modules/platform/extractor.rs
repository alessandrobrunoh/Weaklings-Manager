//! Extractor for control-plane operators.

use axum::extract::FromRequestParts;
use axum::http::request::Parts;
use axum_extra::extract::cookie::{Key, PrivateCookieJar};

use crate::errors::AppError;
use crate::modules::auth::service::DiscordUserProfile;
use crate::platform_admins::PlatformAdmins;

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
        let jar = PrivateCookieJar::from_headers(&parts.headers, key);
        let cookie = jar
            .get("session_user")
            .ok_or_else(|| AppError::Unauthorized("No active session".to_owned()))?;
        let profile: DiscordUserProfile = serde_json::from_str(cookie.value())
            .map_err(|_| AppError::Unauthorized("Invalid session cookie format".to_owned()))?;
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
    use axum::response::IntoResponse;
    use axum_extra::extract::cookie::PrivateCookieJar;

    fn encrypt_session(key: &Key, json: &str) -> String {
        let response = PrivateCookieJar::new(key.clone())
            .add(("session_user", json.to_owned()))
            .into_response();
        response
            .headers()
            .get(axum::http::header::SET_COOKIE)
            .unwrap()
            .to_str()
            .unwrap()
            .split(';')
            .next()
            .unwrap()
            .to_string()
    }

    #[tokio::test]
    async fn rejects_missing_session() {
        let req = Request::builder().body(()).unwrap();
        let (mut parts, _) = req.into_parts();
        parts.extensions.insert(Key::generate());
        parts.extensions.insert(PlatformAdmins::new_empty());
        let err = PlatformAdmin::from_request_parts(&mut parts, &())
            .await
            .expect_err("no cookie");
        assert!(matches!(err, AppError::Unauthorized(_)));
    }

    #[tokio::test]
    async fn rejects_user_without_platform_role() {
        let key = Key::generate();
        let cookie = encrypt_session(
            &key,
            r#"{"id":"111","username":"bob","email":null,"avatar":null,"roles":[],"highest_role":"User","user_id":1}"#,
        );
        let req = Request::builder()
            .header("Cookie", cookie)
            .body(())
            .unwrap();
        let (mut parts, _) = req.into_parts();
        parts.extensions.insert(key);
        parts.extensions.insert(PlatformAdmins::new_empty());
        let err = PlatformAdmin::from_request_parts(&mut parts, &())
            .await
            .expect_err("not a platform admin");
        assert!(matches!(err, AppError::Forbidden(_)));
    }

    #[tokio::test]
    async fn accepts_listed_platform_admin() {
        let key = Key::generate();
        let cookie = encrypt_session(
            &key,
            r#"{"id":"111","username":"ada","email":null,"avatar":null,"roles":[],"highest_role":"User","user_id":1}"#,
        );
        let admins = PlatformAdmins::new_empty();
        admins.insert_for_test("111");
        let req = Request::builder()
            .header("Cookie", cookie)
            .body(())
            .unwrap();
        let (mut parts, _) = req.into_parts();
        parts.extensions.insert(key);
        parts.extensions.insert(admins);
        let admin = PlatformAdmin::from_request_parts(&mut parts, &())
            .await
            .expect("extract");
        assert_eq!(admin.discord_id, "111");
        assert_eq!(admin.username, "ada");
    }
}
