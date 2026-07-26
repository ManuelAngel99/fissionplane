//! Validated domain value objects for canonical FissionPlane resources.
//!
//! Canonical resource identifiers are secure 24-character
//! lowercase-alphanumeric NanoIDs. IDs owned by external systems and content
//! digests deliberately use their own types and validation rules.

#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used, clippy::panic))]

use std::{fmt, str::FromStr};

use nanoid::nanoid;
use thiserror::Error;

/// Alphabet shared with the TypeScript core and public API contract.
pub const NANO_ID_ALPHABET: [char; 36] = [
    '0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i',
    'j', 'k', 'l', 'm', 'n', 'o', 'p', 'q', 'r', 's', 't', 'u', 'v', 'w', 'x', 'y', 'z',
];

/// Length shared with the TypeScript core and public API contract.
pub const NANO_ID_LENGTH: usize = 24;

/// Minimum organization display-name length.
pub const ORGANIZATION_NAME_MIN_LENGTH: usize = 1;
/// Maximum organization display-name length.
pub const ORGANIZATION_NAME_MAX_LENGTH: usize = 100;
/// Minimum user display-name length.
pub const USER_DISPLAY_NAME_MIN_LENGTH: usize = 1;
/// Maximum user display-name length.
pub const USER_DISPLAY_NAME_MAX_LENGTH: usize = 80;
/// Minimum organization-slug length.
pub const ORGANIZATION_SLUG_MIN_LENGTH: usize = 1;
/// Maximum organization-slug length.
pub const ORGANIZATION_SLUG_MAX_LENGTH: usize = 63;
/// Minimum sandbox-name length.
pub const SANDBOX_NAME_MIN_LENGTH: usize = 1;
/// Maximum sandbox-name length.
pub const SANDBOX_NAME_MAX_LENGTH: usize = 63;
/// Minimum template-alias length.
pub const TEMPLATE_ALIAS_MIN_LENGTH: usize = 1;
/// Maximum template-alias length.
pub const TEMPLATE_ALIAS_MAX_LENGTH: usize = 63;
/// Minimum resource-description length.
pub const RESOURCE_DESCRIPTION_MIN_LENGTH: usize = 1;
/// Maximum resource-description length.
pub const RESOURCE_DESCRIPTION_MAX_LENGTH: usize = 2_000;

/// A domain primitive failed validation.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum ValueObjectError {
    /// A canonical resource identifier is malformed.
    #[error("{kind} must be a {NANO_ID_LENGTH}-character lowercase-alphanumeric NanoID")]
    InvalidNanoId {
        /// Name of the value object being parsed.
        kind: &'static str,
    },
    /// A display value is empty.
    #[error("{kind} must not be empty")]
    Empty {
        /// Name of the value object being parsed.
        kind: &'static str,
    },
    /// A display value is shorter than its bound.
    #[error("{kind} must be at least {min} characters")]
    TooShort {
        /// Name of the value object being parsed.
        kind: &'static str,
        /// Minimum character count.
        min: usize,
    },
    /// A display value exceeds its bound.
    #[error("{kind} must be at most {max} characters")]
    TooLong {
        /// Name of the value object being parsed.
        kind: &'static str,
        /// Maximum character count.
        max: usize,
    },
    /// A value uses characters outside its domain alphabet.
    #[error("{kind} contains invalid characters")]
    InvalidCharacters {
        /// Name of the value object being parsed.
        kind: &'static str,
    },
}

fn is_nano_id(value: &str) -> bool {
    value.len() == NANO_ID_LENGTH
        && value
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
}

macro_rules! nano_id_type {
    ($name:ident) => {
        #[doc = concat!("Validated canonical ", stringify!($name), ".")]
        #[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
        pub struct $name(String);

        impl $name {
            #[doc = concat!("Generate a secure ", stringify!($name), ".")]
            #[must_use]
            pub fn generate() -> Self {
                Self(nanoid!(NANO_ID_LENGTH, &NANO_ID_ALPHABET))
            }

            #[doc = concat!("Parse and validate a ", stringify!($name), ".")]
            ///
            /// # Errors
            ///
            /// Returns [`ValueObjectError::InvalidNanoId`] when the value does
            /// not use the canonical alphabet and length.
            pub fn parse(value: impl Into<String>) -> Result<Self, ValueObjectError> {
                let value = value.into();
                if is_nano_id(&value) {
                    Ok(Self(value))
                } else {
                    Err(ValueObjectError::InvalidNanoId {
                        kind: stringify!($name),
                    })
                }
            }

            /// Return the validated identifier as a string slice.
            #[must_use]
            pub fn as_str(&self) -> &str {
                &self.0
            }
        }

        impl FromStr for $name {
            type Err = ValueObjectError;

            fn from_str(value: &str) -> Result<Self, Self::Err> {
                Self::parse(value)
            }
        }

        impl AsRef<str> for $name {
            fn as_ref(&self) -> &str {
                self.as_str()
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str(self.as_str())
            }
        }
    };
}

nano_id_type!(OrganizationId);
nano_id_type!(SandboxId);
nano_id_type!(TemplateId);
nano_id_type!(TemplateBuildId);

fn validate_display_name(
    value: String,
    kind: &'static str,
    min: usize,
    max: usize,
) -> Result<String, ValueObjectError> {
    if value.is_empty() {
        return Err(ValueObjectError::Empty { kind });
    }
    let length = value.chars().count();
    if length < min {
        return Err(ValueObjectError::TooShort { kind, min });
    }
    if length > max {
        return Err(ValueObjectError::TooLong { kind, max });
    }
    if value.trim() != value || value.chars().any(char::is_control) {
        return Err(ValueObjectError::InvalidCharacters { kind });
    }
    Ok(value)
}

