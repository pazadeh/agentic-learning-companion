"""Bedrock AgentCore entry point.

Wraps lecture generation and series planning in a security middleware chain:

    validate input -> rate limit -> content filter -> invoke agent -> audit log

Strands agents are not safe to invoke concurrently from multiple threads, so a
module-level lock serializes agent execution within a runtime instance.
"""
from __future__ import annotations

import json
import logging
import re
import threading
import time
from typing import Any

from bedrock_agentcore.runtime import BedrockAgentCoreApp

from agents.orchestrator import build_orchestrator
from agents.series_planner import plan_series
from agents import config, memory, run_context
from security.audit_logger import log_event
from security.content_filter import check_topic_safety
from security.input_validator import (
    ValidationError,
    validate_episode_count,
    validate_episode_duration,
    validate_episode_id,
    validate_message,
    validate_series_id,
    validate_user_id,
)
from security.rate_limiter import check_rate_limit

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("audio_companion.main")

app = BedrockAgentCoreApp()

# Strands agents are not thread-safe; serialize invocations.
_agent_lock = threading.Lock()

# Some models occasionally emit chain-of-thought wrapped in thinking tags. Strip
# those so reasoning never reaches the user.
_THINKING_RE = re.compile(r"<thinking>.*?</thinking>", re.IGNORECASE | re.DOTALL)
_STRAY_TAG_RE = re.compile(r"</?thinking>", re.IGNORECASE)


def _strip_reasoning(text: str) -> str:
    cleaned = _THINKING_RE.sub("", text)
    cleaned = _STRAY_TAG_RE.sub("", cleaned)
    return cleaned.strip()


def _response_text(result: Any) -> str:
    """Extract clean assistant text from a Strands AgentResult."""
    message = getattr(result, "message", None)
    if isinstance(message, dict):
        blocks = message.get("content", [])
        texts = [
            block["text"]
            for block in blocks
            if isinstance(block, dict) and isinstance(block.get("text"), str)
        ]
        if texts:
            joined = "\n".join(text.strip() for text in texts if text.strip()).strip()
            return _strip_reasoning(joined)
    return _strip_reasoning(str(result).strip())


def _series_context(payload: dict[str, Any]) -> dict[str, Any] | None:
    """Validate optional series metadata attached to an episode request."""
    supplied = any(
        key in payload for key in ("series_id", "episode_id", "episode_order")
    )
    if not supplied:
        return None

    series_id = validate_series_id(payload.get("series_id", ""))
    episode_id = validate_episode_id(payload.get("episode_id", ""))
    episode_order = payload.get("episode_order")
    if (
        isinstance(episode_order, bool)
        or not isinstance(episode_order, int)
        or not 1 <= episode_order <= 8
    ):
        raise ValidationError("Episode order must be between 1 and 8")
    return {
        "series_id": series_id,
        "episode_id": episode_id,
        "episode_order": episode_order,
    }


def _personalization_context(payload: dict[str, Any]) -> dict[str, Any]:
    """Validate the trusted worker's resolved personalization contract."""
    raw = payload.get("personalization_context")
    if raw is None:
        # Backward-compatible default for older workers during rolling deployment.
        raw = {
            "learningStyle": {"value": "examples", "source": "default", "confidencePercent": 0},
            "knowledgeLevel": {"value": "intermediate", "source": "default", "confidencePercent": 0},
            "durationMinutes": {"value": 15, "source": "default", "confidencePercent": 0},
            "researchDepth": {"value": "standard", "source": "default", "confidencePercent": 0},
        }
    if not isinstance(raw, dict):
        raise ValidationError("Invalid personalization context")
    specifications = {
        "learningStyle": {"examples", "theory", "practical"},
        "knowledgeLevel": {"beginner", "intermediate", "advanced"},
        "researchDepth": {"standard", "deep"},
    }
    result: dict[str, Any] = {}
    for name, allowed in specifications.items():
        trait = raw.get(name)
        if not isinstance(trait, dict) or trait.get("value") not in allowed:
            raise ValidationError(f"Invalid personalization field: {name}")
        source = trait.get("source")
        if source not in {"current_request", "explicit", "inferred", "default"}:
            raise ValidationError(f"Invalid personalization source: {name}")
        confidence = trait.get("confidencePercent", 0)
        if isinstance(confidence, bool) or not isinstance(confidence, int) or not 0 <= confidence <= 100:
            raise ValidationError(f"Invalid personalization confidence: {name}")
        result[name] = {"value": trait["value"], "source": source, "confidencePercent": confidence}

    duration = raw.get("durationMinutes")
    if not isinstance(duration, dict):
        raise ValidationError("Invalid personalization field: durationMinutes")
    value = duration.get("value")
    if isinstance(value, bool) or not isinstance(value, int) or not 1 <= value <= 60:
        raise ValidationError("Invalid personalization duration")
    source = duration.get("source")
    if source not in {"current_request", "explicit", "inferred", "default"}:
        raise ValidationError("Invalid personalization duration source")
    confidence = duration.get("confidencePercent", 0)
    if isinstance(confidence, bool) or not isinstance(confidence, int) or not 0 <= confidence <= 100:
        raise ValidationError("Invalid personalization duration confidence")
    result["durationMinutes"] = {"value": value, "source": source, "confidencePercent": confidence}
    return result


