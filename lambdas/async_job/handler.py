"""Async job Lambda.

Handles the job lifecycle for lecture generation. The same function serves two
roles, distinguished by the event shape:

1. **API role** (API Gateway proxy event): routes ``POST /jobs/start``,
   ``GET /jobs/{jobId}/status`` and ``GET /jobs/{jobId}/result``. ``start``
   validates input, applies rate limiting + content filtering, writes a ``pending``
   job to DynamoDB, then invokes *this same function* asynchronously to do the work.

2. **Worker role** (``{"_worker": true, "job_id": ...}`` event): pulls the job,
   invokes the Bedrock AgentCore runtime, and updates the job with progress/result.

Security: the user id always comes from the verified Cognito JWT claims
(``requestContext.authorizer.claims.sub``) — never from the request body.
"""
from __future__ import annotations

import json
import logging
import os
import time
import uuid
from decimal import Decimal
from typing import Any, Optional

import boto3
from botocore.config import Config
from botocore.exceptions import ClientError
from boto3.dynamodb.conditions import Key

from security.audit_logger import log_event
from security.content_filter import check_topic_safety
from security.input_validator import (
    ValidationError,
    validate_job_id,
    validate_message,
    validate_user_id,
)
from security.rate_limiter import check_rate_limit

import learner_profile  # sibling module in the Lambda package
import series  # sibling module in the Lambda package

logger = logging.getLogger()
logger.setLevel(logging.INFO)

JOBS_TABLE = os.environ.get("JOBS_TABLE", "")
LECTURES_TABLE = os.environ.get("LECTURES_TABLE", "")
AGENT_RUNTIME_ARN = os.environ.get("AGENT_RUNTIME_ARN", "")
SELF_FUNCTION_NAME = os.environ.get("AWS_LAMBDA_FUNCTION_NAME", "")
JOB_TTL_SECONDS = 24 * 60 * 60  # 24 hours

_dynamodb = None
_lambda_client = None
_agentcore_client = None


def _jobs_table():
    global _dynamodb
    if _dynamodb is None:
        _dynamodb = boto3.resource("dynamodb")
    return _dynamodb.Table(JOBS_TABLE)


def _lectures_table():
    global _dynamodb
    if _dynamodb is None:
        _dynamodb = boto3.resource("dynamodb")
    return _dynamodb.Table(LECTURES_TABLE)


def _lambda():
    global _lambda_client
    if _lambda_client is None:
        _lambda_client = boto3.client("lambda")
    return _lambda_client


def _agentcore():
    global _agentcore_client
    if _agentcore_client is None:
        # Lecture generation (research + writing + Polly synthesis) routinely runs
        # longer than boto3's default 60s read timeout — especially for longer
        # lectures. A client read timeout would mark the job failed even though the
        # worker Lambda has a 900s budget. Give the synchronous invoke nearly the
        # whole Lambda timeout, and disable retries so a slow run isn't re-issued.
        _agentcore_client = boto3.client(
            "bedrock-agentcore",
            config=Config(
                connect_timeout=15,
                read_timeout=870,
                retries={"max_attempts": 1, "mode": "standard"},
            ),
        )
    return _agentcore_client


# --------------------------------------------------------------------------- #
# HTTP helpers
# --------------------------------------------------------------------------- #
def _response(status: int, body: dict[str, Any]) -> dict[str, Any]:
    return {
        "statusCode": status,
        "headers": {
            "Content-Type": "application/json",
            "Cache-Control": "no-store",
            "Access-Control-Allow-Origin": os.environ.get("CORS_ALLOW_ORIGIN", "*"),
            "Access-Control-Allow-Headers": "Authorization,Content-Type",
            "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
        },
        "body": json.dumps(body),
    }


def _claims(event: dict[str, Any]) -> dict[str, Any]:
    return (
        event.get("requestContext", {})
        .get("authorizer", {})
        .get("claims", {})
        or {}
    )


