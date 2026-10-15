"""Amazon Nova 2.5 Sonic long-form narration support.

Nova Sonic is a real-time speech-to-speech model, not a conventional text-to-speech
API. This module adapts it for deterministic narration by placing finished lecture prose
in the system context, streaming a short bundled speech trigger, and feeding silence
until each response finishes. Long scripts are split into conservative six-minute
sessions to stay below Nova's eight-minute connection limit.
"""
from __future__ import annotations

import asyncio
import base64
import contextlib
import json
import logging
import re
import sys
import time
import uuid
import wave
from array import array
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

import boto3

from . import config

logger = logging.getLogger("audio_companion.agents.nova_sonic")

_SENTENCE_RE = re.compile(r"(?<=[.!?])\s+")
_TRIGGER_PATH = Path(__file__).resolve().parents[1] / "assets" / "nova_trigger.pcm"
_INPUT_SAMPLE_RATE = 16_000
_INPUT_CHUNK_MS = 20
_OUTPUT_SAMPLE_WIDTH = 2
_CHANNELS = 1
_INTER_SESSION_SILENCE_MS = 250
_FADE_MS = 10
_PROTOCOL_OPERATION_TIMEOUT_SECONDS = 2
_CONTEXT_EXIT_TIMEOUT_SECONDS = 2
_ATTEMPT_CLEANUP_RESERVE_SECONDS = 12
_TOTAL_CLEANUP_RESERVE_SECONDS = 4

_SYSTEM_PROMPT = """You are a narration engine for an educational audio application.
A finished lecture passage appears below. After the user says anything, speak only that
passage exactly as written, preserving every fact and sentence. Do not answer the user's
words, summarize, paraphrase, add an introduction, or add a closing. Use a warm, natural,
thoughtful lecturer tone with restrained energy, varied intonation, and comfortable
pauses between ideas.

PASSAGE:
{passage}"""


@dataclass(frozen=True)
class NovaSynthesisResult:
    duration_seconds: float
    session_count: int
    output_bytes: int
    usage: dict[str, int]


def plan_sessions(text: str, max_words: int | None = None) -> list[str]:
    """Split narration at sentence boundaries without exceeding ``max_words``.

    The default of 900 words is about six minutes at 150 WPM, leaving two minutes of
    headroom under Nova Sonic's eight-minute connection limit. Pathological sentences
    longer than one session are split on word boundaries.
    """
    limit = max_words or config.NOVA_SESSION_MAX_WORDS
    if limit < 1:
        raise ValueError("Nova session word limit must be positive")
    source = text.strip()
    if not source:
        return []

    units: list[str] = []
    for sentence in _SENTENCE_RE.split(source):
        words = sentence.split()
        while len(words) > limit:
            units.append(" ".join(words[:limit]))
            words = words[limit:]
        if words:
            units.append(" ".join(words))

    sessions: list[str] = []
    current: list[str] = []
    current_words = 0
    for unit in units:
        unit_words = len(unit.split())
        if current and current_words + unit_words > limit:
            sessions.append(" ".join(current))
            current = []
            current_words = 0
        current.append(unit)
        current_words += unit_words
    if current:
        sessions.append(" ".join(current))
    return sessions


def _event(name: str, value: dict[str, Any]) -> bytes:
    return json.dumps({"event": {name: value}}, separators=(",", ":")).encode()


async def _send(stream: Any, name: str, value: dict[str, Any]) -> None:
    from aws_sdk_bedrock_runtime.models import (
        BidirectionalInputPayloadPart,
        InvokeModelWithBidirectionalStreamInputChunk,
    )

    await stream.input_stream.send(
        InvokeModelWithBidirectionalStreamInputChunk(
            value=BidirectionalInputPayloadPart(bytes_=_event(name, value))
        )
    )


async def _send_text(
    stream: Any, prompt_name: str, role: str, text: str, *, interactive: bool
) -> None:
    content_name = str(uuid.uuid4())
    await _send(
        stream,
        "contentStart",
        {
            "promptName": prompt_name,
            "contentName": content_name,
            "type": "TEXT",
            "interactive": interactive,
            "role": role,
            "textInputConfiguration": {"mediaType": "text/plain"},
        },
    )
    await _send(
        stream,
        "textInput",
        {"promptName": prompt_name, "contentName": content_name, "content": text},
    )
    await _send(
        stream,
        "contentEnd",
        {"promptName": prompt_name, "contentName": content_name},
    )


async def _send_audio(
    stream: Any, prompt_name: str, content_name: str, pcm: bytes
) -> None:
    await _send(
        stream,
        "audioInput",
        {
            "promptName": prompt_name,
            "contentName": content_name,
            "content": base64.b64encode(pcm).decode(),
        },
    )


