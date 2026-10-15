"""Audio agent — synthesizes lecture narration and publishes it to Amazon S3.

Amazon Nova 2.5 Sonic is the default narration provider. Long scripts are divided into
sub-eight-minute sessions and assembled as one PCM WAV file. Amazon Polly Neural remains
available as an explicit rollback provider through ``NARRATION_PROVIDER=polly``.
"""
from __future__ import annotations

import json
import logging
import re
import tempfile
import uuid
from pathlib import Path

from strands import tool

from . import config, nova_sonic, progress, run_context

logger = logging.getLogger("audio_companion.agents.audio")

_SENTENCE_RE = re.compile(r"(?<=[.!?])\s+")
_SUPPORTED_PROVIDERS = {"nova-sonic", "polly"}


def _chunk_text(text: str, max_chars: int = config.POLLY_CHUNK_CHARS) -> list[str]:
    """Split Polly text into chunks <= max_chars, preferring sentence boundaries."""
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
        while len(sentence) > max_chars:
            chunks.append(sentence[:max_chars])
            sentence = sentence[max_chars:]
        current = sentence
    if current:
        chunks.append(current)
    return chunks


def _validate_script(text: str) -> str:
    script = text.strip()
    if not script:
        raise ValueError("Cannot synthesize empty text")
    if len(script) > config.MAX_SCRIPT_CHARS:
        raise ValueError(
            f"Script exceeds {config.MAX_SCRIPT_CHARS} character synthesis cap"
        )
    return script


def _synthesize_with_polly(script: str) -> tuple[bytes, int, int]:
    chunks = _chunk_text(script)
    polly = config.polly_client()
    audio_bytes = bytearray()
    for index, chunk in enumerate(chunks, start=1):
        response = polly.synthesize_speech(
            Text=chunk,
            Engine="neural",
            VoiceId="Joanna",
            OutputFormat="mp3",
        )
        stream = response.get("AudioStream")
        if stream is None:
            raise RuntimeError(f"Polly returned no audio for segment {index}")
        audio_bytes.extend(stream.read())
        progress.report(
            "synthesizing",
            70 + round(index / max(len(chunks), 1) * 18),
            "Creating the audio",
            f"Polly segment {index} of {len(chunks)}",
        )
    duration_seconds = int(
        round(len(script.split()) / config.WORDS_PER_MINUTE * 60)
    )
    return bytes(audio_bytes), duration_seconds, len(chunks)


def _upload_nova_wav(script: str, user_id: str, lecture_id: str) -> tuple[str, int, int]:
    sessions = nova_sonic.plan_sessions(script)
    progress.report(
        "synthesizing",
        70,
        "Creating the audio",
        f"Preparing {len(sessions)} Nova speech session{'s' if len(sessions) != 1 else ''}",
    )

    def report_session(index: int, total: int) -> None:
        progress.report(
            "synthesizing",
            70 + round(index / max(total, 1) * 18),
            "Creating the audio",
            f"Nova speech session {index} of {total}",
        )

    temp_path = ""
    try:
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as output:
            temp_path = output.name
        result = nova_sonic.synthesize_to_wav(
            script,
            temp_path,
            on_session_complete=report_session,
        )
        s3_key = f"audio/{user_id}/{lecture_id}/lecture.wav"
        progress.report("uploading", 90, "Uploading your audio")
        config.s3_client().upload_file(
            temp_path,
            config.AUDIO_BUCKET,
            s3_key,
            ExtraArgs={"ContentType": "audio/wav"},
        )
        logger.info(
            "Nova Sonic usage",
            extra={
                "lecture_id": lecture_id,
                "sessions": result.session_count,
                **result.usage,
            },
        )
        return s3_key, int(round(result.duration_seconds)), result.session_count
    finally:
        if temp_path:
            Path(temp_path).unlink(missing_ok=True)


def _upload_polly_mp3(script: str, user_id: str, lecture_id: str) -> tuple[str, int, int]:
    chunks = _chunk_text(script)
    progress.report(
        "synthesizing",
        70,
        "Creating the audio",
        f"Preparing {len(chunks)} Polly speech segments",
    )
    audio_bytes, duration_seconds, segment_count = _synthesize_with_polly(script)
    s3_key = f"audio/{user_id}/{lecture_id}/lecture.mp3"
    progress.report("uploading", 90, "Uploading your audio")
    config.s3_client().put_object(
        Bucket=config.AUDIO_BUCKET,
        Key=s3_key,
        Body=audio_bytes,
        ContentType="audio/mpeg",
    )
    return s3_key, duration_seconds, segment_count


@tool
def synthesize_and_upload(lecture_title: str, user_id: str, text: str = "") -> str:
    """Synthesize the generated lecture script and upload its audio to S3.

    The full script written by ``generate_lecture`` is read from per-invocation context;
    ``text`` is only a fallback for direct and test use. The configured narration
    provider is used without silently switching voices on failure.

    Returns:
        JSON containing lecture_id, s3_key, duration_seconds, char_count, and provider.
    """
    script = _validate_script(run_context.get_script() or (text or ""))
    provider = config.NARRATION_PROVIDER
    if provider not in _SUPPORTED_PROVIDERS:
        raise ValueError(f"Unsupported narration provider: {provider}")

    lecture_id = str(uuid.uuid4())
    if provider == "nova-sonic":
        s3_key, duration_seconds, segment_count = _upload_nova_wav(
            script, user_id, lecture_id
        )
        audio_format = "wav"
    else:
        s3_key, duration_seconds, segment_count = _upload_polly_mp3(
            script, user_id, lecture_id
        )
        audio_format = "mp3"
    progress.report("uploading", 93, "Audio upload complete")

    logger.info(
        "Synthesized lecture audio",
        extra={
            "lecture_id": lecture_id,
            "provider": provider,
            "segments": segment_count,
        },
    )
    run_context.set_lecture(
        lectureId=lecture_id,
        s3Key=s3_key,
        durationSeconds=duration_seconds,
        durationMinutes=max(1, round(duration_seconds / 60)),
        title=lecture_title,
        audioProvider=provider,
        audioFormat=audio_format,
    )
    return json.dumps(
        {
            "lecture_id": lecture_id,
            "s3_key": s3_key,
            "duration_seconds": duration_seconds,
            "char_count": len(script),
            "provider": provider,
            "audio_format": audio_format,
        }
    )
