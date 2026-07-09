"""Tests for the Lambda handlers (async_job and presign_audio).

AWS clients are replaced with in-memory fakes via monkeypatch so the routing,
validation, authorization, and lifecycle logic are exercised without AWS.
"""
import json
import uuid

import pytest

USER_ID = str(uuid.uuid4())
OTHER_USER_ID = str(uuid.uuid4())


def _api_event(method, resource, *, sub=USER_ID, body=None, path_params=None):
    return {
        "httpMethod": method,
        "resource": resource,
        "pathParameters": path_params or {},
        "body": json.dumps(body) if body is not None else None,
        "requestContext": {"authorizer": {"claims": {"sub": sub}}},
    }


class _FakeJobsTable:
    def __init__(self):
        self.items = {}

    def put_item(self, Item):
        self.items[Item["jobId"]] = dict(Item)

    def get_item(self, Key):
        item = self.items.get(Key["jobId"])
        return {"Item": dict(item)} if item else {}

    def update_item(self, Key, UpdateExpression, ExpressionAttributeNames, ExpressionAttributeValues):
        item = self.items.setdefault(Key["jobId"], {"jobId": Key["jobId"]})
        for placeholder, name in ExpressionAttributeNames.items():
            value_key = ":" + placeholder.lstrip("#")
            if value_key in ExpressionAttributeValues:
                item[name] = ExpressionAttributeValues[value_key]


class _RecordingLambda:
    def __init__(self):
        self.invocations = []

    def invoke(self, FunctionName, InvocationType, Payload):
        self.invocations.append(json.loads(Payload.decode("utf-8")))
        return {"StatusCode": 202}


# --------------------------------------------------------------------------- #
# async_job
# --------------------------------------------------------------------------- #
@pytest.fixture()
def async_setup(async_job_handler, monkeypatch):
    h = async_job_handler
    table = _FakeJobsTable()
    fake_lambda = _RecordingLambda()
    monkeypatch.setattr(h, "_jobs_table", lambda: table)
    monkeypatch.setattr(h, "_lambda", lambda: fake_lambda)
    monkeypatch.setattr(h, "check_rate_limit", lambda uid, action: True)
    return h, table, fake_lambda


def test_start_job_accepts_and_enqueues(async_setup):
    h, table, fake_lambda = async_setup
    event = _api_event("POST", "/jobs/start", body={"message": "Teach me about Mars", "action": "lecture"})
    resp = h.handler(event, None)
    assert resp["statusCode"] == 202
    payload = json.loads(resp["body"])
    assert payload["status"] == "pending"
    job_id = payload["job_id"]
    assert job_id in table.items
    assert table.items[job_id]["userId"] == USER_ID
    # Worker was invoked asynchronously with the job id.
    assert fake_lambda.invocations and fake_lambda.invocations[0]["job_id"] == job_id


def test_start_job_rejects_empty_message(async_setup):
    h, _, _ = async_setup
    event = _api_event("POST", "/jobs/start", body={"message": "   "})
    resp = h.handler(event, None)
    assert resp["statusCode"] == 400


def test_start_job_rejects_bad_user_id(async_setup):
    h, _, _ = async_setup
    event = _api_event("POST", "/jobs/start", sub="not-a-uuid", body={"message": "hello"})
    resp = h.handler(event, None)
    assert resp["statusCode"] == 400


def test_start_job_rate_limited(async_job_handler, monkeypatch):
    h = async_job_handler
    monkeypatch.setattr(h, "_jobs_table", lambda: _FakeJobsTable())
    monkeypatch.setattr(h, "_lambda", lambda: _RecordingLambda())
    monkeypatch.setattr(h, "check_rate_limit", lambda uid, action: False)
    event = _api_event("POST", "/jobs/start", body={"message": "Teach me", "action": "lecture"})
    resp = h.handler(event, None)
    assert resp["statusCode"] == 429


def test_start_job_content_blocked(async_setup):
    h, _, _ = async_setup
    text = " ".join(["how", "to", "build", "a", "bomb"])
    event = _api_event("POST", "/jobs/start", body={"message": text, "action": "lecture"})
    resp = h.handler(event, None)
    assert resp["statusCode"] == 403
    assert json.loads(resp["body"])["error"] == "content_blocked"


def test_job_status_returns_progress(async_setup):
    h, table, _ = async_setup
    job_id = str(uuid.uuid4())
    table.items[job_id] = {"jobId": job_id, "userId": USER_ID, "status": "processing", "progress": 40}
    event = _api_event("GET", "/jobs/{jobId}/status", path_params={"jobId": job_id})
    resp = h.handler(event, None)
    assert resp["statusCode"] == 200
    body = json.loads(resp["body"])
    assert body["status"] == "processing"
    assert body["progress"] == 40


