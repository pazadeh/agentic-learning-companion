#!/usr/bin/env python3
"""End-to-end smoke test against a deployed Audio Learning Companion stack.

Exercises the real, deployed API: it confirms that unauthenticated access is
rejected, that an authenticated user can start a lecture job and poll it to
completion, that a fresh presigned audio URL can be obtained, and that a user
cannot request audio belonging to a different user.

Configuration (env vars):
  Required (one auth method):
    SMOKE_ID_TOKEN                 A valid Cognito ID token (simplest; MFA-agnostic).
                                   Grab it from the app after signing in (devtools ->
                                   Application -> Local Storage -> ...idToken).
    -- OR --
    SMOKE_EMAIL, SMOKE_PASSWORD    Cognito credentials (uses SRP via pycognito).
    SMOKE_TOTP_SECRET              (optional) Base32 TOTP secret to auto-answer MFA.

  Optional:
    OUTPUTS_FILE                   Path to CDK outputs.json (default: ../outputs.json).
    SMOKE_API_URL / SMOKE_USER_POOL_ID / SMOKE_CLIENT_ID / SMOKE_REGION
                                   Override values instead of reading outputs.json.
    SMOKE_TIMEOUT                  Seconds to wait for the job (default: 300).
    SMOKE_PROMPT                   Lecture prompt (default: a short water-cycle ask).

Exit code is 0 only if every check passes.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import struct
import sys
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


# --------------------------------------------------------------------------- #
# Config
# --------------------------------------------------------------------------- #
def load_config() -> dict:
    outputs_file = Path(os.environ.get("OUTPUTS_FILE", ROOT / "outputs.json"))
    stack = {}
    if outputs_file.exists():
        with open(outputs_file) as f:
            stack = json.load(f).get("AudioCompanionStack", {})

    cfg = {
        "api_url": os.environ.get("SMOKE_API_URL") or stack.get("ApiUrl", ""),
        "user_pool_id": os.environ.get("SMOKE_USER_POOL_ID") or stack.get("UserPoolId", ""),
        "client_id": os.environ.get("SMOKE_CLIENT_ID") or stack.get("UserPoolClientId", ""),
        "region": os.environ.get("SMOKE_REGION") or stack.get("Region", "us-east-1"),
    }
    cfg["api_url"] = cfg["api_url"].rstrip("/")
    if not cfg["api_url"]:
        fail_hard("No API URL. Provide SMOKE_API_URL or a valid outputs.json.")
    return cfg


def fail_hard(message: str) -> None:
    print(f"FATAL: {message}", file=sys.stderr)
    sys.exit(2)


# --------------------------------------------------------------------------- #
# TOTP (RFC 6238) — for auto-answering software-token MFA
# --------------------------------------------------------------------------- #
def totp_now(secret_base32: str, period: int = 30, digits: int = 6, for_time: float | None = None) -> str:
    key = base64.b32decode(secret_base32.strip().replace(" ", "").upper())
    now = time.time() if for_time is None else for_time
    counter = int(now) // period
    msg = struct.pack(">Q", counter)
    digest = hmac.new(key, msg, hashlib.sha1).digest()
    offset = digest[-1] & 0x0F
    code_int = (struct.unpack(">I", digest[offset : offset + 4])[0] & 0x7FFFFFFF) % (10 ** digits)
    return str(code_int).zfill(digits)


# --------------------------------------------------------------------------- #
# Auth
# --------------------------------------------------------------------------- #
def get_id_token(cfg: dict) -> str:
    token = os.environ.get("SMOKE_ID_TOKEN", "").strip()
    if token:
        print("auth: using SMOKE_ID_TOKEN")
        return token

    email = os.environ.get("SMOKE_EMAIL", "").strip()
    password = os.environ.get("SMOKE_PASSWORD", "")
    if not (email and password):
        fail_hard("Provide SMOKE_ID_TOKEN, or SMOKE_EMAIL + SMOKE_PASSWORD.")

    if not (cfg["user_pool_id"] and cfg["client_id"]):
        fail_hard("UserPoolId/ClientId missing; cannot authenticate with password.")

    try:
        from pycognito import Cognito
        from pycognito.exceptions import SoftwareTokenMFAChallengeException
    except ImportError:
        fail_hard("pycognito not installed. Run: pip install -r scripts/requirements-smoke.txt")

    print(f"auth: SRP sign-in as {email}")
    user = Cognito(
        cfg["user_pool_id"],
        cfg["client_id"],
        username=email,
        user_pool_region=cfg["region"],
    )
    try:
        user.authenticate(password=password)
    except SoftwareTokenMFAChallengeException:
        secret = os.environ.get("SMOKE_TOTP_SECRET", "").strip()
        if not secret:
            fail_hard("MFA required but SMOKE_TOTP_SECRET not set.")
        code = totp_now(secret)
        print("auth: answering software-token MFA challenge")
        user.respond_to_software_token_mfa_challenge(code)

    if not getattr(user, "id_token", None):
        fail_hard("Authentication did not yield an ID token.")
    return user.id_token


# --------------------------------------------------------------------------- #
# HTTP helpers
# --------------------------------------------------------------------------- #
def http(method: str, url: str, token: str | None = None, body: dict | None = None):
    data = json.dumps(body).encode("utf-8") if body is not None else None
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = token
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return resp.status, _json(resp.read())
    except urllib.error.HTTPError as e:
        return e.code, _json(e.read())
    except urllib.error.URLError as e:
        return 0, {"error": str(e)}


def _json(raw: bytes):
    if not raw:
        return {}
    try:
        return json.loads(raw.decode("utf-8"))
    except (json.JSONDecodeError, UnicodeDecodeError):
        return {"raw": raw[:200].decode("utf-8", "replace")}


# --------------------------------------------------------------------------- #
# Checks
# --------------------------------------------------------------------------- #
class Results:
    def __init__(self) -> None:
        self.passed = 0
        self.failed = 0

    def check(self, name: str, ok: bool, detail: str = "") -> bool:
        mark = "PASS" if ok else "FAIL"
        suffix = f" — {detail}" if detail else ""
        print(f"  [{mark}] {name}{suffix}")
        if ok:
            self.passed += 1
        else:
            self.failed += 1
        return ok


def run(cfg: dict, token: str) -> int:
    api = cfg["api_url"]
    r = Results()
    print(f"\nSmoke testing {api}\n")

    # 1. Unauthenticated request must be rejected by the Cognito authorizer.
    status, _ = http("GET", f"{api}/jobs/{uuid.uuid4()}/status", token=None)
    r.check("unauthenticated request rejected", status in (401, 403), f"status={status}")

    # 2. Start a lecture job.
    prompt = os.environ.get(
        "SMOKE_PROMPT", "Give me a very short one minute overview of the water cycle."
    )
    status, body = http("POST", f"{api}/jobs/start", token=token, body={"message": prompt, "action": "lecture"})
    started = r.check("start job accepted", status == 202 and "job_id" in body, f"status={status}")
    job_id = body.get("job_id")

    # 3. Poll to completion.
    result_body: dict = {}
    if started and job_id:
        timeout = int(os.environ.get("SMOKE_TIMEOUT", "300"))
        deadline = time.time() + timeout
        final_status = "pending"
        while time.time() < deadline:
            s, sb = http("GET", f"{api}/jobs/{job_id}/status", token=token)
            final_status = sb.get("status", "pending")
            if final_status in ("completed", "failed"):
                break
            time.sleep(3)
        r.check("job completed", final_status == "completed", f"final_status={final_status}")

        if final_status == "completed":
            s, result_body = http("GET", f"{api}/jobs/{job_id}/result", token=token)
            resp_text = (result_body.get("result") or {}).get("response", "")
            r.check("result has a response", bool(resp_text), f"len={len(resp_text)}")

    # 4. Fresh presigned audio URL (only if a lecture was produced).
    lecture = (result_body.get("result") or {}).get("lecture") or {}
    s3_key = lecture.get("s3Key")
    if s3_key:
        status, body = http("POST", f"{api}/audio/refresh", token=token, body={"s3_key": s3_key})
        r.check("audio presign for own key", status == 200 and "url" in body, f"status={status}")
    else:
        print("  [SKIP] audio presign — no lecture metadata returned")

    # 5. Cross-user audio access must be forbidden.
    foreign_key = f"audio/{uuid.uuid4()}/{uuid.uuid4()}/lecture.mp3"
    status, _ = http("POST", f"{api}/audio/refresh", token=token, body={"s3_key": foreign_key})
    r.check("cross-user audio access forbidden", status == 403, f"status={status}")

    print(f"\n{r.passed} passed, {r.failed} failed\n")
    return 0 if r.failed == 0 else 1


def main() -> None:
    cfg = load_config()
    token = get_id_token(cfg)
    sys.exit(run(cfg, token))


if __name__ == "__main__":
    main()
