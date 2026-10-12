"""Durable coordination for multi-part lecture series.

A series is planned once, reviewed/edited by the learner, then generated one
episode at a time. Each episode is a normal lecture produced by the existing
AgentCore orchestrator (research -> write -> Polly -> save), so no lecture logic
is duplicated here.

State lives in SERIES_TABLE (durable) and work items live in the existing
JobsTable (24h TTL):

* Summary  ``pk=USER#{userId}``     ``sk=SERIES#{seriesId}``
* Episode  ``pk=SERIES#{seriesId}`` ``sk=EPISODE#{order:02d}``
* Jobs     ``jobType`` = ``SERIES_PLAN`` | ``SERIES_EPISODE``

Series status:  planning -> ready_for_approval -> generating -> completed
                planning -> failed            (planner error)
                generating -> attention       (an episode failed; retry resumes)
Episode status: planned -> queued -> processing -> completed | failed

Every transition is a conditional DynamoDB transaction keyed on the active job
id, so a duplicate or late worker delivery can never regenerate an episode or
enqueue the next one twice.
"""
from __future__ import annotations

import json
import logging
import os
import time
import uuid
from datetime import datetime, timezone
from decimal import Decimal
from typing import Any, Callable, Optional

import boto3
from boto3.dynamodb.conditions import Key
from boto3.dynamodb.types import TypeSerializer
from botocore.exceptions import ClientError

from security.content_filter import check_topic_safety
from security.input_validator import (
    ValidationError,
    validate_episode_count,
    validate_episode_duration,
    validate_episode_id,
    validate_message,
    validate_series_id,
    validate_series_title,
)
from security.rate_limiter import check_rate_limit

logger = logging.getLogger("audio_companion.series")

JOBS_TABLE = os.environ.get("JOBS_TABLE", "")
SERIES_TABLE = os.environ.get("SERIES_TABLE", "")
JOB_TTL_SECONDS = 24 * 60 * 60
# The worker Lambda times out after 15 minutes, so anything older is dead.
STALE_EPISODE_SECONDS = 16 * 60
MAX_SUMMARY_CHARS = 1000
MAX_DESCRIPTION_CHARS = 2000
MAX_LIST_ITEMS = 100

SERIES_JOB_TYPES = frozenset({"SERIES_PLAN", "SERIES_EPISODE"})

Response = Callable[[int, dict[str, Any]], dict[str, Any]]
Dispatch = Callable[[str], None]
InvokeAgent = Callable[..., dict[str, Any]]

_resource = None
_client = None
_serializer = TypeSerializer()

_SAFE_ERRORS = {
    "rate_limited": "Lecture rate limit reached. Wait a while, then retry this episode.",
    "content_blocked": "This episode was blocked by the content filter.",
    "missing_audio": "The episode finished without audio. Retry this episode.",
    "dispatch_failed": "The episode could not be started. Retry this episode.",
    "stale": "The episode stopped responding. Retry this episode.",
}
_DEFAULT_ERROR = "Generation failed. Retry this episode."


