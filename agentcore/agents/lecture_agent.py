"""Lecture agent — turns research into a personalized, spoken-word lecture script.

Uses a sub-agent (high-quality prose) to write the actual script, tailored to the
learner's knowledge level, target duration, and preferred learning style. The
orchestrator calls this as a tool.

Two things make this reliable for *long* lectures:

1. The script is written iteratively. Language models routinely under-deliver on a
   single-shot word target, so we keep asking the writer to continue the same
   lecture until it reaches (close to) the requested length, then close it out.
2. The finished script is stored in ``run_context`` rather than only returned to the
   orchestrator. The synthesis tool reads it from there, so the full script never has
   to be re-emitted by the orchestrator LLM as a tool argument (which truncates it).
"""
from __future__ import annotations

import json
import logging

from strands import Agent, tool
from strands.models import BedrockModel

from . import config, progress, run_context

logger = logging.getLogger("audio_companion.agents.lecture")

_LECTURE_SYSTEM_PROMPT = """You are an expert educator who writes engaging lectures \
meant to be LISTENED TO, not read. Write in clear spoken prose: no markdown, no \
bullet points, no headings, no code blocks, no URLs read aloud, and never any meta \
commentary about writing the lecture. Use natural transitions, concrete examples, and \
a warm conversational tone. This lecture may be written in several parts; only give a \
closing recap when you are explicitly asked to conclude. Above all, produce the full \
requested length — do not stop early or wrap up prematurely."""

# Stop growing the script near the provider-neutral synthesis cap (leave headroom).
_MAX_SCRIPT_CHARS = config.MAX_SCRIPT_CHARS - 2000
# Bound on how many "continue" passes we make, to cap latency and cost.
_MAX_CONTINUATIONS = 6


def _word_target(duration_minutes: int) -> int:
    return max(
        1,
        round(int(duration_minutes) * config.WORDS_PER_MINUTE * config.LECTURE_TARGET_FACTOR),
    )


def _extract_text(result) -> str:
    """Extract clean assistant text from a Strands AgentResult.

    ``result.message`` is a dict like {"role": "assistant", "content": [{"text": ...}]};
    ``str(result.message)`` would yield a Python dict repr, so join the text blocks.
    """
    message = getattr(result, "message", None)
    if isinstance(message, dict):
        blocks = message.get("content", [])
        texts = [
            b["text"]
            for b in blocks
            if isinstance(b, dict) and isinstance(b.get("text"), str)
        ]
        if texts:
            return "\n".join(t.strip() for t in texts if t.strip()).strip()
    return str(result).strip()


def _truncate_to_sentence(text: str, max_chars: int) -> str:
    """Trim ``text`` to <= max_chars, preferring the last sentence boundary."""
    if len(text) <= max_chars:
        return text
    clipped = text[:max_chars]
    for sep in (". ", "! ", "? ", "\n"):
        idx = clipped.rfind(sep)
        if idx > max_chars * 0.6:
            return clipped[: idx + 1].strip()
    return clipped.strip()


def _write_script(
    writer: Agent, first_prompt: str, word_target: int, reinforcement: str = "recap"
) -> str:
    """Write the lecture in parts until it approaches ``word_target`` words.

    The writer Agent keeps conversation history across calls, so each continuation
    naturally follows on from the previous text.
    """
    script = _extract_text(writer(first_prompt))
    progress.report(
        "writing",
        min(63, 48 + round(len(script.split()) / max(word_target, 1) * 15)),
        "Writing your lecture",
        f"Drafted {len(script.split())} of about {word_target} words",
    )
    # Consider "close enough" at 90% of target so we don't over-generate.
    threshold = int(word_target * 0.9)

    for _ in range(_MAX_CONTINUATIONS):
        if len(script.split()) >= threshold or len(script) >= _MAX_SCRIPT_CHARS:
            break
        remaining = max(150, word_target - len(script.split()))
        cont_prompt = (
            "Continue the SAME lecture seamlessly from exactly where it left off. "
            "Do not repeat, recap, or summarize anything already covered, and do not "
            "add any meta commentary. Keep the same spoken, flowing style and move on "
            f"to the next part of the material. Write about {remaining} more words. "
            "Do not conclude the lecture yet."
        )
        addition = _extract_text(writer(cont_prompt))
        if len(addition.split()) < 20:  # writer had nothing meaningful to add
            break
        script = f"{script}\n\n{addition}".strip()
        progress.report(
            "writing",
            min(67, 48 + round(len(script.split()) / max(word_target, 1) * 19)),
            "Expanding your lecture",
            f"Drafted {len(script.split())} of about {word_target} words",
        )

    # Apply the confirmed reinforcement contract rather than always forcing a recap.
    if len(script) < _MAX_SCRIPT_CHARS and reinforcement != "none":
        closing_instruction = {
            "reflection": (
                "End with two concise spoken reflection questions. Do not answer them "
                "or introduce new topics."
            ),
            "memory-hooks": (
                "End with a short set of memorable verbal hooks or analogies that help "
                "the learner retain the core ideas. Do not introduce new topics."
            ),
            "recap": (
                "Write a short, warm spoken closing that recaps the key takeaways in a "
                "few sentences. Do not introduce new topics."
            ),
        }.get(reinforcement, "Write a short spoken recap without new topics.")
        closing = _extract_text(writer(closing_instruction))
        if 0 < len(closing.split()) < 400:
            script = f"{script}\n\n{closing}".strip()
            progress.report(
                "writing",
                68,
                "Adding the closing summary",
                f"Lecture contains {len(script.split())} words",
            )

    return _truncate_to_sentence(script, _MAX_SCRIPT_CHARS)