def _tag_series_lecture(
    user_id: str,
    lecture: dict[str, Any],
    series_context: dict[str, Any] | None,
) -> dict[str, Any]:
    """Attach authoritative series fields to the lecture row just persisted."""
    if series_context is None:
        return lecture

    lecture_id = lecture.get("lectureId")
    s3_key = lecture.get("s3Key")
    if not isinstance(lecture_id, str) or not lecture_id or not s3_key:
        raise RuntimeError("Series episode did not produce persisted lecture audio")
    if not config.LECTURES_TABLE:
        raise RuntimeError("LECTURES_TABLE is not configured")

    config.dynamodb_resource().Table(config.LECTURES_TABLE).update_item(
        Key={"pk": f"USER#{user_id}", "sk": f"LECTURE#{lecture_id}"},
        UpdateExpression=(
            "SET seriesId = :series_id, episodeId = :episode_id, "
            "episodeOrder = :episode_order"
        ),
        ExpressionAttributeValues={
            ":series_id": series_context["series_id"],
            ":episode_id": series_context["episode_id"],
            ":episode_order": series_context["episode_order"],
        },
        ConditionExpression="attribute_exists(pk) AND attribute_exists(sk)",
    )
    tagged = dict(lecture)
    tagged.update(
        {
            "seriesId": series_context["series_id"],
            "episodeId": series_context["episode_id"],
            "episodeOrder": series_context["episode_order"],
        }
    )
    return tagged


def _record_interaction(
    *,
    user_id: str,
    request_id: Any,
    user_text: str,
    assistant_text: str,
) -> None:
    memory.record_interaction(
        user_id=user_id,
        session_id=str(request_id) if request_id else user_id,
        user_text=user_text,
        assistant_text=assistant_text,
    )


@app.entrypoint
def agent_invocation(payload, context):
    """Handle a lecture-generation or series-plan invocation."""
    started = time.time()
    request_id = getattr(context, "session_id", None) or payload.get("job_id")
    request_type = payload.get("request_type") or "lecture"

    try:
        if request_type not in {"lecture", "series_plan"}:
            raise ValidationError("Invalid request type")
        user_id = validate_user_id(payload.get("user_id", ""))
        message = validate_message(payload.get("message", ""))
        personalization_context = _personalization_context(payload)
        series_context = _series_context(payload) if request_type == "lecture" else None
    except ValidationError as exc:
        log_event("agent_invoke", "invalid_input", error_code="ValidationError")
        return {"error": "invalid_input", "message": str(exc)}

    rate_action = "series_plan" if request_type == "series_plan" else "lecture"
    if not check_rate_limit(user_id, rate_action):
        log_event("agent_invoke", "rate_limited", user_id=user_id, request_id=request_id)
        return {"error": "rate_limited"}

    safety = check_topic_safety(message)
    if not safety.allowed:
        log_event(
            "agent_invoke",
            "blocked",
            user_id=user_id,
            request_id=request_id,
            error_code=f"content:{safety.reason}",
        )
        return {"error": "content_blocked"}

    log_event(
        "agent_invoke",
        "started",
        user_id=user_id,
        request_id=request_id,
    )
    memory_context = memory.retrieve_user_memories(user_id, message)

    try:
        if request_type == "series_plan":
            episode_count = payload.get("episode_count")
            duration_minutes = payload.get("duration_minutes")
            with _agent_lock:
                plan = plan_series(
                    request=message,
                    episode_count=(
                        None if episode_count is None else validate_episode_count(episode_count)
                    ),
                    duration_minutes=(
                        None
                        if duration_minutes is None
                        else validate_episode_duration(duration_minutes)
                    ),
                    learner_context=(
                        memory_context
                        + "\nResolved personalization:\n"
                        + json.dumps(personalization_context, sort_keys=True)
                    ),
                )
            response_text = "Your lecture-series plan is ready for review."
            lecture: dict[str, Any] = {}
        else:
            with _agent_lock:
                run_context.reset()
                run_context.set_lecture(personalizationUsed=personalization_context)
                agent = build_orchestrator(
                    user_id,
                    memory_context=memory_context,
                    personalization_context=personalization_context,
                )
                result = agent(message)
                lecture = run_context.get_lecture()
            response_text = _response_text(result)
            lecture = _tag_series_lecture(user_id, lecture, series_context)
    except Exception as exc:  # noqa: BLE001
        logger.exception("Agent invocation failed")
        log_event(
            "agent_invoke",
            "failed",
            user_id=user_id,
            request_id=request_id,
            error_code=type(exc).__name__,
            duration_ms=int((time.time() - started) * 1000),
        )
        return {"error": "agent_error"}

    log_event(
        "agent_invoke",
        "completed",
        user_id=user_id,
        request_id=request_id,
        lecture_id=lecture.get("lectureId"),
        duration_ms=int((time.time() - started) * 1000),
    )

    if request_type == "series_plan":
        memory_text = f"Planned a {len(plan['episodes'])}-part lecture series: {plan['title']}"
    else:
        memory_text = response_text
    _record_interaction(
        user_id=user_id,
        request_id=request_id,
        user_text=message,
        assistant_text=memory_text,
    )

    if request_type == "series_plan":
        return {"response": response_text, "plan": plan}

    response: dict[str, Any] = {"response": response_text}
    if lecture.get("s3Key"):
        response["lecture"] = lecture
    return response


if __name__ == "__main__":
    app.run()
