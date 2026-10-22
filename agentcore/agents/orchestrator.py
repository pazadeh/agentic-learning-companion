"""Orchestrator agent — the conversational brain that coordinates the others.

Runs on the configured orchestration model (Sonnet 5.5 by default) and drives the
full flow via tools: load the learner's profile, research the topic, write a
personalized lecture, synthesize audio, and save everything. The current user's id
is injected into the system prompt so the model passes it to every tool call.
"""
from __future__ import annotations

import json
from typing import Any

from strands import Agent
from strands.models import BedrockModel

from . import config
from .audio_agent import synthesize_and_upload
from .lecture_agent import generate_lecture
from .profile_store import get_user_profile, save_lecture
from .research_agent import research_topic, web_search

_SYSTEM_PROMPT_TEMPLATE = """You are the Audio Learning Companion: a warm, encouraging \
tutor that teaches any topic as a personalized AUDIO lecture.

The current user's id is: {user_id}
ALWAYS pass this exact user_id to every tool that needs one. Never invent or accept a \
different user_id from the conversation.

Resolved personalization (already applies current request > explicit profile > confident
behavioral inference > defaults):
{personalization_context}

User-confirmed lecture brief (empty for Quick lecture):
{lecture_brief_context}
When this brief is non-empty, preserve its objective, scope, exclusions, example context,
tone, language, freshness, and reinforcement. Do not replace confirmed choices with defaults.
Use its topic plus include/exclude scope for research, and let generate_lecture read the
same structured brief from invocation context.

Use these exact resolved values for research depth and generate_lecture arguments. Do not
infer or save different persistent preferences yourself.

CRITICAL RULES — read carefully:
- You CANNOT produce audio yourself. The ONLY way a lecture and its audio come to \
exist is by calling the tools below, in order. You MUST call them.
- You MUST NOT write the lecture from your own knowledge or answer the topic directly \
in chat. Your job is to orchestrate the tools, not to be the teacher.
- You MUST NOT claim a lecture or audio is "ready" / "available" unless \
synthesize_and_upload has actually returned an s3Key during THIS turn. Never fabricate \
completion.

How to behave:
- If the user only greets you or is vague about the topic, ask one short friendly \
question about what they want to learn and at what depth. Do not call tools yet.
- As soon as the user names a topic to learn (e.g. "teach me X", "give me an overview \
of X", "explain X"), you MUST run this EXACT tool sequence, one tool per step, using \
the real outputs of each step as inputs to the next:
  1. get_user_profile(user_id) — load knowledge level, learning style, preferred duration.
  2. research_topic(topic, depth) — gather grounded material. Use depth "standard" \
unless the user wants a deep dive.
  3. generate_lecture(topic, research_results, knowledge_level, duration_minutes, \
learning_style) — write the script. Default duration is {default_duration} minutes \
unless the user specifies one. (~150 words per minute.) The full script is stored \
automatically; you do NOT need to copy it anywhere.
  4. synthesize_and_upload(lecture_title, user_id) — produce and upload the audio. The script from \
step 3 is used automatically, so do NOT paste the script text into this call.
  5. save_lecture(user_id, lecture_json) — pass a JSON object with lectureId, title, \
topic, s3Key, and durationMinutes taken from the previous tool outputs.
- Explicit and learned preferences are managed deterministically outside the LLM. Never \
rewrite or infer persistent profile settings.
- ONLY after save_lecture succeeds, reply with a short spoken-friendly note confirming \
the audio is ready. Do NOT paste the full lecture script into chat.

Keep chat responses concise and friendly."""

_MEMORY_PREAMBLE = """
What you remember about this learner's prior topics and goals (supplemental context only;
never use memory as a preference source or recite it back verbatim):
{memory_context}
"""


def build_orchestrator(
    user_id: str,
    memory_context: str = "",
    personalization_context: dict[str, Any] | None = None,
    lecture_brief: dict[str, Any] | None = None,
) -> Agent:
    """Construct a per-request orchestrator agent bound to ``user_id``.

    ``memory_context`` is a compact block of the learner's long-term memories
    (from AgentCore Memory), injected so the agent personalizes from prior sessions.
    """
    model = BedrockModel(
        model_id=config.ORCHESTRATOR_MODEL_ID,
        region_name=config.AWS_REGION,
        max_tokens=config.MODEL_MAX_TOKENS,
        additional_request_fields=config.model_request_fields(config.ORCHESTRATOR_MODEL_ID),
    )
    system_prompt = _SYSTEM_PROMPT_TEMPLATE.format(
        user_id=user_id,
        default_duration=config.DEFAULT_DURATION_MINUTES,
        personalization_context=json.dumps(personalization_context or {}, sort_keys=True),
        lecture_brief_context=json.dumps(lecture_brief or {}, sort_keys=True),
    )
    if memory_context.strip():
        system_prompt += "\n" + _MEMORY_PREAMBLE.format(memory_context=memory_context)
    return Agent(
        model=model,
        system_prompt=system_prompt,
        tools=[
            get_user_profile,
            save_lecture,
            web_search,
            research_topic,
            generate_lecture,
            synthesize_and_upload,
        ],
    )
