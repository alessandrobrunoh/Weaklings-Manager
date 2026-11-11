//! Parties of an event: seat derivation, keys, comp changes, removal, extra roles and signup
//! options, on a migrated SQLite database.

use sea_orm::ActiveValue::Set;
use sea_orm::{ActiveModelTrait, ColumnTrait, DatabaseConnection, EntityTrait, QueryFilter};

use backend_combat::seats::EventSeatKey;
use backend_core::errors::AppError;
use backend_entities::comps::{
    build::ActiveModel as BuildActiveModel, build_category::ActiveModel as BuildCategoryActiveModel,
    comp::ActiveModel as CompActiveModel, comp_build::ActiveModel as CompBuildActiveModel,
    comp_category::ActiveModel as CompCategoryActiveModel,
};
use backend_entities::events::{event, event_party, event_roster_assignment, event_roster_role};
use backend_entities::users::ActiveModel as UserActiveModel;

use super::models::{
    AssignRosterSeatRequest, CreateEventPartyRequest, CreateEventRequest,
    CreateEventRosterRoleRequest, EventRosterView, ParticipateEventRequest,
    ReorderEventPartiesRequest, UpdateEventPartyRequest, UpdateEventRequest,
};
use super::service::EventService;

/// A database with a creator, three builds and the helpers to make comps and events.
struct Fixture {
    db: DatabaseConnection,
    creator: i64,
    category: i64,
    comp_category: i64,
    build_a: i64,
    build_b: i64,
    build_c: i64,
}

impl Fixture {
    async fn new() -> Self {
        let db = backend_migration::testkit::migrated_sqlite().await;
        let creator = Self::user(&db, "creator").await;
        let category = BuildCategoryActiveModel {
            name: Set("party-builds".to_string()),
            slug: Set("party-builds".to_string()),
            ..Default::default()
        }
        .insert(&db)
        .await
        .expect("build category")
        .id;
        let comp_category = CompCategoryActiveModel {
            name: Set("party-comps".to_string()),
            slug: Set("party-comps".to_string()),
            ..Default::default()
        }
        .insert(&db)
        .await
        .expect("comp category")
        .id;
        let mut fixture = Self {
            db,
            creator,
            category,
            comp_category,
            build_a: 0,
            build_b: 0,
            build_c: 0,
        };
        fixture.build_a = fixture.build("build-a").await;
        fixture.build_b = fixture.build("build-b").await;
        fixture.build_c = fixture.build("build-c").await;
        fixture
    }

    async fn user(db: &DatabaseConnection, name: &str) -> i64 {
        UserActiveModel {
            username: Set(name.to_string()),
            email: Set(format!("{name}@example.com")),
            role: Set("User".to_string()),
            ..Default::default()
        }
        .insert(db)
        .await
        .expect("user")
        .id
    }

    async fn member(&self, name: &str) -> i64 {
        Self::user(&self.db, name).await
    }

    async fn build(&self, name: &str) -> i64 {
        BuildActiveModel {
            name: Set(name.to_string()),
            role: Set("dps".to_string()),
            category_id: Set(self.category),
            created_by: Set(self.creator),
            ..Default::default()
        }
        .insert(&self.db)
        .await
        .expect("build")
        .id
    }

    async fn comp(&self, name: &str, parent_id: Option<i64>, builds: &[(i64, i32)]) -> i64 {
        let comp_id = CompActiveModel {
            name: Set(name.to_string()),
            category_id: Set(self.comp_category),
            parent_id: Set(parent_id),
            created_by: Set(self.creator),
            ..Default::default()
        }
        .insert(&self.db)
        .await
        .expect("comp")
        .id;
        for (build_id, quantity) in builds {
            CompBuildActiveModel {
                comp_id: Set(comp_id),
                build_id: Set(*build_id),
                quantity: Set(*quantity),
                ..Default::default()
            }
            .insert(&self.db)
            .await
            .expect("comp build");
        }
        comp_id
    }

