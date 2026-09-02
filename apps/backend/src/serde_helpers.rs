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

/// Deserializes an optional integer from either a numeric value or its string representation.
///
/// Query-string extractors expose every value as a string, while JSON request bodies commonly
/// use a number. Keeping this compatibility at the boundary avoids making the domain model
/// stringly typed just because one endpoint is consumed through both representations.
pub fn optional_i64_from_string_or_number<'de, D>(deserializer: D) -> Result<Option<i64>, D::Error>
where
    D: Deserializer<'de>,
{
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum IntegerValue {
        Number(i64),
        String(String),
    }

    Option::<IntegerValue>::deserialize(deserializer)?
        .map(|value| match value {
            IntegerValue::Number(value) => Ok(value),
            IntegerValue::String(value) => value
                .parse::<i64>()
                .map_err(|_| serde::de::Error::custom(format!("invalid integer value: {value:?}"))),
        })
        .transpose()
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
        assert_eq!(
            p.field,
            Some(None),
            "explicit null must be distinguishable from a missing key"
        );
    }

    #[test]
    fn explicit_value_means_set() {
        let p: Probe = serde_json::from_str(r#"{"field": 42}"#).unwrap();
        assert_eq!(p.field, Some(Some(42)));
    }

    #[derive(Debug, serde::Deserialize, PartialEq)]
    struct OptionalIntegerProbe {
        #[serde(deserialize_with = "super::optional_i64_from_string_or_number")]
        field: Option<i64>,
    }

    #[test]
    fn optional_integer_accepts_json_number_and_string() {
        let number: OptionalIntegerProbe = serde_json::from_str(r#"{"field": 23}"#).unwrap();
        let string: OptionalIntegerProbe = serde_json::from_str(r#"{"field": "23"}"#).unwrap();
        assert_eq!(number.field, Some(23));
        assert_eq!(string.field, Some(23));
    }
}
