"""Tests for the tool-free guided lecture-design agent contract."""
from __future__ import annotations

import json
import sys
import types

import pytest

if "strands" not in sys.modules:
    strands = types.ModuleType("strands")
    strands.Agent = object
    strands.tool = lambda function: function
    sys.modules["strands"] = strands
else:
    setattr(sys.modules["strands"], "Agent", object)
    if not hasattr(sys.modules["strands"], "tool"):
        setattr(sys.modules["strands"], "tool", lambda function: function)
if "strands.models" not in sys.modules:
    models = types.ModuleType("strands.models")
    models.BedrockModel = object
    sys.modules["strands.models"] = models
else:
    setattr(sys.modules["strands.models"], "BedrockModel", object)

from agents import lecture_agent, lecture_designer, run_context


PERSONALIZATION = {
    "knowledgeLevel": {"value": "beginner"},
    "learningStyle": {"value": "examples"},
    "durationMinutes": {"value": 20},
    "researchDepth": {"value": "standard"},
}


class _Result:
    def __init__(self, value):
        self.message = {"content": [{"text": json.dumps(value)}]}


def _install_model(monkeypatch, value):
    class Model:
        def __init__(self, **_kwargs):
            pass

    class Agent:
        def __init__(self, **_kwargs):
            pass

        def __call__(self, _prompt):
            return _Result(value)

    monkeypatch.setattr(lecture_designer, "BedrockModel", Model)
    monkeypatch.setattr(lecture_designer, "Agent", Agent)


def test_design_returns_validated_single_choice_question(monkeypatch):
    _install_model(
        monkeypatch,
        {
            "message": "Which outcome matters most?",
            "brief": {"topic": "Kubernetes", "durationMinutes": 20},
            "readyForConfirmation": False,
            "question": {
                "id": "goal",
                "prompt": "What should you be able to do afterward?",
                "selection": "single",
                "allowCustomAnswer": True,
                "choices": [
                    {"id": "deploy", "label": "Deploy an app", "value": "Deploy an application", "recommended": True},
                    {"id": "architecture", "label": "Understand architecture", "value": "Understand architecture"},
                ],
            },
        },
    )

    result = lecture_designer.design_lecture(
        request="Kubernetes",
        answer="Kubernetes",
        current_brief=None,
        history=[],
        turn=1,
        personalization=PERSONALIZATION,
    )

    assert result["readyForConfirmation"] is False
    assert result["question"]["choices"][0]["recommended"] is True
    assert result["brief"]["knowledgeLevel"] == "beginner"
    assert result["brief"]["durationMinutes"] == 20


def test_third_turn_forces_confirmation_and_bounds_values(monkeypatch):
    _install_model(
        monkeypatch,
        {
            "message": "Review this brief.",
            "brief": {
                "topic": "TCP",
                "durationMinutes": 999,
                "knowledgeLevel": "expert",
                "includeTopics": [f"topic-{index}" for index in range(20)],
            },
            "readyForConfirmation": False,
            "question": {
                "prompt": "Another question?",
                "choices": [{"label": "A", "value": "A"}, {"label": "B", "value": "B"}],
            },
        },
    )

    result = lecture_designer.design_lecture(
        request="TCP",
        answer="Make it practical",
        current_brief={},
        history=[],
        turn=3,
        personalization=PERSONALIZATION,
    )

    assert result["readyForConfirmation"] is True
    assert result["question"] is None
    assert result["brief"]["durationMinutes"] == 20
    assert result["brief"]["knowledgeLevel"] == "beginner"
    assert len(result["brief"]["includeTopics"]) == 12
    assert result["brief"]["_designFinalized"] is True


def test_question_requires_two_valid_choices():
    assert lecture_designer._normalize_question(
        {"prompt": "Choose", "choices": [{"label": "Only", "value": "one"}]}
    ) is None


def test_question_ids_are_non_empty_and_unique():
    question = lecture_designer._normalize_question(
        {
            "id": "",
            "prompt": "Choose",
            "choices": [
                {"id": "same", "label": "One", "value": "one"},
                {"id": "same", "label": "Two", "value": "two"},
            ],
        }
    )
    assert question["id"] == "preference"
    assert len({choice["id"] for choice in question["choices"]}) == 2


def test_confirmed_brief_is_sanitized_and_reinforcement_none_skips_closing():
    confirmed = lecture_designer.validate_confirmed_brief(
        {
            "topic": "TCP",
            "title": "TCP essentials",
            "learningObjective": "Understand reliable transport",
            "knowledgeLevel": "beginner",
            "durationMinutes": 10,
            "depth": "overview",
            "learningStyle": "story",
            "tone": "friendly",
            "includeTopics": ["handshake"],
            "excludeTopics": ["kernel internals"],
            "exampleContext": "a phone call",
            "reinforcement": "none",
            "sourceFreshness": "timeless",
            "language": "English",
        },
        PERSONALIZATION,
    )
    run_context.reset()
    run_context.set_lecture_brief(confirmed)
    assert run_context.get_lecture_brief()["reinforcement"] == "none"

    calls = []

    def writer(_prompt):
        calls.append(_prompt)
        return _Result("One complete sentence with enough words.")

    script = lecture_agent._write_script(writer, "initial", 5, reinforcement="none")
    assert script
    assert len(calls) == 1


def test_invalid_json_is_rejected():
    with pytest.raises(Exception, match="JSON"):
        lecture_designer._extract_json("not json")