    /// An organized event created the normal way, so it gets its first party.
    async fn event(&self, comp_id: i64) -> i64 {
        EventService::new()
            .create_event(
                &self.db,
                self.creator,
                CreateEventRequest {
                    title: "Party event".to_string(),
                    description: None,
                    call_to_arms: false,
                    regear: false,
                    event_kind: None,
                    comp_id: Some(comp_id),
                    player_cap: None,
                    event_date_utc: Some("2026-12-20T20:00:00Z".to_string()),
                    mass_time_utc: None,
                    start_time_utc: None,
                    discord_role_ids: Vec::new(),
                    create_split: false,
                    island_tab_id: None,
                    origin_guild_id: None,
                    ping_alliance: false,
                    vod_forum_post_enabled: false,
                    discord_delivery: "message".to_string(),
                },
            )
            .await
            .expect("event")
            .id
    }

    async fn roster(&self, event_id: i64) -> EventRosterView {
        EventService::new()
            .get_roster(&self.db, event_id)
            .await
            .expect("roster")
    }

    /// Adds a party and returns the new roster.
    async fn add_party(&self, event_id: i64, comp_id: i64, name: Option<&str>) -> EventRosterView {
        let version = self.roster(event_id).await.roster_version;
        EventService::new()
            .create_event_party(
                &self.db,
                event_id,
                CreateEventPartyRequest {
                    comp_id,
                    name: name.map(str::to_string),
                    expected_roster_version: version,
                },
            )
            .await
            .expect("party created");
        self.roster(event_id).await
    }

    async fn sign_up(&self, event_id: i64, user_id: i64, build_id: i64) {
        EventService::new()
            .participate_with_roster_version(
                &self.db,
                event_id,
                user_id,
                ParticipateEventRequest {
                    primary_build_id: Some(build_id),
                    secondary_build_id: None,
                },
            )
            .await
            .expect("signup");
    }

    async fn seat(&self, event_id: i64, user_id: i64, key: &str) {
        let version = self.roster(event_id).await.roster_version;
        EventService::new()
            .assign_roster_seat(
                &self.db,
                event_id,
                key,
                AssignRosterSeatRequest {
                    user_id,
                    expected_roster_version: version,
                },
                self.creator,
            )
            .await
            .expect("seat assigned");
    }
}

fn key(party_id: i64, build_id: i64, ordinal: i32) -> String {
    EventSeatKey {
        party_id,
        build_id,
        ordinal,
    }
    .render()
}

fn occupant(roster: &EventRosterView, seat_key: &str) -> Option<i64> {
    roster
        .seats
        .iter()
        .find(|seat| seat.key == seat_key)
        .and_then(|seat| seat.participant.as_ref())
        .map(|participant| participant.user_id)
}

#[tokio::test]
async fn creating_an_event_creates_its_first_party() {
    let fx = Fixture::new().await;
    let comp = fx.comp("main", None, &[(fx.build_a, 2)]).await;
    let event_id = fx.event(comp).await;

    let roster = fx.roster(event_id).await;
    assert_eq!(roster.parties.len(), 1);
    let party = &roster.parties[0];
    assert_eq!((party.position, party.comp_id, party.seat_count), (1, comp, 2));
    assert_eq!(party.name, None);
    assert_eq!(party.board_party_numbers, vec![1]);
    assert_eq!(roster.seats[0].key, key(party.id, fx.build_a, 1));
    assert_eq!(roster.seats[1].key, key(party.id, fx.build_a, 2));
}