class SeriesJobError(Exception):
    """A worker failure carrying a user-safe error code."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


# --------------------------------------------------------------------------- #
# AWS helpers
# --------------------------------------------------------------------------- #
def _ddb():
    global _resource
    if _resource is None:
        _resource = boto3.resource("dynamodb")
    return _resource


def _ddb_client():
    global _client
    if _client is None:
        _client = boto3.client("dynamodb")
    return _client


def _series_table():
    if not SERIES_TABLE:
        raise RuntimeError("SERIES_TABLE is not configured")
    return _ddb().Table(SERIES_TABLE)


def _jobs_table():
    return _ddb().Table(JOBS_TABLE)


def _ser(value: dict[str, Any]) -> dict[str, Any]:
    return {key: _serializer.serialize(item) for key, item in value.items()}


def _transact(items: list[dict[str, Any]]) -> None:
    _ddb_client().transact_write_items(TransactItems=items)


def _is_conflict(exc: ClientError) -> bool:
    return exc.response.get("Error", {}).get("Code") in {
        "TransactionCanceledException",
        "ConditionalCheckFailedException",
    }


def _put(table: str, item: dict[str, Any], condition: Optional[str] = None) -> dict[str, Any]:
    op: dict[str, Any] = {"TableName": table, "Item": _ser(item)}
    if condition:
        op["ConditionExpression"] = condition
    return {"Put": op}


def _update(
    table: str,
    key: dict[str, Any],
    expression: str,
    values: dict[str, Any],
    condition: Optional[str] = None,
    names: Optional[dict[str, str]] = None,
) -> dict[str, Any]:
    op: dict[str, Any] = {
        "TableName": table,
        "Key": _ser(key),
        "UpdateExpression": expression,
        "ExpressionAttributeValues": _ser(values),
        "ExpressionAttributeNames": {"#status": "status", **(names or {})},
    }
    if condition:
        op["ConditionExpression"] = condition
    return {"Update": op}


# --------------------------------------------------------------------------- #
# Keys, time, conversion
# --------------------------------------------------------------------------- #
def _summary_key(user_id: str, series_id: str) -> dict[str, str]:
    return {"pk": f"USER#{user_id}", "sk": f"SERIES#{series_id}"}


def _episode_key(series_id: str, order: int) -> dict[str, str]:
    return {"pk": f"SERIES#{series_id}", "sk": f"EPISODE#{int(order):02d}"}


def _epoch() -> int:
    return int(time.time())


def _iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _int(value: Any, default: int = 0) -> int:
    if isinstance(value, bool):
        return default
    if isinstance(value, (int, Decimal)):
        return int(value)
    return default


def _body(event: dict[str, Any]) -> dict[str, Any]:
    try:
        value = json.loads(event.get("body") or "{}")
    except (json.JSONDecodeError, TypeError) as exc:
        raise ValidationError("Request body must be valid JSON") from exc
    if not isinstance(value, dict):
        raise ValidationError("Request body must be a JSON object")
    return value


def _path(event: dict[str, Any], name: str) -> str:
    return (event.get("pathParameters") or {}).get(name, "") or ""


def _error(response: Response, status: int, code: str, message: str) -> dict[str, Any]:
    return response(status, {"error": code, "message": message})


# --------------------------------------------------------------------------- #
# Validation
# --------------------------------------------------------------------------- #
def _clean_text(value: Any, label: str, max_length: int) -> str:
    """Optional free text: may be empty, bounded, no control characters."""
    if value is None:
        return ""
    if not isinstance(value, str):
        raise ValidationError(f"{label} must be a string")
    cleaned = value.strip()
    if len(cleaned) > max_length:
        raise ValidationError(f"{label} must be at most {max_length} characters")
    if cleaned:
        validate_message(cleaned)  # rejects control characters
    return cleaned


def _optional_count(value: Any) -> Optional[int]:
    return None if value is None else validate_episode_count(value)


def _optional_duration(value: Any) -> Optional[int]:
    return None if value is None else validate_episode_duration(value)


def normalize_plan(raw: Any, *, keep_ids: bool) -> dict[str, Any]:
    """Validate a plan from the planner or the editor into canonical form.

    Array order is authoritative; client-supplied ``order`` values are ignored.
    """
    if not isinstance(raw, dict):
        raise ValidationError("Plan must be a JSON object")
    episodes = raw.get("episodes")
    if not isinstance(episodes, list):
        raise ValidationError("Plan episodes must be a list")
    validate_episode_count(len(episodes))

    seen: set[str] = set()
    normalized: list[dict[str, Any]] = []
    for index, episode in enumerate(episodes, start=1):
        if not isinstance(episode, dict):
            raise ValidationError("Each episode must be a JSON object")
        episode_id = episode.get("episodeId") if keep_ids else None
        if episode_id:
            episode_id = validate_episode_id(episode_id)
            if episode_id in seen:
                episode_id = None
        episode_id = episode_id or str(uuid.uuid4())
        seen.add(episode_id)
        duration = episode.get("durationMinutes", episode.get("duration_minutes"))
        normalized.append(
            {
                "episodeId": episode_id,
                "title": validate_series_title(episode.get("title")),
                "summary": _clean_text(episode.get("summary"), "Episode summary", MAX_SUMMARY_CHARS),
                "order": index,
                "durationMinutes": validate_episode_duration(duration),
            }
        )

    return {
        "title": validate_series_title(raw.get("title")),
        "description": _clean_text(raw.get("description"), "Description", MAX_DESCRIPTION_CHARS),
        "episodes": normalized,
    }


# --------------------------------------------------------------------------- #
# Reads and public shapes
# --------------------------------------------------------------------------- #
def _load_summary(user_id: str, series_id: str) -> Optional[dict[str, Any]]:
    return _series_table().get_item(Key=_summary_key(user_id, series_id)).get("Item")


def _owned_summary(user_id: str, raw_series_id: str) -> dict[str, Any]:
    """Load a summary from the caller's own partition; LookupError if absent."""
    summary = _load_summary(user_id, validate_series_id(raw_series_id))
    if not summary:
        raise LookupError("series not found")
    return summary


def _episodes(series_id: str) -> list[dict[str, Any]]:
    result = _series_table().query(
        KeyConditionExpression=Key("pk").eq(f"SERIES#{series_id}")
        & Key("sk").begins_with("EPISODE#")
    )
    items = result.get("Items", [])
    items.sort(key=lambda item: _int(item.get("order")))
    return items