def _user_id_from_event(event: dict[str, Any]) -> str:
    sub = _claims(event).get("sub", "")
    return validate_user_id(sub)


# --------------------------------------------------------------------------- #
# Entry point
# --------------------------------------------------------------------------- #
def handler(event: dict[str, Any], context: Any) -> Any:
    # Worker invocation (async self-invoke) carries an explicit flag.
    if isinstance(event, dict) and event.get("_worker"):
        return _run_worker(event["job_id"])

    method = event.get("httpMethod", "")
    resource = event.get("resource", "") or event.get("path", "")

    try:
        if resource.startswith("/profile"):
            return _route_profile(method, resource, event)
        if method == "POST" and resource == "/lectures/{lectureId}/playback":
            user_id = _user_id_from_event(event)
            lecture_id = (event.get("pathParameters") or {}).get("lectureId", "")
            return learner_profile.record_playback(event, user_id, lecture_id, _response)
        if resource.startswith("/series"):
            return _route_series(method, resource, event)
        if method == "POST" and resource.endswith("/jobs/start"):
            return _start_job(event)
        if method == "GET" and resource.endswith("/jobs/{jobId}/status"):
            return _job_status(event)
        if method == "GET" and resource.endswith("/jobs/{jobId}/result"):
            return _job_result(event)
        if method == "GET" and resource.endswith("/lectures/{lectureId}"):
            return _get_lecture(event)
        if method == "GET" and resource.endswith("/lectures"):
            return _list_lectures(event)
        return _response(404, {"error": "not_found"})
    except (ValidationError, ValueError) as exc:
        return _response(400, {"error": "invalid_input", "message": str(exc)})
    except PermissionError:
        return _response(403, {"error": "forbidden"})
    except LookupError:
        return _response(404, {"error": "not_found", "message": "Not found"})
    except Exception:  # noqa: BLE001
        logger.exception("Unhandled error")
        return _response(500, {"error": "internal_error"})


def _route_profile(method: str, resource: str, event: dict[str, Any]) -> dict[str, Any]:
    """Explicit and inferred profile routes, scoped to the verified Cognito user."""
    user_id = _user_id_from_event(event)
    if method == "GET" and resource == "/profile":
        return learner_profile.get_profile(user_id, _response)
    if method == "PUT" and resource == "/profile":
        return learner_profile.put_profile(event, user_id, _response)
    if method == "GET" and resource == "/profile/inferences":
        return _response(200, learner_profile.derive_inferences(user_id))
    if method == "DELETE" and resource == "/profile/inferences":
        return learner_profile.reset_inferences(user_id, _response)
    return _response(404, {"error": "not_found"})


def _route_series(method: str, resource: str, event: dict[str, Any]) -> dict[str, Any]:
    """Lecture-series routes. Ownership comes from the verified JWT only."""
    user_id = _user_id_from_event(event)
    if method == "POST" and resource == "/series/drafts":
        return series.create_draft(event, user_id, _response, _dispatch)
    if method == "GET" and resource == "/series":
        return series.list_series(user_id, _response)
    if method == "GET" and resource == "/series/{seriesId}":
        return series.get_series(event, user_id, _response)
    if method == "POST" and resource == "/series/{seriesId}/plan":
        return series.save_plan(event, user_id, _response)
    if method == "POST" and resource == "/series/{seriesId}/approve":
        return series.approve(event, user_id, _response, _dispatch)
    if method == "POST" and resource == "/series/{seriesId}/episodes/{episodeId}/retry":
        return series.retry_episode(event, user_id, _response, _dispatch)
    return _response(404, {"error": "not_found"})


def _dispatch(job_id: str) -> None:
    """Fire-and-forget the worker role for a persisted job."""
    _lambda().invoke(
        FunctionName=SELF_FUNCTION_NAME,
        InvocationType="Event",
        Payload=json.dumps({"_worker": True, "job_id": job_id}).encode("utf-8"),
    )


