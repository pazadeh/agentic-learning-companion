"""End-to-end local integration tests for durable lecture series.

These tests execute the real API router, DynamoDB transaction expressions, series
worker state machine, deterministic lecture upsert, and cross-device history query.
Only external boundaries (AgentCore and Lambda async dispatch) are faked.
"""
from __future__ import annotations

import json
import os
import uuid
from decimal import Decimal
from typing import Any

import boto3
import pytest
from moto import mock_aws

USER_ID = str(uuid.uuid4())


def _api_event(
    method: str,
    resource: str,
    *,
    body: dict[str, Any] | None = None,
    path_params: dict[str, str] | None = None,
) -> dict[str, Any]:
    return {
        "httpMethod": method,
        "resource": resource,
        "pathParameters": path_params or {},
        "body": json.dumps(body) if body is not None else None,
        "requestContext": {"authorizer": {"claims": {"sub": USER_ID}}},
    }


class _FakeAgentCore:
    """Returns real AgentCore response bytes while recording invocation payloads."""

    def __init__(self) -> None:
        self.payloads: list[dict[str, Any]] = []

    def invoke_agent_runtime(self, **kwargs: Any) -> dict[str, bytes]:
        payload = json.loads(kwargs["payload"].decode("utf-8"))
        self.payloads.append(payload)
        lecture_id = str(uuid.uuid4())
        result = {
            "response": "Episode ready",
            "lecture": {
                "lectureId": lecture_id,
                "title": "Generated episode",
                "topic": "Distributed systems",
                "s3Key": f"audio/{payload['user_id']}/{lecture_id}/lecture.mp3",
                "durationMinutes": 1,
            },
        }
        return {"response": json.dumps(result).encode("utf-8")}


class _DispatchQueue:
    def __init__(self) -> None:
        self.job_ids: list[str] = []

    def invoke(self, *, FunctionName: str, InvocationType: str, Payload: bytes) -> dict[str, int]:
        assert FunctionName == os.environ["AWS_LAMBDA_FUNCTION_NAME"]
        assert InvocationType == "Event"
        self.job_ids.append(json.loads(Payload.decode("utf-8"))["job_id"])
        return {"StatusCode": 202}

    def pop(self) -> str:
        assert self.job_ids, "expected a dispatched worker job"
        return self.job_ids.pop(0)


def _create_tables() -> None:
    client = boto3.client("dynamodb", region_name="us-east-1")
    client.create_table(
        TableName=os.environ["JOBS_TABLE"],
        KeySchema=[{"AttributeName": "jobId", "KeyType": "HASH"}],
        AttributeDefinitions=[{"AttributeName": "jobId", "AttributeType": "S"}],
        BillingMode="PAY_PER_REQUEST",
    )
    client.create_table(
        TableName=os.environ["SERIES_TABLE"],
        KeySchema=[
            {"AttributeName": "pk", "KeyType": "HASH"},
            {"AttributeName": "sk", "KeyType": "RANGE"},
        ],
        AttributeDefinitions=[
            {"AttributeName": "pk", "AttributeType": "S"},
            {"AttributeName": "sk", "AttributeType": "S"},
        ],
        BillingMode="PAY_PER_REQUEST",
    )
    client.create_table(
        TableName=os.environ["PROFILES_TABLE"],
        KeySchema=[
            {"AttributeName": "pk", "KeyType": "HASH"},
            {"AttributeName": "sk", "KeyType": "RANGE"},
        ],
        AttributeDefinitions=[
            {"AttributeName": "pk", "AttributeType": "S"},
            {"AttributeName": "sk", "AttributeType": "S"},
        ],
        BillingMode="PAY_PER_REQUEST",
    )
    client.create_table(
        TableName=os.environ["LECTURES_TABLE"],
        KeySchema=[
            {"AttributeName": "pk", "KeyType": "HASH"},
            {"AttributeName": "sk", "KeyType": "RANGE"},
        ],
        AttributeDefinitions=[
            {"AttributeName": "pk", "AttributeType": "S"},
            {"AttributeName": "sk", "AttributeType": "S"},
            {"AttributeName": "createdAt", "AttributeType": "S"},
        ],
        GlobalSecondaryIndexes=[
            {
                "IndexName": "GSI1",
                "KeySchema": [
                    {"AttributeName": "pk", "KeyType": "HASH"},
                    {"AttributeName": "createdAt", "KeyType": "RANGE"},
                ],
                "Projection": {"ProjectionType": "ALL"},
            }
        ],
        BillingMode="PAY_PER_REQUEST",
    )


