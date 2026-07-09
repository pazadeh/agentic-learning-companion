"""Per-invocation result collector.

Tool functions are module-level and can't easily return structured side-data to the
entry point, so they record the lecture they produced here. The entry point
(``main.py``) holds a lock around the *entire* agent run — reset() before and
get_lecture() after — so a plain module-level dict is correct and safe.

Note: we deliberately do NOT use ``threading.local`` here. Strands may execute tool
calls on a different thread than the entrypoint, and a thread-local would make the
data the tools write invisible to the entrypoint thread.
"""
from __future__ import annotations

from typing import Any

_lecture: dict[str, Any] = {}
_script: str = ""


def reset() -> None:
    """Clear the collector at the start of an invocation."""
    global _lecture, _script
    _lecture = {}
    _script = ""


def set_lecture(**fields: Any) -> None:
    """Merge fields into the current invocation's lecture record."""
    for key, value in fields.items():
        if value is not None:
            _lecture[key] = value


def get_lecture() -> dict[str, Any]:
    """Return the lecture produced during this invocation (may be empty)."""
    return dict(_lecture)


def set_script(script: str) -> None:
    """Store the full lecture script written this invocation.

    Kept separate from the lecture record so the (potentially long) script does not
    have to be round-tripped through the orchestrator LLM as a tool argument — the
    synthesis tool reads it directly from here, guaranteeing the *complete* script
    is turned into audio.
    """
    global _script
    _script = script or ""


def get_script() -> str:
    """Return the full script written this invocation (may be empty)."""
    return _script
