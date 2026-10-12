"""Per-user rate limiting backed by DynamoDB.

Uses an hour-bucket key so counters expire naturally via TTL. Limits are enforced
per user and per action. On any DynamoDB error we *fail open* (log a warning and
allow the request): availability of a personal learning app for 1-5 trusted users
matters more than a hard cap, and the WAF + API Gateway throttle provide a backstop.
"""
from __future__ import annotations

import logging
import os
import time
from typing import Optional

try:  # boto3 is present in the Lambda runtime; guard so unit tests can run without it
    import boto3
    from botocore.exceptions import ClientError
except Exception:  # pragma: no cover - exercised only when boto3 is absent
    boto3 = None  # type: ignore[assignment]

    class ClientError(Exception):  # type: ignore[no-redef]
        """Fallback when botocore is unavailable."""


logger = logging.getLogger("audio_companion.security.ratelimit")

# Maximum number of actions allowed per rolling hour bucket.
LIMITS: dict[str, int] = {
    "lecture": 20,
    "chat": 100,
    # Planning is cheaper than lecture generation but still invokes a model. The
    # API and AgentCore both enforce this as defense in depth, matching flat jobs.
    "series_plan": 20,
}

DEFAULT_LIMIT = 100
BUCKET_TTL_SECONDS = 2 * 60 * 60  # 2 hours

_table = None


def _get_table():
    """Lazily create and cache the DynamoDB Table resource."""
    global _table
    if _table is not None:
        return _table
    if boto3 is None:
        raise RuntimeError("boto3 is not available")
    table_name = os.environ["RATE_LIMITS_TABLE"]
    _table = boto3.resource("dynamodb").Table(table_name)
    return _table


def _hour_bucket(now: Optional[float] = None) -> str:
    """Return the current hour bucket key, e.g. ``2026-06-26T14``."""
    ts = time.gmtime(now if now is not None else time.time())
    return time.strftime("%Y-%m-%dT%H", ts)


def check_rate_limit(user_id: str, action: str) -> bool:
    """Atomically increment the user's counter for ``action`` and check the limit.

    Returns ``True`` if the request is allowed, ``False`` if the limit is exceeded.
    Fails open (returns ``True``) on any backend error.
    """
    limit = LIMITS.get(action, DEFAULT_LIMIT)
    pk = f"{user_id}#{action}"
    bucket = _hour_bucket()
    ttl = int(time.time()) + BUCKET_TTL_SECONDS

    try:
        table = _get_table()
        response = table.update_item(
            Key={"pk": pk, "sk": bucket},
            UpdateExpression="ADD #count :one SET #ttl = if_not_exists(#ttl, :ttl)",
            ExpressionAttributeNames={"#count": "count", "#ttl": "ttl"},
            ExpressionAttributeValues={":one": 1, ":ttl": ttl},
            ReturnValues="UPDATED_NEW",
        )
        count = int(response["Attributes"]["count"])
    except (ClientError, KeyError, RuntimeError, Exception) as exc:  # noqa: BLE001
        logger.warning(
            "Rate limiter unavailable; failing open",
            extra={"action": action, "error_code": type(exc).__name__},
        )
        return True

    if count > limit:
        logger.info(
            "Rate limit exceeded",
            extra={"action": action, "count": count, "limit": limit},
        )
        return False

    return True