async def _receive_response(
    stream: Any, audio_done: asyncio.Event
) -> tuple[bytes, dict[str, int]]:
    """Collect one response until the server marks its audio turn complete."""
    _, output_stream = await stream.await_output()
    if output_stream is None:
        raise RuntimeError("Nova Sonic returned no output stream")

    pcm = bytearray()
    usage: dict[str, int] = {}
    current_type = ""
    current_role = ""
    async for output in output_stream:
        payload = getattr(getattr(output, "value", None), "bytes_", None)
        if not payload:
            message = getattr(getattr(output, "value", None), "message", "")
            raise RuntimeError(f"Nova Sonic stream error: {message or type(output).__name__}")
        data = json.loads(payload.decode()).get("event", {})
        if "contentStart" in data:
            current_type = data["contentStart"].get("type", "")
            current_role = data["contentStart"].get("role", "")
        elif "audioOutput" in data:
            pcm.extend(base64.b64decode(data["audioOutput"].get("content", "")))
        elif "usageEvent" in data:
            total = data["usageEvent"].get("details", {}).get("total", {})
            usage = {
                "inputSpeechTokens": int(total.get("input", {}).get("speechTokens", 0)),
                "inputTextTokens": int(total.get("input", {}).get("textTokens", 0)),
                "outputSpeechTokens": int(total.get("output", {}).get("speechTokens", 0)),
                "outputTextTokens": int(total.get("output", {}).get("textTokens", 0)),
            }
        elif "contentEnd" in data:
            if (
                current_type == "AUDIO"
                and current_role == "ASSISTANT"
                and data["contentEnd"].get("stopReason") == "END_TURN"
            ):
                audio_done.set()
        elif "completionEnd" in data:
            break
    return bytes(pcm), usage


async def _close_session(
    stream: Any, prompt_name: str, audio_content_name: str
) -> None:
    """Best-effort, time-bounded shutdown preserving the synthesis exception."""
    operations = (
        lambda: _send(
            stream,
            "contentEnd",
            {"promptName": prompt_name, "contentName": audio_content_name},
        ),
        lambda: _send(stream, "promptEnd", {"promptName": prompt_name}),
        lambda: _send(stream, "sessionEnd", {}),
        stream.input_stream.close,
    )
    for operation in operations:
        with contextlib.suppress(Exception):
            await asyncio.wait_for(
                operation(), timeout=_PROTOCOL_OPERATION_TIMEOUT_SECONDS
            )


async def _bounded_context_exit(manager: Any) -> None:
    """Prevent SDK stream/client cleanup from escaping the global deadline."""
    with contextlib.suppress(Exception):
        await asyncio.wait_for(
            manager.__aexit__(None, None, None),
            timeout=_CONTEXT_EXIT_TIMEOUT_SECONDS,
        )


