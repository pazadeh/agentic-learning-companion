"""Security package: input validation, content filtering, rate limiting, audit logging.

This package is intentionally dependency-light (standard library + boto3 only) so it
can be packaged as a Lambda layer and imported by both the Lambda handlers and the
Bedrock AgentCore backend.
"""
from .content_filter import SafetyResult, check_topic_safety
from .input_validator import (
    ValidationError,
    validate_job_id,
    validate_message,
    validate_user_id,
)

__all__ = [
    "ValidationError",
    "validate_message",
    "validate_user_id",
    "validate_job_id",
    "SafetyResult",
    "check_topic_safety",
]
