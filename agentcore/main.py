"""Bedrock AgentCore entry point.

Wraps the orchestrator agent in a security middleware chain:

    validate input -> rate limit -> content filter -> invoke agent -> audit log

Strands agents are not safe to invoke concurrently from multiple threads, so a
module-level lock serializes agent execution within a runtime instance.
"""
from __future__ import annotations

import logging
import re
import threading
import time

from bedrock_agentcore.runtime import BedrockAgentCoreApp

from agents.orchestrator import build_orchestrator
from agents import memory, run_context
from security.audit_logger import log_event
from security.content_filter import check_topic_safety
from security.input_validator import (
    ValidationError,
    validate_message,
    validate_user_id,
)
from security.rate_limiter import check_rate_limit

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("audio_companion.main")

app = BedrockAgentCoreApp()

# Strands agents are not thread-safe; serialize invocations.
_agent_lock = threading.Lock()


# Some models (e.g. Nova) occasionally emit chain-of-thought wrapped in
# <thinking>...</thinking> tags. Strip those so reasoning never reaches the user.
_THINKING_RE = re.compile(r"<thinking>.*?</thinking>", re.IGNORECASE | re.DOTALL)
# Also strip a stray unclosed opening/closing tag if a block was truncated.
_STRAY_TAG_RE = re.compile(r"</?thinking>", re.IGNORECASE)


def _strip_reasoning(text: str) -> str:
    cleaned = _THINKING_RE.sub("", text)
    cleaned = _STRAY_TAG_RE.sub("", cleaned)
    return cleaned.strip()


def _response_text(result) -> str:
    """Extract clean assistant text from a Strands AgentResult.

    ``result.message`` is a dict like {"role": "assistant", "content": [{"text": ...}]}.
    We join the text blocks; fall back to ``str(result)`` for other shapes.
    """
    message = getattr(result, "message", None)
    if isinstance(message, dict):
        blocks = message.get("content", [])
        texts = [
            b["text"]
            for b in blocks
            if isinstance(b, dict) and isinstance(b.get("text"), str)
        ]
        if texts:
            joined = "\n".join(t.strip() for t in texts if t.strip()).strip()
            return _strip_reasoning(joined)
    return _strip_reasoning(str(result).strip())


@app.entrypoint
def agent_invocation(payload, context):
    """Handle one agent invocation from the async job Lambda."""
    started = time.time()
    request_id = getattr(context, "session_id", None) or payload.get("job_id")

    try:
        user_id = validate_user_id(payload.get("user_id", ""))
        message = validate_message(payload.get("message", ""))
    except ValidationError as exc:
        log_event("agent_invoke", "invalid_input", error_code="ValidationError")
        return {"error": "invalid_input", "message": str(exc)}

    # Defense in depth — the Lambda already rate-limited and content-filtered, but
    # we re-check here so the agent runtime is safe even if invoked directly.
    if not check_rate_limit(user_id, "lecture"):
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

    log_event("agent_invoke", "started", user_id=user_id, request_id=request_id)

    # Pull the learner's long-term memories (facts + preferences) so the agent can
    # personalize from prior sessions. Fails open to "" if memory is unavailable.
    memory_context = memory.retrieve_user_memories(user_id, message)

    try:
        with _agent_lock:
            run_context.reset()
            agent = build_orchestrator(user_id, memory_context=memory_context)
            result = agent(message)
            lecture = run_context.get_lecture()
        response_text = _response_text(result)
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

    # Record this turn so AgentCore Memory can extract long-term facts/preferences.
    session_id = str(request_id) if request_id else user_id
    memory.record_interaction(
        user_id=user_id,
        session_id=session_id,
        user_text=message,
        assistant_text=response_text,
    )

    response: dict = {"response": response_text}
    if lecture.get("s3Key"):
        response["lecture"] = lecture
    return response


if __name__ == "__main__":
    app.run()
