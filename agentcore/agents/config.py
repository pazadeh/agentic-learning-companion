"""Shared configuration and lazily-created AWS clients for the agents."""
from __future__ import annotations

import functools
import os

import boto3
from botocore.config import Config

# Model IDs (overridable via env for region/version flexibility).
#
# Current Anthropic models require a cross-region inference profile on Bedrock. We
# default to US profiles (prefix "us."), keeping routing within US regions for this
# us-east-1 deployment. Use the "global." prefix where global routing is acceptable.
#
# Role-specific defaults are backed by the 2026 Isengard evaluation under
# experiments/lecture_model_eval/results_2026:
#   * Sonnet 5.5 low/between-tools passed every orchestration case and reduced cost.
#   * Haiku 5.5 low passed every planner constraint at ~97% lower measured cost.
#   * Calibrated Sonnet 5.5 improved judged lecture quality and reduced mean duration
#     error to ~8% while remaining faster and cheaper than the Sonnet 4.6 baseline.
ORCHESTRATOR_MODEL_ID = os.environ.get(
    "ORCHESTRATOR_MODEL_ID", "us.anthropic.claude-sonnet-5-5"
)
PLANNER_MODEL_ID = os.environ.get(
    "PLANNER_MODEL_ID", "us.anthropic.claude-haiku-5-5"
)
LECTURE_MODEL_ID = os.environ.get(
    "LECTURE_MODEL_ID", "us.anthropic.claude-sonnet-5-5"
)


def model_request_fields(model_id: str) -> dict:
    """Return the evaluated low-cost reasoning configuration for a model family."""
    if "claude-sonnet-5-5" in model_id:
        return {
            "thinking": {"type": "between_tools"},
            "output_config": {"effort": "low"},
        }
    if "claude-haiku-5-5" in model_id:
        return {
            "thinking": {"type": "disabled"},
            "output_config": {"effort": "low"},
        }
    if "claude-opus-5-5" in model_id:
        return {
            "thinking": {"type": "adaptive"},
            "output_config": {"effort": "low"},
        }
    return {}

AWS_REGION = os.environ.get("AWS_REGION", "us-east-1")

# Resource names / config from the environment (set on the AgentCore runtime).
PROFILES_TABLE = os.environ.get("PROFILES_TABLE", "")
LECTURES_TABLE = os.environ.get("LECTURES_TABLE", "")
JOBS_TABLE = os.environ.get("JOBS_TABLE", "")
AUDIO_BUCKET = os.environ.get("AUDIO_BUCKET", "")
TAVILY_SECRET_NAME = os.environ.get("TAVILY_SECRET_NAME", "audio-companion/tavily-api-key")

# AgentCore Memory resource id (empty disables memory; the agent then runs without
# long-term recall and just uses the DynamoDB profile).
MEMORY_ID = os.environ.get("MEMORY_ID", "")

# Words spoken per minute — used to translate target duration into a word count.
WORDS_PER_MINUTE = 150
DEFAULT_DURATION_MINUTES = 15
# Sonnet 5.5 naturally writes ~25% beyond its requested word target. The controlled
# 0.8 calibration reduced measured absolute duration error from 27% to 8% without a
# material quality loss. Override to 1.0 when evaluating other writer families.
LECTURE_TARGET_FACTOR = float(os.environ.get("LECTURE_TARGET_FACTOR", "0.8"))

# Max output tokens per model call. Set to 16384 based on the lecture-model
# experiment (experiments/lecture_model_eval): even 25-minute lectures complete in a
# single pass, and 16384 is free headroom at observed output sizes (~5-12k tokens)
# while preventing the rare mid-sentence truncation seen with verbose models at 8192.
# NOTE: values far above this do nothing — the finished script is hard-capped to
# MAX_SCRIPT_CHARS - 2000 before synthesis.
MODEL_MAX_TOKENS = int(os.environ.get("MODEL_MAX_TOKENS", "16384"))

# Provider-neutral narration cap and provider selection. Nova Sonic is the evaluated
# production default; Polly remains available as an explicit rollback provider.
MAX_SCRIPT_CHARS = int(os.environ.get("MAX_SCRIPT_CHARS", "60000"))
NARRATION_PROVIDER = os.environ.get("NARRATION_PROVIDER", "nova-sonic").strip().lower()