@pytest.fixture()
def series_env(async_job_handler, monkeypatch):
    with mock_aws():
        _create_tables()
        handler = async_job_handler
        # Module globals can survive through the sibling-module import cache.
        handler._dynamodb = None
        handler._lambda_client = None
        handler.series._resource = None
        handler.series._client = None
        handler.learner_profile._resource = None
        handler.learner_profile._client = None

        dispatch = _DispatchQueue()
        monkeypatch.setattr(handler, "_lambda", lambda: dispatch)
        monkeypatch.setattr(handler.series, "check_rate_limit", lambda user_id, action: True)
        yield handler, dispatch


def _json_body(response: dict[str, Any]) -> dict[str, Any]:
    return json.loads(response["body"])


def _create_and_plan(handler, dispatch: _DispatchQueue) -> dict[str, Any]:
    response = handler.handler(
        _api_event(
            "POST",
            "/series/drafts",
            body={"message": "Teach me distributed systems in two short lectures"},
        ),
        None,
    )
    assert response["statusCode"] == 202
    draft = _json_body(response)
    assert draft["status"] == "planning"

    def planner(user_id, message, job_id, request_type="lecture", extra=None):
        assert user_id == USER_ID
        assert request_type == "series_plan"
        return {
            "response": "Plan ready",
            "plan": {
                "title": "Distributed Systems",
                "description": "Build a reliable conceptual foundation.",
                "episodes": [
                    {
                        "title": "Foundations",
                        "summary": "Nodes, messages, time, and failure.",
                        "duration_minutes": 1,
                    },
                    {
                        "title": "Consistency",
                        "summary": "Replication, consensus, and trade-offs.",
                        "duration_minutes": 1,
                    },
                ],
            },
        }

    handler._invoke_agent = planner
    assert handler._run_worker(dispatch.pop()) == {"ok": True}

    response = handler.handler(
        _api_event("GET", "/series/{seriesId}", path_params={"seriesId": draft["seriesId"]}),
        None,
    )
    detail = _json_body(response)
    assert detail["status"] == "ready_for_approval"
    assert len(detail["episodes"]) == 2
    return detail


def test_series_happy_path_generates_sequentially_and_syncs_history(series_env, monkeypatch):
    """Draft -> plan -> edit -> approve -> two sequential episodes -> history."""
    handler, dispatch = series_env
    real_invoke_agent = handler._invoke_agent
    detail = _create_and_plan(handler, dispatch)
    series_id = detail["seriesId"]

    # Exercise revision-checked editing before approval.
    plan = detail["plan"]
    plan["title"] = "Distributed Systems Essentials"
    plan["episodes"][0]["title"] = "Failure and Time"
    response = handler.handler(
        _api_event(
            "POST",
            "/series/{seriesId}/plan",
            path_params={"seriesId": series_id},
            body={"revision": detail["revision"], "plan": plan},
        ),
        None,
    )
    edited = _json_body(response)
    assert response["statusCode"] == 200
    assert edited["revision"] == detail["revision"] + 1

    response = handler.handler(
        _api_event(
            "POST",
            "/series/{seriesId}/approve",
            path_params={"seriesId": series_id},
            body={"revision": edited["revision"]},
        ),
        None,
    )
    assert response["statusCode"] == 202
    assert _json_body(response)["status"] == "generating"
    first_job_id = dispatch.pop()

    agentcore = _FakeAgentCore()
    monkeypatch.setattr(handler, "_invoke_agent", real_invoke_agent)
    monkeypatch.setattr(handler, "_agentcore", lambda: agentcore)
    first_result = handler._run_worker(first_job_id)
    assert first_result == {"ok": True}
    second_job_id = dispatch.pop()

    # A duplicate delivery cannot generate the episode again.
    assert handler._run_worker(first_job_id) == {"ok": True, "duplicate": True}
    assert [payload["job_id"] for payload in agentcore.payloads] == [first_job_id]

    assert handler._run_worker(second_job_id) == {"ok": True}
    assert dispatch.job_ids == []
    assert [payload["job_id"] for payload in agentcore.payloads] == [first_job_id, second_job_id]
    assert all(payload["request_type"] == "lecture" for payload in agentcore.payloads)
    assert all(payload["series_id"] == series_id for payload in agentcore.payloads)

    response = handler.handler(
        _api_event("GET", "/series/{seriesId}", path_params={"seriesId": series_id}),
        None,
    )
    completed = _json_body(response)
    assert completed["status"] == "completed"
    assert completed["completedEpisodeCount"] == 2
    assert [episode["status"] for episode in completed["episodes"]] == ["completed", "completed"]
    assert all(episode["s3Key"].startswith(f"audio/{USER_ID}/") for episode in completed["episodes"])

    # A second device using the same Cognito subject discovers both lectures from DynamoDB.
    response = handler.handler(_api_event("GET", "/lectures"), None)
    history = _json_body(response)
    assert response["statusCode"] == 200
    assert len(history["lectures"]) == 2
    assert {item["lectureId"] for item in history["lectures"]} == {
        episode["lectureId"] for episode in completed["episodes"]
    }


