"""Focused tests for Nova Sonic planning, streaming, retry, and publication."""
from __future__ import annotations

import asyncio
import base64
import contextlib
import json
import sys
import time
import types
import wave
from pathlib import Path

import pytest

# The production decorator only attaches tool metadata; these unit tests exercise the
# underlying deterministic helpers without pulling the full Strands runtime into pytest.
sys.modules.setdefault("strands", types.SimpleNamespace(tool=lambda function: function))

from agents import audio_agent, nova_sonic


class _FakeS3:
    def __init__(self) -> None:
        self.calls = []

    def upload_file(self, filename, bucket, key, ExtraArgs):
        path = Path(filename)
        assert path.exists()
        with wave.open(str(path), "rb") as source:
            assert source.getnchannels() == 1
            assert source.getsampwidth() == 2
            assert source.getframerate() == 24000
            assert source.getnframes() == 48_000
        self.calls.append((filename, bucket, key, ExtraArgs))


class _AsyncEvents:
    def __init__(self, events):
        self._events = iter(events)

    def __aiter__(self):
        return self

    async def __anext__(self):
        try:
            return next(self._events)
        except StopIteration as exc:
            raise StopAsyncIteration from exc


class _OutputStream:
    def __init__(self, events):
        self.events = _AsyncEvents(events)

    async def await_output(self):
        return None, self.events


class _InputStream:
    def __init__(self, calls):
        self.calls = calls

    async def close(self):
        self.calls.append("close")


def _output_event(name, value):
    payload = json.dumps({"event": {name: value}}).encode()
    return types.SimpleNamespace(value=types.SimpleNamespace(bytes_=payload))


def test_plan_sessions_keeps_sentences_and_limit():
    text = "One two three. Four five six. Seven eight nine. Ten eleven."
    sessions = nova_sonic.plan_sessions(text, max_words=6)
    assert sessions == ["One two three. Four five six.", "Seven eight nine. Ten eleven."]
    assert " ".join(sessions) == text


def test_plan_sessions_splits_pathological_sentence():
    text = " ".join(f"word-{index}" for index in range(13))
    sessions = nova_sonic.plan_sessions(text, max_words=5)
    assert [len(session.split()) for session in sessions] == [5, 5, 3]
    assert " ".join(sessions) == text


def test_twenty_five_minute_script_uses_multiple_safe_sessions():
    text = " ".join(f"word-{index}" for index in range(3_000))
    sessions = nova_sonic.plan_sessions(text, max_words=900)
    assert len(sessions) == 4
    assert max(len(session.split()) for session in sessions) <= 900
    assert sum(len(session.split()) for session in sessions) == 3_000


def test_default_total_deadline_fits_synchronous_worker_envelope():
    assert nova_sonic.config.NOVA_TOTAL_TIMEOUT_SECONDS == 660
    assert nova_sonic.config.NOVA_SESSION_TIMEOUT_SECONDS == 180


def test_progress_dynamodb_client_has_strict_network_bounds(monkeypatch):
    captured = {}

    def fake_resource(service, **kwargs):
        captured.update({"service": service, **kwargs})
        return object()

    nova_sonic.config.progress_dynamodb_resource.cache_clear()
    monkeypatch.setattr(nova_sonic.config.boto3, "resource", fake_resource)
    try:
        nova_sonic.config.progress_dynamodb_resource()
    finally:
        nova_sonic.config.progress_dynamodb_resource.cache_clear()

    client_config = captured["config"]
    assert captured["service"] == "dynamodb"
    assert client_config.connect_timeout == 1
    assert client_config.read_timeout == 1
    assert client_config.retries["total_max_attempts"] == 1