def _public_summary(item: dict[str, Any]) -> dict[str, Any]:
    return {
        "seriesId": item["seriesId"],
        "title": item.get("title", ""),
        "topic": item.get("topic", ""),
        "status": item.get("status", "planning"),
        "revision": _int(item.get("revision")),
        "episodeCount": _int(item.get("episodeCount")),
        "completedEpisodeCount": _int(item.get("completedEpisodeCount")),
        "createdAt": item.get("createdAt", ""),
        "updatedAt": item.get("updatedAt", ""),
    }


def _public_episode(item: dict[str, Any]) -> dict[str, Any]:
    status = item.get("status", "planned")
    started = _int(item.get("startedAt")) or _int(item.get("queuedAt"))
    stalled = (
        status in {"queued", "processing"}
        and started > 0
        and started <= _epoch() - STALE_EPISODE_SECONDS
    )
    episode = {
        "episodeId": item["episodeId"],
        "title": item.get("title", ""),
        "summary": item.get("summary", ""),
        "order": _int(item.get("order")),
        "durationMinutes": _int(item.get("durationMinutes")),
        "status": status,
        "progress": _int(item.get("progress")),
        "attemptCount": _int(item.get("attemptCount")),
        "retryable": status == "failed" or stalled,
    }
    for field in ("lectureId", "s3Key", "error"):
        if item.get(field):
            episode[field] = item[field]
    return episode


def _detail(summary: dict[str, Any], episodes: list[dict[str, Any]]) -> dict[str, Any]:
    plan = None
    if episodes:
        plan = {
            "title": summary.get("title", ""),
            "description": summary.get("description", ""),
            "episodes": [
                {
                    "episodeId": item["episodeId"],
                    "title": item.get("title", ""),
                    "summary": item.get("summary", ""),
                    "order": _int(item.get("order")),
                    "durationMinutes": _int(item.get("durationMinutes")),
                }
                for item in episodes
            ],
        }
    return {
        **_public_summary(summary),
        "prompt": summary.get("prompt", ""),
        "description": summary.get("description", ""),
        "plan": plan,
        "episodes": [_public_episode(item) for item in episodes],
    }


def _detail_response(response: Response, status: int, user_id: str, series_id: str) -> dict[str, Any]:
    summary = _load_summary(user_id, series_id)
    if not summary:
        return _error(response, 404, "not_found", "Series not found")
    return response(status, _detail(summary, _episodes(series_id)))


# --------------------------------------------------------------------------- #
# Job construction
# --------------------------------------------------------------------------- #
def _new_job(user_id: str, job_type: str, series_id: str, message: str, **extra: Any) -> dict[str, Any]:
    now = _epoch()
    return {
        "jobId": str(uuid.uuid4()),
        "userId": user_id,
        "jobType": job_type,
        "seriesId": series_id,
        "message": message,
        "status": "pending",
        "progress": 0,
        "createdAt": now,
        "ttl": now + JOB_TTL_SECONDS,
        **{key: value for key, value in extra.items() if value is not None},
    }


def episode_message(summary: dict[str, Any], episodes: list[dict[str, Any]], episode: dict[str, Any]) -> str:
    """Build the lecture request for one episode, within the 2000-char message cap.

    The existing orchestrator infers topic and duration from this text, so the
    episode is generated by the unchanged single-lecture pipeline.
    """
    order = _int(episode.get("order"))
    total = len(episodes)
    title = str(summary.get("title", ""))[:200]
    focus = str(episode.get("summary", ""))[:600]
    text = (
        f"Create a {_int(episode.get('durationMinutes'))}-minute lecture titled "
        f"\"{str(episode.get('title', ''))[:200]}\". It is episode {order} of {total} "
        f"in the lecture series \"{title}\".\n"
    )
    if focus:
        text += f"Episode focus: {focus}\n"
    text += (
        "Teach only this episode's scope. Open with a one-sentence link to the previous "
        "episode and close by previewing the next one, without repeating their content.\n"
        "Series outline:\n"
    )
    for item in episodes:
        marker = " (this episode)" if _int(item.get("order")) == order else ""
        line = f"{_int(item.get('order'))}. {str(item.get('title', ''))[:80]}{marker}\n"
        if len(text) + len(line) > 2000:
            break
        text += line
    return validate_message(text[:2000])


def _episode_job(summary: dict[str, Any], episodes: list[dict[str, Any]], episode: dict[str, Any]) -> dict[str, Any]:
    return _new_job(
        summary["userId"],
        "SERIES_EPISODE",
        summary["seriesId"],
        episode_message(summary, episodes, episode),
        episodeId=episode["episodeId"],
        episodeOrder=_int(episode.get("order")),
    )


