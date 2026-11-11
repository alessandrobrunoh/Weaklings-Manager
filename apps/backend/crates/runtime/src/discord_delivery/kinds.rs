//! Effect catalogue of the Discord outbox: the only list of effect kinds, their policy,
//! and the coalesce / once keys each kind is deduplicated by.
//!
//! Keys (DO §4, R22): a `once` key is unique forever and makes a one-shot Discord create
//! idempotent; a `coalesce` key is unique while the row is pending and collapses repeated
//! state refreshes into one row. The `key_suffix` carries the schedule epoch, the status or
//! the minute bucket the key needs; a time change therefore yields a new once key (R22).

use std::fmt;

/// Who caused an effect. Stored in `discord_outbox.cause`; it labels rows and never changes
/// the effect list.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Cause {
    /// Web API request.
    Web,
    /// Discord command, button or modal.
    Discord,
    /// Backend scheduler (mass, start, reminder, auto-stop).
    Scheduler,
    /// Sync engine convergence.
    Sync,
    /// Guild settings change.
    Settings,
    /// Drift sweep.
    Reconcile,
    /// Legacy state import.
    Import,
    /// Explicit manual action (for example a manual remind).
    Manual,
}

impl Cause {
    /// Stored label.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Web => "web",
            Self::Discord => "discord",
            Self::Scheduler => "scheduler",
            Self::Sync => "sync",
            Self::Settings => "settings",
            Self::Reconcile => "reconcile",
            Self::Import => "import",
            Self::Manual => "manual",
        }
    }
}

/// Entity an outbox row or a binding refers to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EntityType {
    /// Event id.
    Event,
    /// Split id.
    Split,
    /// Giveaway id.
    Giveaway,
    /// Battle id.
    Battle,
    /// Notification id (DMs).
    Notification,
    /// VOD post, keyed by event id.
    Vod,
    /// Calendar pages (binding only).
    Calendar,
    /// Application panel (binding only, id 0).
    ApplicationPanel,
    /// Tenant singleton: the entity id is always 0.
    Tenant,
}

impl EntityType {
    /// Every entity type, in declaration order.
    pub const ALL: [Self; 9] = [
        Self::Event,
        Self::Split,
        Self::Giveaway,
        Self::Battle,
        Self::Notification,
        Self::Vod,
        Self::Calendar,
        Self::ApplicationPanel,
        Self::Tenant,
    ];

    /// Parses the stored label.
    #[must_use]
    pub fn parse(value: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|kind| kind.as_str() == value)
    }

    /// Stored label.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Event => "event",
            Self::Split => "split",
            Self::Giveaway => "giveaway",
            Self::Battle => "battle",
            Self::Notification => "notification",
            Self::Vod => "vod",
            Self::Calendar => "calendar",
            Self::ApplicationPanel => "application_panel",
            Self::Tenant => "tenant",
        }
    }
}

/// Retry class of an effect (DO §4). Stored nowhere: it documents the reducer contract.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EffectClass {
    /// Idempotent: re-running renders the current state.
    Converge,
    /// Non-idempotent Discord create: needs a `creating` binding and verify on recovery.
    Once,
    /// May answer "not yet" without consuming an attempt.
    Retry,
}

/// Every effect kind. The string form is what `discord_outbox.kind` stores.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EffectKind {
    /// Create or refresh an event announcement, thread and signup card.
    EventUpsert,
    /// Render the final card and close the thread.
    EventClose,
    /// Archive the announcement, keep the binding as deleted.
    EventRemove,
    /// Ensure voice and post the mass notice.
    EventMass,
    /// "Starts in less than one hour" notice (scheduled or manual).
    EventReminder,
    /// Start notice with the live roster.
    EventStart,
    /// Delete the event voice channel once it is empty.
    VoiceRelease,
    /// Delete orphaned event voice channels.
    VoiceSweep,
    /// Rebuild the calendar pages.
    CalendarSync,
    /// Refresh the split summary post.
    SplitUpsert,
    /// Post the giveaway announcement.
    GiveawayPost,
    /// Refresh the giveaway embed (entry count).
    GiveawayUpdate,
    /// Edit the giveaway embed with the result.
    GiveawayResult,
    /// Post a battle embed.
    BattleAnnounce,
    /// Send a direct message.
    DmSend,
    /// Refresh the application panel.
    ApplicationPanel,
    /// Create the VOD forum post.
    VodCreate,
    /// Delete the VOD forum post.
    VodDelete,
}