# --------------------------------------------------------------------------- #
# Routes
# --------------------------------------------------------------------------- #
def _validated_lecture_brief(raw: Any) -> Optional[dict[str, Any]]:
    if raw is None:
        return None
    if not isinstance(raw, dict) or len(json.dumps(raw)) > 12000:
        raise ValidationError("invalid confirmed lecture brief")
    required_text = ("topic", "title", "learningObjective", "tone", "language")
    for name in required_text:
        if not isinstance(raw.get(name), str) or not raw[name].strip():
            raise ValidationError(f"invalid lecture brief field: {name}")
    if raw.get("knowledgeLevel") not in {"beginner", "intermediate", "advanced"}:
        raise ValidationError("invalid lecture brief level")
    if raw.get("depth") not in {"overview", "standard", "deep"}:
        raise ValidationError("invalid lecture brief depth")
    if raw.get("learningStyle") not in {"examples", "theory", "practical", "story", "step-by-step"}:
        raise ValidationError("invalid lecture brief style")
    duration = raw.get("durationMinutes")
    if isinstance(duration, bool) or not isinstance(duration, int) or not 1 <= duration <= 60:
        raise ValidationError("invalid lecture brief duration")
    if raw.get("reinforcement") not in {"recap", "reflection", "memory-hooks", "none"}:
        raise ValidationError("invalid lecture brief reinforcement")
    if raw.get("sourceFreshness") not in {"current", "timeless"}:
        raise ValidationError("invalid lecture brief source freshness")
    for name in ("includeTopics", "excludeTopics"):
        values = raw.get(name, [])
        if not isinstance(values, list) or len(values) > 12 or any(
            not isinstance(value, str) or not value.strip() or len(value) > 200
            for value in values
        ):
            raise ValidationError(f"invalid lecture brief field: {name}")
    example = raw.get("exampleContext", "")
    if not isinstance(example, str) or len(example) > 500:
        raise ValidationError("invalid lecture brief example")
    return json.loads(json.dumps(raw))


def _validated_design_context(body: dict[str, Any], message: str) -> dict[str, Any]:
    raw = body.get("design_context") or {}
    if not isinstance(raw, dict):
        raise ValidationError("invalid design context")
    request = raw.get("request", message)
    answer = raw.get("answer", message)
    brief = raw.get("brief") or {}
    history = raw.get("history") or []
    turn = raw.get("turn", 1)
    if not isinstance(request, str) or not request.strip() or len(request) > 4000:
        raise ValidationError("invalid design request")
    if not isinstance(answer, str) or len(answer) > 4000:
        raise ValidationError("invalid design answer")
    if not isinstance(brief, dict) or len(json.dumps(brief)) > 12000:
        raise ValidationError("invalid lecture brief")
    if brief.get("_designFinalized") is True:
        raise ValidationError("lecture design is already finalized")
    if not isinstance(history, list) or len(history) > 8:
        raise ValidationError("invalid design history")
    if isinstance(turn, bool) or not isinstance(turn, int) or not 1 <= turn <= 3:
        raise ValidationError("invalid design turn")
    safe_history = []
    for item in history:
        if not isinstance(item, dict):
            raise ValidationError("invalid design history")
        role = item.get("role")
        content = item.get("content")
        if role not in {"user", "assistant"} or not isinstance(content, str) or len(content) > 1000:
            raise ValidationError("invalid design history")
        safe_history.append({"role": role, "content": content})
    return {
        "request": request.strip(),
        "answer": answer.strip(),
        "brief": brief,
        "history": safe_history,
        "turn": turn,
    }