#[tokio::test]
async fn parties_continue_board_numbers_and_a_large_comp_spans_two() {
    let fx = Fixture::new().await;
    let big = fx.comp("big", None, &[(fx.build_a, 25)]).await;
    let small = fx.comp("small", None, &[(fx.build_b, 2)]).await;
    let event_id = fx.event(big).await;

    let roster = fx.add_party(event_id, small, Some("  Brawl ")).await;

    assert_eq!(roster.seats.len(), 27);
    assert_eq!(roster.parties[0].board_party_numbers, vec![1, 2]);
    assert_eq!(roster.parties[1].board_party_numbers, vec![3]);
    assert_eq!(roster.parties[1].name.as_deref(), Some("Brawl"));
    let board = |index: usize| {
        let seat = &roster.seats[index];
        (seat.party_number, seat.position)
    };
    assert_eq!(board(0), (1, 1));
    assert_eq!(board(19), (1, 20));
    assert_eq!(board(20), (2, 1));
    assert_eq!(board(24), (2, 5));
    // The next party starts on a fresh board party, positions restart.
    assert_eq!(board(25), (3, 1));
    assert_eq!(board(26), (3, 2));
    let second = &roster.seats[25];
    assert_eq!(second.party_id, roster.parties[1].id);
    assert_eq!(second.party_position, 2);
    assert_eq!(second.party_name.as_deref(), Some("Brawl"));
    // Ordinals count per build inside a party.
    assert_eq!(second.key, key(roster.parties[1].id, fx.build_b, 1));
    assert_eq!(roster.seats[26].key, key(roster.parties[1].id, fx.build_b, 2));
}

#[tokio::test]
async fn seat_keys_survive_reordering_the_parties() {
    let fx = Fixture::new().await;
    let first = fx.comp("first", None, &[(fx.build_a, 1)]).await;
    let second = fx.comp("second", None, &[(fx.build_b, 1)]).await;
    let event_id = fx.event(first).await;
    let roster = fx.add_party(event_id, second, None).await;
    let (p1, p2) = (roster.parties[0].id, roster.parties[1].id);
    let member = fx.member("member").await;
    fx.sign_up(event_id, member, fx.build_b).await;
    let seat_key = key(p2, fx.build_b, 1);
    fx.seat(event_id, member, &seat_key).await;

    let version = fx.roster(event_id).await.roster_version;
    EventService::new()
        .reorder_event_parties(
            &fx.db,
            event_id,
            ReorderEventPartiesRequest {
                party_ids: vec![p2, p1],
                expected_roster_version: version,
            },
        )
        .await
        .expect("reorder");

    let roster = fx.roster(event_id).await;
    assert_eq!(
        roster.parties.iter().map(|p| (p.id, p.position)).collect::<Vec<_>>(),
        vec![(p2, 1), (p1, 2)]
    );
    assert_eq!(occupant(&roster, &seat_key), Some(member), "the assignment survived");
    assert_eq!(roster.seats[0].key, seat_key, "and its seat moved to the front");
    assert_eq!(roster.seats[0].party_number, 1);
    // The first party's comp is the event's comp.
    let stored = event::Entity::find_by_id(event_id)
        .one(&fx.db)
        .await
        .expect("event")
        .expect("row");
    assert_eq!(stored.comp_id, Some(second));

    // A list that is not exactly the event's parties is refused.
    let version = roster.roster_version;
    let refused = EventService::new()
        .reorder_event_parties(
            &fx.db,
            event_id,
            ReorderEventPartiesRequest {
                party_ids: vec![p1],
                expected_roster_version: version,
            },
        )
        .await;
    assert!(matches!(refused, Err(AppError::Validation(_))));
}

