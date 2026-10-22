"""Guided lecture-design agent.

This agent can only propose and refine a structured lecture brief. It has no tools and
cannot research, synthesize, upload, or persist a lecture. The existing generation
pipeline starts only after the user explicitly confirms the validated brief.
"""
from __future__ import annotations

import json
from typing import Any

from strands import Agent
from strands.models import BedrockModel

from . import config
from security.input_validator import ValidationError

_MAX_TURNS = 3
_LEVELS = {"beginner", "intermediate", "advanced"}
_DEPTHS = {"overview", "standard", "deep"}
_STYLES = {"examples", "theory", "practical", "story", "step-by-step"}
_REINFORCEMENT = {"recap", "reflection", "memory-hooks", "none"}

_SYSTEM_PROMPT = """You are a concise AI lecture-design assistant. Help a learner
turn an incomplete idea into a useful audio-lecture plan. You NEVER write the lecture,
research it, call tools, or claim that generation has started.

Return exactly one JSON object and no markdown:
{
  "message": "one short helpful response",
  "brief": {
    "topic": "...", "title": "...", "learningObjective": "...",
    "knowledgeLevel": "beginner|intermediate|advanced",
    "durationMinutes": 15, "depth": "overview|standard|deep",
    "learningStyle": "examples|theory|practical|story|step-by-step",
    "tone": "...", "includeTopics": ["..."], "excludeTopics": ["..."],
    "exampleContext": "...", "reinforcement": "recap|reflection|memory-hooks|none",
    "sourceFreshness": "current|timeless", "language": "English"
  },
  "readyForConfirmation": false,
  "question": {
    "id": "goal|level|duration|depth|style|scope|example|reinforcement",
    "prompt": "one focused question",
    "selection": "single|multiple",
    "allowCustomAnswer": true,
    "choices": [
      {"id":"...","label":"...","value":"...","description":"...","recommended":true}
    ]
  }
}

Rules:
- Preserve every preference the learner has already given; never silently reverse it.
- Use profile values as visible recommendations, not hidden requirements.
- Ask only one high-impact missing question per turn, with 2-5 concise choices.
- Usually ask about the learning goal first, then only the most consequential gap.
- The user can always type a custom answer.
- Offer a recommended choice when justified.
- Duration must be a whole number from 1 to 60.
- Keep include/exclude topics to at most 12 concise entries each.
- If the brief is sufficiently useful, or this is turn 3, set readyForConfirmation=true
  and question=null. The message should invite the learner to confirm or refine.
- A broad scope over about 30 minutes may recommend a series in the message, but this
  brief remains for one lecture.
"""


def _result_text(result: Any) -> str:
    message = getattr(result, "message", None)
    if isinstance(message, dict):
        texts = [
            block["text"]
            for block in message.get("content", [])
            if isinstance(block, dict) and isinstance(block.get("text"), str)
        ]
        if texts:
            return "\n".join(texts).strip()
    return str(result).strip()


def _extract_json(raw: str) -> dict[str, Any]:
    try:
        value = json.loads(raw)
    except json.JSONDecodeError:
        start, end = raw.find("{"), raw.rfind("}")
        if start < 0 or end <= start:
            raise ValidationError("Designer did not return JSON")
        try:
            value = json.loads(raw[start : end + 1])
        except json.JSONDecodeError as exc:
            raise ValidationError("Designer returned invalid JSON") from exc
    if not isinstance(value, dict):
        raise ValidationError("Designer output must be an object")
    return value


def _text(value: Any, default: str = "", limit: int = 500) -> str:
    if not isinstance(value, str):
        return default
    return value.strip()[:limit]


def _required_text(value: Any, fallback: str, limit: int) -> str:
    cleaned = _text(value, limit=limit)
    return cleaned or _text(fallback, "Untitled lecture", limit) or "Untitled lecture"