# --------------------------------------------------------------------------- #
# API routes
# --------------------------------------------------------------------------- #
def create_draft(event: dict[str, Any], user_id: str, response: Response, dispatch: Dispatch) -> dict[str, Any]:
    """POST /series/drafts — persist a planning series and enqueue the planner."""
    body = _body(event)
    message = validate_message(body.get("message", ""))
    episode_count = _optional_count(body.get("episodeCount"))
    duration = _optional_duration(body.get("durationMinutes"))

    if not check_rate_limit(user_id, "series_plan"):
        return _error(response, 429, "rate_limited", "Series planning rate limit reached. Try again later.")
    safety = check_topic_safety(message)
    if not safety.allowed:
        return _error(response, 403, "content_blocked", "This topic can't be turned into a lecture series.")

    series_id = str(uuid.uuid4())
    job = _new_job(
        user_id,
        "SERIES_PLAN",
        series_id,
        message,
        requestedEpisodeCount=episode_count,
        requestedDurationMinutes=duration,
    )
    now = _iso()
    summary = {
        **_summary_key(user_id, series_id),
        "entityType": "SERIES",
        "seriesId": series_id,
        "userId": user_id,
        "title": message[:80],
        "topic": message,
        "prompt": message,
        "description": "",
        "status": "planning",
        "revision": 0,
        "episodeCount": episode_count or 0,
        "completedEpisodeCount": 0,
        "planJobId": job["jobId"],
        "createdAt": now,
        "updatedAt": now,
    }
    _transact(
        [
            _put(SERIES_TABLE, summary, "attribute_not_exists(pk)"),
            _put(JOBS_TABLE, job, "attribute_not_exists(jobId)"),
        ]
    )
    try:
        dispatch(job["jobId"])
    except Exception:  # noqa: BLE001
        logger.exception("Could not dispatch series planner")
        _fail_plan(job, "dispatch_failed")
    return _detail_response(response, 202, user_id, series_id)


def list_series(user_id: str, response: Response) -> dict[str, Any]:
    """GET /series — the caller's series, newest first."""
    items: list[dict[str, Any]] = []
    kwargs: dict[str, Any] = {
        "KeyConditionExpression": Key("pk").eq(f"USER#{user_id}") & Key("sk").begins_with("SERIES#")
    }
    while len(items) < MAX_LIST_ITEMS:
        result = _series_table().query(**kwargs)
        items.extend(result.get("Items", []))
        if "LastEvaluatedKey" not in result:
            break
        kwargs["ExclusiveStartKey"] = result["LastEvaluatedKey"]
    items.sort(key=lambda item: item.get("createdAt", ""), reverse=True)
    return response(200, {"series": [_public_summary(item) for item in items[:MAX_LIST_ITEMS]]})


def get_series(event: dict[str, Any], user_id: str, response: Response) -> dict[str, Any]:
    """GET /series/{seriesId} — summary, editable plan, and episode progress."""
    summary = _owned_summary(user_id, _path(event, "seriesId"))
    return response(200, _detail(summary, _episodes(summary["seriesId"])))


def save_plan(event: dict[str, Any], user_id: str, response: Response) -> dict[str, Any]:
    """POST /series/{seriesId}/plan — replace the draft plan (revision-checked)."""
    summary = _owned_summary(user_id, _path(event, "seriesId"))
    series_id = summary["seriesId"]
    body = _body(event)
    revision = body.get("revision")
    if summary.get("status") != "ready_for_approval":
        return _error(response, 409, "invalid_state", "Only a plan awaiting approval can be edited.")
    if isinstance(revision, bool) or not isinstance(revision, int) or revision != _int(summary.get("revision")):
        return _error(response, 409, "conflict", "This plan changed. Reload it before saving.")

    plan = normalize_plan(body.get("plan"), keep_ids=True)
    now = _iso()
    old_count = _int(summary.get("episodeCount"))
    new_count = len(plan["episodes"])

    transaction = [
        _put(SERIES_TABLE, _episode_item(user_id, series_id, episode, now))
        for episode in plan["episodes"]
    ]
    transaction.extend(
        {"Delete": {"TableName": SERIES_TABLE, "Key": _ser(_episode_key(series_id, order))}}
        for order in range(new_count + 1, old_count + 1)
    )
    transaction.append(
        _update(
            SERIES_TABLE,
            _summary_key(user_id, series_id),
            "SET #title = :title, #description = :description, episodeCount = :count, "
            "revision = revision + :one, updatedAt = :now",
            {
                ":title": plan["title"],
                ":description": plan["description"],
                ":count": new_count,
                ":one": 1,
                ":now": now,
                ":ready": "ready_for_approval",
                ":revision": revision,
            },
            condition="#status = :ready AND revision = :revision",
            names={"#title": "title", "#description": "description"},
        )
    )
    try:
        _transact(transaction)
    except ClientError as exc:
        if _is_conflict(exc):
            return _error(response, 409, "conflict", "This plan changed. Reload it before saving.")
        raise
    return _detail_response(response, 200, user_id, series_id)


