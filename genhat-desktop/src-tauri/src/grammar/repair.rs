//! JSON key repair with Levenshtein distance (revamp.md §5.2).
//!
//! For mildly corrupted payloads that slip through GBNF (rare at boundaries):
//!   1. Parse the JSON.
//!   2. For each key not in the allowlist, compute normalized edit distance to
//!      the nearest valid key.
//!   3. If distance ≤ 3, substitute the nearest key (log the repair).
//!   4. If distance > 3, return `TooCorrupted` — do not guess, escalate to
//!      the unhappy-path fallback (revamp.md §9).

/// Maximum allowed Levenshtein edit distance for a key repair.
const MAX_REPAIR_DISTANCE: usize = 3;

/// Error type returned when repair is not possible or safe.
#[derive(Debug, PartialEq)]
pub enum RepairError {
    /// A key's edit distance exceeds `MAX_REPAIR_DISTANCE` — payload too corrupted.
    TooCorrupted { bad_key: String, distance: usize },
    /// The string could not be parsed as JSON.
    ParseError(String),
}

impl std::fmt::Display for RepairError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            RepairError::TooCorrupted { bad_key, distance } => write!(
                f,
                "Key '{bad_key}' is too far (distance={distance}) from any valid key; discarding"
            ),
            RepairError::ParseError(msg) => write!(f, "JSON parse error: {msg}"),
        }
    }
}

/// Compute the Levenshtein edit distance between two strings.
pub fn levenshtein(a: &str, b: &str) -> usize {
    let a: Vec<char> = a.chars().collect();
    let b: Vec<char> = b.chars().collect();
    let m = a.len();
    let n = b.len();

    if m == 0 {
        return n;
    }
    if n == 0 {
        return m;
    }

    let mut dp = vec![vec![0usize; n + 1]; m + 1];
    for i in 0..=m {
        dp[i][0] = i;
    }
    for j in 0..=n {
        dp[0][j] = j;
    }
    for i in 1..=m {
        for j in 1..=n {
            dp[i][j] = if a[i - 1] == b[j - 1] {
                dp[i - 1][j - 1]
            } else {
                1 + dp[i - 1][j - 1].min(dp[i - 1][j]).min(dp[i][j - 1])
            };
        }
    }

    dp[m][n]
}

/// Find the nearest valid key for `bad_key` from `valid_keys`.
/// Returns `(best_key, distance)`, or `None` if `valid_keys` is empty.
pub fn nearest_key<'a>(bad_key: &str, valid_keys: &[&'a str]) -> Option<(&'a str, usize)> {
    valid_keys
        .iter()
        .map(|k| (*k, levenshtein(bad_key, k)))
        .min_by_key(|(_, d)| *d)
}

/// Attempt to repair a JSON object by replacing unknown top-level keys with
/// the nearest valid key from `valid_keys`.
///
/// Returns the (possibly-repaired) JSON string, or a `RepairError` if:
///   - The string cannot be parsed as JSON.
///   - Any unknown key's edit distance exceeds `MAX_REPAIR_DISTANCE`.
///
/// Non-object JSON values are returned as-is (no keys to repair).
pub fn repair_json_keys(json: &str, valid_keys: &[&str]) -> Result<String, RepairError> {
    let mut value: serde_json::Value = serde_json::from_str(json)
        .map_err(|e| RepairError::ParseError(e.to_string()))?;

    if let Some(obj) = value.as_object_mut() {
        let unknown_keys: Vec<String> = obj
            .keys()
            .filter(|k| !valid_keys.contains(&k.as_str()))
            .cloned()
            .collect();

        for bad_key in unknown_keys {
            match nearest_key(&bad_key, valid_keys) {
                Some((nearest, dist)) if dist <= MAX_REPAIR_DISTANCE => {
                    log::info!(
                        "JSON key repair: '{}' → '{}' (distance={})",
                        bad_key,
                        nearest,
                        dist
                    );
                    let v = obj.remove(&bad_key).unwrap();
                    obj.insert(nearest.to_string(), v);
                }
                Some((_, dist)) => {
                    return Err(RepairError::TooCorrupted {
                        bad_key,
                        distance: dist,
                    });
                }
                None => {} // no valid keys at all — leave as-is
            }
        }
    }

    serde_json::to_string(&value).map_err(|e| RepairError::ParseError(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn levenshtein_identical() {
        assert_eq!(levenshtein("ops", "ops"), 0);
    }

    #[test]
    fn levenshtein_one_deletion() {
        assert_eq!(levenshtein("ops", "op"), 1);
    }

    #[test]
    fn levenshtein_transposition() {
        assert_eq!(levenshtein("col", "ocl"), 2);
    }

    #[test]
    fn repair_nearby_key() {
        let json = r#"{"op_s": "SUM_COLUMN", "col": "revenue"}"#;
        let valid = &["ops", "col", "label"];
        let repaired = repair_json_keys(json, valid).unwrap();
        let v: serde_json::Value = serde_json::from_str(&repaired).unwrap();
        assert!(v.get("ops").is_some(), "expected 'op_s' to be repaired to 'ops'");
        assert!(v.get("col").is_some(), "col should be unchanged");
    }

    #[test]
    fn repair_too_far_key() {
        let json = r#"{"completely_wrong_key_name": "value"}"#;
        let valid = &["ops"];
        assert!(matches!(
            repair_json_keys(json, valid),
            Err(RepairError::TooCorrupted { .. })
        ));
    }

    #[test]
    fn repair_already_valid() {
        let json = r#"{"ops": [], "headers": []}"#;
        let valid = &["ops", "headers", "source_rows", "output_name"];
        let repaired = repair_json_keys(json, valid).unwrap();
        let v: serde_json::Value = serde_json::from_str(&repaired).unwrap();
        assert!(v.get("ops").is_some());
        assert!(v.get("headers").is_some());
    }

    #[test]
    fn repair_invalid_json() {
        let json = "not json";
        assert!(matches!(
            repair_json_keys(json, &["ops"]),
            Err(RepairError::ParseError(_))
        ));
    }
}