@tool
def generate_lecture(
    topic: str,
    research_results: str,
    knowledge_level: str = "intermediate",
    duration_minutes: int = config.DEFAULT_DURATION_MINUTES,
    learning_style: str = "examples",
) -> str:
    """Write a personalized lecture script from research material.

    The full script is stored internally and synthesized directly by
    ``synthesize_and_upload`` — you do NOT need to pass the script text yourself.

    Args:
        topic: The lecture subject.
        research_results: JSON or text from the research step to ground the lecture.
        knowledge_level: "beginner", "intermediate", or "advanced".
        duration_minutes: Target spoken length; ~150 words per minute.
        learning_style: "examples", "theory", or "practical".

    Returns:
        A JSON string: {title, word_count, target_word_count, duration_minutes}.
    """
    brief = run_context.get_lecture_brief()
    word_target = _word_target(duration_minutes)

    confirmed_style = brief.get("learningStyle", learning_style)
    style_hint = {
        "examples": "Lead with concrete, relatable examples before generalizing.",
        "theory": "Emphasize underlying principles and the why behind each idea.",
        "practical": "Focus on practical application and actionable takeaways.",
        "story": "Use a coherent narrative arc and vivid examples while preserving rigor.",
        "step-by-step": "Teach as a clear sequence of steps, decisions, and examples.",
    }.get(confirmed_style, "Lead with concrete, relatable examples.")

    contract_lines = []
    if brief:
        contract_lines = [
            f"Confirmed learning objective: {brief['learningObjective']}",
            f"Confirmed tone: {brief['tone']}",
            f"Language: {brief['language']}",
            f"Must include: {', '.join(brief['includeTopics']) or 'the essential scope'}",
            f"Must exclude: {', '.join(brief['excludeTopics']) or 'nothing additional'}",
            f"Example context: {brief['exampleContext'] or 'choose an appropriate example'}",
            f"Reinforcement: {brief['reinforcement']}",
            f"Source freshness: {brief['sourceFreshness']}",
        ]
    contract = "\n".join(contract_lines)

    first_prompt = (
        f"Write a spoken-word lecture on: {topic}\n\n"
        f"Learner knowledge level: {knowledge_level}\n"
        f"Preferred learning style: {confirmed_style}. {style_hint}\n"
        f"Target length: about {word_target} words "
        f"(~{duration_minutes} minutes at 150 words per minute). This is a LONG "
        "lecture; pace yourself, cover the material in depth, and do not rush to a "
        "conclusion.\n\n"
        + (f"User-confirmed lecture contract:\n{contract}\n\n" if contract else "")
        + "Ground the lecture in this research (do not read URLs aloud):\n"
        f"{research_results[:8000]}\n\n"
        "Begin the lecture now. Return ONLY spoken lecture prose — no preamble, no "
        "markdown, no headings."
    )

    progress.report(
        "writing",
        45,
        "Writing your personalized lecture",
        f"Targeting about {word_target} spoken words",
    )
    model = BedrockModel(
        model_id=config.LECTURE_MODEL_ID,
        region_name=config.AWS_REGION,
        max_tokens=config.MODEL_MAX_TOKENS,
        additional_request_fields=config.model_request_fields(config.LECTURE_MODEL_ID),
    )
    writer = Agent(model=model, system_prompt=_LECTURE_SYSTEM_PROMPT)
    script = _write_script(
        writer,
        first_prompt,
        word_target,
        reinforcement=brief.get("reinforcement", "recap"),
    )

    # Hand the full script to the synthesis step directly (not via the orchestrator).
    run_context.set_script(script)
    progress.report(
        "writing",
        69,
        "Lecture script complete",
        f"{len(script.split())} words ready for audio",
    )

    title = (brief.get("title") or topic).strip()
    word_count = len(script.split())

    return json.dumps(
        {
            "title": title,
            "word_count": word_count,
            "target_word_count": word_target,
            "duration_minutes": duration_minutes,
            "note": "Script stored; call synthesize_and_upload(lecture_title, user_id).",
        }
    )
