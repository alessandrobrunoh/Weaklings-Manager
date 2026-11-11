//! Member weapon declarations, mounted under `/api/users`.
//!
//! A member declares the weapons they can play (`main`, `good` or `basic`); an officer can
//! additionally lock a weapon for a member. Event signup, the roster board and auto-fill read
//! these rows (see `backend_events`); the Destiny Board specialization levels stay optional and
//! keep feeding Item Power suggestions.
//!
//! The rows, DTOs and per-user lookups live in `backend_identity::users::weapons`. The routes and
//! the catalog-aware validation live here because the catalog crate (`backend_albion_data`)
//! depends on the identity crate, and combat is the feature that consumes the declarations; the
//! app registry merges [`router`] into the `/api/users` router.

use std::cmp::Reverse;
use std::collections::{HashMap, HashSet};

use axum::{
    Extension, Json, Router,
    extract::Path,
    routing::get,
};
use sea_orm::{
    ActiveModelTrait, ColumnTrait, DatabaseConnection, EntityTrait, QueryFilter, Set,
    TransactionTrait,
};

use backend_albion_data::openalbion::service::weapon_name_for_key;
use backend_core::errors::{AppError, ProblemDetails};
use backend_core::responses::ApiResponse;
use backend_identity::audit::service::AuditService;
use backend_identity::auth::{Permission, Permissions, UserContext};
use backend_identity::users::weapons::{
    self, ManageUserWeaponsRequest, UpdateMyWeaponsRequest, UserWeaponView, WeaponProficiency,
};

/// Most weapon rows one request may carry; the catalog has far fewer distinct weapons.
const MAX_WEAPONS_PER_REQUEST: usize = 300;

/// Routes merged into the `/api/users` router.
pub fn router() -> Router {
    Router::new()
        .route("/me/weapons", get(get_my_weapons).put(update_my_weapons))
        .route(
            "/{user_id}/weapons",
            get(get_user_weapons).put(update_user_weapons),
        )
}

/// Returns the caller's declared and locked weapons.
#[utoipa::path(
    get,
    path = "/api/users/me/weapons",
    tag = "users",
    summary = "List the caller's weapons",
    description = "Returns every weapon the caller declared (with its level) and every weapon an \
                   officer locked for them. Sorted main, good, basic, then lock-only rows, and \
                   by name inside each group.",
    security(("session_cookie" = [])),
    responses(
        (status = 200, description = "The caller's weapons", body = crate::schemas::ApiResponseUserWeapons),
        (status = 401, description = "Unauthorized - no active session", body = ProblemDetails)
    )
)]
pub async fn get_my_weapons(
    user: UserContext,
    Extension(db): Extension<DatabaseConnection>,
) -> Result<Json<ApiResponse<Vec<UserWeaponView>>>, AppError> {
    Ok(Json(ApiResponse::new(
        list_weapons(&db, user.user_id).await?,
    )))
}

/// Replaces the caller's declared weapons.
#[utoipa::path(
    put,
    path = "/api/users/me/weapons",
    tag = "users",
    summary = "Replace the caller's declared weapons",
    description = "Replaces the caller's declarations with the request body. Unknown or non-weapon \
                   keys and duplicate keys are refused, as is a weapon an officer locked. Locked \
                   rows are never modified or deleted by this call; unlocked rows missing from the \
                   body are deleted. Returns the full list afterwards.",
    security(("session_cookie" = [])),
    request_body = UpdateMyWeaponsRequest,
    responses(
        (status = 200, description = "The caller's weapons after the update", body = crate::schemas::ApiResponseUserWeapons),
        (status = 401, description = "Unauthorized - no active session", body = ProblemDetails),
        (status = 422, description = "Unknown, duplicate or locked weapon", body = ProblemDetails)
    )
)]
pub async fn update_my_weapons(
    user: UserContext,
    Extension(db): Extension<DatabaseConnection>,
    Json(body): Json<UpdateMyWeaponsRequest>,
) -> Result<Json<ApiResponse<Vec<UserWeaponView>>>, AppError> {
    Ok(Json(ApiResponse::new(
        replace_my_weapons(&db, user.user_id, &body).await?,
    )))
}

