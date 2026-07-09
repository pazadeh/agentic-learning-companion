"""Tests for security.content_filter.

Offending test strings are assembled from word parts so the test file itself never
contains a full instructional phrase.
"""
import pytest

from security.content_filter import check_topic_safety


@pytest.mark.parametrize(
    "topic",
    [
        "the history of the Roman Empire",
        "how vaccines train the immune system",
        "an introduction to quantum computing",
        "defensive cybersecurity best practices",
        "the science behind nuclear power plants",
        "world war two key turning points",
        "how to make a great sourdough bread",
    ],
)
def test_legitimate_topics_allowed(topic):
    assert check_topic_safety(topic).allowed is True


def test_empty_is_allowed():
    assert check_topic_safety("").allowed is True
    assert check_topic_safety("   ").allowed is True


def test_csam_blocked():
    # Co-occurrence of a minor term + sexual term is blocked, assembled from parts.
    parts = ["explicit", "content", "involving", "a", "child"]
    result = check_topic_safety(" ".join(parts))
    assert result.allowed is False
    assert result.reason == "csam"


def test_explosives_howto_blocked():
    text = " ".join(["how", "to", "build", "a", "bomb"])
    result = check_topic_safety(text)
    assert result.allowed is False
    assert result.reason == "explosives"


def test_wmd_howto_blocked():
    text = " ".join(["how", "to", "make", "a", "bioweapon"])
    result = check_topic_safety(text)
    assert result.allowed is False
    assert result.reason == "weapons_of_mass_destruction"


def test_malware_creation_blocked():
    text = " ".join(["write", "ransomware", "to", "encrypt", "files"])
    result = check_topic_safety(text)
    assert result.allowed is False
    assert result.reason == "malware"


def test_subject_without_intent_not_blocked():
    # Mentioning a category word without a how-to intent should not be blocked.
    assert check_topic_safety("the history of the atomic bomb in 1945").allowed is True
