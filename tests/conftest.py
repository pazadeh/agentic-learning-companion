"""Shared pytest fixtures.

Puts the shared ``security`` package (under ``agentcore/``) on ``sys.path`` and loads
the Lambda handler modules from their files with unique names (both files are named
``handler.py``, so they must be imported under distinct module names to coexist).
"""
from __future__ import annotations

import importlib.util
import os
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]

# Make `import security.*` work (the package lives under agentcore/).
sys.path.insert(0, str(ROOT / "agentcore"))
# The async-job handler imports its sibling `series` module, as in the Lambda package.
sys.path.insert(0, str(ROOT / "lambdas" / "async_job"))

# Environment expected by the handlers/modules (values are placeholders; the AWS
# clients themselves are monkeypatched in the tests).
os.environ.setdefault("JOBS_TABLE", "JobsTableTest")
os.environ.setdefault("PROFILES_TABLE", "ProfilesTableTest")
os.environ.setdefault("LECTURES_TABLE", "LecturesTableTest")
os.environ.setdefault("SERIES_TABLE", "SeriesTableTest")
os.environ.setdefault("RATE_LIMITS_TABLE", "RateLimitsTableTest")
os.environ.setdefault("AUDIO_BUCKET", "audio-bucket-test")
os.environ.setdefault("AWS_LAMBDA_FUNCTION_NAME", "async-job-test")
os.environ.setdefault("AGENT_RUNTIME_ARN", "arn:aws:bedrock-agentcore:us-east-1:111122223333:runtime/test")
os.environ.setdefault("AWS_DEFAULT_REGION", "us-east-1")


def _load_module(name: str, relative_path: str):
    spec = importlib.util.spec_from_file_location(name, ROOT / relative_path)
    assert spec and spec.loader, f"cannot load {relative_path}"
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


@pytest.fixture()
def async_job_handler():
    return _load_module("async_job_handler", "lambdas/async_job/handler.py")


@pytest.fixture()
def presign_handler():
    return _load_module("presign_audio_handler", "lambdas/presign_audio/handler.py")