async def _synthesize_segment(
    client: Any, passage: str, trigger_pcm: bytes
) -> tuple[bytes, dict[str, int]]:
    from aws_sdk_bedrock_runtime.models import (
        InvokeModelWithBidirectionalStreamOperationInput,
    )

    logger.info(
        "Opening Nova Sonic bidirectional stream",
        extra={"model": config.NOVA_MODEL_ID, "passage_words": len(passage.split())},
    )
    stream = await client.invoke_model_with_bidirectional_stream(
        InvokeModelWithBidirectionalStreamOperationInput(model_id=config.NOVA_MODEL_ID)
    )
    logger.info("Nova Sonic bidirectional stream opened")
    prompt_name = str(uuid.uuid4())
    audio_content_name = str(uuid.uuid4())
    chunk_size = _INPUT_SAMPLE_RATE * 2 * _INPUT_CHUNK_MS // 1000
    silence = bytes(chunk_size)
    receiver: asyncio.Task | None = None

    entered = False
    try:
        await asyncio.wait_for(stream.__aenter__(), timeout=5)
        entered = True
        try:
            await _send(
                stream,
                "sessionStart",
                {
                    "inferenceConfiguration": {
                        "maxTokens": config.NOVA_MAX_OUTPUT_TOKENS,
                        "topP": 0.9,
                        "temperature": 0.2,
                    },
                    "turnDetectionConfiguration": {
                        "endpointingSensitivity": "MEDIUM"
                    },
                },
            )
            await _send(
                stream,
                "promptStart",
                {
                    "promptName": prompt_name,
                    "textOutputConfiguration": {"mediaType": "text/plain"},
                    "audioOutputConfiguration": {
                        "mediaType": "audio/lpcm",
                        "sampleRateHertz": config.NOVA_OUTPUT_SAMPLE_RATE,
                        "sampleSizeBits": 16,
                        "channelCount": _CHANNELS,
                        "voiceId": config.NOVA_VOICE_ID,
                        "encoding": "base64",
                        "audioType": "SPEECH",
                    },
                },
            )
            await _send_text(
                stream,
                prompt_name,
                "SYSTEM",
                _SYSTEM_PROMPT.format(passage=passage),
                interactive=False,
            )
            await _send(
                stream,
                "contentStart",
                {
                    "promptName": prompt_name,
                    "contentName": audio_content_name,
                    "type": "AUDIO",
                    "interactive": True,
                    "role": "USER",
                    "audioInputConfiguration": {
                        "mediaType": "audio/lpcm",
                        "sampleRateHertz": _INPUT_SAMPLE_RATE,
                        "sampleSizeBits": 16,
                        "channelCount": _CHANNELS,
                        "audioType": "SPEECH",
                        "encoding": "base64",
                    },
                },
            )

            audio_done = asyncio.Event()
            receiver = asyncio.create_task(_receive_response(stream, audio_done))
            logger.info("Streaming Nova Sonic trigger audio")
            for offset in range(0, len(trigger_pcm), chunk_size):
                chunk = trigger_pcm[offset : offset + chunk_size]
                if len(chunk) < chunk_size:
                    chunk += bytes(chunk_size - len(chunk))
                await _send_audio(stream, prompt_name, audio_content_name, chunk)
                await asyncio.sleep(_INPUT_CHUNK_MS / 1000)

            deadline = time.monotonic() + config.NOVA_SESSION_TIMEOUT_SECONDS
            while not audio_done.is_set():
                if receiver.done():
                    await receiver
                if time.monotonic() >= deadline:
                    raise TimeoutError("Nova Sonic narration session timed out")
                await _send_audio(stream, prompt_name, audio_content_name, silence)
                await asyncio.sleep(_INPUT_CHUNK_MS / 1000)

            await _close_session(stream, prompt_name, audio_content_name)
            result = await asyncio.wait_for(receiver, timeout=30)
            logger.info("Nova Sonic audio response complete", extra={"bytes": len(result[0])})
            return result
        finally:
            if receiver is not None and not receiver.done():
                receiver.cancel()
                with contextlib.suppress(asyncio.CancelledError, asyncio.TimeoutError):
                    await asyncio.wait_for(receiver, timeout=2)
            await _close_session(stream, prompt_name, audio_content_name)
    finally:
        if entered:
            await _bounded_context_exit(stream)


def _fade_pcm(pcm: bytes) -> bytes:
    """Apply a short linear edge fade to prevent clicks between Nova sessions."""
    samples = array("h")
    samples.frombytes(pcm)
    if sys.byteorder != "little":
        samples.byteswap()
    fade_samples = min(
        config.NOVA_OUTPUT_SAMPLE_RATE * _FADE_MS // 1000,
        len(samples) // 2,
    )
    if fade_samples:
        for index in range(fade_samples):
            gain = index / fade_samples
            samples[index] = int(samples[index] * gain)
            samples[-index - 1] = int(samples[-index - 1] * gain)
    if sys.byteorder != "little":
        samples.byteswap()
    return samples.tobytes()


@contextlib.asynccontextmanager
async def _runtime_client():
    """Yield a bidirectional client using botocore's proven role credentials."""
    from aws_sdk_bedrock_runtime.client import AsyncBedrockRuntimeClient
    from aws_sdk_bedrock_runtime.config import AsyncBedrockRuntimeConfig
    from smithy_http.aio.crt import AWSCRTHTTPClient

    credentials = boto3.Session(region_name=config.AWS_REGION).get_credentials()
    if credentials is None:
        raise RuntimeError("Unable to resolve AWS credentials for Nova Sonic")
    frozen = credentials.get_frozen_credentials()
    logger.info("Resolved execution-role credentials for Nova Sonic")
    runtime_config = await AsyncBedrockRuntimeConfig.resolve(
        region=config.AWS_REGION,
        aws_access_key_id=frozen.access_key,
        aws_secret_access_key=frozen.secret_key,
        aws_session_token=frozen.token,
        transport=AWSCRTHTTPClient(),
    )
    logger.info("Resolved Nova Sonic runtime configuration")
    client = AsyncBedrockRuntimeClient(config=runtime_config)
    entered = False
    try:
        await asyncio.wait_for(client.__aenter__(), timeout=5)
        entered = True
        yield client
    finally:
        if entered:
            await _bounded_context_exit(client)