def test_failed_episode_pauses_and_retry_resumes(series_env, monkeypatch):
    handler, dispatch = series_env
    detail = _create_and_plan(handler, dispatch)
    series_id = detail["seriesId"]

    response = handler.handler(
        _api_event(
            "POST",
            "/series/{seriesId}/approve",
            path_params={"seriesId": series_id},
            body={"revision": detail["revision"]},
        ),
        None,
    )
    assert response["statusCode"] == 202
    failed_job_id = dispatch.pop()
    monkeypatch.setattr(
        handler,
        "_invoke_agent",
        lambda *args, **kwargs: {"error": "rate_limited"},
    )
    assert handler._run_worker(failed_job_id) == {"ok": False}

    response = handler.handler(
        _api_event("GET", "/series/{seriesId}", path_params={"seriesId": series_id}),
        None,
    )
    paused = _json_body(response)
    assert paused["status"] == "attention"
    failed = paused["episodes"][0]
    assert failed["status"] == "failed"
    assert failed["retryable"] is True
    assert "rate limit" in failed["error"].lower()

    response = handler.handler(
        _api_event(
            "POST",
            "/series/{seriesId}/episodes/{episodeId}/retry",
            path_params={"seriesId": series_id, "episodeId": failed["episodeId"]},
        ),
        None,
    )
    resumed = _json_body(response)
    assert response["statusCode"] == 202
    assert resumed["status"] == "generating"
    assert resumed["episodes"][0]["status"] == "queued"
    assert dispatch.pop() != failed_job_id


def test_worker_persistence_rejects_cross_user_audio_key(series_env):
    handler, _ = series_env
    lecture_id = str(uuid.uuid4())
    foreign_user = str(uuid.uuid4())
    with pytest.raises(RuntimeError, match="invalid audio key"):
        handler._persist_lecture_result(
            USER_ID,
            {
                "lecture": {
                    "lectureId": lecture_id,
                    "title": "Unsafe result",
                    "s3Key": f"audio/{foreign_user}/{lecture_id}/lecture.mp3",
                    "durationMinutes": 1,
                }
            },
        )