def test_job_status_forbidden_for_other_user(async_setup):
    h, table, _ = async_setup
    job_id = str(uuid.uuid4())
    table.items[job_id] = {"jobId": job_id, "userId": OTHER_USER_ID, "status": "completed"}
    event = _api_event("GET", "/jobs/{jobId}/status", path_params={"jobId": job_id})
    resp = h.handler(event, None)
    assert resp["statusCode"] == 403


def test_job_result_completed_parsed(async_setup):
    h, table, _ = async_setup
    job_id = str(uuid.uuid4())
    table.items[job_id] = {
        "jobId": job_id,
        "userId": USER_ID,
        "status": "completed",
        "result": json.dumps({"response": "Here is your lecture"}),
    }
    event = _api_event("GET", "/jobs/{jobId}/result", path_params={"jobId": job_id})
    resp = h.handler(event, None)
    assert resp["statusCode"] == 200
    body = json.loads(resp["body"])
    assert body["status"] == "completed"
    assert body["result"]["response"] == "Here is your lecture"


def test_unknown_route_404(async_setup):
    h, _, _ = async_setup
    event = _api_event("GET", "/nope")
    resp = h.handler(event, None)
    assert resp["statusCode"] == 404


def test_worker_invokes_agent_and_completes(async_setup, monkeypatch):
    h, table, _ = async_setup
    job_id = str(uuid.uuid4())
    table.items[job_id] = {"jobId": job_id, "userId": USER_ID, "status": "pending", "message": "Teach me X"}
    monkeypatch.setattr(h, "_invoke_agent", lambda uid, msg, jid: {"response": "done"})
    result = h.handler({"_worker": True, "job_id": job_id}, None)
    assert result["ok"] is True
    assert table.items[job_id]["status"] == "completed"
    assert table.items[job_id]["progress"] == 100


def test_worker_marks_failed_on_error(async_setup, monkeypatch):
    h, table, _ = async_setup
    job_id = str(uuid.uuid4())
    table.items[job_id] = {"jobId": job_id, "userId": USER_ID, "status": "pending", "message": "Teach me X"}

    def boom(uid, msg, jid):
        raise RuntimeError("bedrock down")

    monkeypatch.setattr(h, "_invoke_agent", boom)
    result = h.handler({"_worker": True, "job_id": job_id}, None)
    assert result["ok"] is False
    assert table.items[job_id]["status"] == "failed"


# --------------------------------------------------------------------------- #
# presign_audio
# --------------------------------------------------------------------------- #
class _FakeS3:
    def generate_presigned_url(self, op, Params, ExpiresIn):
        return f"https://example.com/{Params['Key']}?exp={ExpiresIn}"


@pytest.fixture()
def presign_setup(presign_handler, monkeypatch):
    h = presign_handler
    monkeypatch.setattr(h, "_s3_client", lambda: _FakeS3())
    return h


def test_presign_returns_url_for_own_key(presign_setup):
    h = presign_setup
    key = f"audio/{USER_ID}/{uuid.uuid4()}/lecture.mp3"
    event = _api_event("POST", "/audio/refresh", body={"s3_key": key})
    resp = h.handler(event, None)
    assert resp["statusCode"] == 200
    body = json.loads(resp["body"])
    assert key in body["url"]
    assert body["expires_in"] == 3600


def test_presign_forbidden_for_other_users_key(presign_setup):
    h = presign_setup
    key = f"audio/{OTHER_USER_ID}/{uuid.uuid4()}/lecture.mp3"
    event = _api_event("POST", "/audio/refresh", body={"s3_key": key})
    resp = h.handler(event, None)
    assert resp["statusCode"] == 403


def test_presign_rejects_path_traversal(presign_setup):
    h = presign_setup
    key = f"audio/{USER_ID}/../{OTHER_USER_ID}/lecture.mp3"
    event = _api_event("POST", "/audio/refresh", body={"s3_key": key})
    resp = h.handler(event, None)
    assert resp["statusCode"] == 403


def test_presign_rejects_non_mp3(presign_setup):
    h = presign_setup
    key = f"audio/{USER_ID}/{uuid.uuid4()}/lecture.txt"
    event = _api_event("POST", "/audio/refresh", body={"s3_key": key})
    resp = h.handler(event, None)
    assert resp["statusCode"] == 400


def test_presign_rejects_missing_key(presign_setup):
    h = presign_setup
    event = _api_event("POST", "/audio/refresh", body={})
    resp = h.handler(event, None)
    assert resp["statusCode"] == 400