/// Returns another member's declared and locked weapons.
#[utoipa::path(
    get,
    path = "/api/users/{user_id}/weapons",
    tag = "users",
    summary = "List a member's weapons",
    description = "Readable by any authenticated member, like specializations.",
    security(("session_cookie" = [])),
    params(("user_id" = i64, Path, description = "Internal user ID")),
    responses(
        (status = 200, description = "The member's weapons", body = crate::schemas::ApiResponseUserWeapons),
        (status = 401, description = "Unauthorized - no active session", body = ProblemDetails),
        (status = 404, description = "User not found", body = ProblemDetails)
    )
)]
pub async fn get_user_weapons(
    _user: UserContext,
    Extension(db): Extension<DatabaseConnection>,
    Path(user_id): Path<i64>,
) -> Result<Json<ApiResponse<Vec<UserWeaponView>>>, AppError> {
    ensure_user_exists(&db, user_id).await?;
    Ok(Json(ApiResponse::new(list_weapons(&db, user_id).await?)))
}

/// Replaces a member's weapon rows, locks included.
#[utoipa::path(
    put,
    path = "/api/users/{user_id}/weapons",
    tag = "users",
    summary = "Replace a member's weapons and locks",
    description = "Officer endpoint: replaces every weapon row of the member, including officer \
                   locks. Rows with no level and no lock are dropped. Requires \
                   `users.specializations.manage` even for the caller's own rows, because it can \
                   clear locks. Returns the full list afterwards.",
    security(("session_cookie" = [])),
    params(("user_id" = i64, Path, description = "Internal user ID")),
    request_body = ManageUserWeaponsRequest,
    responses(
        (status = 200, description = "The member's weapons after the update", body = crate::schemas::ApiResponseUserWeapons),
        (status = 401, description = "Unauthorized - no active session", body = ProblemDetails),
        (status = 403, description = "Missing users.specializations.manage", body = ProblemDetails),
        (status = 404, description = "User not found", body = ProblemDetails),
        (status = 422, description = "Unknown or duplicate weapon", body = ProblemDetails)
    )
)]
pub async fn update_user_weapons(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(db): Extension<DatabaseConnection>,
    Path(user_id): Path<i64>,
    Json(body): Json<ManageUserWeaponsRequest>,
) -> Result<Json<ApiResponse<Vec<UserWeaponView>>>, AppError> {
    user.require(&perms, Permission::UsersSpecializationsManage)
        .await?;
    ensure_user_exists(&db, user_id).await?;
    Ok(Json(ApiResponse::new(
        manage_user_weapons(&db, user_id, user.user_id, &body).await?,
    )))
}

/// Fails with [`AppError::NotFound`] when no user has this id.
async fn ensure_user_exists(db: &DatabaseConnection, user_id: i64) -> Result<(), AppError> {
    backend_entities::users::Entity::find_by_id(user_id)
        .one(db)
        .await
        .map_err(AppError::Database)?
        .map(|_| ())
        .ok_or_else(|| AppError::NotFound(format!("user {user_id} not found")))
}

/// The display name of a stored weapon key. A key the catalog no longer knows (the bundled
/// catalog changed after the row was written) keeps showing up under its raw identifier, so an
/// officer lock never silently disappears from the list.
fn display_name(weapon_key: &str) -> String {
    weapon_name_for_key(weapon_key).map_or_else(
        || {
            weapon_key
                .strip_prefix("weapon:")
                .unwrap_or(weapon_key)
                .to_string()
        },
        str::to_string,
    )
}

/// Checks a requested key against the bundled catalog and returns it trimmed.
fn validate_weapon_key(raw: &str) -> Result<String, AppError> {
    let key = raw.trim();
    if weapon_name_for_key(key).is_none() {
        return Err(AppError::Validation(format!(
            "{key:?} is not a catalog weapon; use the form weapon:{{BASE}}, for example weapon:2H_POLEHAMMER"
        )));
    }
    Ok(key.to_string())
}