def approve(event: dict[str, Any], user_id: str, response: Response, dispatch: Dispatch) -> dict[str, Any]:
    """POST /series/{seriesId}/approve — freeze the plan and start episode 1."""
    summary = _owned_summary(user_id, _path(event, "seriesId"))
    series_id = summary["seriesId"]
    revision = _body(event).get("revision")
    if summary.get("status") != "ready_for_approval":
        return _error(response, 409, "invalid_state", "This series is not awaiting approval.")
    if isinstance(revision, bool) or not isinstance(revision, int) or revision != _int(summary.get("revision")):
        return _error(response, 409, "conflict", "This plan changed. Reload it before approving.")

    episodes = _episodes(series_id)
    validate_episode_count(len(episodes))
    first = episodes[0]
    job = _episode_job(summary, episodes, first)
    epoch, now = _epoch(), _iso()
    try:
        _transact(
            [
                _put(JOBS_TABLE, job, "attribute_not_exists(jobId)"),
                _update(
                    SERIES_TABLE,
                    _episode_key(series_id, _int(first.get("order"))),
                    "SET #status = :queued, activeJobId = :job, progress = :zero, "
                    "queuedAt = :epoch, updatedAt = :now",
                    {":queued": "queued", ":job": job["jobId"], ":zero": 0, ":epoch": epoch,
                     ":now": now, ":planned": "planned"},
                    condition="#status = :planned",
                ),
                _update(
                    SERIES_TABLE,
                    _summary_key(user_id, series_id),
                    "SET #status = :generating, activeJobId = :job, approvedAt = :now, updatedAt = :now",
                    {":generating": "generating", ":job": job["jobId"], ":now": now,
                     ":ready": "ready_for_approval", ":revision": revision},
                    condition="#status = :ready AND revision = :revision",
                ),
            ]
        )
    except ClientError as exc:
        if _is_conflict(exc):
            return _error(response, 409, "conflict", "This series changed. Reload it and try again.")
        raise
    _dispatch_or_pause(job, dispatch)
    return _detail_response(response, 202, user_id, series_id)


def retry_episode(event: dict[str, Any], user_id: str, response: Response, dispatch: Dispatch) -> dict[str, Any]:
    """POST /series/{seriesId}/episodes/{episodeId}/retry — failed or stale only."""
    summary = _owned_summary(user_id, _path(event, "seriesId"))
    series_id = summary["seriesId"]
    episode_id = validate_episode_id(_path(event, "episodeId"))
    episodes = _episodes(series_id)
    episode = next((item for item in episodes if item.get("episodeId") == episode_id), None)
    if not episode:
        raise LookupError("episode not found")

    status = episode.get("status")
    epoch = _epoch()
    started = _int(episode.get("startedAt")) or _int(episode.get("queuedAt"))
    stale = status in {"queued", "processing"} and started <= epoch - STALE_EPISODE_SECONDS
    if status != "failed" and not stale:
        return _error(response, 409, "invalid_state", "Only a failed or stalled episode can be retried.")

    old_job = episode.get("activeJobId", "")
    job = _episode_job(summary, episodes, episode)
    now = _iso()
    try:
        _transact(
            [
                _put(JOBS_TABLE, job, "attribute_not_exists(jobId)"),
                _update(
                    SERIES_TABLE,
                    _episode_key(series_id, _int(episode.get("order"))),
                    "SET #status = :queued, activeJobId = :job, progress = :zero, "
                    "queuedAt = :epoch, updatedAt = :now REMOVE #error, errorCode",
                    {":queued": "queued", ":job": job["jobId"], ":zero": 0, ":epoch": epoch,
                     ":now": now, ":old_status": status, ":old_job": old_job},
                    condition="#status = :old_status AND activeJobId = :old_job",
                    names={"#error": "error"},
                ),
                _update(
                    SERIES_TABLE,
                    _summary_key(user_id, series_id),
                    "SET #status = :generating, activeJobId = :job, updatedAt = :now",
                    {":generating": "generating", ":job": job["jobId"], ":now": now,
                     ":attention": "attention", ":old_job": old_job},
                    condition="#status = :attention OR activeJobId = :old_job",
                ),
            ]
        )
    except ClientError as exc:
        if _is_conflict(exc):
            return _error(response, 409, "conflict", "This episode changed. Reload the series.")
        raise
    _dispatch_or_pause(job, dispatch)
    return _detail_response(response, 202, user_id, series_id)


