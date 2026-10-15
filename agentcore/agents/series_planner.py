"""Strict-JSON planner for multi-part lecture series.

Produces only a plan (titles, per-episode focus, durations). It never researches,
writes, synthesizes, or saves a lecture; each approved episode is later generated
by the normal single-lecture orchestrator.
"""
from __future__ import annotations

import json
from typing import Any, Optional

from strands import Agent
from strands.models import BedrockModel

from . import config
from security.input_validator import (
    ValidationError,
    validate_episode_count,
    validate_episode_duration,
    validate_series_title,
)

_MAX_SUMMARY_CHARS = 1000
_MAX_DESCRIPTION_CHARS = 2000

_SYSTEM_PROMPT = """You design coherent multi-part audio lecture series.
Return exactly one JSON object and nothing else (no markdown, no commentary):
{"title":"...","description":"...","episodes":[{"title":"...","summary":"...","duration_minutes":30}]}
Rules:
- 2 to 8 episodes in a deliberate learning sequence: foundations first, then
  core ideas, then applications and synthesis. No two episodes may cover the
  same material.
- If the learner states a number of lectures/episodes or a length per lecture,
  use exactly those values. Otherwise choose what the scope genuinely needs,
  usually 3-6 episodes of 15-30 minutes.
- duration_minutes is a whole number from 1 to 30.
- title: concise series title (max 200 characters).
- description: 1-3 sentences on what the learner will understand by the end
  (max 2000 characters).
- Each episode summary (max 1000 characters) states exactly what that episode
  teaches, so a separate writer can produce it without seeing the others.
- For a book, follow its argument and structure; do not invent chapters or
  quotes you are unsure about.
- Never include IDs."""


def _result_text(result: Any) -> str:
    message = getattr(result, "message", None)
    if isinstance(message, dict):
        texts = [
            block["text"]
            for block in message.get("content", [])
            if isinstance(block, dict) and isinstance(block.get("text"), str)
        ]
        if texts:
            return "\n".join(text.strip() for text in texts if text.strip()).strip()
    return str(result).strip()


def _extract_json(raw: str) -> Any:
    """Parse the model output, tolerating stray fences or prose around the object."""
    try:
        return json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        pass
    start, end = raw.find("{"), raw.rfind("}")
    if start == -1 or end <= start:
        raise ValidationError("Planner did not return JSON")
    try:
        return json.loads(raw[start : end + 1])
    except json.JSONDecodeError as exc:
        raise ValidationError("Planner did not return valid JSON") from exc


def _text(value: Any, label: str, max_length: int) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValidationError(f"Planner {label} must be non-empty text")
    cleaned = value.strip()
    if len(cleaned) > max_length:
        raise ValidationError(f"Planner {label} must be at most {max_length} characters")
    return cleaned


def _validate_plan(
    value: Any,
    *,
    episode_count: Optional[int],
    duration_minutes: Optional[int],
) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValidationError("Planner output must be a JSON object")
    episodes = value.get("episodes")
    if not isinstance(episodes, list):
        raise ValidationError("Planner output has no episodes")
    validate_episode_count(len(episodes))
    if episode_count is not None and len(episodes) != episode_count:
        raise ValidationError("Planner returned the wrong number of episodes")

    normalized = []
    for episode in episodes:
        if not isinstance(episode, dict):
            raise ValidationError("Planner episode must be a JSON object")
        duration = validate_episode_duration(episode.get("duration_minutes"))
        if duration_minutes is not None and duration != duration_minutes:
            raise ValidationError("Planner changed the requested episode duration")
        normalized.append(
            {
                "title": validate_series_title(episode.get("title")),
                "summary": _text(episode.get("summary"), "episode summary", _MAX_SUMMARY_CHARS),
                "duration_minutes": duration,
            }
        )
    return {
        "title": validate_series_title(value.get("title")),
        "description": _text(value.get("description"), "description", _MAX_DESCRIPTION_CHARS),
        "episodes": normalized,
    }


def plan_series(
    *,
    request: str,
    episode_count: Optional[int] = None,
    duration_minutes: Optional[int] = None,
    learner_context: str = "",
) -> dict[str, Any]:
    """Generate and strictly validate a series plan for the learner's request."""
    if episode_count is not None:
        episode_count = validate_episode_count(episode_count)
    if duration_minutes is not None:
        duration_minutes = validate_episode_duration(duration_minutes)

    model = BedrockModel(
        model_id=config.PLANNER_MODEL_ID,
        region_name=config.AWS_REGION,
        max_tokens=min(config.MODEL_MAX_TOKENS, 4096),
        additional_request_fields=config.model_request_fields(config.PLANNER_MODEL_ID),
    )
    planner = Agent(model=model, system_prompt=_SYSTEM_PROMPT)

    prompt = f"Learner request: {request}\n"
    if episode_count is not None:
        prompt += f"Required number of episodes: {episode_count}\n"
    if duration_minutes is not None:
        prompt += f"Required minutes per episode: {duration_minutes}\n"
    if learner_context.strip():
        prompt += f"Learner context for personalization:\n{learner_context[:2000]}\n"
    prompt += "Return the JSON plan now."

    return _validate_plan(
        _extract_json(_result_text(planner(prompt))),
        episode_count=episode_count,
        duration_minutes=duration_minutes,
    )
