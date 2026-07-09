"""Cognito Pre-Sign-up trigger.

Enforces an email allowlist so only specific, trusted addresses can ever create
an account. The allowlist is supplied via the ``ALLOWED_EMAILS`` environment
variable (comma-separated) which is stored KMS-encrypted on the function.
"""
import os

ALLOWED_EMAILS = set(
    e.strip().lower()
    for e in os.environ.get("ALLOWED_EMAILS", "").split(",")
    if e.strip()
)


def handler(event, context):
    """Reject sign-up unless the email is on the allowlist."""
    email = (
        event.get("request", {})
        .get("userAttributes", {})
        .get("email", "")
        .strip()
        .lower()
    )

    if not email or email not in ALLOWED_EMAILS:
        # Generic message — never reveal the allowlist contents.
        raise Exception("Sign-up not allowed for this email")

    return event
