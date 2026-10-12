"""Persistence tools — user profiles and saved lectures (DynamoDB).

These are exposed to the orchestrator as tools. The ``user_id`` is always passed in
explicitly by the orchestrator (it is injected into the system prompt from the
verified JWT), so a tool can never touch another user's data.
"""
from __future__ import annotations

import json
import logging
import time

from strands import tool

from . import config, run_context

logger = logging.getLogger("audio_companion.agents.store")


def _profiles_table():
    return config.dynamodb_resource().Table(config.PROFILES_TABLE)


def _lectures_table():
    return config.dynamodb_resource().Table(config.LECTURES_TABLE)


@tool
def get_user_profile(user_id: str) -> str:
    """Fetch the learner's profile (knowledge level, style, preferences).

    Args:
        user_id: The current user's id.

    Returns:
        A JSON string of the profile, or an empty default profile if none exists.
    """
    item = (
        _profiles_table()
        .get_item(Key={"pk": f"USER#{user_id}", "sk": "PROFILE#EXPLICIT"})
        .get("Item")
    )
    if not item:
        # Backward-compatible read for profiles created before cloud profile sync.
        item = (
            _profiles_table()
            .get_item(Key={"pk": f"USER#{user_id}", "sk": "PROFILE"})
            .get("Item")
        )
    if not item:
        return json.dumps(
            {
                "exists": False,
                "profession": "",
                "expertiseAreas": [],
                "learningGoals": [],
                "learningStyle": "examples",
                "preferredDuration": config.DEFAULT_DURATION_MINUTES,
                "knowledgeLevels": {},
            }
        )
    item.pop("pk", None)
    item.pop("sk", None)
    return json.dumps(item, default=str)


@tool
def save_user_profile(user_id: str, profile_json: str) -> str:
    """Create or update the learner's profile.

    Args:
        user_id: The current user's id.
        profile_json: A JSON object string with any of: profession, expertiseAreas,
            learningGoals, learningStyle, preferredDuration, knowledgeLevels.

    Returns:
        A JSON status string.
    """
    try:
        profile = json.loads(profile_json) if profile_json else {}
    except json.JSONDecodeError:
        return json.dumps({"ok": False, "error": "invalid profile_json"})
    if not isinstance(profile, dict):
        return json.dumps({"ok": False, "error": "profile must be an object"})

    now = int(time.time())
    item = {"pk": f"USER#{user_id}", "sk": "PROFILE#EXPLICIT", "updatedAt": now}
    allowed = {
        "profession",
        "expertiseAreas",
        "learningGoals",
        "learningStyle",
        "preferredDuration",
        "knowledgeLevels",
        "email",
        "lecturesCompleted",
        "totalListeningTime",
    }
    for k, v in profile.items():
        if k in allowed:
            item[k] = v
    item.setdefault("createdAt", now)
    _profiles_table().put_item(Item=item)
    return json.dumps({"ok": True})


@tool
def save_lecture(user_id: str, lecture_json: str) -> str:
    """Persist a generated lecture's metadata for the history view.

    Args:
        user_id: The current user's id.
        lecture_json: A JSON object string with: lectureId, title, topic, s3Key,
            durationMinutes, knowledgeLevel (optional), sources (optional).

    Returns:
        A JSON status string echoing the stored lectureId.
    """
    try:
        lecture = json.loads(lecture_json) if lecture_json else {}
    except json.JSONDecodeError:
        return json.dumps({"ok": False, "error": "invalid lecture_json"})

    # Prefer the authoritative values produced by synthesize_and_upload (real audio
    # location + duration measured from the actual synthesized script) over whatever
    # the orchestrator put in ``lecture_json`` (which is often an optimistic guess).
    produced = run_context.get_lecture()
    lecture_id = produced.get("lectureId") or lecture.get("lectureId")
    if not lecture_id:
        return json.dumps({"ok": False, "error": "missing lectureId"})
    s3_key = produced.get("s3Key") or lecture.get("s3Key", "")
    duration_minutes = produced.get("durationMinutes") or lecture.get(
        "durationMinutes", 0
    )

    created_at = lecture.get("createdAt") or _iso_now()
    item = {
        "pk": f"USER#{user_id}",
        "sk": f"LECTURE#{lecture_id}",
        "lectureId": lecture_id,
        "title": lecture.get("title", "") or produced.get("title", ""),
        "topic": lecture.get("topic", ""),
        "s3Key": s3_key,
        "durationMinutes": duration_minutes,
        "knowledgeLevel": lecture.get("knowledgeLevel", ""),
        "sources": lecture.get("sources", []),
        "personalizationUsed": produced.get("personalizationUsed", {}),
        "createdAt": created_at,
    }
    if lecture.get("script"):
        item["script"] = lecture["script"]
    _lectures_table().put_item(Item=item)
    run_context.set_lecture(
        lectureId=lecture_id,
        title=item["title"],
        topic=item["topic"],
        s3Key=item["s3Key"],
        durationMinutes=item["durationMinutes"],
        createdAt=created_at,
    )
    return json.dumps({"ok": True, "lectureId": lecture_id})


def _iso_now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