def _start_job(event: dict[str, Any]) -> dict[str, Any]:
    started = time.time()
    user_id = _user_id_from_event(event)

    body = json.loads(event.get("body") or "{}")
    message = validate_message(body.get("message", ""))
    action = body.get("action", "chat")
    if action not in {"lecture", "chat", "design"}:
        raise ValidationError("invalid job action")
    design_context = _validated_design_context(body, message) if action == "design" else None
    lecture_brief = _validated_lecture_brief(body.get("lecture_brief")) if action == "lecture" else None

    if not check_rate_limit(user_id, action):
        log_event("job_start", "rate_limited", user_id=user_id, error_code="rate_limited")
        return _response(429, {"error": "rate_limited"})

    safety_text = (
        json.dumps(design_context, sort_keys=True)
        if design_context is not None
        else f"{message}\n{json.dumps(lecture_brief, sort_keys=True)}" if lecture_brief is not None else message
    )
    safety = check_topic_safety(safety_text)
    if not safety.allowed:
        log_event("job_start", "blocked", user_id=user_id, error_code=f"content:{safety.reason}")
        return _response(
            403,
            {"error": "content_blocked", "message": "This topic can't be turned into a lecture."},
        )

    job_id = str(uuid.uuid4())
    now = int(time.time())
    _jobs_table().put_item(
        Item={
            "jobId": job_id,
            "userId": user_id,
            "status": "pending",
            "stage": "queued",
            "stageMessage": "Queued for generation",
            "stageDetail": "Waiting for a worker",
            "stageSeq": 0,
            "progress": 0,
            "progressUpdatedAt": now,
            "message": message,
            "action": action,
            "designContext": design_context or {},
            "lectureBrief": lecture_brief or {},
            "createdAt": now,
            "ttl": now + JOB_TTL_SECONDS,
        }
    )

    # Kick off the worker asynchronously (Event invocation type = fire and forget).
    _dispatch(job_id)

    log_event(
        "job_start",
        "accepted",
        user_id=user_id,
        job_id=job_id,
        duration_ms=int((time.time() - started) * 1000),
    )
    return _response(202, {"job_id": job_id, "status": "pending"})


def _load_job_for_user(event: dict[str, Any]) -> dict[str, Any]:
    user_id = _user_id_from_event(event)
    job_id = validate_job_id((event.get("pathParameters") or {}).get("jobId", ""))
    item = _jobs_table().get_item(Key={"jobId": job_id}).get("Item")
    if not item:
        raise ValidationError("job not found")
    if item.get("userId") != user_id:
        # Never reveal another user's job.
        raise PermissionError("not your job")
    return item


def _public_job_state(item: dict[str, Any]) -> dict[str, Any]:
    state = {
        "job_id": item["jobId"],
        "status": item.get("status", "pending"),
        "stage": item.get("stage", "queued"),
        "progress": max(0, min(100, int(item.get("progress", 0)))),
        "stage_message": item.get("stageMessage", "Preparing your lecture"),
        "stage_detail": item.get("stageDetail", ""),
        "updated_at": int(item.get("progressUpdatedAt", item.get("createdAt", 0))),
    }
    if item.get("publicError"):
        state["error"] = item["publicError"]
    return state


def _job_status(event: dict[str, Any]) -> dict[str, Any]:
    return _response(200, _public_job_state(_load_job_for_user(event)))


def _job_result(event: dict[str, Any]) -> dict[str, Any]:
    item = _load_job_for_user(event)
    status = item.get("status", "pending")
    if status != "completed":
        return _response(200, _public_job_state(item))
    result = item.get("result")
    if isinstance(result, str):
        try:
            result = json.loads(result)
        except json.JSONDecodeError:
            result = {"response": result}
    return _response(200, {**_public_job_state(item), "result": result})


# --------------------------------------------------------------------------- #
# Lectures (history)
# --------------------------------------------------------------------------- #
def _to_jsonable(value: Any) -> Any:
    """Convert DynamoDB types (Decimal) into JSON-serializable values."""
    if isinstance(value, Decimal):
        # Whole numbers -> int, otherwise float.
        return int(value) if value % 1 == 0 else float(value)
    if isinstance(value, list):
        return [_to_jsonable(v) for v in value]
    if isinstance(value, dict):
        return {k: _to_jsonable(v) for k, v in value.items()}
    return value


