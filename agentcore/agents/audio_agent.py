"""Audio agent — synthesizes a lecture script to MP3 with Amazon Polly and uploads it.

Polly's neural engine accepts up to ~3000 characters per request, so long scripts
are split on sentence boundaries, synthesized chunk by chunk, and the resulting MP3
byte streams are concatenated (MP3 frames are independently decodable, so simple
concatenation produces a valid, gapless file for speech).
"""
from __future__ import annotations

import json
import logging
import re
import uuid

from strands import tool

from . import config, run_context

logger = logging.getLogger("audio_companion.agents.audio")

_SENTENCE_RE = re.compile(r"(?<=[.!?])\s+")


def _chunk_text(text: str, max_chars: int = config.POLLY_CHUNK_CHARS) -> list[str]:
    """Split text into chunks <= max_chars, preferring sentence boundaries."""
    text = text.strip()
    if not text:
        return []

    chunks: list[str] = []
    current = ""
    for sentence in _SENTENCE_RE.split(text):
        if not sentence:
            continue
        if len(current) + len(sentence) + 1 <= max_chars:
            current = f"{current} {sentence}".strip()
            continue
        if current:
            chunks.append(current)
        # A single sentence longer than the limit is hard-split.
        while len(sentence) > max_chars:
            chunks.append(sentence[:max_chars])
            sentence = sentence[max_chars:]
        current = sentence
    if current:
        chunks.append(current)
    return chunks


@tool
def synthesize_and_upload(lecture_title: str, user_id: str, text: str = "") -> str:
    """Synthesize the lecture script to MP3 and upload it to S3.

    The full script written by ``generate_lecture`` is used automatically (it is read
    from the per-invocation context), so you normally do NOT need to pass ``text``.
    ``text`` is only a fallback for direct/testing use.

    Args:
        lecture_title: Human-readable title (for logging/metadata).
        user_id: The owning user's id; audio is stored under their prefix only.
        text: Optional explicit script; ignored when a generated script is available.

    Returns:
        A JSON string: {lecture_id, s3_key, duration_seconds, char_count}.
    """
    # Prefer the full script captured by generate_lecture. Falling back to the passed
    # ``text`` would risk synthesizing a truncated copy the orchestrator re-typed.
    script = run_context.get_script() or (text or "")
    if not script or not script.strip():
        raise ValueError("Cannot synthesize empty text")
    if len(script) > config.POLLY_MAX_TOTAL_CHARS:
        raise ValueError(
            f"Script exceeds {config.POLLY_MAX_TOTAL_CHARS} character synthesis cap"
        )

    chunks = _chunk_text(script)
    polly = config.polly_client()

    audio_bytes = bytearray()
    for chunk in chunks:
        response = polly.synthesize_speech(
            Text=chunk,
            Engine="neural",
            VoiceId="Joanna",
            OutputFormat="mp3",
        )
        stream = response.get("AudioStream")
        if stream is not None:
            audio_bytes.extend(stream.read())

    lecture_id = str(uuid.uuid4())
    s3_key = f"audio/{user_id}/{lecture_id}/lecture.mp3"
    config.s3_client().put_object(
        Bucket=config.AUDIO_BUCKET,
        Key=s3_key,
        Body=bytes(audio_bytes),
        ContentType="audio/mpeg",
    )

    # Estimate duration from the *actual* synthesized word count (~150 wpm) — Polly
    # does not return duration, and decoding MP3 here would add a heavy dependency.
    word_count = len(script.split())
    duration_seconds = int(round(word_count / config.WORDS_PER_MINUTE * 60))

    logger.info(
        "Synthesized lecture audio",
        extra={"lecture_id": lecture_id, "chunks": len(chunks)},
    )
    run_context.set_lecture(
        lectureId=lecture_id,
        s3Key=s3_key,
        durationSeconds=duration_seconds,
        durationMinutes=max(1, round(duration_seconds / 60)),
        title=lecture_title,
    )
    return json.dumps(
        {
            "lecture_id": lecture_id,
            "s3_key": s3_key,
            "duration_seconds": duration_seconds,
            "char_count": len(script),
        }
    )