/// Lists a member's weapon rows: main, good, basic, then lock-only rows, by name inside a group.
///
/// # Errors
///
/// Returns [`AppError::Database`] when the query fails.
pub async fn list_weapons(
    db: &DatabaseConnection,
    user_id: i64,
) -> Result<Vec<UserWeaponView>, AppError> {
    let rows = weapons::Entity::find()
        .filter(weapons::Column::UserId.eq(user_id))
        .all(db)
        .await
        .map_err(AppError::Database)?;
    let mut views: Vec<UserWeaponView> = rows
        .into_iter()
        .map(|row| UserWeaponView {
            weapon_name: display_name(&row.weapon_key),
            proficiency: row.proficiency.as_deref().and_then(WeaponProficiency::parse),
            locked: row.locked,
            updated_at: row.updated_at,
            weapon_key: row.weapon_key,
        })
        .collect();
    views.sort_by(|left, right| {
        let rank = |view: &UserWeaponView| view.proficiency.map_or(0, WeaponProficiency::rank);
        Reverse(rank(left))
            .cmp(&Reverse(rank(right)))
            .then_with(|| left.weapon_name.cmp(&right.weapon_name))
            .then_with(|| left.weapon_key.cmp(&right.weapon_key))
    });
    Ok(views)
}

/// Replaces a member's own declarations.
///
/// Locked rows are never modified or deleted; a request that names a locked weapon is refused.
/// Unlocked rows missing from the request are deleted.
///
/// # Errors
///
/// Returns [`AppError::Validation`] for an unknown key, a duplicate key or a weapon an officer
/// locked, and [`AppError::Database`] when a query fails.
pub async fn replace_my_weapons(
    db: &DatabaseConnection,
    user_id: i64,
    request: &UpdateMyWeaponsRequest,
) -> Result<Vec<UserWeaponView>, AppError> {
    if request.weapons.len() > MAX_WEAPONS_PER_REQUEST {
        return Err(AppError::Validation(format!(
            "At most {MAX_WEAPONS_PER_REQUEST} weapons can be declared at once"
        )));
    }
    let mut seen = HashSet::new();
    let mut wanted: Vec<(String, WeaponProficiency)> = Vec::with_capacity(request.weapons.len());
    for item in &request.weapons {
        let key = validate_weapon_key(&item.weapon_key)?;
        if !seen.insert(key.clone()) {
            return Err(AppError::Validation(format!(
                "{} is listed more than once",
                display_name(&key)
            )));
        }
        wanted.push((key, item.proficiency));
    }

    let txn = db.begin().await.map_err(AppError::Database)?;
    let existing = weapons::Entity::find()
        .filter(weapons::Column::UserId.eq(user_id))
        .all(&txn)
        .await
        .map_err(AppError::Database)?;
    let existing_by_key: HashMap<&str, &weapons::Model> = existing
        .iter()
        .map(|row| (row.weapon_key.as_str(), row))
        .collect();

    for (key, _) in &wanted {
        if existing_by_key.get(key.as_str()).is_some_and(|row| row.locked) {
            return Err(AppError::Validation(format!(
                "{} is locked by an officer",
                display_name(key)
            )));
        }
    }

    // Unlocked rows the member no longer lists go away; locked rows stay exactly as they are.
    let stale: Vec<i64> = existing
        .iter()
        .filter(|row| !row.locked && !seen.contains(&row.weapon_key))
        .map(|row| row.id)
        .collect();
    if !stale.is_empty() {
        weapons::Entity::delete_many()
            .filter(weapons::Column::Id.is_in(stale))
            .exec(&txn)
            .await
            .map_err(AppError::Database)?;
    }

    let now: sea_orm::prelude::DateTimeWithTimeZone = chrono::Utc::now().into();
    for (key, level) in &wanted {
        match existing_by_key.get(key.as_str()) {
            Some(row) => {
                if row.proficiency.as_deref() != Some(level.as_str()) {
                    let mut active: weapons::ActiveModel = (*row).clone().into();
                    active.proficiency = Set(Some(level.as_str().to_string()));
                    active.updated_at = Set(now);
                    active.updated_by_user_id = Set(Some(user_id));
                    active.update(&txn).await.map_err(AppError::Database)?;
                }
            }
            None => {
                weapons::ActiveModel {
                    user_id: Set(user_id),
                    weapon_key: Set(key.clone()),
                    proficiency: Set(Some(level.as_str().to_string())),
                    locked: Set(false),
                    locked_by_user_id: Set(None),
                    updated_at: Set(now),
                    updated_by_user_id: Set(Some(user_id)),
                    ..Default::default()
                }
                .insert(&txn)
                .await
                .map_err(AppError::Database)?;
            }
        }
    }
    txn.commit().await.map_err(AppError::Database)?;

    let _ = AuditService::log(
        db,
        "USER_WEAPONS_UPDATED",
        Some("USER_WEAPONS"),
        Some(user_id),
        Some(user_id),
        Some(serde_json::json!({
            "target_user_id": user_id,
            "weapon_keys": wanted.iter().map(|(key, _)| key.as_str()).collect::<Vec<_>>(),
        })),
    )
    .await;

    list_weapons(db, user_id).await
}