/// All effect kinds, in catalogue order.
pub const EFFECT_KINDS: [EffectKind; 18] = [
    EffectKind::EventUpsert,
    EffectKind::EventClose,
    EffectKind::EventRemove,
    EffectKind::EventMass,
    EffectKind::EventReminder,
    EffectKind::EventStart,
    EffectKind::VoiceRelease,
    EffectKind::VoiceSweep,
    EffectKind::CalendarSync,
    EffectKind::SplitUpsert,
    EffectKind::GiveawayPost,
    EffectKind::GiveawayUpdate,
    EffectKind::GiveawayResult,
    EffectKind::BattleAnnounce,
    EffectKind::DmSend,
    EffectKind::ApplicationPanel,
    EffectKind::VodCreate,
    EffectKind::VodDelete,
];

/// Attempt budget of most kinds.
pub const DEFAULT_MAX_ATTEMPTS: i32 = 8;
/// Effectively unbounded budget; expiry bounds these rows instead.
pub const UNLIMITED_ATTEMPTS: i32 = i32::MAX;

/// Priority of lifecycle effects (start, close, remove, mass, reminder, voice).
pub const PRIORITY_LIFECYCLE: i16 = 100;
/// Priority of entity refreshes (announcement, split, giveaway).
pub const PRIORITY_ENTITY: i16 = 50;
/// Priority of background posts (DMs, battles, VODs).
pub const PRIORITY_BACKGROUND: i16 = 30;
/// Priority of periodic maintenance (calendar, panel, voice sweep).
pub const PRIORITY_PERIODIC: i16 = 10;

/// Static policy of one effect kind.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Policy {
    /// Retry class.
    pub class: EffectClass,
    /// Entity the kind refers to.
    pub entity: EntityType,
    /// Claim priority, higher first.
    pub priority: i16,
    /// Attempt budget before the row becomes `failed`.
    pub max_attempts: i32,
    /// Kinds of the same entity whose pending rows are superseded when this kind is emitted.
    pub supersedes: &'static [EffectKind],
}

