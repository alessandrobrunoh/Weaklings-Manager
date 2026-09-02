//! Small, reusable `serde` helpers shared across request DTOs.

use serde::{Deserialize, Deserializer};

/// Deserializes an `Option<Option<T>>` field so a JSON `null` is distinguishable from a
/// missing key, letting a PATCH-style request tell "leave this field alone" apart from
/// "clear this field".
///
/// Without this, `serde`/`serde_json` collapse both a missing key and an explicit `null`
/// to the same outer `None` — a field typed as plain `Option<Option<T>>` can never see
/// the explicit-null case, so "clear this field" requests silently no-op instead of
/// clearing it (see the double-Option gotcha this fixes).
///
/// Usage: `#[serde(default, deserialize_with = "crate::serde_helpers::double_option")]`
/// on a field typed `Option<Option<T>>`. `#[serde(default)]` is required — it is what
/// produces the outer `None` when the key is missing entirely; this function only runs
/// when the key is present, and always wraps its result in `Some(..)`, so:
/// - key missing        -> `#[serde(default)]` kicks in -> `None` ("unchanged")
/// - key present, `null` -> inner `Option<T>` deserializes to `None` -> `Some(None)` ("clear")
/// - key present, value  -> inner `Option<T>` deserializes to `Some(v)` -> `Some(Some(v))` ("set")
pub fn double_option<'de, T, D>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
where
    T: Deserialize<'de>,
    D: Deserializer<'de>,
{
    Option::<T>::deserialize(deserializer).map(Some)
}

#[cfg(test)]
mod tests {
    #[derive(Debug, serde::Deserialize, PartialEq)]
    struct Probe {
        #[serde(default, deserialize_with = "super::double_option")]
        field: Option<Option<i64>>,
    }

    #[test]
    fn missing_key_means_unchanged() {
        let p: Probe = serde_json::from_str("{}").unwrap();
        assert_eq!(p.field, None, "missing key must not be treated as 'clear'");
    }

    #[test]
    fn explicit_null_means_clear() {
        let p: Probe = serde_json::from_str(r#"{"field": null}"#).unwrap();
        assert_eq!(p.field, Some(None), "explicit null must be distinguishable from a missing key");
    }

    #[test]
    fn explicit_value_means_set() {
        let p: Probe = serde_json::from_str(r#"{"field": 42}"#).unwrap();
        assert_eq!(p.field, Some(Some(42)));
    }
}
