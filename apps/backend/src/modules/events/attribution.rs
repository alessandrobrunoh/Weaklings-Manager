//! Participant-to-guild attribution for linked events.
//!
//! A signup from a guild tenant is always attributed to that guild. A signup
//! from an alliance tenant is attributed to one of the caller's active member
//! guilds, chosen explicitly when more than one is eligible. The choice is
//! persisted in the control plane keyed by the canonical event and the stable
//! Discord identity, never by display name.

use std::collections::HashMap;

use sea_orm::{ConnectionTrait, DatabaseConnection, DbBackend, Statement, Value};
use serde::Serialize;
use utoipa::ToSchema;

use crate::errors::AppError;
use crate::modules::sync::event_links::{canonical_event_origin, stored_attribution};

use super::models::{EventDetailView, EventParticipantView, EventRosterView};

/// One guild a caller may be attributed to for a linked event.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, ToSchema)]
pub struct ParticipationGuild {
    /// Control-plane tenant id of the guild.
    pub tenant_id: String,
    /// Guild display name.
    pub name: String,
}

/// The caller's eligible active guilds in this tenant context.
///
/// A guild tenant always yields itself. An alliance tenant yields the active
/// membership guilds the caller's Discord identity belongs to.
pub async fn eligible_participation_guilds(
    control: &DatabaseConnection,
    tenant_id: &str,
    discord_id: &str,
) -> Result<Vec<ParticipationGuild>, AppError> {
    let kind = tenant_kind(control, tenant_id).await?;
    let rows = if kind == "guild" {
        control
            .query_one(Statement::from_sql_and_values(
                DbBackend::Postgres,
                "SELECT id, name FROM tenants WHERE id = $1 AND status = 'active'",
                [tenant_id.into()],
            ))
            .await?
            .into_iter()
            .collect::<Vec<_>>()
    } else {
        control
            .query_all(Statement::from_sql_and_values(
                DbBackend::Postgres,
                "SELECT t.id, t.name FROM alliance_memberships m \
                 JOIN tenants t ON t.id = m.guild_tenant_id \
                 JOIN user_tenant_memberships u ON u.tenant_id = t.id AND u.discord_id = $2 \
                 WHERE m.alliance_tenant_id = $1 AND m.status = 'active' AND t.status = 'active' \
                 ORDER BY t.name",
                [tenant_id.into(), discord_id.into()],
            ))
            .await?
    };
    rows.into_iter()
        .map(|row| {
            Ok(ParticipationGuild {
                tenant_id: row.try_get_by_index(0)?,
                name: row.try_get_by_index(1)?,
            })
        })
        .collect::<Result<Vec<_>, sea_orm::DbErr>>()
        .map_err(Into::into)
}

/// The attributed guild of every given participant on a linked event, keyed by Discord id.
///
/// Attributions live under the canonical origin, so the origin, the alliance mirror and every
/// guild copy resolve to the same rows. Two control-plane queries regardless of roster size: the
/// canonical lookup, then one batched read of the whole roster. Participants without a stored
/// attribution (legacy signups) are simply absent from the map, and so is everybody on an event
/// that is not linked to another tenant.
pub async fn participant_guilds(
    control: &DatabaseConnection,
    tenant_id: &str,
    event_id: i64,
    discord_ids: &[&str],
) -> Result<HashMap<String, ParticipationGuild>, AppError> {
    if discord_ids.is_empty() {
        return Ok(HashMap::new());
    }
    let (origin_tenant, origin_event) =
        canonical_event_origin(control, tenant_id, event_id).await?;
    let placeholders = (3..discord_ids.len() + 3)
        .map(|index| format!("${index}"))
        .collect::<Vec<_>>()
        .join(", ");
    let sql = format!(
        "SELECT a.discord_id, a.guild_tenant_id, t.name \
         FROM event_participant_attributions a \
         JOIN tenants t ON t.id = a.guild_tenant_id \
         WHERE a.source_tenant_id = $1 AND a.source_event_id = $2 \
           AND a.discord_id IN ({placeholders}) \
           AND EXISTS (SELECT 1 FROM event_sync_links l \
                       WHERE l.sync_enabled AND l.source_tenant_id = $1 AND l.source_event_id = $2)"
    );
    let mut values = vec![Value::from(origin_tenant), Value::from(origin_event)];
    values.extend(discord_ids.iter().map(|id| Value::from((*id).to_owned())));
    let rows = control
        .query_all(Statement::from_sql_and_values(
            DbBackend::Postgres,
            &sql,
            values,
        ))
        .await?;
    rows.into_iter()
        .map(|row| {
            Ok((
                row.try_get_by_index::<String>(0)?,
                ParticipationGuild {
                    tenant_id: row.try_get_by_index(1)?,
                    name: row.try_get_by_index(2)?,
                },
            ))
        })
        .collect::<Result<HashMap<_, _>, sea_orm::DbErr>>()
        .map_err(Into::into)
}