def _persist_lecture_result(user_id: str, result: dict[str, Any]) -> None:
    """Idempotently upsert AgentCore's authoritative lecture metadata.

    AgentCore also asks the orchestrator to call ``save_lecture``, but model-controlled
    persistence is not a reliable completion boundary. The trusted worker performs a
    second, deterministic update before completing the job. ``UpdateItem`` preserves
    richer fields (such as sources or a script) already written by AgentCore.
    """
    lecture = result.get("lecture")
    if not isinstance(lecture, dict):
        return

    raw_lecture_id = lecture.get("lectureId")
    if not isinstance(raw_lecture_id, str):
        raise RuntimeError("Agent result has an invalid lectureId")
    try:
        lecture_id = str(uuid.UUID(raw_lecture_id))
    except (ValueError, AttributeError) as exc:
        raise RuntimeError("Agent result has an invalid lectureId") from exc

    s3_key = lecture.get("s3Key")
    allowed_keys = {
        f"audio/{user_id}/{lecture_id}/lecture.mp3",
        f"audio/{user_id}/{lecture_id}/lecture.wav",
    }
    if s3_key not in allowed_keys:
        raise RuntimeError("Agent result has an invalid audio key")

    duration = lecture.get("durationMinutes", 0)
    if isinstance(duration, bool):
        raise RuntimeError("Agent result has an invalid duration")
    try:
        duration_minutes = max(1, int(round(float(duration))))
    except (TypeError, ValueError) as exc:
        raise RuntimeError("Agent result has an invalid duration") from exc

    created_at = lecture.get("createdAt")
    if not isinstance(created_at, str) or not created_at.strip():
        created_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())

    _lectures_table().update_item(
        Key={"pk": f"USER#{user_id}", "sk": f"LECTURE#{lecture_id}"},
        UpdateExpression=(
            "SET #lecture_id = :lecture_id, #title = :title, #topic = :topic, "
            "#s3_key = :s3_key, #duration = :duration, #audio_provider = :audio_provider, "
            "#audio_format = :audio_format, #transcript_available = :transcript_available, "
            "#personalization = :personalization, "
            "#created_at = if_not_exists(#created_at, :created_at)"
        ),
        ExpressionAttributeNames={
            "#lecture_id": "lectureId",
            "#title": "title",
            "#topic": "topic",
            "#s3_key": "s3Key",
            "#duration": "durationMinutes",
            "#audio_provider": "audioProvider",
            "#audio_format": "audioFormat",
            "#transcript_available": "transcriptAvailable",
            "#personalization": "personalizationUsed",
            "#created_at": "createdAt",
        },
        ExpressionAttributeValues={
            ":lecture_id": lecture_id,
            ":title": str(lecture.get("title", ""))[:500],
            ":topic": str(lecture.get("topic", ""))[:2000],
            ":s3_key": s3_key,
            ":duration": duration_minutes,
            ":audio_provider": str(lecture.get("audioProvider", ""))[:100],
            ":audio_format": str(lecture.get("audioFormat", ""))[:20],
            ":transcript_available": bool(lecture.get("transcriptAvailable", False)),
            ":personalization": lecture.get("personalizationUsed", {}),
            ":created_at": created_at,
        },
    )