def test_cloud_profile_playback_and_inference_flow(series_env):
    handler, _ = series_env

    # Explicit settings are durable and remain distinct from inferred preferences.
    response = handler.handler(
        _api_event(
            "PUT",
            "/profile",
            body={
                "profession": "Engineer",
                "expertiseAreas": ["Distributed systems"],
                "learningGoals": ["Learn consensus"],
                "learningStyle": "practical",
                "preferredDuration": 20,
                "behavioralPersonalizationEnabled": True,
                "revision": 0,
            },
        ),
        None,
    )
    profile = _json_body(response)
    assert response["statusCode"] == 200
    assert profile["explicit"]["learningStyle"] == "practical"
    assert profile["explicit"]["preferredDuration"] == 20
    assert profile["revision"] == 1

    stale = handler.handler(
        _api_event(
            "PUT",
            "/profile",
            body={
                "profession": "Stale device",
                "expertiseAreas": [],
                "learningGoals": [],
                "learningStyle": "theory",
                "preferredDuration": 10,
                "behavioralPersonalizationEnabled": True,
                "revision": 0,
            },
        ),
        None,
    )
    assert stale["statusCode"] == 409

    lectures = boto3.resource("dynamodb", region_name="us-east-1").Table(
        os.environ["LECTURES_TABLE"]
    )
    created_at = "2026-07-14T12:00:00Z"
    lecture_ids: list[str] = []
    for index in range(4):
        lecture_id = str(uuid.uuid4())
        lecture_ids.append(lecture_id)
        lectures.put_item(
            Item={
                "pk": f"USER#{USER_ID}",
                "sk": f"LECTURE#{lecture_id}",
                "lectureId": lecture_id,
                "title": f"Consensus {index + 1}",
                "topic": "Distributed systems",
                "s3Key": f"audio/{USER_ID}/{lecture_id}/lecture.mp3",
                "durationMinutes": 20,
                "createdAt": created_at,
                "listenedSeconds": 1200,
                "mediaDurationSeconds": 1200,
                "playbackRate": Decimal("1.25"),
                "lastListenedAt": created_at,
                "personalizationUsed": {
                    "learningStyle": {"value": "examples", "source": "default", "confidencePercent": 0},
                    "knowledgeLevel": {"value": "intermediate", "source": "default", "confidencePercent": 0},
                },
            }
        )

    # A real playback summary updates the lecture exactly once for a sequence number.
    playback = {
        "playbackSessionId": str(uuid.uuid4()),
        "sequence": 1,
        "playedSeconds": 20,
        "positionSeconds": 20,
        "mediaDurationSeconds": 1200,
        "playbackRate": 1.25,
        "eventType": "heartbeat",
        "occurredAt": handler.learner_profile._iso_now(),
    }
    event = _api_event(
        "POST",
        "/lectures/{lectureId}/playback",
        path_params={"lectureId": lecture_ids[0]},
        body=playback,
    )
    first = handler.handler(event, None)
    duplicate = handler.handler(event, None)
    assert _json_body(first)["accepted"] is True
    assert _json_body(duplicate) == {"accepted": False, "duplicate": True}

    inferred = handler.learner_profile.derive_inferences(USER_ID)
    assert inferred["topicInterests"][0]["topic"] == "Distributed systems"
    assert inferred["preferredDuration"]["value"] == 20
    assert inferred["preferredDuration"]["sampleCount"] == 4
    assert inferred["preferredPlaybackRate"]["value"] == 1.25

    # Current request wins over explicit profile; explicit wins over inference otherwise.
    current = handler.learner_profile.resolve_personalization(
        USER_ID, "Give me a 10-minute advanced explanation with examples"
    )
    assert current["durationMinutes"]["value"] == 10
    assert current["durationMinutes"]["source"] == "current_request"
    assert current["knowledgeLevel"]["value"] == "advanced"
    assert current["learningStyle"]["value"] == "examples"
    ordinary = handler.learner_profile.resolve_personalization(USER_ID, "Teach me Raft")
    assert ordinary["durationMinutes"] == {
        "value": 20,
        "source": "explicit",
        "confidencePercent": 100,
    }
    assert ordinary["learningStyle"]["value"] == "practical"

    reset = handler.handler(_api_event("DELETE", "/profile/inferences"), None)
    assert _json_body(reset)["ok"] is True
    after_reset = handler.learner_profile.derive_inferences(USER_ID)
    assert after_reset["topicInterests"] == []
    # Reset hides behavioral preferences, but does not erase factual listening totals.
    assert after_reset["stats"]["lecturesCompleted"] == 4

    # New listening on an old lecture contributes only its post-reset delta; the old
    # cumulative completion cannot cross the reset boundary again.
    playback["sequence"] = 2
    playback["playedSeconds"] = 40
    playback["positionSeconds"] = 40
    accepted = handler.handler(
        _api_event(
            "POST",
            "/lectures/{lectureId}/playback",
            path_params={"lectureId": lecture_ids[0]},
            body=playback,
        ),
        None,
    )
    assert _json_body(accepted)["accepted"] is True
    post_reset = handler.learner_profile.derive_inferences(USER_ID)
    assert "preferredDuration" not in post_reset
    assert "learningStyle" not in post_reset
    assert post_reset["topicInterests"] == []