#[tokio::test]
async fn changing_a_comp_keeps_matching_seats_and_reports_the_unseated() {
    let fx = Fixture::new().await;
    let wide = fx.comp("wide", None, &[(fx.build_a, 2), (fx.build_b, 1)]).await;
    let narrow = fx.comp("narrow", None, &[(fx.build_a, 1)]).await;
    let event_id = fx.event(wide).await;
    let roster = fx.roster(event_id).await;
    let party_id = roster.parties[0].id;
    let (u1, u2, u3) = (
        fx.member("u1").await,
        fx.member("u2").await,
        fx.member("u3").await,
    );
    fx.sign_up(event_id, u1, fx.build_a).await;
    fx.sign_up(event_id, u2, fx.build_a).await;
    fx.sign_up(event_id, u3, fx.build_b).await;
    fx.seat(event_id, u1, &key(party_id, fx.build_a, 1)).await;
    fx.seat(event_id, u2, &key(party_id, fx.build_a, 2)).await;
    fx.seat(event_id, u3, &key(party_id, fx.build_b, 1)).await;

    let version = fx.roster(event_id).await.roster_version;
    let (new_version, unseated) = EventService::new()
        .update_event_party(
            &fx.db,
            event_id,
            party_id,
            UpdateEventPartyRequest {
                comp_id: Some(narrow),
                name: Some("Clap".to_string()),
                expected_roster_version: version,
            },
        )
        .await
        .expect("party updated");

    assert_eq!(new_version, version + 1);
    assert_eq!(unseated, 2, "A2 and B1 no longer exist in the narrow comp");
    let roster = fx.roster(event_id).await;
    assert_eq!(roster.parties[0].comp_id, narrow);
    assert_eq!(roster.parties[0].name.as_deref(), Some("Clap"));
    assert_eq!(occupant(&roster, &key(party_id, fx.build_a, 1)), Some(u1));
    let mut bench: Vec<i64> = roster.bench.iter().map(|p| p.user_id).collect();
    bench.sort_unstable();
    assert_eq!(bench, vec![u2, u3]);
    let stored = event::Entity::find_by_id(event_id)
        .one(&fx.db)
        .await
        .expect("event")
        .expect("row");
    assert_eq!(stored.comp_id, Some(narrow), "events.comp_id follows the first party");

    // An empty name clears the label, a stale version is a conflict.
    let version = roster.roster_version;
    EventService::new()
        .update_event_party(
            &fx.db,
            event_id,
            party_id,
            UpdateEventPartyRequest {
                comp_id: None,
                name: Some(String::new()),
                expected_roster_version: version,
            },
        )
        .await
        .expect("name cleared");
    assert_eq!(fx.roster(event_id).await.parties[0].name, None);
    let stale = EventService::new()
        .update_event_party(
            &fx.db,
            event_id,
            party_id,
            UpdateEventPartyRequest {
                comp_id: None,
                name: Some("X".to_string()),
                expected_roster_version: version,
            },
        )
        .await;
    assert!(matches!(stale, Err(AppError::Conflict(_))));
}

#[tokio::test]
async fn removing_a_party_unseats_its_members_and_the_last_party_stays() {
    let fx = Fixture::new().await;
    let first = fx.comp("first", None, &[(fx.build_a, 1)]).await;
    let second = fx.comp("second", None, &[(fx.build_b, 1)]).await;
    let third = fx.comp("third", None, &[(fx.build_c, 1)]).await;
    let event_id = fx.event(first).await;
    fx.add_party(event_id, second, None).await;
    let roster = fx.add_party(event_id, third, None).await;
    let ids: Vec<i64> = roster.parties.iter().map(|p| p.id).collect();
    let service = EventService::new();
    // An extra role on the party that is about to go.
    service
        .create_event_roster_role(
            &fx.db,
            event_id,
            CreateEventRosterRoleRequest {
                build_id: fx.build_a,
                party_id: Some(ids[1]),
            },
        )
        .await
        .expect("extra role");
    let member = fx.member("member").await;
    fx.sign_up(event_id, member, fx.build_b).await;
    fx.seat(event_id, member, &key(ids[1], fx.build_b, 1)).await;

    let version = fx.roster(event_id).await.roster_version;
    let (_, unseated) = service
        .delete_event_party(&fx.db, event_id, ids[1], version)
        .await
        .expect("party removed");

    assert_eq!(unseated, 1);
    let roster = fx.roster(event_id).await;
    assert_eq!(
        roster.parties.iter().map(|p| (p.id, p.position)).collect::<Vec<_>>(),
        vec![(ids[0], 1), (ids[2], 2)],
        "positions close the gap"
    );
    assert_eq!(roster.bench.len(), 1);
    assert_eq!(
        event_roster_role::Entity::find()
            .filter(event_roster_role::Column::EventId.eq(event_id))
            .all(&fx.db)
            .await
            .expect("roles")
            .len(),
        0,
        "the party's extra role went with it"
    );
    assert_eq!(
        event_roster_assignment::Entity::find()
            .filter(event_roster_assignment::Column::EventId.eq(event_id))
            .all(&fx.db)
            .await
            .expect("assignments")
            .len(),
        0
    );

    let version = roster.roster_version;
    service
        .delete_event_party(&fx.db, event_id, ids[2], version)
        .await
        .expect("second to last party removed");
    let version = fx.roster(event_id).await.roster_version;
    let last = service
        .delete_event_party(&fx.db, event_id, ids[0], version)
        .await;
    assert!(
        matches!(last, Err(AppError::Conflict(_))),
        "the last party cannot be removed: {last:?}"
    );
    assert_eq!(
        event_party::Entity::find()
            .filter(event_party::Column::EventId.eq(event_id))
            .all(&fx.db)
            .await
            .expect("parties")
            .len(),
        1
    );
}