def _episode_item(user_id: str, series_id: str, episode: dict[str, Any], now: str) -> dict[str, Any]:
    return {
        **_episode_key(series_id, episode["order"]),
        "entityType": "EPISODE",
        "seriesId": series_id,
        "userId": user_id,
        "episodeId": episode["episodeId"],
        "order": episode["order"],
        "title": episode["title"],
        "summary": episode["summary"],
        "durationMinutes": episode["durationMinutes"],
        "status": "planned",
        "progress": 0,
        "attemptCount": 0,
        "createdAt": now,
        "updatedAt": now,
    }


# --------------------------------------------------------------------------- #
# Worker
# --------------------------------------------------------------------------- #
def run_job(job: dict[str, Any], invoke_agent: InvokeAgent, dispatch: Dispatch) -> dict[str, Any]:
    """Run a persisted SERIES_PLAN or SERIES_EPISODE job (async worker role)."""
    if job.get("jobType") == "SERIES_PLAN":
        return _run_plan(job, invoke_agent)
    if job.get("jobType") == "SERIES_EPISODE":
        return _run_episode(job, invoke_agent, dispatch)
    raise RuntimeError("Unknown series job type")


def _claim_job(job: dict[str, Any]) -> Optional[str]:
    """Claim planning work with a fencing token; a redelivery supersedes safely."""
    claim_token = str(uuid.uuid4())
    try:
        _transact(
            [
                _update(
                    JOBS_TABLE,
                    {"jobId": job["jobId"]},
                    "SET #status = :processing, progress = :progress, startedAt = :now, "
                    "claimToken = :claim",
                    {
                        ":processing": "processing",
                        ":progress": 10,
                        ":pending": "pending",
                        ":now": _epoch(),
                        ":claim": claim_token,
                    },
                    condition="#status = :pending OR #status = :processing",
                ),
                _update(
                    SERIES_TABLE,
                    _summary_key(job["userId"], job["seriesId"]),
                    "SET planClaimToken = :claim, updatedAt = :now",
                    {
                        ":claim": claim_token,
                        ":now": _iso(),
                        ":planning": "planning",
                        ":job": job["jobId"],
                    },
                    condition="#status = :planning AND planJobId = :job",
                ),
            ]
        )
        return claim_token
    except ClientError as exc:
        if _is_conflict(exc):
            return None
        raise


def _run_plan(job: dict[str, Any], invoke_agent: InvokeAgent) -> dict[str, Any]:
    claim_token = _claim_job(job)
    if not claim_token:
        return {"ok": True, "duplicate": True}
    try:
        extra: dict[str, Any] = {}
        if job.get("requestedEpisodeCount") is not None:
            extra["episode_count"] = _int(job["requestedEpisodeCount"])
        if job.get("requestedDurationMinutes") is not None:
            extra["duration_minutes"] = _int(job["requestedDurationMinutes"])
        result = invoke_agent(job["userId"], job["message"], job["jobId"], "series_plan", extra)
        if result.get("error"):
            raise SeriesJobError(str(result["error"]))
        plan = normalize_plan(result.get("plan"), keep_ids=False)

        now = _iso()
        transaction = [
            _put(SERIES_TABLE, _episode_item(job["userId"], job["seriesId"], episode, now),
                 "attribute_not_exists(pk)")
            for episode in plan["episodes"]
        ]
        transaction.append(
            _update(
                SERIES_TABLE,
                _summary_key(job["userId"], job["seriesId"]),
                "SET #status = :ready, #title = :title, #description = :description, "
                "episodeCount = :count, revision = :one, updatedAt = :now",
                {":ready": "ready_for_approval", ":title": plan["title"],
                 ":description": plan["description"], ":count": len(plan["episodes"]),
                 ":one": 1, ":now": now, ":planning": "planning", ":job": job["jobId"],
                 ":claim": claim_token},
                condition=(
                    "#status = :planning AND planJobId = :job "
                    "AND planClaimToken = :claim"
                ),
                names={"#title": "title", "#description": "description"},
            )
        )
        transaction.append(
            _update(
                JOBS_TABLE,
                {"jobId": job["jobId"]},
                "SET #status = :completed, progress = :hundred",
                {":completed": "completed", ":hundred": 100, ":processing": "processing",
                 ":claim": claim_token},
                condition="#status = :processing AND claimToken = :claim",
            )
        )
        _transact(transaction)
        return {"ok": True}
    except Exception as exc:  # noqa: BLE001
        logger.exception("Series plan job failed")
        _fail_plan(
            job,
            exc.code if isinstance(exc, SeriesJobError) else type(exc).__name__,
            claim_token=claim_token,
        )
        return {"ok": False}


