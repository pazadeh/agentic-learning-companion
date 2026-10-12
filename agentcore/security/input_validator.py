"""Input validation for user-supplied data.

Validates chat messages and identifiers before they reach the agents or the
database. Suspicious prompt-injection patterns are logged (metadata only) but not
blocked — the downstream LLM system prompts are responsible for safe behaviour, and
over-blocking legitimate questions would hurt the product.
"""
from __future__ import annotations

import logging
import re
import uuid

logger = logging.getLogger("audio_companion.security.input")

MIN_MESSAGE_LENGTH = 1
MAX_MESSAGE_LENGTH = 2000
MIN_SERIES_EPISODES = 2
MAX_SERIES_EPISODES = 8
MIN_EPISODE_DURATION_MINUTES = 1
MAX_EPISODE_DURATION_MINUTES = 30
MAX_SERIES_TITLE_LENGTH = 200

# Control characters that must never appear in user text. We allow the common
# whitespace controls (tab, newline, carriage return) and reject the rest,
# including the null byte and other C0/C1 control characters.
_ALLOWED_CONTROL = {"\t", "\n", "\r"}
_CONTROL_CHAR_RE = re.compile(
    "[" + "".join(
        re.escape(chr(c))
        for c in list(range(0x00, 0x20)) + [0x7F]
        if chr(c) not in _ALLOWED_CONTROL
    ) + "]"
)

# Patterns that *often* indicate a prompt-injection attempt. Logged, not blocked.
_INJECTION_PATTERNS = [
    re.compile(r"ignore\s+(all\s+)?(previous|prior|above)\s+instructions", re.IGNORECASE),
    re.compile(r"disregard\s+(the\s+)?(system|previous)\s+prompt", re.IGNORECASE),
    re.compile(r"you\s+are\s+now\s+(a|an|in)\b", re.IGNORECASE),
    re.compile(r"reveal\s+(your\s+)?(system\s+prompt|instructions)", re.IGNORECASE),
    re.compile(r"\bdeveloper\s+mode\b", re.IGNORECASE),
]

# Canonical UUID format (8-4-4-4-12 hex).
_UUID_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
    re.IGNORECASE,
)


class ValidationError(Exception):
    """Raised when user input fails validation."""


def validate_message(text: str) -> str:
    """Validate and sanitize a chat message.

    Returns the trimmed message. Raises :class:`ValidationError` if the message is
    not a string, is empty/too long, or contains forbidden control characters.
    """
    if not isinstance(text, str):
        raise ValidationError("Message must be a string")

    if _CONTROL_CHAR_RE.search(text):
        raise ValidationError("Message contains forbidden control characters")

    cleaned = text.strip()

    if len(cleaned) < MIN_MESSAGE_LENGTH:
        raise ValidationError("Message must not be empty")

    if len(cleaned) > MAX_MESSAGE_LENGTH:
        raise ValidationError(
            f"Message must be at most {MAX_MESSAGE_LENGTH} characters"
        )

    for pattern in _INJECTION_PATTERNS:
        if pattern.search(cleaned):
            # Metadata only — never log the message content itself.
            logger.warning(
                "Possible prompt-injection pattern detected",
                extra={"pattern": pattern.pattern},
            )
            break

    return cleaned


def _validate_uuid(value: str, label: str) -> str:
    """Validate that ``value`` is a canonical UUID string (any version).

    Cognito subject ids are UUIDs but not guaranteed to be v4 (newer user pools
    issue v7-style ids), so we accept any valid canonical UUID. The value already
    comes from a verified JWT, so this is a format sanity check — not an auth control.
    """
    if not isinstance(value, str) or not _UUID_RE.match(value):
        raise ValidationError(f"Invalid {label}")
    try:
        parsed = uuid.UUID(value)
    except (ValueError, AttributeError, TypeError) as exc:
        raise ValidationError(f"Invalid {label}") from exc
    return str(parsed)


def validate_user_id(user_id: str) -> str:
    """Validate a Cognito subject / user id (canonical UUID, any version)."""
    return _validate_uuid(user_id, "user id")


def validate_job_id(job_id: str) -> str:
    """Validate a job id (canonical UUID)."""
    return _validate_uuid(job_id, "job id")


def validate_series_id(series_id: str) -> str:
    """Validate a series id (canonical UUID)."""
    return _validate_uuid(series_id, "series id")


def validate_episode_id(episode_id: str) -> str:
    """Validate a series episode id (canonical UUID)."""
    return _validate_uuid(episode_id, "episode id")


def _validate_bounded_int(value: object, label: str, minimum: int, maximum: int) -> int:
    """Validate an integer without accepting booleans or numeric strings."""
    if isinstance(value, bool) or not isinstance(value, int):
        raise ValidationError(f"{label} must be an integer")
    if value < minimum or value > maximum:
        raise ValidationError(f"{label} must be between {minimum} and {maximum}")
    return value


def validate_episode_count(value: object) -> int:
    """Validate that a series contains between two and eight episodes."""
    return _validate_bounded_int(
        value,
        "Episode count",
        MIN_SERIES_EPISODES,
        MAX_SERIES_EPISODES,
    )


def validate_episode_duration(value: object) -> int:
    """Validate an episode's target duration in minutes."""
    return _validate_bounded_int(
        value,
        "Episode duration",
        MIN_EPISODE_DURATION_MINUTES,
        MAX_EPISODE_DURATION_MINUTES,
    )


def validate_series_title(value: object) -> str:
    """Validate and normalize a user-visible series or episode title."""
    if not isinstance(value, str):
        raise ValidationError("Series title must be a string")
    title = value.strip()
    if not title:
        raise ValidationError("Series title must not be empty")
    if len(title) > MAX_SERIES_TITLE_LENGTH:
        raise ValidationError(
            f"Series title must be at most {MAX_SERIES_TITLE_LENGTH} characters"
        )
    if _CONTROL_CHAR_RE.search(title):
        raise ValidationError("Series title contains forbidden control characters")
    return title