#[tokio::test]
async fn an_extra_role_goes_on_the_chosen_party() {
    let fx = Fixture::new().await;
    let first = fx.comp("first", None, &[(fx.build_a, 1)]).await;
    let second = fx.comp("second", None, &[(fx.build_b, 1)]).await;
    let event_id = fx.event(first).await;
    let roster = fx.add_party(event_id, second, None).await;
    let (p1, p2) = (roster.parties[0].id, roster.parties[1].id);
    let service = EventService::new();

    let on_p1 = service
        .create_event_roster_role(
            &fx.db,
            event_id,
            CreateEventRosterRoleRequest {
                build_id: fx.build_c,
                party_id: Some(p1),
            },
        )
        .await
        .expect("role on the first party");
    assert_eq!(on_p1.party_id, Some(p1));
    // No party given: the last one.
    let default = service
        .create_event_roster_role(
            &fx.db,
            event_id,
            CreateEventRosterRoleRequest {
                build_id: fx.build_a,
                party_id: None,
            },
        )
        .await
        .expect("role on the default party");
    assert_eq!(default.party_id, Some(p2));
    let unknown = service
        .create_event_roster_role(
            &fx.db,
            event_id,
            CreateEventRosterRoleRequest {
                build_id: fx.build_b,
                party_id: Some(p2 + 1000),
            },
        )
        .await;
    assert!(matches!(unknown, Err(AppError::NotFound(_))));

    let roster = fx.roster(event_id).await;
    let keys: Vec<&str> = roster.seats.iter().map(|seat| seat.key.as_str()).collect();
    assert_eq!(
        keys,
        vec![
            key(p1, fx.build_a, 1).as_str(),
            key(p1, fx.build_c, 1).as_str(),
            key(p2, fx.build_b, 1).as_str(),
            // Ordinals restart per party: the first A of party 2.
            key(p2, fx.build_a, 1).as_str(),
        ]
    );
    assert_eq!(
        roster.parties.iter().map(|p| p.seat_count).collect::<Vec<_>>(),
        vec![2, 2]
    );
    assert_eq!(
        (roster.seats[3].party_number, roster.seats[3].position),
        (2, 2)
    );
}

#[tokio::test]
async fn one_party_resolves_the_comp_variant_and_two_parties_do_not() {
    let fx = Fixture::new().await;
    let base = fx.comp("base", None, &[(fx.build_a, 2)]).await;
    let variant = fx.comp("variant", Some(base), &[(fx.build_a, 4)]).await;
    let event_id = fx.event(base).await;

    let roster = fx.roster(event_id).await;
    assert_eq!(roster.parties[0].active_comp_id, base);
    assert_eq!(roster.seats.len(), 2);

    let member = fx.member("member").await;
    fx.sign_up(event_id, member, fx.build_a).await;
    let roster = fx.roster(event_id).await;
    assert_eq!(roster.active_comp_id, variant, "75% of the base comp is reached");
    assert_eq!(roster.parties[0].active_comp_id, variant);
    assert_eq!(roster.parties[0].comp_id, base, "the stored comp is unchanged");
    assert_eq!(roster.seats.len(), 4);

    let other = fx.comp("other", None, &[(fx.build_b, 1)]).await;
    let roster = fx.add_party(event_id, other, None).await;
    assert_eq!(roster.parties[0].active_comp_id, base, "stored comps are used as-is");
    assert_eq!(roster.seats.len(), 3);
}