def _fail_plan(
    job: dict[str, Any], code: str, *, claim_token: Optional[str] = None
) -> None:
    job_values: dict[str, Any] = {
        ":failed": "failed",
        ":hundred": 100,
        ":code": code[:100],
        ":expected": "processing" if claim_token else "pending",
    }
    summary_values: dict[str, Any] = {
        ":failed": "failed",
        ":code": code[:100],
        ":now": _iso(),
        ":job": job["jobId"],
        ":planning": "planning",
    }
    job_condition = "#status = :expected"
    summary_condition = "#status = :planning AND planJobId = :job"
    if claim_token:
        job_values[":claim"] = claim_token
        summary_values[":claim"] = claim_token
        job_condition += " AND claimToken = :claim"
        summary_condition += " AND planClaimToken = :claim"
    try:
        _transact(
            [
                _update(
                    JOBS_TABLE,
                    {"jobId": job["jobId"]},
                    "SET #status = :failed, progress = :hundred, errorCode = :code",
                    job_values,
                    condition=job_condition,
                ),
                _update(
                    SERIES_TABLE,
                    _summary_key(job["userId"], job["seriesId"]),
                    "SET #status = :failed, errorCode = :code, updatedAt = :now",
                    summary_values,
                    condition=summary_condition,
                ),
            ]
        )
    except ClientError:
        logger.info("Series planning failure was superseded by another claim")


def _claim_episode(job: dict[str, Any]) -> bool:
    try:
        _transact(
            [
                _update(
                    JOBS_TABLE,
                    {"jobId": job["jobId"]},
                    "SET #status = :processing, progress = :ten",
                    {":processing": "processing", ":ten": 10, ":pending": "pending"},
                    condition="#status = :pending",
                ),
                _update(
                    SERIES_TABLE,
                    _episode_key(job["seriesId"], _int(job.get("episodeOrder"))),
                    "SET #status = :processing, progress = :ten, startedAt = :epoch, "
                    "attemptCount = if_not_exists(attemptCount, :zero) + :one, updatedAt = :now",
                    {":processing": "processing", ":ten": 10, ":epoch": _epoch(), ":zero": 0,
                     ":one": 1, ":now": _iso(), ":queued": "queued", ":job": job["jobId"]},
                    condition="#status = :queued AND activeJobId = :job",
                ),
            ]
        )
        return True
    except ClientError as exc:
        if _is_conflict(exc):
            return False
        raise


def _run_episode(job: dict[str, Any], invoke_agent: InvokeAgent, dispatch: Dispatch) -> dict[str, Any]:
    if not _claim_episode(job):
        # Duplicate delivery, or superseded by a retry: never generate twice.
        return {"ok": True, "duplicate": True}
    try:
        result = invoke_agent(
            job["userId"],
            job["message"],
            job["jobId"],
            "lecture",
            {
                "series_id": job["seriesId"],
                "episode_id": job["episodeId"],
                "episode_order": _int(job.get("episodeOrder")),
            },
        )
        if result.get("error"):
            raise SeriesJobError(str(result["error"]))
        lecture = result.get("lecture")
        if not isinstance(lecture, dict) or not lecture.get("s3Key") or not lecture.get("lectureId"):
            raise SeriesJobError("missing_audio")
        next_job = _complete_episode(job, lecture, result)
    except Exception as exc:  # noqa: BLE001
        logger.exception("Series episode job failed")
        _fail_episode(job, exc.code if isinstance(exc, SeriesJobError) else type(exc).__name__,
                      job_status="processing")
        return {"ok": False}

    if next_job:
        _dispatch_or_pause(next_job, dispatch)
    return {"ok": True}


