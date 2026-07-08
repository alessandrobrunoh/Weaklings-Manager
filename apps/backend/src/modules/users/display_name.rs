//! Resolves a user's display name across the app.
//!
//! Wherever a user's name is shown (split participants, bank transactions, comp/build/event
//! creators, event participants, the caller's own profile, ...), it should be their linked
//! Albion Online character name (`albion_links.albion_player_name`, joined via `discord_id`) if
//! they have one linked, falling back to their Discord username otherwise.

use std::collections::HashMap;

use sea_orm::{ColumnTrait, DatabaseConnection, EntityTrait, QueryFilter};

use crate::errors::AppError;
use crate::modules::albion::entities::albion_link::{Column as AlbionLinkColumn, Entity as AlbionLinkEntity};
use super::entities::{Column as UserColumn, Entity as UserEntity, Model as UserModel};

/// Fetches `albion_player_name` for every given `discord_id`, keyed by `discord_id`.
async fn albion_names_by_discord_id(
    db: &DatabaseConnection,
    discord_ids: Vec<String>,
) -> Result<HashMap<String, String>, AppError> {
    if discord_ids.is_empty() {
        return Ok(HashMap::new());
    }

    let links = AlbionLinkEntity::find()
        .filter(AlbionLinkColumn::DiscordId.is_in(discord_ids))
        .all(db)
        .await?;

    Ok(links.into_iter().map(|l| (l.discord_id, l.albion_player_name)).collect())
}

/// Resolves a single user's display name: their linked Albion Online character name if they
/// have one, otherwise their Discord username.
///
/// # Errors
///
/// Returns `AppError::Database` if the `albion_links` lookup fails.
pub async fn resolve(db: &DatabaseConnection, user: &UserModel) -> Result<String, AppError> {
    let Some(discord_id) = user.discord_id.clone() else {
        return Ok(user.username.clone());
    };

    let names = albion_names_by_discord_id(db, vec![discord_id]).await?;
    Ok(names.into_values().next().unwrap_or_else(|| user.username.clone()))
}

/// Resolves display names for a set of user ids in bulk (one query for users, one for
/// `albion_links`, regardless of how many ids are given).
///
/// # Errors
///
/// Returns `AppError::Database` if either query fails.
pub async fn resolve_by_ids(
    db: &DatabaseConnection,
    user_ids: &[i64],
) -> Result<HashMap<i64, String>, AppError> {
    if user_ids.is_empty() {
        return Ok(HashMap::new());
    }

    let users = UserEntity::find()
        .filter(UserColumn::Id.is_in(user_ids.to_vec()))
        .all(db)
        .await?;

    let discord_ids: Vec<String> = users.iter().filter_map(|u| u.discord_id.clone()).collect();
    let names = albion_names_by_discord_id(db, discord_ids).await?;

    Ok(users
        .into_iter()
        .map(|u| {
            let display = u
                .discord_id
                .as_ref()
                .and_then(|d| names.get(d))
                .cloned()
                .unwrap_or(u.username);
            (u.id, display)
        })
        .collect())
}

/// Resolves a single user's display name by id, returning `"Unknown"` if the user no longer
/// exists.
///
/// # Errors
///
/// Returns `AppError::Database` if the lookup fails.
pub async fn resolve_by_id(db: &DatabaseConnection, user_id: i64) -> Result<String, AppError> {
    let mut names = resolve_by_ids(db, &[user_id]).await?;
    Ok(names.remove(&user_id).unwrap_or_else(|| "Unknown".to_string()))
}
