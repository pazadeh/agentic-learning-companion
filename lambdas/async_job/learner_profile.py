"""Cloud-synced explicit profiles, playback telemetry, and inferred preferences.

The explicit profile is user-authored. Inferences are derived deterministically from
that user's durable lecture/playback rows, so they remain explainable and resettable;
no LLM is allowed to overwrite declared preferences.
"""
from __future__ import annotations

import json
import math
import os
import re
import time
import uuid
from collections import defaultdict
from datetime import datetime, timezone
from decimal import Decimal
from typing import Any, Callable

import boto3
from boto3.dynamodb.conditions import Key
from boto3.dynamodb.types import TypeSerializer
from botocore.exceptions import ClientError

PROFILES_TABLE = os.environ.get("PROFILES_TABLE", "")
LECTURES_TABLE = os.environ.get("LECTURES_TABLE", "")
DEFAULT_DURATION = 15
MAX_LECTURES = 100
PLAYBACK_SESSION_TTL = 7 * 24 * 60 * 60

Response = Callable[[int, dict[str, Any]], dict[str, Any]]
_serializer = TypeSerializer()
_resource = None
_client = None

_STYLES = {"examples", "theory", "practical"}
_LEVELS = {"beginner", "intermediate", "advanced"}
_EVENTS = {"heartbeat", "pause", "ended"}
_CONTROL_RE = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")


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


def _profiles():
    if not PROFILES_TABLE:
        raise RuntimeError("PROFILES_TABLE is not configured")
    return _ddb().Table(PROFILES_TABLE)


def _lectures():
    if not LECTURES_TABLE:
        raise RuntimeError("LECTURES_TABLE is not configured")
    return _ddb().Table(LECTURES_TABLE)


def _ser(value: dict[str, Any]) -> dict[str, Any]:
    return {key: _serializer.serialize(item) for key, item in value.items()}


def _iso_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _body(event: dict[str, Any]) -> dict[str, Any]:
    try:
        value = json.loads(event.get("body") or "{}")
    except (json.JSONDecodeError, TypeError) as exc:
        raise ValueError("Request body must be valid JSON") from exc
    if not isinstance(value, dict):
        raise ValueError("Request body must be an object")
    return value


def _text(value: Any, label: str, maximum: int) -> str:
    if not isinstance(value, str):
        raise ValueError(f"{label} must be a string")
    result = value.strip()
    if len(result) > maximum:
        raise ValueError(f"{label} must be at most {maximum} characters")
    if _CONTROL_RE.search(result):
        raise ValueError(f"{label} contains unsupported characters")
    return result


def _tags(value: Any, label: str, item_maximum: int = 100) -> list[str]:
    if not isinstance(value, list) or len(value) > 20:
        raise ValueError(f"{label} must be a list of at most 20 items")
    result: list[str] = []
    for item in value:
        tag = _text(item, label, item_maximum)
        if tag and tag.casefold() not in {existing.casefold() for existing in result}:
            result.append(tag)
    return result


def _knowledge_levels(value: Any) -> dict[str, str]:
    if not isinstance(value, dict) or len(value) > 50:
        raise ValueError("Knowledge levels must be an object with at most 50 topics")
    result: dict[str, str] = {}
    for raw_topic, level in value.items():
        topic = _text(raw_topic, "Knowledge topic", 100)
        if level not in _LEVELS:
            raise ValueError("Knowledge level must be beginner, intermediate, or advanced")
        if topic:
            result[topic] = level
    return result


def _explicit_key(user_id: str) -> dict[str, str]:
    return {"pk": f"USER#{user_id}", "sk": "PROFILE#EXPLICIT"}


def _load_explicit_record(user_id: str) -> dict[str, Any]:
    return (
        _profiles()
        .get_item(Key=_explicit_key(user_id), ConsistentRead=True)
        .get("Item")
        or {}
    )


def _load_legacy_profile(user_id: str) -> dict[str, Any]:
    return (
        _profiles()
        .get_item(
            Key={"pk": f"USER#{user_id}", "sk": "PROFILE"},
            ConsistentRead=True,
        )
        .get("Item")
        or {}
    )


def _load_explicit(user_id: str) -> dict[str, Any]:
    """Merge a legacy profile beneath the versioned explicit record."""
    return {**_load_legacy_profile(user_id), **_load_explicit_record(user_id)}


