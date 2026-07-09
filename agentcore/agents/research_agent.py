"""Research agent tools — web search via Tavily and multi-query topic research.

The Tavily API key is read from Secrets Manager (preferred) or the ``TAVILY_API_KEY``
environment variable as a fallback for local development. Searches are capped to
avoid runaway cost.
"""
from __future__ import annotations

import json
import logging
import os
import urllib.error
import urllib.request
from typing import Any

from strands import tool

from . import config, research_ranking

logger = logging.getLogger("audio_companion.agents.research")

_TAVILY_URL = "https://api.tavily.com/search"
_cached_key: str | None = None


def _get_tavily_key() -> str:
    """Resolve the Tavily API key from env or Secrets Manager (cached)."""
    global _cached_key
    if _cached_key:
        return _cached_key

    env_key = os.environ.get("TAVILY_API_KEY", "").strip()
    if env_key:
        _cached_key = env_key
        return _cached_key

    secret = config.secrets_client().get_secret_value(SecretId=config.TAVILY_SECRET_NAME)
    raw = secret.get("SecretString", "")
    try:
        parsed = json.loads(raw)
        _cached_key = parsed.get("apiKey") or parsed.get("api_key") or ""
    except (json.JSONDecodeError, AttributeError):
        _cached_key = raw.strip()

    if not _cached_key:
        raise RuntimeError("Tavily API key is not configured")
    return _cached_key


def _tavily_search(query: str, max_results: int = config.TAVILY_RESULTS_PER_QUERY) -> list[dict[str, Any]]:
    """Call the Tavily search API and return a list of result dicts."""
    body = json.dumps(
        {
            "api_key": _get_tavily_key(),
            "query": query,
            "max_results": max_results,
            "search_depth": "advanced",
        }
    ).encode("utf-8")
    request = urllib.request.Request(
        _TAVILY_URL, data=body, headers={"Content-Type": "application/json"}
    )
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            data = json.loads(response.read().decode("utf-8"))
    except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError) as exc:
        logger.warning("Tavily search failed: %s", type(exc).__name__)
        return []

    results = []
    for item in data.get("results", [])[:max_results]:
        results.append(
            {
                "title": item.get("title", ""),
                "url": item.get("url", ""),
                "content": item.get("content", ""),
                # Tavily's own relevance score (0..1); used for ranking, kept optional.
                "score": item.get("score"),
            }
        )
    return results


@tool
def web_search(query: str) -> str:
    """Search the web for up-to-date information on a query.

    Results are ranked by source authority (academic, scientific, reference, and
    standards sources rank above blogs/forums) blended with search relevance.

    Args:
        query: The search query.

    Returns:
        A JSON string of the top results (title, url, content, authority_tier).
    """
    results = _tavily_search(query)
    ranked = research_ranking.rank_sources(
        results,
        max_sources=max(len(results), 1),
        authority_weight=config.RESEARCH_AUTHORITY_WEIGHT,
    )
    if config.RESEARCH_TRUSTED_ONLY:
        ranked = research_ranking.filter_trusted(ranked) or ranked
    return json.dumps(ranked[: config.TAVILY_RESULTS_PER_QUERY])


@tool
def research_topic(topic: str, depth: str = "standard") -> str:
    """Research a topic by running several varied web searches and synthesizing them.

    Sources are deduplicated and then ranked by domain authority (academic,
    scientific, reference, and standards sources are favored over blogs and forums)
    blended with search relevance, so the most credible material is surfaced first
    and used to ground the lecture.

    Args:
        topic: The subject to research.
        depth: "quick" (3 searches), "standard" (5), or "deep" (8 searches).

    Returns:
        A JSON string with ranked, credibility-tagged sources and a tier breakdown.
    """
    n_by_depth = {"quick": 3, "standard": 5, "deep": 8}
    n_searches = min(n_by_depth.get(depth, 5), config.MAX_SEARCHES_PER_LECTURE)

    # Varied angles, including ones biased toward authoritative material (textbooks,
    # lecture notes, peer-reviewed research). Trimmed to the number of searches.
    angles = [
        topic,
        f"{topic} explained with examples",
        f"{topic} key concepts",
        f"{topic} textbook overview",
        f"{topic} university lecture notes",
        f"{topic} peer-reviewed research",
        f"{topic} common misconceptions",
        f"{topic} recent developments",
    ][:n_searches]

    seen_urls: set[str] = set()
    collected: list[dict[str, Any]] = []
    for angle in angles:
        for result in _tavily_search(angle):
            url = result.get("url", "")
            if url and url not in seen_urls:
                seen_urls.add(url)
                collected.append(result)

    # Rank the full set first, then (optionally) keep only trusted tiers, then cap —
    # so trusted filtering doesn't get pre-empted by the source cap.
    ranked_all = research_ranking.rank_sources(
        collected,
        max_sources=max(len(collected), 1),
        authority_weight=config.RESEARCH_AUTHORITY_WEIGHT,
    )
    if config.RESEARCH_TRUSTED_ONLY:
        trusted = research_ranking.filter_trusted(ranked_all)
        ranked_all = trusted or ranked_all  # fall back so a lecture is never blocked
    ranked = ranked_all[: config.RESEARCH_MAX_SOURCES]

    tier_breakdown: dict[str, int] = {}
    for src in ranked:
        tier = src.get("authority_tier", "general")
        tier_breakdown[tier] = tier_breakdown.get(tier, 0) + 1

    return json.dumps(
        {
            "topic": topic,
            "searches_run": len(angles),
            "sources_found": len(collected),
            "source_count": len(ranked),
            "trusted_only": config.RESEARCH_TRUSTED_ONLY,
            "tier_breakdown": tier_breakdown,
            "sources": ranked,
        }
    )