def _get_lecture(event: dict[str, Any]) -> dict[str, Any]:
    """Return one owned lecture with its transcript for explicit offline saving."""
    user_id = _user_id_from_event(event)
    raw_id = (event.get("pathParameters") or {}).get("lectureId", "")
    try:
        lecture_id = str(uuid.UUID(raw_id))
    except (ValueError, TypeError, AttributeError) as exc:
        raise ValidationError("invalid lecture id") from exc
    if raw_id != lecture_id:
        raise ValidationError("invalid lecture id")
    item = _lectures_table().get_item(
        Key={"pk": f"USER#{user_id}", "sk": f"LECTURE#{lecture_id}"},
        ConsistentRead=True,
    ).get("Item")
    if not item or not item.get("s3Key"):
        raise LookupError("lecture not found")
    transcript_item = _lectures_table().get_item(
        Key={"pk": f"USER#{user_id}", "sk": f"TRANSCRIPT#{lecture_id}"},
        ConsistentRead=True,
    ).get("Item") or {}
    script = transcript_item.get("script") or item.get("script")  # legacy inline rows
    if not isinstance(script, str) or not script.strip():
        script = None
    return _response(
        200,
        {
            "lectureId": lecture_id,
            "title": item.get("title", ""),
            "topic": item.get("topic", ""),
            "s3Key": item["s3Key"],
            "durationMinutes": _to_jsonable(item.get("durationMinutes", 0)),
            "createdAt": item.get("createdAt", ""),
            "audioProvider": item.get("audioProvider", ""),
            "audioFormat": item.get("audioFormat", ""),
            "seriesId": item.get("seriesId"),
            "episodeId": item.get("episodeId"),
            "episodeOrder": _to_jsonable(item.get("episodeOrder")),
            "script": script,
            "transcriptAvailable": script is not None,
            "personalizationUsed": _to_jsonable(item.get("personalizationUsed", {})),
        },
    )


def _list_lectures(event: dict[str, Any]) -> dict[str, Any]:
    """Return the caller's saved lectures, newest first.

    Lectures are stored as ``pk = USER#{user_id}``, ``sk = LECTURE#{lecture_id}``.
    GSI1 (pk, createdAt) lets us return them ordered by recency without a scan.
    """
    user_id = _user_id_from_event(event)
    if not LECTURES_TABLE:
        return _response(200, {"lectures": []})

    try:
        result = _lectures_table().query(
            IndexName="GSI1",
            KeyConditionExpression=Key("pk").eq(f"USER#{user_id}"),
            ScanIndexForward=False,  # newest createdAt first
            Limit=200,
        )
    except ClientError:
        logger.exception("Failed to query lectures for user")
        return _response(500, {"error": "internal_error"})

    lectures = []
    for item in result.get("Items", []):
        listened = float(item.get("listenedSeconds", 0))
        media_duration = float(item.get("mediaDurationSeconds", 0))
        completion = min(100, round(listened / media_duration * 100)) if media_duration > 0 else 0
        lectures.append(
            {
                "lectureId": item.get("lectureId", ""),
                "title": item.get("title", ""),
                "topic": item.get("topic", ""),
                "s3Key": item.get("s3Key", ""),
                "audioProvider": item.get("audioProvider", ""),
                "audioFormat": item.get("audioFormat", ""),
                "transcriptAvailable": bool(
                    item.get("transcriptAvailable")
                    or (isinstance(item.get("script"), str) and item.get("script", "").strip())
                ),
                "seriesId": item.get("seriesId"),
                "episodeId": item.get("episodeId"),
                "episodeOrder": _to_jsonable(item.get("episodeOrder")),
                "durationMinutes": _to_jsonable(item.get("durationMinutes", 0)),
                "createdAt": item.get("createdAt", ""),
                "listenedSeconds": round(listened),
                "completionPercent": completion,
                "resumePositionSeconds": round(float(item.get("resumePositionSeconds", 0))),
                "lastListenedAt": item.get("lastListenedAt", ""),
                "personalizationUsed": _to_jsonable(item.get("personalizationUsed", {})),
            }
        )
    # Drop any malformed rows missing the essentials for playback.
    lectures = [l for l in lectures if l["lectureId"] and l["s3Key"]]
    return _response(200, {"lectures": lectures})