def _explicit_public(item: dict[str, Any]) -> dict[str, Any]:
    return {
        "profession": item.get("profession", ""),
        "expertiseAreas": list(item.get("expertiseAreas", [])),
        "learningGoals": list(item.get("learningGoals", [])),
        "learningStyle": item.get("learningStyle", "examples"),
        "preferredDuration": int(item.get("preferredDuration", DEFAULT_DURATION)),
        "knowledgeLevels": dict(item.get("knowledgeLevels", {})),
        "behavioralPersonalizationEnabled": item.get("behavioralPersonalizationEnabled", True),
    }


def _parse_time(value: Any) -> float:
    if not isinstance(value, str) or not value:
        return 0.0
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return 0.0


def _number(value: Any) -> float:
    if isinstance(value, bool):
        return 0.0
    if isinstance(value, (int, float, Decimal)):
        return float(value)
    return 0.0


def _lecture_rows(user_id: str) -> list[dict[str, Any]]:
    result = _lectures().query(
        IndexName="GSI1",
        KeyConditionExpression=Key("pk").eq(f"USER#{user_id}"),
        ScanIndexForward=False,
        Limit=MAX_LECTURES,
    )
    return list(result.get("Items", []))


def _confidence(weight: float, scale: float = 3.0) -> int:
    return max(0, min(99, round((1 - math.exp(-weight / scale)) * 100)))


def _choice_trait(rows: list[tuple[str, float]], allowed: set[str]) -> dict[str, Any] | None:
    scores: dict[str, float] = defaultdict(float)
    samples: dict[str, int] = defaultdict(int)
    for value, weight in rows:
        if value in allowed and weight > 0:
            scores[value] += weight
            samples[value] += 1
    if not scores:
        return None
    value = max(scores, key=scores.get)
    total = sum(scores.values())
    confidence = round(100 * scores[value] / total) if total else 0
    confidence = min(confidence, _confidence(total, 2.0))
    return {
        "value": value,
        "confidencePercent": confidence,
        "sampleCount": samples[value],
    }