/// Fills `guild` on every participant. Cosmetic, so a control-plane failure is logged and the
/// participants are left unattributed rather than failing the whole read.
async fn attribute_participants(
    control: &DatabaseConnection,
    tenant_id: &str,
    event_id: i64,
    mut participants: Vec<&mut EventParticipantView>,
) {
    let discord_ids: Vec<&str> = participants
        .iter()
        .filter_map(|participant| participant.discord_id.as_deref())
        .collect();
    let guilds = match participant_guilds(control, tenant_id, event_id, &discord_ids).await {
        Ok(guilds) => guilds,
        Err(error) => {
            tracing::warn!(%error, event_id, "could not resolve participant guild attribution");
            return;
        }
    };
    for participant in &mut participants {
        participant.guild = participant
            .discord_id
            .as_ref()
            .and_then(|discord_id| guilds.get(discord_id))
            .cloned();
    }
}

/// Attributes every participant of an event detail to their guild.
pub async fn attribute_detail(
    control: &DatabaseConnection,
    tenant_id: &str,
    detail: &mut EventDetailView,
) {
    let event_id = detail.event.id;
    attribute_participants(
        control,
        tenant_id,
        event_id,
        detail.participants.iter_mut().collect(),
    )
    .await;
}

/// Attributes every seated and benched participant of a roster to their guild.
pub async fn attribute_roster(
    control: &DatabaseConnection,
    tenant_id: &str,
    roster: &mut EventRosterView,
) {
    let event_id = roster.event_id;
    let seated = roster
        .seats
        .iter_mut()
        .filter_map(|seat| seat.participant.as_mut());
    let participants = seated.chain(roster.bench.iter_mut()).collect();
    attribute_participants(control, tenant_id, event_id, participants).await;
}

/// Resolves and durably records the guild attribution for a join.
///
/// Fails closed: an explicit choice must be one of the eligible guilds, and an
/// ambiguous alliance join without a choice is rejected with the guild list.
/// A previously stored attribution is authoritative; it cannot be switched.
pub async fn resolve_join_attribution(
    control: &DatabaseConnection,
    tenant_id: &str,
    event_id: i64,
    discord_id: &str,
    requested: Option<&str>,
) -> Result<String, AppError> {
    let (canonical_tenant, canonical_event) =
        canonical_event_origin(control, tenant_id, event_id).await?;
    if let Some(stored) =
        stored_attribution(control, &canonical_tenant, canonical_event, discord_id).await?
    {
        if let Some(requested) = requested.filter(|guild| !guild.is_empty())
            && requested != stored
        {
            return Err(AppError::Conflict(format!(
                "this signup is already attributed to guild {stored}; the attribution cannot be changed"
            )));
        }
        return Ok(stored);
    }

    let kind = tenant_kind(control, tenant_id).await?;
    let guild = if kind == "guild" {
        tenant_id.to_owned()
    } else {
        let eligible = eligible_participation_guilds(control, tenant_id, discord_id).await?;
        if eligible.is_empty() {
            return Err(AppError::Conflict(
                "you are not a member of any active guild in this alliance; join a member guild server or ask the alliance staff to add you"
                    .to_owned(),
            ));
        }
        if let Some(requested) = requested.map(str::trim).filter(|guild| !guild.is_empty()) {
            if !eligible.iter().any(|guild| guild.tenant_id == requested) {
                return Err(AppError::Forbidden(format!(
                    "guild {requested} is not one of your eligible guilds for this event"
                )));
            }
            requested.to_owned()
        } else {
            if eligible.len() > 1 {
                let choices = eligible
                    .iter()
                    .map(|guild| format!("{} ({})", guild.name, guild.tenant_id))
                    .collect::<Vec<_>>()
                    .join(", ");
                return Err(AppError::Conflict(format!(
                    "you are a member of multiple guilds in this alliance; pass guild_tenant_id to choose one of: {choices}"
                )));
            }
            eligible[0].tenant_id.clone()
        }
    };

    control
        .execute(Statement::from_sql_and_values(
            DbBackend::Postgres,
            "INSERT INTO event_participant_attributions \
             (id, source_tenant_id, source_event_id, discord_id, guild_tenant_id) \
             VALUES ($1, $2, $3, $4, $5) \
             ON CONFLICT (source_tenant_id, source_event_id, discord_id) DO NOTHING",
            [
                uuid::Uuid::new_v4().into(),
                canonical_tenant.clone().into(),
                canonical_event.into(),
                discord_id.into(),
                guild.clone().into(),
            ],
        ))
        .await?;
    // A concurrent join may have won the insert; the stored row is authoritative.
    Ok(
        stored_attribution(control, &canonical_tenant, canonical_event, discord_id)
            .await?
            .unwrap_or(guild),
    )
}

