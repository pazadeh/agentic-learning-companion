"""Content safety filter.

A deliberately narrow blocklist covering only the most egregious categories where
producing instructional audio would be clearly harmful:

* child sexual abuse material,
* operational instructions for weapons of mass destruction / explosives,
* creation of malicious software.

The filter looks for an *intent verb* ("how to make", "build", "synthesize", ...)
co-occurring with a *harmful subject* category term. Ordinary sensitive-but-
legitimate educational topics (history of conflicts, how vaccines work,
cybersecurity defense, the science of nuclear power, etc.) are intentionally NOT
blocked. The goal is to catch clear "how-to-cause-harm" requests, not to police
curiosity.
"""
from __future__ import annotations

import re
from dataclasses import dataclass


@dataclass(frozen=True)
class SafetyResult:
    """Outcome of a content-safety check."""

    allowed: bool
    reason: str = ""


# Intent verbs that, combined with a harmful subject, signal a request for
# operational "how-to" instructions rather than general education.
_INTENT = (
    r"(?:how\s+to\s+\w+|make|build|create|synthesi[sz]e|manufacture|produce|"
    r"weaponi[sz]e|cultivate|culture|grow|recipe|instructions?|"
    r"step[\s-]?by[\s-]?step|deploy|write)"
)

# Harmful subject categories expressed at the *category* level (no recipes/specifics).
_SUBJECTS: dict[str, str] = {
    "explosives": r"(?:bomb|explosive\s+device|explosives|detonator|ied)",
    "weapons_of_mass_destruction": (
        r"(?:bioweapon|biological\s+weapon|chemical\s+weapon|nerve\s+agent|"
        r"weapon\s+of\s+mass\s+destruction|dirty\s+bomb)"
    ),
    "malware": (
        r"(?:malware|ransomware|computer\s+virus|trojan|keylogger|botnet|"
        r"rootkit|spyware|worm\s+(?:that|to))"
    ),
}

# Child sexual abuse material: any co-occurrence of a minor term with a sexual term,
# in either order, is blocked outright (no intent verb required).
_MINORS = r"(?:child|children|minor|underage|pre[\s-]?teen|toddler|infant)"
_SEXUAL = r"(?:sexual|porn\w*|nude|naked|explicit|molest\w*)"

_INTENT_SUBJECT_PATTERNS: list[tuple[str, re.Pattern[str]]] = [
    (category, re.compile(rf"{_INTENT}[\w\s,'\"-]{{0,40}}{subject}", re.IGNORECASE))
    for category, subject in _SUBJECTS.items()
]

_CSAM_PATTERNS: list[re.Pattern[str]] = [
    re.compile(rf"{_MINORS}[\w\s,'\"-]{{0,40}}{_SEXUAL}", re.IGNORECASE),
    re.compile(rf"{_SEXUAL}[\w\s,'\"-]{{0,40}}{_MINORS}", re.IGNORECASE),
]


def check_topic_safety(text: str) -> SafetyResult:
    """Return whether ``text`` is safe to turn into a lecture.

    The check is intentionally conservative about *blocking* — it only rejects clear
    requests for harmful operational instructions or any sexualized content involving
    minors.
    """
    if not isinstance(text, str) or not text.strip():
        # Empty/invalid input is handled by the input validator; treat as safe here.
        return SafetyResult(allowed=True)

    for pattern in _CSAM_PATTERNS:
        if pattern.search(text):
            return SafetyResult(allowed=False, reason="csam")

    for category, pattern in _INTENT_SUBJECT_PATTERNS:
        if pattern.search(text):
            return SafetyResult(allowed=False, reason=category)

    return SafetyResult(allowed=True)
