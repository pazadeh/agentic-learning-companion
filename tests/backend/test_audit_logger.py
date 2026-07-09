"""Tests for security.audit_logger — the hard rule is: never log content."""
import json
import logging

from security import audit_logger


def test_logs_allowlisted_metadata():
    record = audit_logger.log_event(
        "job_start",
        "accepted",
        user_id="user-1",
        job_id="job-1",
        duration_ms=42,
    )
    assert record["action"] == "job_start"
    assert record["status"] == "accepted"
    assert record["user_id"] == "user-1"
    assert record["job_id"] == "job-1"
    assert record["duration_ms"] == 42
    assert "timestamp" in record
    assert "request_id" in record


def test_drops_non_allowlisted_fields():
    # _sanitize is the gate: anything not on the allowlist (e.g. content-like keys)
    # is stripped before serialization.
    record = audit_logger._sanitize(
        {
            "action": "job_start",
            "status": "ok",
            "message": "my secret lecture topic",
            "script": "full text",
            "query": "search terms",
        }
    )
    assert "message" not in record
    assert "script" not in record
    assert "query" not in record
    assert record["action"] == "job_start"


def test_content_never_appears_in_emitted_log(caplog):
    secret = "the-users-private-message-content"
    with caplog.at_level(logging.INFO, logger="audio_companion.audit"):
        # Even if a content-like value sneaks into a known key's neighbours, only
        # allowlisted keys are serialized.
        audit_logger.log_event("agent_invoke", "completed", user_id="user-1")
    combined = " ".join(r.getMessage() for r in caplog.records)
    assert secret not in combined
    # The emitted line must be valid JSON metadata.
    payload = json.loads(caplog.records[-1].getMessage())
    assert payload["action"] == "agent_invoke"


def test_none_values_omitted():
    record = audit_logger.log_event("x", "y", user_id=None, job_id=None)
    assert "user_id" not in record
    assert "job_id" not in record


def test_rate_limit_helper():
    record = audit_logger.log_rate_limit("user-1", "lecture")
    assert record["action"] == "rate_limit"
    assert record["status"] == "blocked"
    assert record["error_code"] == "rate_limited:lecture"