def test_inference_reset_preserves_legacy_explicit_profile(series_env):
    handler, _ = series_env
    profiles = boto3.resource("dynamodb", region_name="us-east-1").Table(
        os.environ["PROFILES_TABLE"]
    )
    profiles.put_item(
        Item={
            "pk": f"USER#{USER_ID}",
            "sk": "PROFILE",
            "profession": "Architect",
            "learningStyle": "theory",
            "preferredDuration": 25,
        }
    )

    response = handler.handler(_api_event("DELETE", "/profile/inferences"), None)
    assert response["statusCode"] == 200
    profile = _json_body(handler.handler(_api_event("GET", "/profile"), None))
    assert profile["explicit"]["profession"] == "Architect"
    assert profile["explicit"]["learningStyle"] == "theory"
    assert profile["explicit"]["preferredDuration"] == 25


def test_opted_out_activity_stays_excluded_after_reenable(series_env):
    handler, _ = series_env

    def save_profile(enabled: bool, revision: int):
        return handler.handler(
            _api_event(
                "PUT",
                "/profile",
                body={
                    "profession": "",
                    "expertiseAreas": [],
                    "learningGoals": [],
                    "learningStyle": "examples",
                    "preferredDuration": 15,
                    "behavioralPersonalizationEnabled": enabled,
                    "revision": revision,
                },
            ),
            None,
        )

    disabled = _json_body(save_profile(False, 0))
    assert disabled["revision"] == 1
    lectures = boto3.resource("dynamodb", region_name="us-east-1").Table(
        os.environ["LECTURES_TABLE"]
    )
    lecture_id = str(uuid.uuid4())
    now = handler.learner_profile._iso_now()
    lectures.put_item(
        Item={
            "pk": f"USER#{USER_ID}",
            "sk": f"LECTURE#{lecture_id}",
            "lectureId": lecture_id,
            "title": "Private interval",
            "topic": "A topic requested while opted out",
            "s3Key": f"audio/{USER_ID}/{lecture_id}/lecture.mp3",
            "durationMinutes": 15,
            "createdAt": now,
            "listenedSeconds": 900,
            "mediaDurationSeconds": 900,
            "playbackRate": Decimal("1.5"),
            "lastListenedAt": now,
        }
    )
    assert handler.learner_profile.derive_inferences(USER_ID)["enabled"] is False

    enabled = _json_body(save_profile(True, 1))
    assert enabled["revision"] == 2
    inferred = handler.learner_profile.derive_inferences(USER_ID)
    assert inferred["enabled"] is True
    assert inferred["topicInterests"] == []
    assert "preferredDuration" not in inferred
    assert "preferredPlaybackRate" not in inferred


def test_planner_redelivery_is_recoverable_and_fenced(series_env):
    handler, _ = series_env
    resource = boto3.resource("dynamodb", region_name="us-east-1")
    jobs = resource.Table(os.environ["JOBS_TABLE"])
    series_table = resource.Table(os.environ["SERIES_TABLE"])
    job_id = str(uuid.uuid4())
    series_id = str(uuid.uuid4())
    job = {
        "jobId": job_id,
        "userId": USER_ID,
        "seriesId": series_id,
        "status": "processing",
        "message": "Plan a series",
        "jobType": "SERIES_PLAN",
    }
    jobs.put_item(Item=job)
    series_table.put_item(
        Item={
            "pk": f"USER#{USER_ID}",
            "sk": f"SERIES#{series_id}",
            "seriesId": series_id,
            "userId": USER_ID,
            "status": "planning",
            "planJobId": job_id,
        }
    )

    first_claim = handler.series._claim_job(job)
    second_claim = handler.series._claim_job(job)
    assert first_claim and second_claim and first_claim != second_claim
    stored_job = jobs.get_item(Key={"jobId": job_id})["Item"]
    assert stored_job["claimToken"] == second_claim

    # A displaced worker cannot fail the job or series after a newer delivery claims it.
    handler.series._fail_plan(job, "old_worker_failed", claim_token=first_claim)
    assert jobs.get_item(Key={"jobId": job_id})["Item"]["status"] == "processing"
    summary = series_table.get_item(
        Key={"pk": f"USER#{USER_ID}", "sk": f"SERIES#{series_id}"}
    )["Item"]
    assert summary["status"] == "planning"
    assert summary["planClaimToken"] == second_claim
