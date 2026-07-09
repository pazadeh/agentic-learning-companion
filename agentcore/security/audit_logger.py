"""Structured audit logging.

Emits one JSON line per event to the standard ``logging`` module (which CloudWatch
captures). It records *metadata only* — never message content, lecture text, search
queries, or any other user-generated payload. This is a hard rule: see
``test_audit_logger.py`` which asserts content never leaks.
"""
from __future__ import annotations

import json
import logging
import time
import uuid
from typing import Any, Optional

logger = logging.getLogger("audio_companion.audit")

# Explicit allowlist of metadata keys that may be logged. Anything not on this list
# is dropped before serialization so a careless caller cannot leak content.
_ALLOWED_KEYS = {
    "request_id",
    "user_id",
    "action",
    "timestamp",
    "status",
    "duration_ms",
    "error_code",
    "job_id",
    "lecture_id",
}


def _sanitize(fields: dict[str, Any]) -> dict[str, Any]:
    """Keep only allowlisted, JSON-serializable metadata."""
    clean: dict[str, Any] = {}
    for key, value in fields.items():
        if key not in _ALLOWED_KEYS:
            continue
        if value is None:
            continue
        if isinstance(value, (str, int, float, bool)):
            clean[key] = value
        else:
            clean[key] = str(value)
    return clean


def log_event(
    action: str,
    status: str,
    *,
    user_id: Optional[str] = None,
    request_id: Optional[str] = None,
    duration_ms: Optional[int] = None,
    error_code: Optional[str] = None,
    job_id: Optional[str] = None,
    lecture_id: Optional[str] = None,
    level: int = logging.INFO,
) -> dict[str, Any]:
    """Log a structured audit event and return the emitted record (for testing)."""
    record = _sanitize(
        {
            "request_id": request_id or str(uuid.uuid4()),
            "user_id": user_id,
            "action": action,
            "status": status,
            "timestamp": int(time.time()),
            "duration_ms": duration_ms,
            "error_code": error_code,
            "job_id": job_id,
            "lecture_id": lecture_id,
        }
    )
    logger.log(level, json.dumps(record, sort_keys=True))
    return record


def log_auth_event(action: str, status: str, **kwargs: Any) -> dict[str, Any]:
    """Convenience wrapper for authentication events."""
    return log_event(action, status, **kwargs)


def log_job_event(action: str, status: str, **kwargs: Any) -> dict[str, Any]:
    """Convenience wrapper for job lifecycle events."""
    return log_event(action, status, **kwargs)


def log_rate_limit(user_id: str, action: str, **kwargs: Any) -> dict[str, Any]:
    """Convenience wrapper for rate-limit trigger events."""
    return log_event(
        "rate_limit",
        "blocked",
        user_id=user_id,
        error_code=f"rate_limited:{action}",
        level=logging.WARNING,
        **kwargs,
    )
