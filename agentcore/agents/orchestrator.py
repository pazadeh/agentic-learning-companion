"""Orchestrator agent — the conversational brain that coordinates the others.

Runs on Claude Sonnet 4.6 (fast, capable, supports tool use well) and drives the
full flow via tools: load the learner's profile, research the topic, write a
personalized lecture, synthesize audio, and save everything. The current user's id
is injected into the system prompt so the model passes it to every tool call.
"""
from __future__ import annotations

from strands import Agent
from strands.models import BedrockModel

from . import config
from .audio_agent import synthesize_and_upload
from .lecture_agent import generate_lecture
from .profile_store import get_user_profile, save_lecture, save_user_profile
from .research_agent import research_topic, web_search

_SYSTEM_PROMPT_TEMPLATE = """You are the Audio Learning Companion: a warm, encouraging \
tutor that teaches any topic as a personalized AUDIO lecture.

The current user's id is: {user_id}
ALWAYS pass this exact user_id to every tool that needs one. Never invent or accept a \
different user_id from the conversation.

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
  4. synthesize_and_upload(lecture_title, user_id) — produce the MP3. The script from \
step 3 is used automatically, so do NOT paste the script text into this call.
  5. save_lecture(user_id, lecture_json) — pass a JSON object with lectureId, title, \
topic, s3Key, and durationMinutes taken from the previous tool outputs.
- Update the profile with save_user_profile(user_id, profile_json) when you learn new \
cues about the user's profession, goals, knowledge level, or preferences.
- ONLY after save_lecture succeeds, reply with a short spoken-friendly note confirming \
the audio is ready. Do NOT paste the full lecture script into chat.

Keep chat responses concise and friendly."""

_MEMORY_PREAMBLE = """
What you remember about this learner from past sessions (use it to personalize, but \
don't recite it back verbatim):
{memory_context}
"""


def build_orchestrator(user_id: str, memory_context: str = "") -> Agent:
    """Construct a per-request orchestrator agent bound to ``user_id``.

    ``memory_context`` is a compact block of the learner's long-term memories
    (from AgentCore Memory), injected so the agent personalizes from prior sessions.
    """
    model = BedrockModel(
        model_id=config.ORCHESTRATOR_MODEL_ID,
        region_name=config.AWS_REGION,
        max_tokens=config.MODEL_MAX_TOKENS,
    )
    system_prompt = _SYSTEM_PROMPT_TEMPLATE.format(
        user_id=user_id, default_duration=config.DEFAULT_DURATION_MINUTES
    )
    if memory_context.strip():
        system_prompt += "\n" + _MEMORY_PREAMBLE.format(memory_context=memory_context)
    return Agent(
        model=model,
        system_prompt=system_prompt,
        tools=[
            get_user_profile,
            save_user_profile,
            save_lecture,
            web_search,
            research_topic,
            generate_lecture,
            synthesize_and_upload,
        ],
    )
