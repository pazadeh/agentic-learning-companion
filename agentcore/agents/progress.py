"""Best-effort, monotonic generation-stage reporting to the durable job row.

The context is bound only by the validated AgentCore entrypoint, never from model tool
arguments. The entrypoint serializes agent runs in this runtime, and Strands tools may
execute on another thread, so this intentionally mirrors run_context's module-level
storage rather than using thread-local state.
"""
from __future__ import annotations

import logging
import time
from typing import Any

from botocore.exceptions import ClientError

from . import config

logger = logging.getLogger("audio_companion.agents.progress")

_context: dict[str, Any] = {}
_sequence = 0


def reset() -> None:
    global _context, _sequence
    _context = {}
    _sequence = 0


def bind(*, user_id: str, job_id: str, claim_token: str = "") -> None:
    global _context, _sequence
    _context = {"user_id": user_id, "job_id": job_id, "claim_token": claim_token}
    # Worker claims occupy sequence 1; AgentCore owns 10..999.
    _sequence = 9


def report(stage: str, percent: int, message: str, detail: str = "") -> None:
    """Publish one real execution landmark; telemetry failure never fails generation."""
    global _sequence
    if not config.JOBS_TABLE or not _context:
        return
    _sequence += 1
    sequence = _sequence
    names = {
        "#status": "status",
        "#stage": "stage",
        "#progress": "progress",
        "#message": "stageMessage",
        "#detail": "stageDetail",
        "#sequence": "stageSeq",
        "#updated": "progressUpdatedAt",
    }
    values: dict[str, Any] = {
        ":processing": "processing",
        ":user_id": _context["user_id"],
        ":stage": stage,
        ":progress": max(0, min(99, int(percent))),
        ":message": message[:120],
        ":detail": detail[:200],
        ":sequence": sequence,
        ":updated": int(time.time()),
    }
    condition = (
        "userId = :user_id AND #status = :processing AND "
        "(attribute_not_exists(#sequence) OR #sequence < :sequence)"
    )
    claim_token = _context.get("claim_token")
    if claim_token:
        names["#claim"] = "claimToken"
        values[":claim"] = claim_token
        condition += " AND #claim = :claim"
    try:
        config.progress_dynamodb_resource().Table(config.JOBS_TABLE).update_item(
            Key={"jobId": _context["job_id"]},
            UpdateExpression=(
                "SET #stage = :stage, #progress = :progress, #message = :message, "
                "#detail = :detail, #sequence = :sequence, #updated = :updated"
            ),
            ConditionExpression=condition,
            ExpressionAttributeNames=names,
            ExpressionAttributeValues=values,
        )
    except ClientError as exc:
        code = exc.response.get("Error", {}).get("Code", "")
        if code not in {"ConditionalCheckFailedException", "ResourceNotFoundException"}:
            logger.warning("Progress update failed: %s", code)
    except Exception:  # noqa: BLE001
        logger.warning("Progress update failed", exc_info=True)
