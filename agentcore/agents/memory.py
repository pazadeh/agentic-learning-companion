"""AgentCore Memory integration — long-term, cross-session learner recall.

This wraps the AgentCore Memory *data plane* (`bedrock-agentcore` boto3 client):

* ``record_interaction`` writes each conversation turn as an **event** (short-term
  memory). AgentCore's managed strategies then asynchronously extract long-term
  **memory records** containing prior topics and semantic facts the learner cares about.
* ``retrieve_user_memories`` does a semantic search over those long-term records
  for the current user and returns a compact text block to inject into the agent's
  system prompt, so the agent "remembers" prior sessions.

Everything fails open: if ``MEMORY_ID`` is unset or any call errors, the functions
return empty / no-op so the agent still works (just without long-term recall). The
``actorId`` is always the verified user id, so a user can only ever touch their own
namespaces (``users/<user_id>/facts``). Behavioral preferences are deliberately
kept out of managed Memory and handled by the structured profile engine.
"""
from __future__ import annotations

import logging
from typing import Any

from . import config

logger = logging.getLogger("audio_companion.agents.memory")

# Preference records are deliberately not retrieved: structured explicit/inferred
# settings are the only authoritative preference source and honor privacy/reset controls.
_NAMESPACES = ("facts",)
_TOP_K = 5


def _enabled() -> bool:
    return bool(config.MEMORY_ID)


def _extract_text(content: Any) -> str:
    """Memory record content may be a plain string or a {'text': ...} dict."""
    if isinstance(content, str):
        return content
    if isinstance(content, dict):
        if "text" in content:
            return str(content["text"])
        return str(content)
    return str(content)


def retrieve_user_memories(user_id: str, query: str) -> str:
    """Return a compact text block of the user's most relevant long-term memories.

    Empty string if memory is disabled, nothing is found, or anything errors.
    """
    if not _enabled():
        return ""

    client = config.agentcore_memory_client()
    lines: list[str] = []
    for ns in _NAMESPACES:
        namespace = f"users/{user_id}/{ns}"
        try:
            response = client.retrieve_memory_records(
                memoryId=config.MEMORY_ID,
                namespace=namespace,
                searchCriteria={"searchQuery": query, "topK": _TOP_K},
            )
        except Exception as exc:  # noqa: BLE001 - fail open
            logger.warning(
                "Memory retrieve failed", extra={"error_code": type(exc).__name__}
            )
            continue

        for record in response.get("memoryRecordSummaries", []):
            text = _extract_text(record.get("content")).strip()
            if text:
                lines.append(f"- {text}")

    if not lines:
        return ""

    # De-duplicate while preserving order, cap to keep the prompt lean.
    seen: set[str] = set()
    unique = [ln for ln in lines if not (ln in seen or seen.add(ln))][:8]
    return "\n".join(unique)


def record_interaction(
    user_id: str, session_id: str, user_text: str, assistant_text: str
) -> None:
    """Record one user/assistant turn as a memory event (best effort)."""
    if not _enabled():
        return
    if not (user_text and assistant_text):
        return

    client = config.agentcore_memory_client()
    payload = [
        {"conversationalMessage": {"role": "user", "content": [{"text": user_text}]}},
        {
            "conversationalMessage": {
                "role": "assistant",
                "content": [{"text": assistant_text}],
            }
        },
    ]
    try:
        client.create_event(
            memoryId=config.MEMORY_ID,
            actorId=user_id,
            sessionId=session_id,
            payload=payload,
        )
    except Exception as exc:  # noqa: BLE001 - fail open
        logger.warning(
            "Memory create_event failed", extra={"error_code": type(exc).__name__}
        )
