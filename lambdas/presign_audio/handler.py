"""Presign lecture audio Lambda.

Generates short-lived (1 hour) presigned GET URLs for existing Polly MP3 and Nova Sonic
WAV objects. A caller may only obtain the canonical lecture object under their own
Cognito-derived prefix: ``audio/{user_id}/{lecture_id}/lecture.(mp3|wav)``.
"""
from __future__ import annotations

import json
import logging
import os
import uuid
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
    """Require the caller's canonical MP3 or WAV lecture-object key."""
    if not isinstance(s3_key, str) or not s3_key:
        raise ValidationError("missing s3_key")
    if ".." in s3_key or s3_key.startswith("/") or "//" in s3_key:
        raise PermissionError("invalid key")
    parts = s3_key.split("/")
    if len(parts) != 4 or parts[0] != "audio" or parts[1] != user_id:
        raise PermissionError("key does not belong to user")
    try:
        canonical_lecture_id = str(uuid.UUID(parts[2]))
    except (ValueError, AttributeError) as exc:
        raise PermissionError("invalid lecture id") from exc
    if parts[2] != canonical_lecture_id:
        raise PermissionError("invalid lecture id")
    if parts[3] not in {"lecture.mp3", "lecture.wav"}:
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
