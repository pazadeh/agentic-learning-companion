"""Presign audio Lambda.

Generates short-lived (1 hour) presigned GET URLs for lecture MP3s. The critical
security property: a user may only ever obtain a URL for audio under their *own*
prefix. Audio keys are laid out as ``audio/{user_id}/{lecture_id}/lecture.mp3``,
so we verify the requested key starts with ``audio/{user_id}/`` where ``user_id``
comes from the verified Cognito JWT — never from the request body.
"""
from __future__ import annotations

import json
import logging
import os
from typing import Any

import boto3
from botocore.config import Config

from security.audit_logger import log_event
from security.input_validator import ValidationError, validate_user_id

logger = logging.getLogger()
logger.setLevel(logging.INFO)

AUDIO_BUCKET = os.environ.get("AUDIO_BUCKET", "")
URL_TTL_SECONDS = 60 * 60  # 1 hour

_s3 = None


def _s3_client():
    global _s3
    if _s3 is None:
        # SigV4 is required for presigned URLs to work with the function's
        # temporary STS credentials (the default can yield SigV2, which 403s).
        _s3 = boto3.client(
            "s3",
            region_name=os.environ.get("AWS_REGION", "us-east-1"),
            config=Config(signature_version="s3v4"),
        )
    return _s3


def _response(status: int, body: dict[str, Any]) -> dict[str, Any]:
    return {
        "statusCode": status,
        "headers": {
            "Content-Type": "application/json",
            "Cache-Control": "no-store",
            "Access-Control-Allow-Origin": os.environ.get("CORS_ALLOW_ORIGIN", "*"),
            "Access-Control-Allow-Headers": "Authorization,Content-Type",
            "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
        },
        "body": json.dumps(body),
    }


def _user_id_from_event(event: dict[str, Any]) -> str:
    sub = (
        event.get("requestContext", {})
        .get("authorizer", {})
        .get("claims", {})
        .get("sub", "")
    )
    return validate_user_id(sub)


def _validate_key_owned_by(s3_key: str, user_id: str) -> str:
    """Ensure ``s3_key`` is well-formed and belongs to ``user_id``."""
    if not isinstance(s3_key, str) or not s3_key:
        raise ValidationError("missing s3_key")
    # Reject path traversal and absolute/odd keys outright.
    if ".." in s3_key or s3_key.startswith("/") or "//" in s3_key:
        raise PermissionError("invalid key")
    expected_prefix = f"audio/{user_id}/"
    if not s3_key.startswith(expected_prefix):
        raise PermissionError("key does not belong to user")
    if not s3_key.endswith(".mp3"):
        raise ValidationError("unsupported file type")
    return s3_key


def handler(event: dict[str, Any], context: Any) -> dict[str, Any]:
    try:
        user_id = _user_id_from_event(event)
        body = json.loads(event.get("body") or "{}")
        s3_key = _validate_key_owned_by(body.get("s3_key", ""), user_id)

        url = _s3_client().generate_presigned_url(
            "get_object",
            Params={"Bucket": AUDIO_BUCKET, "Key": s3_key},
            ExpiresIn=URL_TTL_SECONDS,
        )
        log_event("audio_refresh", "ok", user_id=user_id)
        return _response(200, {"url": url, "expires_in": URL_TTL_SECONDS})
    except ValidationError as exc:
        return _response(400, {"error": "invalid_input", "message": str(exc)})
    except PermissionError:
        return _response(403, {"error": "forbidden"})
    except Exception:  # noqa: BLE001
        logger.exception("presign failed")
        return _response(500, {"error": "internal_error"})
