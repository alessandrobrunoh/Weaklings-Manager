//! User service logic module.
//!
//! Provides structures and logic to fetch and manage user data from the database.

use crate::errors::AppError;
use crate::pagination::{PaginatedData, PaginationParams};
use sea_orm::{ColumnTrait, DatabaseConnection, EntityTrait, PaginatorTrait, QueryFilter};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

/// The profile of a user containing identification and authorization details.
#[derive(Debug, Serialize, Clone, ToSchema)]
pub struct UserProfile {
    /// The unique identifier of the user.
    #[schema(example = 42)]
    pub id: u64,
    /// The screen name or username of the user.
    #[schema(example = "rust_developer")]
    pub username: String,
    /// The registered email address of the user.
    #[schema(example = "dev@example.com")]
    pub email: String,
    /// The authorization role of the user (e.g. Admin, User).
    #[schema(example = "Admin")]
    pub role: String,
}

impl UserProfile {
    /// Builds a `UserProfile` from a user row, resolving `username` to the user's linked
    /// Albion Online character name if they have one, falling back to their Discord username.
    async fn from_model(
        db: &sea_orm::DatabaseConnection,
        model: super::entities::Model,
    ) -> Result<Self, AppError> {
        let username = super::display_name::resolve(db, &model).await?;
        Ok(Self {
            id: model.id as u64,
            username,
            email: model.email,
            role: model.role,
        })
    }
}

/// Filters that can be applied when listing users.
#[derive(Debug, Clone, Deserialize, ToSchema)]
pub struct UserFilters {
    /// Filter users whose username contains the given string (case-insensitive).
    #[schema(example = "rust")]
    pub username: Option<String>,
    /// Filter users with the exact email address.
    #[schema(example = "dev@example.com")]
    pub email: Option<String>,
    /// Filter users by their exact resolved role name.
    #[schema(example = "Officer")]
    pub role: Option<String>,
}

/// Service for executing business logic operations related to users.
pub struct UserService;

impl UserService {
    /// Creates a new instance of the `UserService`.
    #[must_use]
    pub fn new() -> Self {
        Self
    }

    /// Fetches the profile of a user by their user ID.
    ///
    /// Returns `Some(UserProfile)` if the user is found, or `None` otherwise.
    pub async fn get_profile(
        &self,
        db: &DatabaseConnection,
        user_id: u64,
    ) -> Result<Option<UserProfile>, AppError> {
        use super::entities::Entity as UserEntity;
        let user = UserEntity::find_by_id(user_id as i64).one(db).await?;
        match user {
            Some(model) => Ok(Some(UserProfile::from_model(db, model).await?)),
            None => Ok(None),
        }
    }

    /// Lists paginated and filtered users from the database.
    ///
    /// # Errors
    ///
    /// Returns `AppError::Database` if the query fails.
    pub async fn list_users(
        &self,
        db: &DatabaseConnection,
        pagination: &PaginationParams,
        filters: &UserFilters,
    ) -> Result<PaginatedData<UserProfile>, AppError> {
        use super::entities::{Column as UserColumn, Entity as UserEntity};

        let mut query = UserEntity::find();

        if let Some(ref username) = filters.username {
            query = query.filter(UserColumn::Username.contains(username));
        }
        if let Some(ref email) = filters.email {
            query = query.filter(UserColumn::Email.eq(email.clone()));
        }
        if let Some(ref role) = filters.role {
            query = query.filter(UserColumn::Role.eq(role.clone()));
        }

        let limit = pagination.limit();
        let page = pagination.offset_page();

        let paginator = query.paginate(db, limit);
        let total_items = paginator.num_items().await?;
        let total_pages = paginator.num_pages().await?;
        let models = paginator.fetch_page(page).await?;

        let user_ids: Vec<i64> = models.iter().map(|m| m.id).collect();
        let mut names = super::display_name::resolve_by_ids(db, &user_ids).await?;
        let items = models
            .into_iter()
            .map(|m| UserProfile {
                username: names.remove(&m.id).unwrap_or_else(|| m.username.clone()),
                id: m.id as u64,
                email: m.email,
                role: m.role,
            })
            .collect();

        Ok(PaginatedData::new(
            items,
            total_items,
            total_pages,
            page + 1,
            limit,
        ))
    }
}

impl Default for UserService {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::migration::MigratorTrait;
    use sea_orm::{ActiveModelTrait, ActiveValue::Set, Database};

    #[tokio::test]
    async fn test_pagination_and_filtering() {
        let db = Database::connect("sqlite::memory:")
            .await
            .expect("Failed to connect to test database");

        crate::migration::Migrator::up(&db, None)
            .await
            .expect("Failed to run database migrations");

        use super::super::entities::ActiveModel;

        let user_a = ActiveModel {
            username: Set("alice".to_string()),
            email: Set("alice@example.com".to_string()),
            role: Set("Admin".to_string()),
            ..Default::default()
        };
        user_a.insert(&db).await.expect("Failed to insert user A");

        let user_b = ActiveModel {
            username: Set("bob".to_string()),
            email: Set("bob@example.com".to_string()),
            role: Set("User".to_string()),
            ..Default::default()
        };
        user_b.insert(&db).await.expect("Failed to insert user B");

        let user_c = ActiveModel {
            username: Set("charlie".to_string()),
            email: Set("charlie@example.com".to_string()),
            role: Set("User".to_string()),
            ..Default::default()
        };
        user_c.insert(&db).await.expect("Failed to insert user C");

        let service = UserService::new();

        let page_1 = service
            .list_users(
                &db,
                &PaginationParams {
                    page: Some(1),
                    limit: Some(2),
                },
                &UserFilters {
                    username: None,
                    email: None,
                    role: None,
                },
            )
            .await
            .expect("Failed to list users");

        assert_eq!(page_1.items.len(), 2);
        assert_eq!(page_1.total_items, 3);
        assert_eq!(page_1.total_pages, 2);
        assert_eq!(page_1.current_page, 1);
        assert_eq!(page_1.items[0].username, "alice");
        assert_eq!(page_1.items[1].username, "bob");

        let page_2 = service
            .list_users(
                &db,
                &PaginationParams {
                    page: Some(2),
                    limit: Some(2),
                },
                &UserFilters {
                    username: None,
                    email: None,
                    role: None,
                },
            )
            .await
            .expect("Failed to list users page 2");

        assert_eq!(page_2.items.len(), 1);
        assert_eq!(page_2.items[0].username, "charlie");

        let role_filter = service
            .list_users(
                &db,
                &PaginationParams {
                    page: Some(1),
                    limit: Some(10),
                },
                &UserFilters {
                    username: None,
                    email: None,
                    role: Some("User".to_string()),
                },
            )
            .await
            .expect("Failed to filter users by role");

        assert_eq!(role_filter.items.len(), 2);
        assert_eq!(role_filter.total_items, 2);
        assert_eq!(role_filter.items[0].username, "bob");
        assert_eq!(role_filter.items[1].username, "charlie");

        let name_filter = service
            .list_users(
                &db,
                &PaginationParams {
                    page: Some(1),
                    limit: Some(10),
                },
                &UserFilters {
                    username: Some("li".to_string()),
                    email: None,
                    role: None,
                },
            )
            .await
            .expect("Failed to filter users by name");

        assert_eq!(name_filter.items.len(), 2);
        assert_eq!(name_filter.items[0].username, "alice");
        assert_eq!(name_filter.items[1].username, "charlie");
    }
}