#[tokio::test]
async fn signup_options_group_the_builds_by_party() {
    let fx = Fixture::new().await;
    let first = fx.comp("front line", None, &[(fx.build_a, 1), (fx.build_b, 1)]).await;
    let second = fx.comp("back line", None, &[(fx.build_b, 2)]).await;
    let event_id = fx.event(first).await;
    fx.add_party(event_id, second, Some("Brawl")).await;
    let member = fx.member("member").await;

    let options = EventService::new()
        .get_event_signup_options(&fx.db, event_id, member)
        .await
        .expect("options");

    let flat: Vec<(i64, i32)> = options.builds.iter().map(|b| (b.build_id, b.quantity)).collect();
    assert_eq!(flat, vec![(fx.build_a, 1), (fx.build_b, 3)], "quantities are summed");
    assert_eq!(options.parties.len(), 2);
    let (p1, p2) = (&options.parties[0], &options.parties[1]);
    assert_eq!((p1.position, p1.name.as_deref(), p1.comp_name.as_str()), (1, None, "front line"));
    assert_eq!((p2.position, p2.name.as_deref(), p2.comp_name.as_str()), (2, Some("Brawl"), "back line"));
    assert_eq!(
        p1.builds.iter().map(|b| (b.build_id, b.quantity)).collect::<Vec<_>>(),
        vec![(fx.build_a, 1), (fx.build_b, 1)]
    );
    assert_eq!(
        p2.builds.iter().map(|b| (b.build_id, b.quantity)).collect::<Vec<_>>(),
        vec![(fx.build_b, 2)]
    );
}

#[tokio::test]
async fn signing_up_uses_the_seats_of_every_party() {
    let fx = Fixture::new().await;
    let first = fx.comp("first", None, &[(fx.build_a, 1)]).await;
    let second = fx.comp("second", None, &[(fx.build_a, 1)]).await;
    let event_id = fx.event(first).await;
    fx.add_party(event_id, second, None).await;
    let (u1, u2, u3) = (
        fx.member("u1").await,
        fx.member("u2").await,
        fx.member("u3").await,
    );

    fx.sign_up(event_id, u1, fx.build_a).await;
    fx.sign_up(event_id, u2, fx.build_a).await;
    let full = EventService::new()
        .participate_with_roster_version(
            &fx.db,
            event_id,
            u3,
            ParticipateEventRequest {
                primary_build_id: Some(fx.build_a),
                secondary_build_id: None,
            },
        )
        .await;
    assert!(
        matches!(full, Err(AppError::Validation(_))),
        "two seats of build A across the parties, a third signup is refused"
    );
}

#[tokio::test]
async fn editing_the_event_comp_changes_the_first_party() {
    let fx = Fixture::new().await;
    let old = fx.comp("old", None, &[(fx.build_a, 1)]).await;
    let new = fx.comp("new", None, &[(fx.build_b, 1)]).await;
    let event_id = fx.event(old).await;
    let party_id = fx.roster(event_id).await.parties[0].id;
    let member = fx.member("member").await;
    fx.sign_up(event_id, member, fx.build_a).await;
    fx.seat(event_id, member, &key(party_id, fx.build_a, 1)).await;

    EventService::new()
        .update_event(
            &fx.db,
            event_id,
            UpdateEventRequest {
                title: None,
                description: None,
                call_to_arms: None,
                regear: None,
                comp_id: Some(new),
                event_date_utc: None,
                mass_time_utc: None,
                start_time_utc: None,
                ping_alliance: None,
                alliance_discord_message_id: None,
            },
        )
        .await
        .expect("event updated");

    let roster = fx.roster(event_id).await;
    assert_eq!(roster.parties[0].comp_id, new);
    assert_eq!(roster.parties[0].id, party_id, "the party is the same row");
    assert_eq!(roster.bench.len(), 1, "A1 does not exist in the new comp");
}