/// The `kind` column of a control-plane tenant.
pub async fn tenant_kind(
    control: &DatabaseConnection,
    tenant_id: &str,
) -> Result<String, AppError> {
    let row = control
        .query_one(Statement::from_sql_and_values(
            DbBackend::Postgres,
            "SELECT kind FROM tenants WHERE id = $1",
            [tenant_id.into()],
        ))
        .await?;
    row.map(|row| row.try_get_by_index(0))
        .transpose()
        .map_err(AppError::Database)?
        .ok_or_else(|| AppError::NotFound(format!("tenant {tenant_id} not found")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::postgres::{
        connect_with_search_path, drop_schema, ensure_schema,
        test_support::{try_admin_db, unique_schema},
    };
    use sea_orm::{ConnectionTrait, DatabaseConnection, DbBackend};
    use sea_orm_migration::MigratorTrait;

    struct ControlWorld {
        admin: DatabaseConnection,
        control: DatabaseConnection,
        schema: String,
    }

    impl ControlWorld {
        async fn new() -> Option<Self> {
            let (url, admin) = try_admin_db().await?;
            let schema = unique_schema("attr_ctl");
            ensure_schema(&admin, &schema).await.expect("create schema");
            let control = connect_with_search_path(&url, &schema)
                .await
                .expect("connect schema");
            crate::control_migration::Migrator::up(&control, None)
                .await
                .expect("apply control migrations");
            let world = Self {
                admin,
                control,
                schema,
            };
            world.insert_tenant("alliance", "alliance").await;
            world.insert_tenant("guild-a", "guild").await;
            world.insert_tenant("guild-b", "guild").await;
            world
                .control
                .execute(Statement::from_sql_and_values(
                    DbBackend::Postgres,
                    "INSERT INTO alliance_memberships (alliance_tenant_id, guild_tenant_id, status) \
                     VALUES ('alliance','guild-a','active'), ('alliance','guild-b','active')",
                    [],
                ))
                .await
                .expect("memberships");
            Some(world)
        }

        async fn insert_tenant(&self, id: &str, kind: &str) {
            self.control
                .execute(Statement::from_sql_and_values(
                    DbBackend::Postgres,
                    "INSERT INTO tenants (id, slug, name, schema_name, status, kind) \
                     VALUES ($1,$1,$1,$1,'active',$2)",
                    [id.into(), kind.into()],
                ))
                .await
                .expect("insert tenant");
        }

        async fn add_membership(&self, discord_id: &str, tenant_id: &str) {
            self.control
                .execute(Statement::from_sql_and_values(
                    DbBackend::Postgres,
                    "INSERT INTO user_tenant_memberships (discord_id, tenant_id) VALUES ($1,$2)",
                    [discord_id.into(), tenant_id.into()],
                ))
                .await
                .expect("user membership");
        }

        async fn link(&self, source: (&str, i64), mirror: (&str, i64)) {
            self.control
                .execute(Statement::from_sql_and_values(
                    DbBackend::Postgres,
                    "INSERT INTO event_sync_links \
                     (id, source_tenant_id, source_event_id, mirror_tenant_id, mirror_event_id) \
                     VALUES ($1,$2,$3,$4,$5)",
                    [
                        uuid::Uuid::new_v4().into(),
                        source.0.into(),
                        source.1.into(),
                        mirror.0.into(),
                        mirror.1.into(),
                    ],
                ))
                .await
                .expect("event sync link");
        }

        async fn attribute(&self, source: (&str, i64), discord_id: &str, guild: &str) {
            self.control
                .execute(Statement::from_sql_and_values(
                    DbBackend::Postgres,
                    "INSERT INTO event_participant_attributions \
                     (id, source_tenant_id, source_event_id, discord_id, guild_tenant_id) \
                     VALUES ($1,$2,$3,$4,$5)",
                    [
                        uuid::Uuid::new_v4().into(),
                        source.0.into(),
                        source.1.into(),
                        discord_id.into(),
                        guild.into(),
                    ],
                ))
                .await
                .expect("attribution");
        }

        async fn rename(&self, tenant_id: &str, name: &str) {
            self.control
                .execute(Statement::from_sql_and_values(
                    DbBackend::Postgres,
                    "UPDATE tenants SET name = $2 WHERE id = $1",
                    [tenant_id.into(), name.into()],
                ))
                .await
                .expect("rename tenant");
        }

        async fn close(self) {
            self.control.close().await.expect("close control");
            drop_schema(&self.admin, &self.schema)
                .await
                .expect("drop schema");
        }
    }

    #[tokio::test]
    async fn guild_context_is_always_attributed_to_the_current_tenant() {
        let Some(world) = ControlWorld::new().await else {
            return;
        };
        let guilds =
            eligible_participation_guilds(&world.control, "guild-a", "discord-anyone").await;
        assert_eq!(guilds.unwrap().len(), 1);
        let attributed =
            resolve_join_attribution(&world.control, "guild-a", 7, "discord-anyone", None)
                .await
                .expect("guild join auto-selects the current tenant");
        assert_eq!(attributed, "guild-a");
        world.close().await;
    }

    #[tokio::test]
    async fn alliance_context_handles_zero_one_and_many_eligible_guilds() {
        let Some(world) = ControlWorld::new().await else {
            return;
        };
        // Zero: no membership at all.
        assert!(matches!(
            eligible_participation_guilds(&world.control, "alliance", "discord-none").await,
            Ok(guilds) if guilds.is_empty()
        ));
        assert!(matches!(
            resolve_join_attribution(&world.control, "alliance", 7, "discord-none", None).await,
            Err(AppError::Conflict(_))
        ));

        // One: auto-selected without a choice.
        world.add_membership("discord-single", "guild-a").await;
        let guilds = eligible_participation_guilds(&world.control, "alliance", "discord-single")
            .await
            .unwrap();
        assert_eq!(guilds.len(), 1);
        assert_eq!(guilds[0].tenant_id, "guild-a");
        let attributed =
            resolve_join_attribution(&world.control, "alliance", 7, "discord-single", None)
                .await
                .expect("single guild auto-selects");
        assert_eq!(attributed, "guild-a");

        // Many: a missing choice is a conflict that lists the guilds.
        world.add_membership("discord-multi", "guild-a").await;
        world.add_membership("discord-multi", "guild-b").await;
        let conflict =
            resolve_join_attribution(&world.control, "alliance", 7, "discord-multi", None)
                .await
                .expect_err("ambiguous join without a choice");
        assert!(
            matches!(conflict, AppError::Conflict(ref message) if message.contains("guild-a") && message.contains("guild-b"))
        );
        let attributed = resolve_join_attribution(
            &world.control,
            "alliance",
            7,
            "discord-multi",
            Some("guild-b"),
        )
        .await
        .expect("explicit choice resolves");
        assert_eq!(attributed, "guild-b");

        // An explicit choice must be one of the caller's eligible guilds.
        assert!(matches!(
            resolve_join_attribution(
                &world.control,
                "alliance",
                8,
                "discord-single",
                Some("guild-b"),
            )
            .await,
            Err(AppError::Forbidden(_))
        ));

        // An explicit choice cannot bypass an empty eligibility list.
        assert!(matches!(
            resolve_join_attribution(
                &world.control,
                "alliance",
                7,
                "discord-none",
                Some("guild-a"),
            )
            .await,
            Err(AppError::Conflict(_))
        ));
        world.close().await;
    }

    #[tokio::test]
    async fn stored_attribution_is_durable_and_cannot_be_switched() {
        let Some(world) = ControlWorld::new().await else {
            return;
        };
        world.add_membership("discord-user", "guild-a").await;
        resolve_join_attribution(&world.control, "alliance", 9, "discord-user", None)
            .await
            .expect("initial join");
        let stored = stored_attribution(&world.control, "alliance", 9, "discord-user")
            .await
            .expect("stored attribution");
        assert_eq!(stored.as_deref(), Some("guild-a"));
        // Even after joining a second guild, the recorded attribution wins and
        // cannot be switched by passing a different choice.
        world.add_membership("discord-user", "guild-b").await;
        let again = resolve_join_attribution(
            &world.control,
            "alliance",
            9,
            "discord-user",
            Some("guild-b"),
        )
        .await
        .expect_err("attribution cannot be switched");
        assert!(matches!(again, AppError::Conflict(_)));
        let unchanged = resolve_join_attribution(
            &world.control,
            "alliance",
            9,
            "discord-user",
            Some("guild-a"),
        )
        .await
        .expect("rejoin reuses the stored attribution");
        assert_eq!(unchanged, "guild-a");
        world.close().await;
    }

    #[tokio::test]
    async fn participant_guilds_are_identical_on_the_origin_and_every_copy() {
        let Some(world) = ControlWorld::new().await else {
            return;
        };
        world.rename("guild-a", "Guild A").await;
        world.rename("guild-b", "Guild B").await;
        world.link(("alliance", 7), ("guild-a", 70)).await;
        world.link(("alliance", 7), ("guild-b", 71)).await;
        world.attribute(("alliance", 7), "d-a", "guild-a").await;
        world.attribute(("alliance", 7), "d-b", "guild-b").await;

        let asked = ["d-a", "d-b", "d-legacy"];
        let mut seen = Vec::new();
        for (tenant, event) in [("alliance", 7), ("guild-a", 70), ("guild-b", 71)] {
            let guilds = participant_guilds(&world.control, tenant, event, &asked)
                .await
                .expect("participant guilds");
            assert_eq!(guilds.len(), 2, "{tenant}: unattributed signups are absent");
            assert!(!guilds.contains_key("d-legacy"));
            seen.push(guilds);
        }
        assert_eq!(seen[0], seen[1]);
        assert_eq!(seen[0], seen[2]);
        assert_eq!(
            seen[0]["d-b"],
            ParticipationGuild {
                tenant_id: "guild-b".to_owned(),
                name: "Guild B".to_owned(),
            }
        );
        world.close().await;
    }

    #[tokio::test]
    async fn participant_guilds_are_absent_on_an_event_that_is_not_linked() {
        let Some(world) = ControlWorld::new().await else {
            return;
        };
        // A plain guild event still records the signup against its own guild, but nothing
        // links it to another tenant, so there is no guild to tell apart.
        world.attribute(("guild-a", 5), "d-a", "guild-a").await;
        let guilds = participant_guilds(&world.control, "guild-a", 5, &["d-a"])
            .await
            .expect("participant guilds");
        assert!(guilds.is_empty());
        assert!(
            participant_guilds(&world.control, "guild-a", 5, &[])
                .await
                .expect("empty roster")
                .is_empty()
        );
        world.close().await;
    }

    #[tokio::test]
    async fn participant_guilds_use_a_constant_number_of_control_queries() {
        let Some(mut world) = ControlWorld::new().await else {
            return;
        };
        world.link(("alliance", 7), ("guild-a", 70)).await;
        let ids: Vec<String> = (0..40).map(|index| format!("d-{index}")).collect();
        for (index, id) in ids.iter().enumerate() {
            let guild = if index % 2 == 0 { "guild-a" } else { "guild-b" };
            world.attribute(("alliance", 7), id, guild).await;
        }
        let queries = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let counter = queries.clone();
        world.control.set_metric_callback(move |_| {
            counter.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        });

        let asked: Vec<&str> = ids.iter().map(String::as_str).collect();
        let guilds = participant_guilds(&world.control, "guild-a", 70, &asked)
            .await
            .expect("participant guilds");
        assert_eq!(guilds.len(), 40);
        assert_eq!(
            queries.load(std::sync::atomic::Ordering::SeqCst),
            2,
            "one canonical-origin lookup plus one batched read, whatever the roster size"
        );
        world.close().await;
    }
}