def derive_inferences(
    user_id: str, explicit_snapshot: dict[str, Any] | None = None
) -> dict[str, Any]:
    explicit = explicit_snapshot if explicit_snapshot is not None else _load_explicit(user_id)
    enabled = explicit.get("behavioralPersonalizationEnabled", True) is not False

    reset_at = _parse_time(explicit.get("inferenceResetAt"))
    inference_generation = int(explicit.get("inferenceGeneration", 0))
    now = time.time()
    topic_scores: dict[str, dict[str, Any]] = {}
    duration_weighted = 0.0
    duration_weight = 0.0
    duration_samples = 0
    rate_weighted = 0.0
    rate_weight = 0.0
    rate_samples = 0
    style_rows: list[tuple[str, float]] = []
    level_rows: list[tuple[str, float]] = []
    total_listened = 0.0
    completed = 0

    for lecture in _lecture_rows(user_id):
        created = _parse_time(lecture.get("createdAt"))
        last_listened = _parse_time(lecture.get("lastListenedAt"))
        inference_last_listened = _parse_time(lecture.get("inferenceLastListenedAt"))
        requested_after_reset = created > reset_at
        evidence_time = (
            max(created if requested_after_reset else 0.0, inference_last_listened)
            if reset_at
            else max(created, last_listened)
        )
        lifetime_listened = max(0.0, _number(lecture.get("listenedSeconds")))
        media_duration = max(1.0, _number(lecture.get("mediaDurationSeconds")))
        lifetime_completion = min(1.0, lifetime_listened / media_duration) if lifetime_listened else 0.0
        total_listened += lifetime_listened
        if lifetime_completion >= 0.9:
            completed += 1

        inference_total = max(
            0.0,
            _number(lecture.get(f"inferenceEligibleG{inference_generation}")),
        )
        inference_listened = (
            max(lifetime_listened, inference_total)
            if inference_generation == 0
            else inference_total
        )
        completion = min(1.0, inference_listened / media_duration) if inference_listened else 0.0
        if not requested_after_reset and completion <= 0:
            continue

        age_days = max(0.0, (now - evidence_time) / 86400)
        decay = math.exp(-age_days / 180.0)
        topic = str(lecture.get("topic") or lecture.get("title") or "").strip()
        normalized = re.sub(r"\s+", " ", topic.casefold())[:160]
        if normalized:
            signal_weight = (0.25 if requested_after_reset else 0.0) + 0.75 * completion
            entry = topic_scores.setdefault(
                normalized,
                {"topic": topic[:200], "score": 0.0, "sampleCount": 0, "lastObservedAt": ""},
            )
            entry["score"] += decay * signal_weight
            entry["sampleCount"] += 1
            if str(lecture.get("lastListenedAt") or lecture.get("createdAt") or "") > entry["lastObservedAt"]:
                entry["lastObservedAt"] = str(
                    lecture.get("lastListenedAt") or lecture.get("createdAt") or ""
                )

        if completion >= 0.8:
            weight = decay * completion
            duration = _number(lecture.get("durationMinutes"))
            if duration > 0:
                duration_weighted += duration * weight
                duration_weight += weight
                duration_samples += 1
            rate = _number(lecture.get("playbackRate"))
            if 0.5 <= rate <= 3:
                rate_weighted += rate * weight
                rate_weight += weight
                rate_samples += 1
            used = lecture.get("personalizationUsed")
            if isinstance(used, dict):
                style = used.get("learningStyle", {})
                level = used.get("knowledgeLevel", {})
                if isinstance(style, dict):
                    style_rows.append((str(style.get("value", "")), weight))
                if isinstance(level, dict):
                    level_rows.append((str(level.get("value", "")), weight))

    if not enabled:
        return {
            "enabled": False,
            "topicInterests": [],
            "stats": {
                "lecturesCompleted": completed,
                "totalListeningSeconds": round(total_listened),
            },
        }

    interests = sorted(topic_scores.values(), key=lambda item: item["score"], reverse=True)[:8]
    for item in interests:
        item["confidencePercent"] = _confidence(item.pop("score"))
    interests = [item for item in interests if item["confidencePercent"] > 0]

    result: dict[str, Any] = {
        "enabled": True,
        "topicInterests": interests,
        "stats": {
            "lecturesCompleted": completed,
            "totalListeningSeconds": round(total_listened),
        },
    }
    if duration_weight > 0:
        result["preferredDuration"] = {
            "value": max(5, min(60, round(duration_weighted / duration_weight / 5) * 5)),
            "confidencePercent": _confidence(duration_weight),
            "sampleCount": duration_samples,
        }
    if rate_weight > 0:
        result["preferredPlaybackRate"] = {
            "value": round(rate_weighted / rate_weight, 2),
            "confidencePercent": _confidence(rate_weight),
            "sampleCount": rate_samples,
        }
    style = _choice_trait(style_rows, _STYLES)
    if style:
        result["learningStyle"] = style
    level = _choice_trait(level_rows, _LEVELS)
    if level:
        result["knowledgeLevel"] = level
    return result


def _current_request_preferences(message: str) -> dict[str, Any]:
    lower = message.casefold()
    result: dict[str, Any] = {}
    duration = re.search(r"\b(\d{1,2})\s*(?:-| )?\s*minutes?\b", lower)
    if duration and 1 <= int(duration.group(1)) <= 60:
        result["durationMinutes"] = int(duration.group(1))
    if re.search(r"\b(beginner|introductory|from scratch|the basics)\b", lower):
        result["knowledgeLevel"] = "beginner"
    elif re.search(r"\b(advanced|expert|deep dive|in-depth)\b", lower):
        result["knowledgeLevel"] = "advanced"
    if re.search(r"\b(example|examples|analogy|analogies)\b", lower):
        result["learningStyle"] = "examples"
    elif re.search(r"\b(theory|theoretical|conceptual)\b", lower):
        result["learningStyle"] = "theory"
    elif re.search(r"\b(practical|hands-on|implementation|implement)\b", lower):
        result["learningStyle"] = "practical"
    if re.search(r"\b(deep dive|in-depth|comprehensive|advanced)\b", lower):
        result["researchDepth"] = "deep"
    return result


def _resolved(value: Any, source: str, confidence: int = 100) -> dict[str, Any]:
    return {"value": value, "source": source, "confidencePercent": confidence}