def _text_list(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    result: list[str] = []
    for item in value[:12]:
        cleaned = _text(item, limit=200)
        if cleaned and cleaned.casefold() not in {entry.casefold() for entry in result}:
            result.append(cleaned)
    return result


def _initial_brief(request: str, personalization: dict[str, Any]) -> dict[str, Any]:
    duration = personalization.get("durationMinutes", {}).get("value", 15)
    level = personalization.get("knowledgeLevel", {}).get("value", "intermediate")
    style = personalization.get("learningStyle", {}).get("value", "examples")
    depth = personalization.get("researchDepth", {}).get("value", "standard")
    return {
        "topic": request[:500],
        "title": request[:200],
        "learningObjective": "",
        "knowledgeLevel": level if level in _LEVELS else "intermediate",
        "durationMinutes": duration if isinstance(duration, int) else 15,
        "depth": depth if depth in _DEPTHS else "standard",
        "learningStyle": style if style in _STYLES else "examples",
        "tone": "conversational",
        "includeTopics": [],
        "excludeTopics": [],
        "exampleContext": "",
        "reinforcement": "recap",
        "sourceFreshness": "timeless",
        "language": "English",
    }


def _normalize_brief(
    raw: Any, request: str, current: dict[str, Any], personalization: dict[str, Any]
) -> dict[str, Any]:
    defaults = _initial_brief(request, personalization)
    prior = current if isinstance(current, dict) else {}
    prior_duration = prior.get("durationMinutes")
    base = {
        "topic": _text(prior.get("topic"), defaults["topic"], 500),
        "title": _text(prior.get("title"), defaults["title"], 200),
        "learningObjective": _text(prior.get("learningObjective"), "", 1000),
        "knowledgeLevel": (
            prior.get("knowledgeLevel")
            if prior.get("knowledgeLevel") in _LEVELS
            else defaults["knowledgeLevel"]
        ),
        "durationMinutes": (
            prior_duration
            if isinstance(prior_duration, int)
            and not isinstance(prior_duration, bool)
            and 1 <= prior_duration <= 60
            else defaults["durationMinutes"]
        ),
        "depth": prior.get("depth") if prior.get("depth") in _DEPTHS else defaults["depth"],
        "learningStyle": (
            prior.get("learningStyle")
            if prior.get("learningStyle") in _STYLES
            else defaults["learningStyle"]
        ),
        "tone": _text(prior.get("tone"), defaults["tone"], 100),
        "includeTopics": _text_list(prior.get("includeTopics")),
        "excludeTopics": _text_list(prior.get("excludeTopics")),
        "exampleContext": _text(prior.get("exampleContext"), "", 500),
        "reinforcement": (
            prior.get("reinforcement")
            if prior.get("reinforcement") in _REINFORCEMENT
            else defaults["reinforcement"]
        ),
        "sourceFreshness": (
            prior.get("sourceFreshness")
            if prior.get("sourceFreshness") in {"current", "timeless"}
            else defaults["sourceFreshness"]
        ),
        "language": _text(prior.get("language"), defaults["language"], 100),
    }
    value = raw if isinstance(raw, dict) else {}
    duration = value.get("durationMinutes", base["durationMinutes"])
    if isinstance(duration, bool) or not isinstance(duration, int) or not 1 <= duration <= 60:
        duration = base["durationMinutes"]
    level = value.get("knowledgeLevel", base["knowledgeLevel"])
    depth = value.get("depth", base["depth"])
    style = value.get("learningStyle", base["learningStyle"])
    reinforcement = value.get("reinforcement", base["reinforcement"])
    freshness = value.get("sourceFreshness", base["sourceFreshness"])
    return {
        "topic": _required_text(value.get("topic"), base["topic"], 500),
        "title": _required_text(value.get("title"), base["title"], 200),
        "learningObjective": _text(
            value.get("learningObjective"), base["learningObjective"], 1000
        ),
        "knowledgeLevel": level if level in _LEVELS else base["knowledgeLevel"],
        "durationMinutes": duration,
        "depth": depth if depth in _DEPTHS else base["depth"],
        "learningStyle": style if style in _STYLES else base["learningStyle"],
        "tone": _required_text(value.get("tone"), base["tone"], 100),
        "includeTopics": _text_list(value.get("includeTopics", base["includeTopics"])),
        "excludeTopics": _text_list(value.get("excludeTopics", base["excludeTopics"])),
        "exampleContext": _text(
            value.get("exampleContext"), base["exampleContext"], 500
        ),
        "reinforcement": (
            reinforcement if reinforcement in _REINFORCEMENT else base["reinforcement"]
        ),
        "sourceFreshness": freshness if freshness in {"current", "timeless"} else base["sourceFreshness"],
        "language": _required_text(value.get("language"), base["language"], 100),
    }


def _normalize_question(raw: Any) -> dict[str, Any] | None:
    if not isinstance(raw, dict):
        return None
    prompt = _text(raw.get("prompt"), limit=500)
    choices_raw = raw.get("choices")
    if not prompt or not isinstance(choices_raw, list):
        return None
    choices = []
    seen_ids: set[str] = set()
    for index, item in enumerate(choices_raw[:5]):
        if not isinstance(item, dict):
            continue
        label = _text(item.get("label"), limit=100)
        value = _text(item.get("value"), label, 300)
        if not label or not value:
            continue
        choice_id = _text(item.get("id"), limit=80)
        if not choice_id or choice_id in seen_ids:
            choice_id = f"choice-{index + 1}"
        while choice_id in seen_ids:
            choice_id += "-alt"
        seen_ids.add(choice_id)
        choices.append(
            {
                "id": choice_id,
                "label": label,
                "value": value,
                "description": _text(item.get("description"), limit=200),
                "recommended": item.get("recommended") is True,
            }
        )
    if len(choices) < 2:
        return None
    return {
        "id": _text(raw.get("id"), limit=80) or "preference",
        "prompt": prompt,
        "selection": "multiple" if raw.get("selection") == "multiple" else "single",
        "allowCustomAnswer": raw.get("allowCustomAnswer") is not False,
        "choices": choices,
    }


def _fallback_question(brief: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": "goal",
        "prompt": "What should you be able to understand or do after this lecture?",
        "selection": "single",
        "allowCustomAnswer": True,
        "choices": [
            {
                "id": "understand",
                "label": "Understand the essentials",
                "value": f"Understand the essential ideas of {brief['topic']}",
                "description": "Build a clear conceptual foundation.",
                "recommended": True,
            },
            {
                "id": "apply",
                "label": "Apply it practically",
                "value": f"Apply {brief['topic']} in a practical situation",
                "description": "Focus on decisions, steps, and examples.",
                "recommended": False,
            },
        ],
    }


def validate_confirmed_brief(
    raw: Any, personalization: dict[str, Any]
) -> dict[str, Any]:
    """Validate the user-confirmed contract before the generation pipeline."""
    if not isinstance(raw, dict):
        raise ValidationError("Invalid confirmed lecture brief")
    topic = _required_text(raw.get("topic"), "Lecture", 500)
    brief = _normalize_brief(raw, topic, {}, personalization)
    brief["learningObjective"] = _required_text(
        brief.get("learningObjective"), brief["topic"], 1000
    )
    return brief


def design_lecture(
    *,
    request: str,
    answer: str,
    current_brief: dict[str, Any] | None,
    history: list[dict[str, str]],
    turn: int,
    personalization: dict[str, Any],
) -> dict[str, Any]:
    """Produce the next guided-design turn and validated structured brief."""
    brief = _normalize_brief(current_brief, request, current_brief or {}, personalization)
    safe_history = [
        {"role": _text(item.get("role"), "user", 20), "content": _text(item.get("content"), limit=1000)}
        for item in history[-6:]
        if isinstance(item, dict)
    ]
    model = BedrockModel(
        model_id=config.DESIGN_MODEL_ID,
        region_name=config.AWS_REGION,
        max_tokens=3000,
        additional_request_fields=config.model_request_fields(config.DESIGN_MODEL_ID),
    )
    agent = Agent(model=model, system_prompt=_SYSTEM_PROMPT)
    result = agent(
        "Original request:\n"
        + request
        + "\n\nLatest learner answer:\n"
        + answer
        + "\n\nCurrent brief:\n"
        + json.dumps(brief, sort_keys=True)
        + "\n\nRecent design conversation:\n"
        + json.dumps(safe_history)
        + f"\n\nThis is design turn {turn} of {_MAX_TURNS}."
    )
    raw = _extract_json(_result_text(result))
    normalized = _normalize_brief(raw.get("brief"), request, brief, personalization)
    ready = raw.get("readyForConfirmation") is True or turn >= _MAX_TURNS
    question = None if ready else (_normalize_question(raw.get("question")) or _fallback_question(normalized))
    if ready:
        normalized["learningObjective"] = _required_text(
            normalized.get("learningObjective"), normalized["topic"], 1000
        )
        if turn >= _MAX_TURNS:
            normalized["_designFinalized"] = True
    return {
        "message": _text(
            raw.get("message"),
            "Your lecture brief is ready to review." if ready else "Let's refine the lecture.",
            1000,
        ),
        "brief": normalized,
        "readyForConfirmation": ready,
        "question": question,
        "turn": min(_MAX_TURNS, max(1, turn)),
    }