fn validate_dns_label(
    value: String,
    kind: &'static str,
    min: usize,
    max: usize,
) -> Result<String, ValueObjectError> {
    if value.is_empty() {
        return Err(ValueObjectError::Empty { kind });
    }
    if value.len() < min {
        return Err(ValueObjectError::TooShort { kind, min });
    }
    if value.len() > max {
        return Err(ValueObjectError::TooLong { kind, max });
    }
    let bytes = value.as_bytes();
    let Some(&first) = bytes.first() else {
        return Err(ValueObjectError::Empty { kind });
    };
    let Some(&last) = bytes.last() else {
        return Err(ValueObjectError::Empty { kind });
    };
    let valid_edge = |byte: u8| byte.is_ascii_lowercase() || byte.is_ascii_digit();
    let valid_body = |byte: u8| valid_edge(byte) || byte == b'-';

    if !valid_edge(first) || !valid_edge(last) || !bytes.iter().copied().all(valid_body) {
        return Err(ValueObjectError::InvalidCharacters { kind });
    }
    Ok(value)
}

macro_rules! display_name_type {
    ($name:ident, $min:expr, $max:expr) => {
        #[doc = concat!("Validated ", stringify!($name), ".")]
        #[derive(Debug, Clone, PartialEq, Eq, Hash)]
        pub struct $name(String);

        impl $name {
            #[doc = concat!("Parse and validate a ", stringify!($name), ".")]
            ///
            /// # Errors
            ///
            /// Returns [`ValueObjectError`] when the value is empty, padded,
            /// too long, or contains control characters.
            pub fn parse(value: impl Into<String>) -> Result<Self, ValueObjectError> {
                validate_display_name(value.into(), stringify!($name), $min, $max).map(Self)
            }

            /// Return the validated value as a string slice.
            #[must_use]
            pub fn as_str(&self) -> &str {
                &self.0
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str(self.as_str())
            }
        }

        impl FromStr for $name {
            type Err = ValueObjectError;

            fn from_str(value: &str) -> Result<Self, Self::Err> {
                Self::parse(value)
            }
        }

        impl AsRef<str> for $name {
            fn as_ref(&self) -> &str {
                self.as_str()
            }
        }
    };
}

macro_rules! dns_name_type {
    ($name:ident, $min:expr, $max:expr) => {
        #[doc = concat!("Validated DNS-label-compatible ", stringify!($name), ".")]
        #[derive(Debug, Clone, PartialEq, Eq, Hash)]
        pub struct $name(String);

        impl $name {
            #[doc = concat!("Parse and validate a ", stringify!($name), ".")]
            ///
            /// # Errors
            ///
            /// Returns [`ValueObjectError`] when the value is not a valid
            /// lowercase DNS-label-compatible name.
            pub fn parse(value: impl Into<String>) -> Result<Self, ValueObjectError> {
                validate_dns_label(value.into(), stringify!($name), $min, $max).map(Self)
            }

            /// Return the validated value as a string slice.
            #[must_use]
            pub fn as_str(&self) -> &str {
                &self.0
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str(self.as_str())
            }
        }

        impl FromStr for $name {
            type Err = ValueObjectError;

            fn from_str(value: &str) -> Result<Self, Self::Err> {
                Self::parse(value)
            }
        }

        impl AsRef<str> for $name {
            fn as_ref(&self) -> &str {
                self.as_str()
            }
        }
    };
}

display_name_type!(
    OrganizationName,
    ORGANIZATION_NAME_MIN_LENGTH,
    ORGANIZATION_NAME_MAX_LENGTH
);
display_name_type!(
    UserDisplayName,
    USER_DISPLAY_NAME_MIN_LENGTH,
    USER_DISPLAY_NAME_MAX_LENGTH
);
display_name_type!(
    ResourceDescription,
    RESOURCE_DESCRIPTION_MIN_LENGTH,
    RESOURCE_DESCRIPTION_MAX_LENGTH
);
dns_name_type!(
    OrganizationSlug,
    ORGANIZATION_SLUG_MIN_LENGTH,
    ORGANIZATION_SLUG_MAX_LENGTH
);
dns_name_type!(
    SandboxName,
    SANDBOX_NAME_MIN_LENGTH,
    SANDBOX_NAME_MAX_LENGTH
);
dns_name_type!(
    TemplateAlias,
    TEMPLATE_ALIAS_MIN_LENGTH,
    TEMPLATE_ALIAS_MAX_LENGTH
);

#[cfg(test)]
mod tests {
    use std::collections::HashSet;

    use super::*;

    #[test]
    fn generated_ids_are_unique_and_valid() {
        let ids: HashSet<_> = (0..1_000).map(|_| SandboxId::generate()).collect();
        assert_eq!(ids.len(), 1_000);
        assert!(ids.iter().all(|id| is_nano_id(id.as_str())));
    }

    #[test]
    fn canonical_ids_reject_uuid_and_default_nanoid_alphabet() {
        let _ = OrganizationId::parse("550e8400-e29b-41d4-a716-446655440000").unwrap_err();
        let _ = OrganizationId::parse("A".repeat(NANO_ID_LENGTH)).unwrap_err();
        let _ = OrganizationId::parse("a".repeat(NANO_ID_LENGTH)).unwrap();
    }

    #[test]
    fn names_are_validated_at_construction() {
        let _ = OrganizationName::parse("FissionPlane").unwrap();
        let _ = OrganizationName::parse(" padded").unwrap_err();
        let _ = SandboxName::parse("build-runner-1").unwrap();
        let _ = SandboxName::parse("-invalid").unwrap_err();
        let _ = TemplateAlias::parse("UPPERCASE").unwrap_err();
    }
}