impl EffectKind {
    /// Stored string form, `family.action`.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::EventUpsert => "event.upsert",
            Self::EventClose => "event.close",
            Self::EventRemove => "event.remove",
            Self::EventMass => "event.mass",
            Self::EventReminder => "event.reminder",
            Self::EventStart => "event.start",
            Self::VoiceRelease => "voice.release",
            Self::VoiceSweep => "voice.sweep",
            Self::CalendarSync => "calendar.sync",
            Self::SplitUpsert => "split.upsert",
            Self::GiveawayPost => "giveaway.post",
            Self::GiveawayUpdate => "giveaway.update",
            Self::GiveawayResult => "giveaway.result",
            Self::BattleAnnounce => "battle.announce",
            Self::DmSend => "dm.send",
            Self::ApplicationPanel => "application.panel",
            Self::VodCreate => "vod.create",
            Self::VodDelete => "vod.delete",
        }
    }

    /// Parses the stored string form.
    #[must_use]
    pub fn parse(value: &str) -> Option<Self> {
        EFFECT_KINDS.into_iter().find(|kind| kind.as_str() == value)
    }

    /// Policy table: the only place a kind's class, entity, priority and supersession live.
    #[must_use]
    pub const fn policy(self) -> Policy {
        use EffectClass::{Converge, Once, Retry};
        match self {
            Self::EventUpsert => Policy {
                class: Converge,
                entity: EntityType::Event,
                priority: PRIORITY_ENTITY,
                max_attempts: DEFAULT_MAX_ATTEMPTS,
                supersedes: &[],
            },
            Self::EventClose => Policy {
                class: Converge,
                entity: EntityType::Event,
                priority: PRIORITY_LIFECYCLE,
                max_attempts: DEFAULT_MAX_ATTEMPTS,
                supersedes: &[
                    Self::EventUpsert,
                    Self::EventMass,
                    Self::EventReminder,
                    Self::EventStart,
                ],
            },
            Self::EventRemove => Policy {
                class: Converge,
                entity: EntityType::Event,
                priority: PRIORITY_LIFECYCLE,
                max_attempts: DEFAULT_MAX_ATTEMPTS,
                supersedes: &[
                    Self::EventUpsert,
                    Self::EventClose,
                    Self::EventMass,
                    Self::EventReminder,
                    Self::EventStart,
                ],
            },
            Self::EventMass => Policy {
                class: Once,
                entity: EntityType::Event,
                priority: PRIORITY_LIFECYCLE,
                max_attempts: DEFAULT_MAX_ATTEMPTS,
                supersedes: &[],
            },
            Self::EventReminder => Policy {
                class: Once,
                entity: EntityType::Event,
                priority: PRIORITY_LIFECYCLE,
                max_attempts: DEFAULT_MAX_ATTEMPTS,
                supersedes: &[],
            },
            Self::EventStart => Policy {
                class: Once,
                entity: EntityType::Event,
                priority: PRIORITY_LIFECYCLE,
                max_attempts: DEFAULT_MAX_ATTEMPTS,
                supersedes: &[Self::EventMass, Self::EventReminder],
            },
            Self::VoiceRelease => Policy {
                class: Retry,
                entity: EntityType::Event,
                priority: PRIORITY_LIFECYCLE,
                max_attempts: UNLIMITED_ATTEMPTS,
                supersedes: &[],
            },
            Self::VoiceSweep => Policy {
                class: Converge,
                entity: EntityType::Tenant,
                priority: PRIORITY_PERIODIC,
                max_attempts: DEFAULT_MAX_ATTEMPTS,
                supersedes: &[],
            },
            Self::CalendarSync => Policy {
                class: Converge,
                entity: EntityType::Tenant,
                priority: PRIORITY_PERIODIC,
                max_attempts: DEFAULT_MAX_ATTEMPTS,
                supersedes: &[],
            },
            Self::SplitUpsert => Policy {
                class: Converge,
                entity: EntityType::Split,
                priority: PRIORITY_ENTITY,
                max_attempts: DEFAULT_MAX_ATTEMPTS,
                supersedes: &[],
            },
            Self::GiveawayPost => Policy {
                class: Once,
                entity: EntityType::Giveaway,
                priority: PRIORITY_ENTITY,
                max_attempts: DEFAULT_MAX_ATTEMPTS,
                supersedes: &[],
            },
            Self::GiveawayUpdate => Policy {
                class: Converge,
                entity: EntityType::Giveaway,
                priority: PRIORITY_ENTITY,
                max_attempts: DEFAULT_MAX_ATTEMPTS,
                supersedes: &[],
            },
            Self::GiveawayResult => Policy {
                class: Once,
                entity: EntityType::Giveaway,
                priority: PRIORITY_ENTITY,
                max_attempts: DEFAULT_MAX_ATTEMPTS,
                supersedes: &[Self::GiveawayUpdate],
            },
            Self::BattleAnnounce => Policy {
                class: Once,
                entity: EntityType::Battle,
                priority: PRIORITY_BACKGROUND,
                max_attempts: DEFAULT_MAX_ATTEMPTS,
                supersedes: &[],
            },
            Self::DmSend => Policy {
                class: Once,
                entity: EntityType::Notification,
                priority: PRIORITY_BACKGROUND,
                max_attempts: DEFAULT_MAX_ATTEMPTS,
                supersedes: &[],
            },
            Self::ApplicationPanel => Policy {
                class: Converge,
                entity: EntityType::Tenant,
                priority: PRIORITY_PERIODIC,
                max_attempts: DEFAULT_MAX_ATTEMPTS,
                supersedes: &[],
            },
            Self::VodCreate => Policy {
                class: Once,
                entity: EntityType::Event,
                priority: PRIORITY_BACKGROUND,
                max_attempts: DEFAULT_MAX_ATTEMPTS,
                supersedes: &[],
            },
            Self::VodDelete => Policy {
                class: Converge,
                entity: EntityType::Event,
                priority: PRIORITY_BACKGROUND,
                max_attempts: DEFAULT_MAX_ATTEMPTS,
                supersedes: &[Self::VodCreate],
            },
        }
    }
}

impl fmt::Display for EffectKind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// Deduplication keys of one effect.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Keys {
    /// Unique while the row is pending.
    pub coalesce: Option<String>,
    /// Unique forever.
    pub once: Option<String>,
}

/// A key cannot be built from the arguments given.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum KeyError {
    /// The kind needs a `key_suffix` (schedule epoch, status or bucket) and none was given.
    MissingSuffix(EffectKind),
}

impl fmt::Display for KeyError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::MissingSuffix(kind) => write!(f, "effect {kind} needs a key suffix"),
        }
    }
}