/// Replaces every weapon row of a member on behalf of an officer, locks included.
///
/// Entries with no level and no lock are dropped. A row that becomes locked records
/// `editor_user_id` as the locker; a row that stays locked keeps its original locker.
///
/// # Errors
///
/// Returns [`AppError::Validation`] for an unknown or duplicate key and [`AppError::Database`]
/// when a query fails.
pub async fn manage_user_weapons(
    db: &DatabaseConnection,
    target_user_id: i64,
    editor_user_id: i64,
    request: &ManageUserWeaponsRequest,
) -> Result<Vec<UserWeaponView>, AppError> {
    if request.weapons.len() > MAX_WEAPONS_PER_REQUEST {
        return Err(AppError::Validation(format!(
            "At most {MAX_WEAPONS_PER_REQUEST} weapons can be updated at once"
        )));
    }
    let mut seen = HashSet::new();
    let mut wanted: Vec<(String, Option<WeaponProficiency>, bool)> = Vec::new();
    for item in &request.weapons {
        let key = validate_weapon_key(&item.weapon_key)?;
        if !seen.insert(key.clone()) {
            return Err(AppError::Validation(format!(
                "{} is listed more than once",
                display_name(&key)
            )));
        }
        if item.proficiency.is_some() || item.locked {
            wanted.push((key, item.proficiency, item.locked));
        }
    }
    let kept: HashSet<&str> = wanted.iter().map(|(key, _, _)| key.as_str()).collect();

    let txn = db.begin().await.map_err(AppError::Database)?;
    let existing = weapons::Entity::find()
        .filter(weapons::Column::UserId.eq(target_user_id))
        .all(&txn)
        .await
        .map_err(AppError::Database)?;
    let existing_by_key: HashMap<&str, &weapons::Model> = existing
        .iter()
        .map(|row| (row.weapon_key.as_str(), row))
        .collect();

    let stale: Vec<i64> = existing
        .iter()
        .filter(|row| !kept.contains(row.weapon_key.as_str()))
        .map(|row| row.id)
        .collect();
    if !stale.is_empty() {
        weapons::Entity::delete_many()
            .filter(weapons::Column::Id.is_in(stale))
            .exec(&txn)
            .await
            .map_err(AppError::Database)?;
    }

    let now: sea_orm::prelude::DateTimeWithTimeZone = chrono::Utc::now().into();
    for (key, level, locked) in &wanted {
        let level = level.map(|level| level.as_str().to_string());
        match existing_by_key.get(key.as_str()) {
            Some(row) => {
                let locked_by = if *locked {
                    row.locked_by_user_id.or(Some(editor_user_id))
                } else {
                    None
                };
                if row.proficiency != level
                    || row.locked != *locked
                    || row.locked_by_user_id != locked_by
                {
                    let mut active: weapons::ActiveModel = (*row).clone().into();
                    active.proficiency = Set(level);
                    active.locked = Set(*locked);
                    active.locked_by_user_id = Set(locked_by);
                    active.updated_at = Set(now);
                    active.updated_by_user_id = Set(Some(editor_user_id));
                    active.update(&txn).await.map_err(AppError::Database)?;
                }
            }
            None => {
                weapons::ActiveModel {
                    user_id: Set(target_user_id),
                    weapon_key: Set(key.clone()),
                    proficiency: Set(level),
                    locked: Set(*locked),
                    locked_by_user_id: Set(locked.then_some(editor_user_id)),
                    updated_at: Set(now),
                    updated_by_user_id: Set(Some(editor_user_id)),
                    ..Default::default()
                }
                .insert(&txn)
                .await
                .map_err(AppError::Database)?;
            }
        }
    }
    txn.commit().await.map_err(AppError::Database)?;

    let _ = AuditService::log(
        db,
        "USER_WEAPONS_MANAGED",
        Some("USER_WEAPONS"),
        Some(target_user_id),
        Some(editor_user_id),
        Some(serde_json::json!({
            "target_user_id": target_user_id,
            "weapon_keys": wanted.iter().map(|(key, _, _)| key.as_str()).collect::<Vec<_>>(),
            "locked_keys": wanted
                .iter()
                .filter(|(_, _, locked)| *locked)
                .map(|(key, _, _)| key.as_str())
                .collect::<Vec<_>>(),
        })),
    )
    .await;

    list_weapons(db, target_user_id).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use backend_identity::users::weapons::{DeclareWeaponInput, ManageWeaponInput};

    const HAMMER: &str = "weapon:2H_POLEHAMMER";
    const SWORD: &str = "weapon:MAIN_SWORD";
    const STAFF: &str = "weapon:MAIN_HOLYSTAFF";

    async fn seed_db() -> DatabaseConnection {
        backend_migration::testkit::migrated_sqlite().await
    }

    async fn insert_user(db: &DatabaseConnection, name: &str) -> i64 {
        backend_entities::users::ActiveModel {
            username: Set(name.to_string()),
            email: Set(format!("{name}@example.com")),
            role: Set("User".to_string()),
            ..Default::default()
        }
        .insert(db)
        .await
        .expect("failed to insert user")
        .id
    }

    fn declare(entries: &[(&str, WeaponProficiency)]) -> UpdateMyWeaponsRequest {
        UpdateMyWeaponsRequest {
            weapons: entries
                .iter()
                .map(|(key, level)| DeclareWeaponInput {
                    weapon_key: (*key).to_string(),
                    proficiency: *level,
                })
                .collect(),
        }
    }

    fn manage(entries: &[(&str, Option<WeaponProficiency>, bool)]) -> ManageUserWeaponsRequest {
        ManageUserWeaponsRequest {
            weapons: entries
                .iter()
                .map(|(key, level, locked)| ManageWeaponInput {
                    weapon_key: (*key).to_string(),
                    proficiency: *level,
                    locked: *locked,
                })
                .collect(),
        }
    }

    fn summary(views: &[UserWeaponView]) -> Vec<(&str, Option<WeaponProficiency>, bool)> {
        views
            .iter()
            .map(|view| (view.weapon_key.as_str(), view.proficiency, view.locked))
            .collect()
    }

    /// Who locked a weapon for the user, read straight from the table.
    async fn locker_of(db: &DatabaseConnection, user_id: i64, key: &str) -> Option<i64> {
        weapons::Entity::find()
            .filter(weapons::Column::UserId.eq(user_id))
            .filter(weapons::Column::WeaponKey.eq(key))
            .one(db)
            .await
            .expect("query user_weapons")
            .and_then(|row| row.locked_by_user_id)
    }

    fn account(user_id: i64) -> UserContext {
        UserContext {
            id: format!("discord-{user_id}"),
            username: "someone".to_owned(),
            email: None,
            avatar: None,
            roles: Vec::new(),
            highest_role: "User".to_owned(),
            user_id,
            super_admin_id: None,
            is_tenant_owner: false,
        }
    }

    #[tokio::test]
    async fn a_member_declares_and_then_replaces_their_weapons() {
        let db = seed_db().await;
        let user = insert_user(&db, "alice").await;

        let first = replace_my_weapons(
            &db,
            user,
            &declare(&[
                (SWORD, WeaponProficiency::Basic),
                (HAMMER, WeaponProficiency::Main),
                (STAFF, WeaponProficiency::Good),
            ]),
        )
        .await
        .expect("declaring weapons should succeed");
        assert_eq!(
            summary(&first),
            vec![
                (HAMMER, Some(WeaponProficiency::Main), false),
                (STAFF, Some(WeaponProficiency::Good), false),
                (SWORD, Some(WeaponProficiency::Basic), false),
            ],
            "sorted main, good, basic"
        );
        assert_eq!(first[0].weapon_name, "Polehammer");

        let second = replace_my_weapons(
            &db,
            user,
            &declare(&[
                (SWORD, WeaponProficiency::Main),
                (STAFF, WeaponProficiency::Good),
            ]),
        )
        .await
        .expect("replacing weapons should succeed");
        assert_eq!(
            summary(&second),
            vec![
                (SWORD, Some(WeaponProficiency::Main), false),
                (STAFF, Some(WeaponProficiency::Good), false),
            ],
            "the hammer is gone, the sword was re-levelled"
        );

        let cleared = replace_my_weapons(&db, user, &declare(&[]))
            .await
            .expect("an empty body clears the declarations");
        assert!(cleared.is_empty());
    }

    #[tokio::test]
    async fn an_unknown_or_non_weapon_key_is_rejected() {
        let db = seed_db().await;
        let user = insert_user(&db, "alice").await;

        for key in [
            "weapon:NOT_A_WEAPON",
            "weapon:T8_MAIN_SWORD",
            "weapon:main_sword",
            "armor:ARMOR_PLATE_SET1",
            "weapon:ARMOR_PLATE_SET1",
            "MAIN_SWORD",
            "",
        ] {
            let error = replace_my_weapons(&db, user, &declare(&[(key, WeaponProficiency::Good)]))
                .await
                .expect_err("a key that is not a catalog weapon must be refused");
            assert!(
                matches!(error, AppError::Validation(_)),
                "{key:?} gave {error:?}"
            );
        }
        assert!(
            list_weapons(&db, user).await.unwrap().is_empty(),
            "nothing was stored"
        );
    }

    #[tokio::test]
    async fn a_duplicate_key_is_rejected() {
        let db = seed_db().await;
        let user = insert_user(&db, "alice").await;

        let error = replace_my_weapons(
            &db,
            user,
            &declare(&[
                (SWORD, WeaponProficiency::Main),
                (SWORD, WeaponProficiency::Basic),
            ]),
        )
        .await
        .expect_err("the same weapon twice must be refused");
        assert!(matches!(error, AppError::Validation(_)));

        let error = manage_user_weapons(
            &db,
            user,
            user,
            &manage(&[(SWORD, None, true), (SWORD, Some(WeaponProficiency::Main), false)]),
        )
        .await
        .expect_err("the officer endpoint refuses duplicates as well");
        assert!(matches!(error, AppError::Validation(_)));
    }

    #[tokio::test]
    async fn a_member_cannot_declare_a_weapon_an_officer_locked() {
        let db = seed_db().await;
        let user = insert_user(&db, "alice").await;
        let officer = insert_user(&db, "officer").await;
        manage_user_weapons(&db, user, officer, &manage(&[(HAMMER, None, true)]))
            .await
            .expect("locking should succeed");

        let error = replace_my_weapons(
            &db,
            user,
            &declare(&[
                (SWORD, WeaponProficiency::Main),
                (HAMMER, WeaponProficiency::Main),
            ]),
        )
        .await
        .expect_err("a locked weapon cannot be declared");
        match error {
            AppError::Validation(message) => {
                assert!(message.contains("Polehammer"), "{message}");
                assert!(message.contains("locked by an officer"), "{message}");
            }
            other => panic!("expected a validation error, got {other:?}"),
        }
        assert_eq!(
            summary(&list_weapons(&db, user).await.unwrap()),
            vec![(HAMMER, None, true)],
            "the refused call changed nothing, not even the sword"
        );
    }

    #[tokio::test]
    async fn locked_rows_survive_the_members_replace() {
        let db = seed_db().await;
        let user = insert_user(&db, "alice").await;
        let officer = insert_user(&db, "officer").await;
        replace_my_weapons(
            &db,
            user,
            &declare(&[
                (HAMMER, WeaponProficiency::Main),
                (SWORD, WeaponProficiency::Good),
            ]),
        )
        .await
        .unwrap();
        // The officer locks the hammer the member had already declared, and a staff they never did.
        manage_user_weapons(
            &db,
            user,
            officer,
            &manage(&[
                (HAMMER, Some(WeaponProficiency::Main), true),
                (SWORD, Some(WeaponProficiency::Good), false),
                (STAFF, None, true),
            ]),
        )
        .await
        .unwrap();

        // The member replaces their list without the hammer: the lock keeps both locked rows.
        let after = replace_my_weapons(&db, user, &declare(&[]))
            .await
            .expect("replacing must not touch locked rows");
        assert_eq!(
            summary(&after),
            vec![
                (HAMMER, Some(WeaponProficiency::Main), true),
                (STAFF, None, true),
            ],
            "locked rows stay, the unlocked sword is deleted"
        );

        let kept = replace_my_weapons(&db, user, &declare(&[(SWORD, WeaponProficiency::Basic)]))
            .await
            .unwrap();
        assert_eq!(
            summary(&kept),
            vec![
                (HAMMER, Some(WeaponProficiency::Main), true),
                (SWORD, Some(WeaponProficiency::Basic), false),
                (STAFF, None, true),
            ]
        );
    }

    #[tokio::test]
    async fn an_officer_sets_and_clears_locks() {
        let db = seed_db().await;
        let user = insert_user(&db, "alice").await;
        let officer = insert_user(&db, "officer").await;
        let other_officer = insert_user(&db, "other-officer").await;

        let locked = manage_user_weapons(
            &db,
            user,
            officer,
            &manage(&[
                (HAMMER, Some(WeaponProficiency::Good), true),
                (STAFF, None, true),
                (SWORD, Some(WeaponProficiency::Main), false),
            ]),
        )
        .await
        .expect("an officer can lock a weapon, declared or not");
        assert_eq!(
            summary(&locked),
            vec![
                (SWORD, Some(WeaponProficiency::Main), false),
                (HAMMER, Some(WeaponProficiency::Good), true),
                (STAFF, None, true),
            ]
        );
        assert_eq!(locker_of(&db, user, HAMMER).await, Some(officer));
        assert_eq!(locker_of(&db, user, SWORD).await, None);

        // A second officer re-saving keeps the original locker and clears the staff lock; the
        // staff row has no level, so it disappears altogether.
        let cleared = manage_user_weapons(
            &db,
            user,
            other_officer,
            &manage(&[
                (HAMMER, Some(WeaponProficiency::Good), true),
                (STAFF, None, false),
                (SWORD, Some(WeaponProficiency::Main), false),
            ]),
        )
        .await
        .unwrap();
        assert_eq!(
            summary(&cleared),
            vec![
                (SWORD, Some(WeaponProficiency::Main), false),
                (HAMMER, Some(WeaponProficiency::Good), true),
            ]
        );
        assert_eq!(locker_of(&db, user, HAMMER).await, Some(officer));

        // Unlocking the hammer returns it to the member as an ordinary declaration, and a row
        // missing from the body is deleted outright.
        let unlocked = manage_user_weapons(
            &db,
            user,
            officer,
            &manage(&[(HAMMER, Some(WeaponProficiency::Good), false)]),
        )
        .await
        .unwrap();
        assert_eq!(
            summary(&unlocked),
            vec![(HAMMER, Some(WeaponProficiency::Good), false)]
        );
        assert_eq!(locker_of(&db, user, HAMMER).await, None);
        replace_my_weapons(&db, user, &declare(&[(HAMMER, WeaponProficiency::Main)]))
            .await
            .expect("the member can declare it again once the lock is gone");
    }

    #[tokio::test]
    async fn managing_another_users_weapons_needs_the_permission() {
        let db = seed_db().await;
        let target = insert_user(&db, "alice").await;
        let member = insert_user(&db, "bob").await;
        let body = manage(&[(HAMMER, None, true)]);

        let denied = update_user_weapons(
            account(member),
            Extension(Permissions::new_empty()),
            Extension(db.clone()),
            Path(target),
            Json(body.clone()),
        )
        .await;
        assert!(
            matches!(denied, Err(AppError::Forbidden(_))),
            "a plain member must not manage another member's weapons"
        );

        // Not even for their own rows: the endpoint can clear locks.
        let own = update_user_weapons(
            account(member),
            Extension(Permissions::new_empty()),
            Extension(db.clone()),
            Path(member),
            Json(body.clone()),
        )
        .await;
        assert!(matches!(own, Err(AppError::Forbidden(_))));
        assert!(list_weapons(&db, target).await.unwrap().is_empty());

        let mut owner = account(member);
        owner.is_tenant_owner = true;
        let allowed = update_user_weapons(
            owner,
            Extension(Permissions::new_empty()),
            Extension(db.clone()),
            Path(target),
            Json(body),
        )
        .await
        .expect("the tenant owner bypasses the permission check");
        assert_eq!(summary(&allowed.0.data), vec![(HAMMER, None, true)]);

        let missing = update_user_weapons(
            {
                let mut owner = account(member);
                owner.is_tenant_owner = true;
                owner
            },
            Extension(Permissions::new_empty()),
            Extension(db.clone()),
            Path(9_999),
            Json(manage(&[])),
        )
        .await;
        assert!(matches!(missing, Err(AppError::NotFound(_))));
    }
}