# --------------------------------------------------------------------------- #
# Worker
# --------------------------------------------------------------------------- #
def _claim_flat_job(item: dict[str, Any]) -> Optional[str]:
    claim_token = str(uuid.uuid4())
    try:
        _jobs_table().update_item(
            Key={"jobId": item["jobId"]},
            UpdateExpression=(
                "SET #status = :processing, #progress = :progress, #stage = :stage, "
                "stageMessage = :message, stageDetail = :detail, stageSeq = :sequence, "
                "progressUpdatedAt = :updated, claimToken = :claim"
            ),
            ConditionExpression="#status = :pending",
            ExpressionAttributeNames={
                "#status": "status",
                "#progress": "progress",
                "#stage": "stage",
            },
            ExpressionAttributeValues={
                ":pending": "pending",
                ":processing": "processing",
                ":progress": 5,
                ":stage": "preparing",
                ":message": "Preparing generation",
                ":detail": "Worker started",
                ":sequence": 1,
                ":updated": int(time.time()),
                ":claim": claim_token,
            },
        )
        return claim_token
    except ClientError as exc:
        if exc.response.get("Error", {}).get("Code") == "ConditionalCheckFailedException":
            return None
        raise


def _update_claimed_job(item: dict[str, Any], claim_token: str, **fields: Any) -> None:
    names = {f"#{key}": key for key in fields}
    names["#status_condition"] = "status"
    names["#claim_condition"] = "claimToken"
    values = {f":{key}": value for key, value in fields.items()}
    values.update({":processing": "processing", ":claim": claim_token})
    _jobs_table().update_item(
        Key={"jobId": item["jobId"]},
        UpdateExpression="SET " + ", ".join(f"#{key} = :{key}" for key in fields),
        ConditionExpression="#status_condition = :processing AND #claim_condition = :claim",
        ExpressionAttributeNames=names,
        ExpressionAttributeValues=values,
    )


def _run_worker(job_id: str) -> dict[str, Any]:
    """Route a worker invocation: series jobs by jobType, everything else is flat."""
    item = _jobs_table().get_item(Key={"jobId": job_id}).get("Item")
    if item and item.get("jobType") in series.SERIES_JOB_TYPES:
        return series.run_job(item, _invoke_agent, _dispatch)
    return _run_job(job_id)


def _run_job(job_id: str) -> dict[str, Any]:
    started = time.time()
    item = _jobs_table().get_item(Key={"jobId": job_id}).get("Item")
    if not item:
        logger.error("Worker could not find job %s", job_id)
        return {"ok": False}

    user_id = item["userId"]
    claim_token = _claim_flat_job(item)
    if not claim_token:
        return {"ok": True, "duplicate": True}
    try:
        if not AGENT_RUNTIME_ARN:
            raise RuntimeError("AGENT_RUNTIME_ARN is not configured")

        is_design = item.get("action") == "design"
        extra: dict[str, Any] = {"claim_token": claim_token}
        if is_design:
            extra["design_context"] = item.get("designContext", {})
        elif item.get("lectureBrief"):
            extra["lecture_brief"] = item["lectureBrief"]
        result = _invoke_agent(
            user_id,
            item["message"],
            job_id,
            request_type="lecture_design" if is_design else "lecture",
            extra=extra,
        )
        if result.get("error"):
            raise RuntimeError(str(result["error"]))

        _update_claimed_job(
            item,
            claim_token,
            stage="finalizing",
            stageMessage="Finalizing your lecture design" if is_design else "Finalizing your lecture",
            stageDetail="Saving the completed brief" if is_design else "Saving the completed result",
            stageSeq=1000,
            progress=99,
            progressUpdatedAt=int(time.time()),
        )
        _update_claimed_job(
            item,
            claim_token,
            status="completed",
            stage="completed",
            stageMessage="Your lecture brief is ready" if is_design else "Your lecture is ready",
            stageDetail="",
            stageSeq=1001,
            progress=100,
            progressUpdatedAt=int(time.time()),
            result=json.dumps(result),
        )
        log_event(
            "job_complete",
            "completed",
            user_id=user_id,
            job_id=job_id,
            duration_ms=int((time.time() - started) * 1000),
        )
        return {"ok": True}
    except Exception as exc:  # noqa: BLE001
        logger.exception("Job %s failed", job_id)
        try:
            _update_claimed_job(
                item,
                claim_token,
                status="failed",
                publicError=(
                    "Lecture design failed. Please try again."
                    if item.get("action") == "design"
                    else "Lecture generation failed. Please try again."
                ),
                errorCode=type(exc).__name__,
                progressUpdatedAt=int(time.time()),
            )
        except ClientError:
            logger.info("Flat job failure was superseded by another worker")
        log_event(
            "job_complete",
            "failed",
            user_id=user_id,
            job_id=job_id,
            error_code=type(exc).__name__,
            duration_ms=int((time.time() - started) * 1000),
        )
        return {"ok": False}