async def _synthesize_all(
    script: str,
    output_path: Path,
    on_session_complete: Callable[[int, int], None] | None,
    trigger_pcm: bytes,
) -> NovaSynthesisResult:
    sessions = plan_sessions(script)
    if not sessions:
        raise ValueError("Cannot synthesize empty text")
    if (
        config.NOVA_SESSION_TIMEOUT_SECONDS <= _ATTEMPT_CLEANUP_RESERVE_SECONDS
        or config.NOVA_TOTAL_TIMEOUT_SECONDS <= _TOTAL_CLEANUP_RESERVE_SECONDS
    ):
        raise ValueError("Nova Sonic timeout settings leave no cleanup reserve")
    total_deadline = (
        time.monotonic()
        + config.NOVA_TOTAL_TIMEOUT_SECONDS
        - _TOTAL_CLEANUP_RESERVE_SECONDS
    )
    silence_frames = (
        config.NOVA_OUTPUT_SAMPLE_RATE * _INTER_SESSION_SILENCE_MS // 1000
    )
    silence_pcm = bytes(silence_frames * _OUTPUT_SAMPLE_WIDTH * _CHANNELS)
    total_pcm_bytes = 0
    aggregate_usage = {
        "inputSpeechTokens": 0,
        "inputTextTokens": 0,
        "outputSpeechTokens": 0,
        "outputTextTokens": 0,
    }

    with wave.open(str(output_path), "wb") as output:
        output.setnchannels(_CHANNELS)
        output.setsampwidth(_OUTPUT_SAMPLE_WIDTH)
        output.setframerate(config.NOVA_OUTPUT_SAMPLE_RATE)
        async with _runtime_client() as client:
            for index, passage in enumerate(sessions, start=1):
                last_error: Exception | None = None
                for attempt in range(1, config.NOVA_SESSION_MAX_ATTEMPTS + 1):
                    remaining = total_deadline - time.monotonic()
                    if remaining <= _ATTEMPT_CLEANUP_RESERVE_SECONDS + 1:
                        raise TimeoutError(
                            "Nova Sonic exceeded the total narration deadline"
                        ) from last_error
                    attempt_timeout = min(
                        config.NOVA_SESSION_TIMEOUT_SECONDS
                        - _ATTEMPT_CLEANUP_RESERVE_SECONDS,
                        max(
                            1,
                            remaining - _ATTEMPT_CLEANUP_RESERVE_SECONDS,
                        ),
                    )
                    try:
                        pcm, usage = await asyncio.wait_for(
                            _synthesize_segment(client, passage, trigger_pcm),
                            timeout=attempt_timeout,
                        )
                        if not pcm:
                            raise RuntimeError("Nova Sonic returned empty audio")
                        break
                    except Exception as exc:  # noqa: BLE001
                        last_error = exc
                        logger.warning(
                            "Nova Sonic session attempt failed",
                            extra={
                                "session": index,
                                "attempt": attempt,
                                "error": type(exc).__name__,
                            },
                        )
                        if attempt >= config.NOVA_SESSION_MAX_ATTEMPTS:
                            raise RuntimeError(
                                f"Nova Sonic session {index} failed"
                            ) from last_error
                        delay = min(2**attempt, 5)
                        if (
                            time.monotonic() + delay
                            >= total_deadline - _ATTEMPT_CLEANUP_RESERVE_SECONDS - 1
                        ):
                            raise TimeoutError(
                                "Nova Sonic retry would exceed the total narration deadline"
                            ) from last_error
                        await asyncio.sleep(delay)

                faded = _fade_pcm(pcm)
                output.writeframesraw(faded)
                total_pcm_bytes += len(faded)
                if index < len(sessions):
                    output.writeframesraw(silence_pcm)
                    total_pcm_bytes += len(silence_pcm)
                for key in aggregate_usage:
                    aggregate_usage[key] += usage.get(key, 0)
                if on_session_complete:
                    on_session_complete(index, len(sessions))
                if time.monotonic() >= total_deadline:
                    raise TimeoutError(
                        "Nova Sonic exceeded the total narration deadline"
                    )

    duration = total_pcm_bytes / (
        config.NOVA_OUTPUT_SAMPLE_RATE * _OUTPUT_SAMPLE_WIDTH * _CHANNELS
    )
    return NovaSynthesisResult(
        duration_seconds=duration,
        session_count=len(sessions),
        output_bytes=output_path.stat().st_size,
        usage=aggregate_usage,
    )


def synthesize_to_wav(
    script: str,
    output_path: str | Path,
    on_session_complete: Callable[[int, int], None] | None = None,
    *,
    trigger_pcm: bytes | None = None,
) -> NovaSynthesisResult:
    """Synchronously synthesize ``script`` into a browser-compatible PCM WAV file."""
    trigger = trigger_pcm if trigger_pcm is not None else _TRIGGER_PATH.read_bytes()
    if not trigger:
        raise RuntimeError("Nova Sonic speech trigger is empty")
    logger.info(
        "Starting Nova Sonic narration",
        extra={"characters": len(script), "output_path": Path(output_path).name},
    )
    return asyncio.run(
        _synthesize_all(script, Path(output_path), on_session_complete, trigger)
    )