def test_receive_response_orders_audio_usage_and_completion():
    pcm = b"\x01\x02\x03\x04"
    events = [
        _output_event(
            "contentStart", {"type": "AUDIO", "role": "ASSISTANT"}
        ),
        _output_event("audioOutput", {"content": base64.b64encode(pcm).decode()}),
        _output_event(
            "usageEvent",
            {
                "details": {
                    "total": {
                        "input": {"speechTokens": 2, "textTokens": 3},
                        "output": {"speechTokens": 4, "textTokens": 5},
                    }
                }
            },
        ),
        _output_event(
            "contentEnd", {"type": "AUDIO", "stopReason": "END_TURN"}
        ),
        _output_event("completionEnd", {"stopReason": "END_TURN"}),
    ]

    async def receive():
        audio_done = asyncio.Event()
        result = await nova_sonic._receive_response(_OutputStream(events), audio_done)
        return result, audio_done.is_set()

    (audio, usage), completed = asyncio.run(receive())
    assert completed is True
    assert audio == pcm
    assert usage == {
        "inputSpeechTokens": 2,
        "inputTextTokens": 3,
        "outputSpeechTokens": 4,
        "outputTextTokens": 5,
    }


def test_close_session_sends_protocol_end_in_order(monkeypatch):
    calls = []

    async def fake_send(_stream, name, _value):
        calls.append(name)

    stream = types.SimpleNamespace(input_stream=_InputStream(calls))
    monkeypatch.setattr(nova_sonic, "_send", fake_send)
    asyncio.run(nova_sonic._close_session(stream, "prompt", "audio"))
    assert calls == ["contentEnd", "promptEnd", "sessionEnd", "close"]


def test_hanging_stream_context_exit_is_bounded(monkeypatch):
    class HangingStream:
        def __init__(self):
            self.exit_started = False

        async def __aexit__(self, *_args):
            self.exit_started = True
            await asyncio.Event().wait()

    stream = HangingStream()
    monkeypatch.setattr(nova_sonic, "_CONTEXT_EXIT_TIMEOUT_SECONDS", 0.01)
    asyncio.run(nova_sonic._bounded_context_exit(stream))
    assert stream.exit_started is True


def test_multi_session_retry_produces_complete_wav(tmp_path, monkeypatch):
    calls = []
    progress = []

    @contextlib.asynccontextmanager
    async def fake_client():
        yield object()

    async def fake_segment(_client, passage, _trigger):
        calls.append(passage)
        if passage == "one two" and calls.count(passage) == 1:
            raise RuntimeError("transient stream error")
        return (b"\x01\x00" * 100, {"outputSpeechTokens": 10})

    async def no_sleep(_seconds):
        return None

    monkeypatch.setattr(nova_sonic, "_runtime_client", fake_client)
    monkeypatch.setattr(nova_sonic, "_synthesize_segment", fake_segment)
    monkeypatch.setattr(nova_sonic.asyncio, "sleep", no_sleep)
    monkeypatch.setattr(nova_sonic.config, "NOVA_SESSION_MAX_WORDS", 2)
    monkeypatch.setattr(nova_sonic.config, "NOVA_SESSION_MAX_ATTEMPTS", 2)
    monkeypatch.setattr(nova_sonic.config, "NOVA_SESSION_TIMEOUT_SECONDS", 30)
    monkeypatch.setattr(nova_sonic.config, "NOVA_TOTAL_TIMEOUT_SECONDS", 60)
    monkeypatch.setattr(nova_sonic.config, "NOVA_OUTPUT_SAMPLE_RATE", 1_000)
    output_path = tmp_path / "multi.wav"

    result = asyncio.run(
        nova_sonic._synthesize_all(
            "one two three four",
            output_path,
            lambda current, total: progress.append((current, total)),
            b"trigger",
        )
    )

    assert calls == ["one two", "one two", "three four"]
    assert progress == [(1, 2), (2, 2)]
    assert result.session_count == 2
    assert result.usage["outputSpeechTokens"] == 20
    with wave.open(str(output_path), "rb") as source:
        assert source.getnframes() == 450  # 100 + 250 ms join + 100