def resolve_personalization(user_id: str, message: str) -> dict[str, Any]:
    """Resolve request > explicit > confident inference > default."""
    explicit_item = _load_explicit(user_id)
    inferred = derive_inferences(user_id, explicit_snapshot=explicit_item)
    current = _current_request_preferences(message)

    def choose(name: str, explicit_name: str, inferred_name: str, default: Any) -> dict[str, Any]:
        if name in current:
            return _resolved(current[name], "current_request")
        if explicit_name in explicit_item:
            return _resolved(explicit_item[explicit_name], "explicit")
        trait = inferred.get(inferred_name)
        if (
            isinstance(trait, dict)
            and int(trait.get("confidencePercent", 0)) >= 70
            and int(trait.get("sampleCount", 0)) >= 3
        ):
            return _resolved(trait.get("value"), "inferred", int(trait["confidencePercent"]))
        return _resolved(default, "default", 0)

    knowledge = choose("knowledgeLevel", "__none__", "knowledgeLevel", "intermediate")
    if "knowledgeLevel" not in current:
        levels = explicit_item.get("knowledgeLevels", {})
        if isinstance(levels, dict):
            message_lower = message.casefold()
            matching = [
                (str(topic), level)
                for topic, level in levels.items()
                if str(topic).casefold() in message_lower and level in _LEVELS
            ]
            if matching:
                _, level = max(matching, key=lambda item: len(item[0]))
                knowledge = _resolved(level, "explicit")

    has_research_override = "researchDepth" in current
    return {
        "learningStyle": choose("learningStyle", "learningStyle", "learningStyle", "examples"),
        "knowledgeLevel": knowledge,
        "durationMinutes": choose(
            "durationMinutes", "preferredDuration", "preferredDuration", DEFAULT_DURATION
        ),
        "researchDepth": _resolved(
            current.get("researchDepth", "standard"),
            "current_request" if has_research_override else "default",
            100 if has_research_override else 0,
        ),
    }


def get_profile(user_id: str, response: Response) -> dict[str, Any]:
    explicit_record = _load_explicit_record(user_id)
    explicit = {**_load_legacy_profile(user_id), **explicit_record}
    inferred = derive_inferences(user_id, explicit_snapshot=explicit)
    stats = inferred.get("stats", {"lecturesCompleted": 0, "totalListeningSeconds": 0})
    return response(
        200,
        {
            "explicit": _explicit_public(explicit),
            "inferred": inferred,
            "stats": stats,
            "revision": int(explicit_record.get("revision", 0)),
            "hasExplicitProfile": bool(explicit),
        },
    )


def put_profile(event: dict[str, Any], user_id: str, response: Response) -> dict[str, Any]:
    body = _body(event)
    style = body.get("learningStyle", "examples")
    if style not in _STYLES:
        raise ValueError("Learning style must be examples, theory, or practical")
    duration = body.get("preferredDuration", DEFAULT_DURATION)
    if isinstance(duration, bool) or not isinstance(duration, int) or not 5 <= duration <= 60:
        raise ValueError("Preferred duration must be a whole number from 5 to 60")
    enabled = body.get("behavioralPersonalizationEnabled", True)
    if not isinstance(enabled, bool):
        raise ValueError("Behavioral personalization setting must be true or false")

    existing_record = _load_explicit_record(user_id)
    existing = {**_load_legacy_profile(user_id), **existing_record}
    current_revision = int(existing_record.get("revision", 0))
    requested_revision = body.get("revision")
    if (
        isinstance(requested_revision, bool)
        or not isinstance(requested_revision, int)
        or requested_revision != current_revision
    ):
        return response(409, {"error": "conflict", "message": "This profile changed. Reload it before saving."})

    now = _iso_now()
    item = {
        **_explicit_key(user_id),
        "entityType": "EXPLICIT_PROFILE",
        "profession": _text(body.get("profession", ""), "Profession", 200),
        "expertiseAreas": _tags(body.get("expertiseAreas", []), "Expertise areas"),
        "learningGoals": _tags(body.get("learningGoals", []), "Learning goals", 500),
        "learningStyle": style,
        "preferredDuration": duration,
        "knowledgeLevels": _knowledge_levels(body.get("knowledgeLevels", {})),
        "behavioralPersonalizationEnabled": enabled,
        "revision": current_revision + 1,
        "createdAt": existing.get("createdAt", now),
        "updatedAt": now,
    }
    privacy_boundary_changed = (
        existing.get("behavioralPersonalizationEnabled", True) != enabled
    )
    if privacy_boundary_changed:
        item["inferenceResetAt"] = now
        item["inferenceGeneration"] = int(existing.get("inferenceGeneration", 0)) + 1
    else:
        for field in ("inferenceResetAt", "inferenceGeneration"):
            if field in existing:
                item[field] = existing[field]
    kwargs: dict[str, Any] = {"Item": item}
    if existing_record:
        kwargs.update(
            {
                "ConditionExpression": "revision = :revision",
                "ExpressionAttributeValues": {":revision": current_revision},
            }
        )
    else:
        kwargs["ConditionExpression"] = "attribute_not_exists(pk) AND attribute_not_exists(sk)"
    try:
        _profiles().put_item(**kwargs)
    except ClientError as exc:
        if exc.response.get("Error", {}).get("Code") == "ConditionalCheckFailedException":
            return response(409, {"error": "conflict", "message": "This profile changed. Reload it before saving."})
        raise
    return get_profile(user_id, response)