# Amazon Polly neural limits (rollback provider).
POLLY_CHUNK_CHARS = 3000
POLLY_MAX_TOTAL_CHARS = 60000

# Amazon Nova 2.5 Sonic bidirectional narration settings. At 150 WPM, 900 words is
# about six minutes and leaves two minutes of safety below the eight-minute session cap.
NOVA_MODEL_ID = os.environ.get("NOVA_MODEL_ID", "amazon.nova-2-5-sonic")
NOVA_VOICE_ID = os.environ.get("NOVA_VOICE_ID", "tiffany")
NOVA_SESSION_MAX_WORDS = int(os.environ.get("NOVA_SESSION_MAX_WORDS", "900"))
NOVA_SESSION_TIMEOUT_SECONDS = int(
    os.environ.get("NOVA_SESSION_TIMEOUT_SECONDS", "180")
)
NOVA_TOTAL_TIMEOUT_SECONDS = int(
    os.environ.get("NOVA_TOTAL_TIMEOUT_SECONDS", "660")
)
NOVA_SESSION_MAX_ATTEMPTS = int(os.environ.get("NOVA_SESSION_MAX_ATTEMPTS", "2"))
NOVA_MAX_OUTPUT_TOKENS = int(os.environ.get("NOVA_MAX_OUTPUT_TOKENS", "32768"))
NOVA_OUTPUT_SAMPLE_RATE = 24000

# Research limits.
# Max distinct search queries ("angles") per lecture. Raised from 5 -> 8 for broader,
# deeper grounding; each query still returns up to TAVILY_RESULTS_PER_QUERY hits.
MAX_SEARCHES_PER_LECTURE = int(os.environ.get("MAX_SEARCHES_PER_LECTURE", "8"))
# Results requested per individual search query.
TAVILY_RESULTS_PER_QUERY = int(os.environ.get("TAVILY_RESULTS_PER_QUERY", "5"))
# After authority+relevance ranking, keep at most this many sources so the highest-
# quality material fills the lecture prompt window (lecture_agent uses research[:8000]).
RESEARCH_MAX_SOURCES = int(os.environ.get("RESEARCH_MAX_SOURCES", "12"))
# Weight on domain authority vs search relevance when ranking sources (0..1).
RESEARCH_AUTHORITY_WEIGHT = float(os.environ.get("RESEARCH_AUTHORITY_WEIGHT", "0.6"))
# Trusted-sources-only mode: when enabled, lectures are grounded only in high-authority
# sources (academic / reference / encyclopedic tiers — incl. .edu/.gov), dropping
# general blogs and forums. Falls back to the full ranked set if filtering leaves
# nothing, so a lecture is never blocked for lack of sources.
RESEARCH_TRUSTED_ONLY = os.environ.get("RESEARCH_TRUSTED_ONLY", "false").strip().lower() in (
    "1", "true", "yes", "on",
)


@functools.lru_cache(maxsize=1)
def dynamodb_resource():
    return boto3.resource("dynamodb", region_name=AWS_REGION)


@functools.lru_cache(maxsize=1)
def progress_dynamodb_resource():
    """DynamoDB resource with telemetry-safe, non-retrying network bounds."""
    return boto3.resource(
        "dynamodb",
        region_name=AWS_REGION,
        config=Config(
            connect_timeout=1,
            read_timeout=1,
            retries={"total_max_attempts": 1, "mode": "standard"},
        ),
    )


@functools.lru_cache(maxsize=1)
def polly_client():
    return boto3.client("polly", region_name=AWS_REGION)


@functools.lru_cache(maxsize=1)
def s3_client():
    return boto3.client("s3", region_name=AWS_REGION)


@functools.lru_cache(maxsize=1)
def secrets_client():
    return boto3.client("secretsmanager", region_name=AWS_REGION)


@functools.lru_cache(maxsize=1)
def agentcore_memory_client():
    """Data-plane client for AgentCore Memory (events + record retrieval)."""
    return boto3.client("bedrock-agentcore", region_name=AWS_REGION)