def test_slow_progress_callback_cannot_publish_after_total_deadline(
    tmp_path, monkeypatch
):
    @contextlib.asynccontextmanager
    async def fake_client():
        yield object()

    async def fake_segment(_client, _passage, _trigger):
        return b"\x01\x00" * 10, {}

    def slow_progress(_current, _total):
        time.sleep(1.1)

    monkeypatch.setattr(nova_sonic, "_runtime_client", fake_client)
    monkeypatch.setattr(nova_sonic, "_synthesize_segment", fake_segment)
    monkeypatch.setattr(nova_sonic, "_ATTEMPT_CLEANUP_RESERVE_SECONDS", 0.001)
    monkeypatch.setattr(nova_sonic, "_TOTAL_CLEANUP_RESERVE_SECONDS", 0.001)
    monkeypatch.setattr(nova_sonic.config, "NOVA_SESSION_TIMEOUT_SECONDS", 2)
    monkeypatch.setattr(nova_sonic.config, "NOVA_TOTAL_TIMEOUT_SECONDS", 1.05)

    with pytest.raises(TimeoutError, match="total narration deadline"):
        asyncio.run(
            nova_sonic._synthesize_all(
                "one short session",
                tmp_path / "late.wav",
                slow_progress,
                b"trigger",
            )
        )


def test_fade_pcm_preserves_length_and_zeroes_edges(monkeypatch):
    monkeypatch.setattr(nova_sonic.config, "NOVA_OUTPUT_SAMPLE_RATE", 1_000)
    samples = (1_000).to_bytes(2, "little", signed=True) * 100
    faded = nova_sonic._fade_pcm(samples)
    assert len(faded) == len(samples)
    assert int.from_bytes(faded[:2], "little", signed=True) == 0
    assert int.from_bytes(faded[-2:], "little", signed=True) == 0


def test_nova_upload_publishes_wav_and_removes_temp_file(monkeypatch):
    fake_s3 = _FakeS3()
    captured_path = ""

    def fake_synthesize(script, output_path, on_session_complete):
        nonlocal captured_path
        captured_path = str(output_path)
        with wave.open(str(output_path), "wb") as output:
            output.setnchannels(1)
            output.setsampwidth(2)
            output.setframerate(24_000)
            output.writeframes(bytes(48_000 * 2))
        on_session_complete(1, 1)
        return nova_sonic.NovaSynthesisResult(
            duration_seconds=2.0,
            session_count=1,
            output_bytes=96_044,
            usage={},
        )

    monkeypatch.setattr(audio_agent.config, "AUDIO_BUCKET", "test-audio")
    monkeypatch.setattr(audio_agent.config, "s3_client", lambda: fake_s3)
    monkeypatch.setattr(audio_agent.nova_sonic, "synthesize_to_wav", fake_synthesize)

    lecture_id = "123e4567-e89b-12d3-a456-426614174000"
    key, duration, sessions = audio_agent._upload_nova_wav(
        "A short lecture.", "user-1", lecture_id
    )

    assert key == f"audio/user-1/{lecture_id}/lecture.wav"
    assert duration == 2
    assert sessions == 1
    assert fake_s3.calls[0][1:] == (
        "test-audio",
        key,
        {"ContentType": "audio/wav"},
    )
    assert not Path(captured_path).exists()


def test_nova_failure_never_uploads_partial_file(monkeypatch):
    fake_s3 = _FakeS3()
    captured_path = ""

    def fail_after_partial_write(_script, output_path, on_session_complete=None):
        nonlocal captured_path
        captured_path = str(output_path)
        Path(output_path).write_bytes(b"partial")
        raise RuntimeError("second session failed")

    monkeypatch.setattr(audio_agent.config, "s3_client", lambda: fake_s3)
    monkeypatch.setattr(
        audio_agent.nova_sonic, "synthesize_to_wav", fail_after_partial_write
    )

    with pytest.raises(RuntimeError, match="second session failed"):
        audio_agent._upload_nova_wav(
            "A multi-session lecture.",
            "user-1",
            "123e4567-e89b-12d3-a456-426614174000",
        )

    assert fake_s3.calls == []
    assert not Path(captured_path).exists()