def reset_inferences(user_id: str, response: Response) -> dict[str, Any]:
    now = _iso_now()
    _profiles().update_item(
        Key=_explicit_key(user_id),
        UpdateExpression=(
            "SET inferenceResetAt = :now, updatedAt = :now, "
            "behavioralPersonalizationEnabled = if_not_exists(behavioralPersonalizationEnabled, :enabled), "
            "revision = if_not_exists(revision, :zero) + :one, "
            "inferenceGeneration = if_not_exists(inferenceGeneration, :zero) + :one"
        ),
        ExpressionAttributeValues={
            ":now": now,
            ":enabled": True,
            ":zero": 0,
            ":one": 1,
        },
    )
    return response(200, {"ok": True, "resetAt": now})


def record_playback(
    event: dict[str, Any],
    user_id: str,
    lecture_id: str,
    response: Response,
    *,
    _attempt: int = 0,
) -> dict[str, Any]:
    try:
        lecture_id = str(uuid.UUID(lecture_id))
    except (ValueError, TypeError, AttributeError) as exc:
        raise ValueError("Invalid lecture id") from exc
    body = _body(event)
    try:
        session_id = str(uuid.UUID(str(body.get("playbackSessionId", ""))))
    except (ValueError, TypeError, AttributeError) as exc:
        raise ValueError("Invalid playback session id") from exc
    sequence = body.get("sequence")
    if isinstance(sequence, bool) or not isinstance(sequence, int) or not 1 <= sequence <= 1_000_000:
        raise ValueError("Invalid playback sequence")
    event_type = body.get("eventType")
    if event_type not in _EVENTS:
        raise ValueError("Invalid playback event type")

    def bounded_number(name: str, minimum: float, maximum: float) -> float:
        value = body.get(name)
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise ValueError(f"Invalid {name}")
        value = float(value)
        if not minimum <= value <= maximum:
            raise ValueError(f"Invalid {name}")
        return value

    cumulative = bounded_number("playedSeconds", 0, 24 * 60 * 60)
    position = bounded_number("positionSeconds", 0, 24 * 60 * 60)
    media_duration = bounded_number("mediaDurationSeconds", 1, 24 * 60 * 60)
    playback_rate = bounded_number("playbackRate", 0.5, 3.0)
    occurred_at = body.get("occurredAt")
    occurred_epoch = _parse_time(occurred_at)
    now_time = time.time()
    if (
        not isinstance(occurred_at, str)
        or occurred_epoch <= 0
        or occurred_epoch > now_time + 300
        or occurred_epoch < now_time - 30 * 24 * 60 * 60
    ):
        raise ValueError("Invalid playback occurrence time")

    lecture_key = {"pk": f"USER#{user_id}", "sk": f"LECTURE#{lecture_id}"}
    lecture = _lectures().get_item(Key=lecture_key).get("Item")
    if not lecture:
        raise LookupError("lecture not found")

    session_key = {
        "pk": f"USER#{user_id}",
        "sk": f"PLAYBACK#{lecture_id}#{session_id}",
    }
    previous = _profiles().get_item(Key=session_key).get("Item", {})
    previous_sequence = int(previous.get("sequence", 0))
    if sequence <= previous_sequence:
        return response(200, {"accepted": False, "duplicate": True})

    previous_played = _number(previous.get("playedSeconds"))
    raw_delta = max(0.0, cumulative - previous_played)
    now_epoch = int(time.time())
    previous_received = int(previous.get("receivedAt", 0))
    elapsed_cap = 35.0 if not previous_received else max(5.0, (now_epoch - previous_received) * 3.0 + 5.0)
    delta = min(raw_delta, elapsed_cap, media_duration)
    explicit = _load_explicit(user_id)
    explicit_record = _load_explicit_record(user_id)
    boundary_revision = int(explicit_record.get("revision", 0))
    boundary_generation = int(explicit.get("inferenceGeneration", 0))
    inference_eligible = (
        explicit.get("behavioralPersonalizationEnabled", True) is not False
        and occurred_epoch > _parse_time(explicit.get("inferenceResetAt"))
    )
    now = _iso_now()
    session_item = {
        **session_key,
        "entityType": "PLAYBACK_SESSION",
        "lectureId": lecture_id,
        "sessionId": session_id,
        "sequence": sequence,
        "playedSeconds": Decimal(str(round(cumulative, 3))),
        "positionSeconds": Decimal(str(round(position, 3))),
        "mediaDurationSeconds": Decimal(str(round(media_duration, 3))),
        "playbackRate": Decimal(str(round(playback_rate, 2))),
        "eventType": event_type,
        "occurredAt": occurred_at,
        "receivedAt": now_epoch,
        "updatedAt": now,
        "ttl": now_epoch + PLAYBACK_SESSION_TTL,
    }
    condition = "attribute_not_exists(#sequence)" if not previous else "#sequence = :previous_sequence"
    put: dict[str, Any] = {
        "TableName": PROFILES_TABLE,
        "Item": _ser(session_item),
        "ConditionExpression": condition,
        "ExpressionAttributeNames": {"#sequence": "sequence"},
    }
    if previous:
        put["ExpressionAttributeValues"] = _ser({":previous_sequence": previous_sequence})

    lecture_update = (
        "SET mediaDurationSeconds = :duration, resumePositionSeconds = :position, "
        "playbackRate = :rate, lastListenedAt = :now"
    )
    lecture_values: dict[str, Any] = {
        ":delta": Decimal(str(round(delta, 3))),
        ":duration": Decimal(str(round(media_duration, 3))),
        ":position": Decimal(str(round(position, 3))),
        ":rate": Decimal(str(round(playback_rate, 2))),
        ":now": now,
    }
    add_clause = " ADD listenedSeconds :delta"
    lecture_names: dict[str, str] = {}
    if inference_eligible:
        lecture_update += ", inferenceLastListenedAt = :occurred"
        lecture_values[":occurred"] = occurred_at
        lecture_names["#inference_generation"] = f"inferenceEligibleG{boundary_generation}"
        add_clause += ", #inference_generation :delta"
    lecture_update += add_clause

    lecture_operation: dict[str, Any] = {
        "TableName": LECTURES_TABLE,
        "Key": _ser(lecture_key),
        "UpdateExpression": lecture_update,
        "ExpressionAttributeValues": _ser(lecture_values),
        "ConditionExpression": "attribute_exists(pk) AND attribute_exists(sk)",
    }
    if lecture_names:
        lecture_operation["ExpressionAttributeNames"] = lecture_names

    boundary_check: dict[str, Any] = {
        "TableName": PROFILES_TABLE,
        "Key": _ser(_explicit_key(user_id)),
    }
    if explicit_record:
        if "revision" in explicit_record:
            boundary_check["ConditionExpression"] = "revision = :boundary_revision"
            boundary_check["ExpressionAttributeValues"] = _ser(
                {":boundary_revision": boundary_revision}
            )
        else:
            boundary_check["ConditionExpression"] = "attribute_not_exists(revision)"
    else:
        boundary_check["ConditionExpression"] = "attribute_not_exists(pk)"

    try:
        _ddb_client().transact_write_items(
            TransactItems=[
                {"ConditionCheck": boundary_check},
                {"Put": put},
                {"Update": lecture_operation},
            ]
        )
    except ClientError as exc:
        if exc.response.get("Error", {}).get("Code") != "TransactionCanceledException":
            raise
        latest = _profiles().get_item(Key=session_key).get("Item", {})
        if int(latest.get("sequence", 0)) >= sequence:
            return response(200, {"accepted": False, "duplicate": True})
        if _attempt < 2:
            return record_playback(
                event,
                user_id,
                lecture_id,
                response,
                _attempt=_attempt + 1,
            )
        raise

    total = _number(lecture.get("listenedSeconds")) + delta
    return response(
        200,
        {
            "accepted": True,
            "listenedSeconds": round(total),
            "completionPercent": min(100, round(total / media_duration * 100)),
            "resumePositionSeconds": round(position),
        },
    )
