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

/// Deserializes an optional boolean from a native bool or a string (`true`/`false`/`1`/`0`).
///
/// Angular `HttpParams` and axum's `Query` extractor (backed by `serde_urlencoded`) expose every
/// query value as a string. Flattened filter structs make this worse: serde presents the value
/// through `deserialize_any`, and the default `bool` visitor rejects strings. Without this
/// coercion, `?archived=true` fails with "Failed to deserialize query string".
pub fn optional_bool_from_string_or_bool<'de, D>(deserializer: D) -> Result<Option<bool>, D::Error>
where
    D: Deserializer<'de>,
{
    struct OptionalBoolVisitor;

    impl<'de> serde::de::Visitor<'de> for OptionalBoolVisitor {
        type Value = Option<bool>;

        fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            formatter.write_str("a boolean or a string boolean")
        }

        fn visit_none<E>(self) -> Result<Self::Value, E>
        where
            E: serde::de::Error,
        {
            Ok(None)
        }

        fn visit_unit<E>(self) -> Result<Self::Value, E>
        where
            E: serde::de::Error,
        {
            Ok(None)
        }

        fn visit_bool<E>(self, value: bool) -> Result<Self::Value, E> {
            Ok(Some(value))
        }

        fn visit_str<E>(self, value: &str) -> Result<Self::Value, E>
        where
            E: serde::de::Error,
        {
            match value.trim().to_ascii_lowercase().as_str() {
                "" => Ok(None),
                "true" | "1" | "yes" => Ok(Some(true)),
                "false" | "0" | "no" => Ok(Some(false)),
                other => Err(E::custom(format!("invalid boolean value: {other}"))),
            }
        }

        fn visit_some<D>(self, deserializer: D) -> Result<Self::Value, D::Error>
        where
            D: Deserializer<'de>,
        {
            deserializer.deserialize_any(self)
        }
    }

    deserializer.deserialize_option(OptionalBoolVisitor)
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
        #[serde(
            default,
            deserialize_with = "super::optional_i64_from_string_or_number"
        )]
        field: Option<i64>,
    }

    #[test]
    fn optional_integer_accepts_json_number_and_string() {
        let number: OptionalIntegerProbe = serde_json::from_str(r#"{"field": 23}"#).unwrap();
        let string: OptionalIntegerProbe = serde_json::from_str(r#"{"field": "23"}"#).unwrap();
        assert_eq!(number.field, Some(23));
        assert_eq!(string.field, Some(23));
    }

    #[test]
    fn optional_integer_accepts_missing_field() {
        let missing: OptionalIntegerProbe = serde_json::from_str("{}").unwrap();
        assert_eq!(missing.field, None);
    }

    #[derive(Debug, serde::Deserialize, PartialEq)]
    struct OptionalBoolProbe {
        #[serde(default, deserialize_with = "super::optional_bool_from_string_or_bool")]
        field: Option<bool>,
    }

    #[derive(Debug, serde::Deserialize, PartialEq)]
    struct FlattenedBoolProbe {
        page: Option<u64>,
        #[serde(flatten)]
        inner: OptionalBoolProbe,
    }

    #[test]
    fn optional_bool_accepts_json_bool_and_string() {
        let native: OptionalBoolProbe = serde_json::from_str(r#"{"field": true}"#).unwrap();
        let string: OptionalBoolProbe = serde_json::from_str(r#"{"field": "true"}"#).unwrap();
        assert_eq!(native.field, Some(true));
        assert_eq!(string.field, Some(true));
    }

    #[test]
    fn optional_bool_accepts_missing_field() {
        let missing: OptionalBoolProbe = serde_json::from_str("{}").unwrap();
        assert_eq!(missing.field, None);
    }

    #[test]
    fn optional_bool_accepts_query_string_true_on_flattened_struct() {
        let parsed: FlattenedBoolProbe =
            serde_urlencoded::from_str("page=1&field=true").expect("archived=true must parse");
        assert_eq!(parsed.page, Some(1));
        assert_eq!(parsed.inner.field, Some(true));
    }

    #[test]
    fn optional_bool_rejects_unknown_query_string() {
        let error = serde_urlencoded::from_str::<FlattenedBoolProbe>("field=maybe").unwrap_err();
        assert!(error.to_string().contains("invalid boolean value"));
    }
}
