"""Shared configuration and lazily-created AWS clients for the agents."""
from __future__ import annotations

import functools
import os

import boto3

# Model IDs (overridable via env for region/version flexibility).
#
# The Claude 4.6 family requires a cross-region inference profile on Bedrock — you
# cannot invoke the bare model ID on-demand. We default to the US inference profile
# (prefix "us."), which keeps routing within US regions for this us-east-1 deploy.
# Use the "global." prefix instead of "us." for global cross-region inference.
#
# Model choice is backed by the lecture-model experiment
# (experiments/lecture_model_eval): Sonnet 4.6, Sonnet 5, and Opus 4.8 scored
# essentially tied on teaching quality (blind judge 4.9-5.0), so Sonnet 4.6 wins on
# the tiebreakers — tightest adherence to the requested spoken duration and lowest
# cost. Opus 4.8 ("us.anthropic.claude-opus-4-8") is an optional, pricier upgrade
# with no measured quality edge. Sonnet 5 is NOT recommended here: it overshot the
# target length by ~50-60% (a 25-min request produced ~40 min of audio).
ORCHESTRATOR_MODEL_ID = os.environ.get(
    "ORCHESTRATOR_MODEL_ID", "us.anthropic.claude-sonnet-4-6"
)
LECTURE_MODEL_ID = os.environ.get(
    "LECTURE_MODEL_ID", "us.anthropic.claude-sonnet-4-6"
)

AWS_REGION = os.environ.get("AWS_REGION", "us-east-1")

# Resource names / config from the environment (set on the AgentCore runtime).
PROFILES_TABLE = os.environ.get("PROFILES_TABLE", "")
LECTURES_TABLE = os.environ.get("LECTURES_TABLE", "")
AUDIO_BUCKET = os.environ.get("AUDIO_BUCKET", "")
TAVILY_SECRET_NAME = os.environ.get("TAVILY_SECRET_NAME", "audio-companion/tavily-api-key")

# AgentCore Memory resource id (empty disables memory; the agent then runs without
# long-term recall and just uses the DynamoDB profile).
MEMORY_ID = os.environ.get("MEMORY_ID", "")

# Words spoken per minute — used to translate target duration into a word count.
WORDS_PER_MINUTE = 150
DEFAULT_DURATION_MINUTES = 15

# Max output tokens per model call. Set to 16384 based on the lecture-model
# experiment (experiments/lecture_model_eval): even 25-minute lectures complete in a
# single pass, and 16384 is free headroom at observed output sizes (~5-12k tokens)
# while preventing the rare mid-sentence truncation seen with verbose models at 8192.
# NOTE: values far above this do nothing — the finished script is hard-capped to
# POLLY_MAX_TOTAL_CHARS - 2000 (58,000 chars, ~13k tokens) before synthesis, so a
# setting like 128k has no effect on lecture length.
MODEL_MAX_TOKENS = int(os.environ.get("MODEL_MAX_TOKENS", "16384"))

# Amazon Polly neural limits.
POLLY_CHUNK_CHARS = 3000
POLLY_MAX_TOTAL_CHARS = 60000

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