def _report_lambda_progress(
    user_id: str,
    job_id: str,
    stage: str,
    percent: int,
    message: str,
    detail: str,
    claim_token: str = "",
) -> None:
    names = {"#status": "status", "#stage": "stage"}
    values: dict[str, Any] = {
        ":processing": "processing",
        ":user_id": user_id,
        ":stage": stage,
        ":progress": percent,
        ":message": message,
        ":detail": detail,
        ":sequence": 5,
        ":updated": int(time.time()),
    }
    condition = "#status = :processing AND userId = :user_id"
    if claim_token:
        names["#claim"] = "claimToken"
        values[":claim"] = claim_token
        condition += " AND #claim = :claim"
    try:
        _jobs_table().update_item(
            Key={"jobId": job_id},
            UpdateExpression=(
                "SET #stage = :stage, progress = :progress, stageMessage = :message, "
                "stageDetail = :detail, stageSeq = :sequence, progressUpdatedAt = :updated"
            ),
            ConditionExpression=condition,
            ExpressionAttributeNames=names,
            ExpressionAttributeValues=values,
        )
    except ClientError:
        logger.info("Lambda progress update was superseded")


def _invoke_agent(
    user_id: str,
    message: str,
    job_id: str,
    request_type: str = "lecture",
    extra: Optional[dict[str, Any]] = None,
) -> dict[str, Any]:
    """Invoke the Bedrock AgentCore runtime and return a parsed result dict.

    ``request_type`` defaults to ``lecture`` so flat jobs send the same request as
    before; series jobs add ``series_plan`` or episode metadata via ``extra``.
    """
    claim_token = str((extra or {}).get("claim_token", ""))
    is_design = request_type == "lecture_design"
    _report_lambda_progress(
        user_id,
        job_id,
        "planning" if is_design else "personalizing",
        10,
        "Refining your lecture brief" if is_design else "Personalizing your lecture",
        (
            "Applying your answers and preparing the next design choice"
            if is_design
            else "Resolving your requested depth, style, and duration"
        ),
        claim_token,
    )
    personalization_context = learner_profile.resolve_personalization(user_id, message)
    body: dict[str, Any] = {
        **(extra or {}),
        "user_id": user_id,
        "message": message,
        "job_id": job_id,
        "request_type": request_type,
        "personalization_context": personalization_context,
    }
    payload = json.dumps(_to_jsonable(body))
    response = _agentcore().invoke_agent_runtime(
        agentRuntimeArn=AGENT_RUNTIME_ARN,
        runtimeSessionId=job_id,
        payload=payload.encode("utf-8"),
        contentType="application/json",
        accept="application/json",
    )

    raw = response.get("response")
    if hasattr(raw, "read"):
        raw = raw.read()
    if isinstance(raw, (bytes, bytearray)):
        raw = raw.decode("utf-8")
    if not raw:
        return {"response": ""}
    try:
        parsed = json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        return {"response": str(raw)}
    result = parsed if isinstance(parsed, dict) else {"response": parsed}
    _persist_lecture_result(user_id, result)
    return result