def _complete_episode(job: dict[str, Any], lecture: dict[str, Any], result: dict[str, Any]) -> Optional[dict[str, Any]]:
    """Atomically complete this episode and queue the next planned one, if any."""
    summary = _load_summary(job["userId"], job["seriesId"])
    if not summary:
        raise RuntimeError("Series summary no longer exists")
    episodes = _episodes(job["seriesId"])
    current = _int(job.get("episodeOrder"))
    remaining = [
        item for item in episodes
        if item.get("status") == "planned" and _int(item.get("order")) != current
    ]
    next_episode = min(remaining, key=lambda item: _int(item.get("order"))) if remaining else None
    next_job = _episode_job(summary, episodes, next_episode) if next_episode else None
    epoch, now = _epoch(), _iso()

    actual_minutes = lecture.get("durationMinutes")
    try:
        actual_minutes = int(round(float(actual_minutes)))
    except (TypeError, ValueError):
        actual_minutes = 0

    transaction = [
        _update(
            SERIES_TABLE,
            _episode_key(job["seriesId"], current),
            "SET #status = :completed, progress = :hundred, lectureId = :lecture_id, "
            "s3Key = :s3_key, actualDurationMinutes = :actual, completedAt = :now, "
            "updatedAt = :now REMOVE #error, errorCode",
            {":completed": "completed", ":hundred": 100, ":lecture_id": str(lecture["lectureId"]),
             ":s3_key": str(lecture["s3Key"]), ":actual": actual_minutes, ":now": now,
             ":processing": "processing", ":job": job["jobId"]},
            condition="#status = :processing AND activeJobId = :job",
            names={"#error": "error"},
        ),
        _update(
            JOBS_TABLE,
            {"jobId": job["jobId"]},
            "SET #status = :completed, progress = :hundred, #result = :result",
            {":completed": "completed", ":hundred": 100, ":result": json.dumps(result, default=str),
             ":processing": "processing"},
            condition="#status = :processing",
            names={"#result": "result"},
        ),
    ]
    summary_key = _summary_key(job["userId"], job["seriesId"])
    if next_episode and next_job:
        transaction.extend(
            [
                _put(JOBS_TABLE, next_job, "attribute_not_exists(jobId)"),
                _update(
                    SERIES_TABLE,
                    _episode_key(job["seriesId"], _int(next_episode.get("order"))),
                    "SET #status = :queued, activeJobId = :job, progress = :zero, "
                    "queuedAt = :epoch, updatedAt = :now",
                    {":queued": "queued", ":job": next_job["jobId"], ":zero": 0, ":epoch": epoch,
                     ":now": now, ":planned": "planned"},
                    condition="#status = :planned",
                ),
                _update(
                    SERIES_TABLE,
                    summary_key,
                    "SET completedEpisodeCount = completedEpisodeCount + :one, "
                    "activeJobId = :job, updatedAt = :now",
                    {":one": 1, ":job": next_job["jobId"], ":now": now, ":generating": "generating"},
                    condition="#status = :generating",
                ),
            ]
        )
    else:
        transaction.append(
            _update(
                SERIES_TABLE,
                summary_key,
                "SET #status = :completed, completedEpisodeCount = completedEpisodeCount + :one, "
                "completedAt = :now, updatedAt = :now REMOVE activeJobId",
                {":completed": "completed", ":one": 1, ":now": now, ":generating": "generating"},
                condition="#status = :generating",
            )
        )
    _transact(transaction)
    return next_job


def _fail_episode(job: dict[str, Any], code: str, *, job_status: str) -> None:
    """Mark the episode failed and pause the series. Later episodes stay planned."""
    message = _SAFE_ERRORS.get(code, _DEFAULT_ERROR)
    now = _iso()
    try:
        _transact(
            [
                _update(
                    JOBS_TABLE,
                    {"jobId": job["jobId"]},
                    "SET #status = :failed, progress = :hundred, errorCode = :code",
                    {":failed": "failed", ":hundred": 100, ":code": code[:100], ":expected": job_status},
                    condition="#status = :expected",
                ),
                _update(
                    SERIES_TABLE,
                    _episode_key(job["seriesId"], _int(job.get("episodeOrder"))),
                    "SET #status = :failed, progress = :hundred, #error = :message, "
                    "errorCode = :code, updatedAt = :now",
                    {":failed": "failed", ":hundred": 100, ":message": message, ":code": code[:100],
                     ":now": now, ":job": job["jobId"]},
                    condition="activeJobId = :job",
                    names={"#error": "error"},
                ),
                _update(
                    SERIES_TABLE,
                    _summary_key(job["userId"], job["seriesId"]),
                    "SET #status = :attention, updatedAt = :now",
                    {":attention": "attention", ":now": now, ":job": job["jobId"]},
                    condition="activeJobId = :job",
                ),
            ]
        )
    except ClientError:
        # Superseded by a retry or already finalized; nothing to record.
        logger.warning("Series episode failure was superseded", exc_info=True)


def _dispatch_or_pause(job: dict[str, Any], dispatch: Dispatch) -> None:
    """Dispatch a persisted job; if dispatch fails, leave a retryable failure."""
    try:
        dispatch(job["jobId"])
    except Exception:  # noqa: BLE001
        logger.exception("Could not dispatch series episode job")
        _fail_episode(job, "dispatch_failed", job_status="pending")