/// Coalesce and once keys of an effect.
///
/// `suffix` is required by the kinds whose key is per schedule or per status: `event.mass`,
/// `event.start`, the scheduled `event.reminder`, the manual remind bucket and
/// `giveaway.result`. Other kinds ignore it.
///
/// # Errors
///
/// Returns [`KeyError::MissingSuffix`] when a suffix-keyed kind is given none.
pub fn keys(
    kind: EffectKind,
    entity_id: i64,
    cause: Cause,
    suffix: Option<&str>,
) -> Result<Keys, KeyError> {
    let need = || suffix.ok_or(KeyError::MissingSuffix(kind));
    let (coalesce, once) = match kind {
        EffectKind::EventUpsert => (Some(format!("event:{entity_id}")), None),
        EffectKind::EventClose | EffectKind::EventRemove => {
            (Some(format!("event-close:{entity_id}")), None)
        }
        EffectKind::EventMass => (None, Some(format!("event:{entity_id}:mass:{}", need()?))),
        EffectKind::EventReminder if cause == Cause::Manual => {
            (Some(format!("event-remind:{entity_id}:{}", need()?)), None)
        }
        EffectKind::EventReminder => (
            None,
            Some(format!("event:{entity_id}:remind1h:{}", need()?)),
        ),
        EffectKind::EventStart => (None, Some(format!("event:{entity_id}:start:{}", need()?))),
        EffectKind::VoiceRelease => (None, Some(format!("event:{entity_id}:voice-release"))),
        EffectKind::VoiceSweep => (Some("voice-sweep:0".to_owned()), None),
        EffectKind::CalendarSync => (Some("calendar:0".to_owned()), None),
        EffectKind::SplitUpsert => (Some(format!("split:{entity_id}")), None),
        EffectKind::GiveawayPost => (None, Some(format!("giveaway:{entity_id}:post"))),
        EffectKind::GiveawayUpdate => (Some(format!("giveaway:{entity_id}")), None),
        EffectKind::GiveawayResult => (
            None,
            Some(format!("giveaway:{entity_id}:result:{}", need()?)),
        ),
        EffectKind::BattleAnnounce => (None, Some(format!("battle:{entity_id}"))),
        EffectKind::DmSend => (None, Some(format!("dm:{entity_id}"))),
        EffectKind::ApplicationPanel => (Some("application-panel:0".to_owned()), None),
        EffectKind::VodCreate => (None, Some(format!("vod:{entity_id}:create"))),
        EffectKind::VodDelete => (Some(format!("vod:{entity_id}")), None),
    };
    Ok(Keys { coalesce, once })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn every_kind_has_a_unique_parseable_name() {
        let names: HashSet<_> = EFFECT_KINDS.iter().map(|kind| kind.as_str()).collect();
        assert_eq!(names.len(), EFFECT_KINDS.len());
        for kind in EFFECT_KINDS {
            assert_eq!(EffectKind::parse(kind.as_str()), Some(kind));
        }
        assert_eq!(EffectKind::parse("event.unknown"), None);
    }

    #[test]
    fn supersession_targets_are_same_entity_and_never_self() {
        for kind in EFFECT_KINDS {
            let policy = kind.policy();
            for target in policy.supersedes {
                assert_ne!(*target, kind, "{kind} supersedes itself");
                assert_eq!(
                    target.policy().entity,
                    policy.entity,
                    "{kind} supersedes {target} of another entity"
                );
            }
        }
    }

    #[test]
    fn classes_and_priorities_follow_the_catalogue() {
        use EffectClass::{Converge, Once, Retry};
        let expected = [
            (EffectKind::EventUpsert, Converge, PRIORITY_ENTITY),
            (EffectKind::EventClose, Converge, PRIORITY_LIFECYCLE),
            (EffectKind::EventRemove, Converge, PRIORITY_LIFECYCLE),
            (EffectKind::EventMass, Once, PRIORITY_LIFECYCLE),
            (EffectKind::EventReminder, Once, PRIORITY_LIFECYCLE),
            (EffectKind::EventStart, Once, PRIORITY_LIFECYCLE),
            (EffectKind::VoiceRelease, Retry, PRIORITY_LIFECYCLE),
            (EffectKind::VoiceSweep, Converge, PRIORITY_PERIODIC),
            (EffectKind::CalendarSync, Converge, PRIORITY_PERIODIC),
            (EffectKind::SplitUpsert, Converge, PRIORITY_ENTITY),
            (EffectKind::GiveawayPost, Once, PRIORITY_ENTITY),
            (EffectKind::GiveawayUpdate, Converge, PRIORITY_ENTITY),
            (EffectKind::GiveawayResult, Once, PRIORITY_ENTITY),
            (EffectKind::BattleAnnounce, Once, PRIORITY_BACKGROUND),
            (EffectKind::DmSend, Once, PRIORITY_BACKGROUND),
            (EffectKind::ApplicationPanel, Converge, PRIORITY_PERIODIC),
            (EffectKind::VodCreate, Once, PRIORITY_BACKGROUND),
            (EffectKind::VodDelete, Converge, PRIORITY_BACKGROUND),
        ];
        assert_eq!(expected.len(), EFFECT_KINDS.len());
        for (kind, class, priority) in expected {
            let policy = kind.policy();
            assert_eq!(policy.class, class, "{kind} class");
            assert_eq!(policy.priority, priority, "{kind} priority");
        }
    }

    #[test]
    fn only_voice_release_is_unbounded_and_tenant_kinds_use_entity_zero_policy() {
        for kind in EFFECT_KINDS {
            let unlimited = kind.policy().max_attempts == UNLIMITED_ATTEMPTS;
            assert_eq!(unlimited, kind == EffectKind::VoiceRelease, "{kind}");
        }
        assert_eq!(EffectKind::VoiceSweep.policy().entity, EntityType::Tenant);
        assert_eq!(EffectKind::CalendarSync.policy().entity, EntityType::Tenant);
        assert_eq!(
            EffectKind::ApplicationPanel.policy().entity,
            EntityType::Tenant
        );
    }

    #[test]
    fn scheduled_mass_key_includes_the_epoch_so_a_postponed_event_is_announced_again() {
        let before = keys(
            EffectKind::EventMass,
            412,
            Cause::Scheduler,
            Some("1700000000"),
        )
        .expect("keys");
        let after = keys(
            EffectKind::EventMass,
            412,
            Cause::Scheduler,
            Some("1700003600"),
        )
        .expect("keys");
        assert_eq!(before.once.as_deref(), Some("event:412:mass:1700000000"));
        assert_ne!(before.once, after.once);
        assert_eq!(before.coalesce, None);
    }

    #[test]
    fn once_kinds_without_a_suffix_are_rejected() {
        for kind in [
            EffectKind::EventMass,
            EffectKind::EventStart,
            EffectKind::EventReminder,
            EffectKind::GiveawayResult,
        ] {
            assert_eq!(
                keys(kind, 1, Cause::Scheduler, None),
                Err(KeyError::MissingSuffix(kind))
            );
        }
    }

    #[test]
    fn manual_reminder_coalesces_per_bucket_and_never_uses_a_once_key() {
        let manual = keys(EffectKind::EventReminder, 9, Cause::Manual, Some("2900")).expect("keys");
        assert_eq!(manual.coalesce.as_deref(), Some("event-remind:9:2900"));
        assert_eq!(manual.once, None);
        let scheduled =
            keys(EffectKind::EventReminder, 9, Cause::Scheduler, Some("1700")).expect("keys");
        assert_eq!(scheduled.once.as_deref(), Some("event:9:remind1h:1700"));
        assert_eq!(scheduled.coalesce, None);
    }

    #[test]
    fn stateful_refreshes_coalesce_by_entity_and_close_shares_one_key_for_remove() {
        let upsert = keys(EffectKind::EventUpsert, 5, Cause::Web, None).expect("keys");
        assert_eq!(upsert.coalesce.as_deref(), Some("event:5"));
        assert_eq!(upsert.once, None);
        let close = keys(EffectKind::EventClose, 5, Cause::Web, None).expect("keys");
        let remove = keys(EffectKind::EventRemove, 5, Cause::Web, None).expect("keys");
        assert_eq!(close.coalesce, remove.coalesce);
        assert_eq!(
            keys(EffectKind::VoiceRelease, 5, Cause::Scheduler, None)
                .expect("keys")
                .once
                .as_deref(),
            Some("event:5:voice-release")
        );
    }

    #[test]
    fn causes_have_stable_labels() {
        assert_eq!(Cause::Scheduler.as_str(), "scheduler");
        assert_eq!(Cause::Import.as_str(), "import");
        assert_eq!(EntityType::ApplicationPanel.as_str(), "application_panel");
    }
}
