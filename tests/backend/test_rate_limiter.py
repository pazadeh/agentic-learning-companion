"""Tests for security.rate_limiter."""
import pytest

from security import rate_limiter


class _FakeTable:
    """Fake DynamoDB Table whose counter returns a preset sequence of counts."""

    def __init__(self, counts):
        self._counts = list(counts)
        self.calls = 0

    def update_item(self, **kwargs):
        value = self._counts[min(self.calls, len(self._counts) - 1)]
        self.calls += 1
        return {"Attributes": {"count": value}}


class _ExplodingTable:
    def update_item(self, **kwargs):
        raise RuntimeError("dynamodb unavailable")


@pytest.fixture(autouse=True)
def _reset_table_cache():
    rate_limiter._table = None
    yield
    rate_limiter._table = None


def test_under_limit_allows(monkeypatch):
    table = _FakeTable([1, 2, 3])
    monkeypatch.setattr(rate_limiter, "_get_table", lambda: table)
    assert rate_limiter.check_rate_limit("user-1", "chat") is True


def test_at_limit_allows(monkeypatch):
    # chat limit is 100; count exactly 100 is still allowed.
    table = _FakeTable([100])
    monkeypatch.setattr(rate_limiter, "_get_table", lambda: table)
    assert rate_limiter.check_rate_limit("user-1", "chat") is True


def test_over_limit_blocks(monkeypatch):
    # lecture limit is 20; count 21 blocks.
    table = _FakeTable([21])
    monkeypatch.setattr(rate_limiter, "_get_table", lambda: table)
    assert rate_limiter.check_rate_limit("user-1", "lecture") is False


def test_unknown_action_uses_default_limit(monkeypatch):
    table = _FakeTable([rate_limiter.DEFAULT_LIMIT + 1])
    monkeypatch.setattr(rate_limiter, "_get_table", lambda: table)
    assert rate_limiter.check_rate_limit("user-1", "mystery") is False


def test_fails_open_on_backend_error(monkeypatch):
    monkeypatch.setattr(rate_limiter, "_get_table", lambda: _ExplodingTable())
    # On any DynamoDB error we allow the request rather than locking the user out.
    assert rate_limiter.check_rate_limit("user-1", "lecture") is True


def test_limits_match_spec():
    assert rate_limiter.LIMITS["lecture"] == 20
    assert rate_limiter.LIMITS["chat"] == 100
