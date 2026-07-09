"""Source-quality ranking for research results.

Pure, dependency-free (stdlib only) so it can be unit-tested without the agent
runtime. Given raw search results, it scores each source by domain authority
(favoring academic, scientific, reference, and standards sources over blogs and
forums) blended with the search engine's own relevance score, then ranks them so
the most credible material is used first.

The tiers/lists are deliberately editable — extend them as you learn which sources
produce the best lectures.
"""
from __future__ import annotations

from typing import Any
from urllib.parse import urlsplit

# --- Authority tiers: (score 0..1, label). Higher = more trustworthy for teaching. ---
TIER_ACADEMIC = (1.0, "academic")        # peer-reviewed, universities, government
TIER_REFERENCE = (0.85, "reference")     # encyclopedias of record, standards bodies
TIER_ENCYCLOPEDIC = (0.65, "encyclopedic")  # wikipedia, official technical docs
TIER_MEDIA = (0.5, "media")              # reputable outlets / established orgs
TIER_GENERAL = (0.3, "general")          # unknown but not obviously low quality
TIER_LOW = (0.12, "low")                 # forums, content farms, user blogs

# Domain *suffixes* that signal academic / governmental origin worldwide.
_ACADEMIC_SUFFIXES = (
    ".edu", ".gov", ".mil", ".ac.uk", ".edu.au", ".ac.jp", ".edu.cn", ".ac.nz",
    ".edu.sg", ".ac.in", ".edu.br", ".ac.za", ".gov.uk", ".europa.eu",
)

# Explicit domain -> tier. Compared against the registered host (www. stripped).
_ACADEMIC_DOMAINS = {
    "arxiv.org", "biorxiv.org", "medrxiv.org", "ssrn.com", "semanticscholar.org",
    "ncbi.nlm.nih.gov", "pubmed.ncbi.nlm.nih.gov", "pmc.ncbi.nlm.nih.gov",
    "nature.com", "science.org", "sciencedirect.com", "springer.com",
    "link.springer.com", "wiley.com", "onlinelibrary.wiley.com", "ieee.org",
    "ieeexplore.ieee.org", "acm.org", "dl.acm.org", "jstor.org", "cambridge.org",
    "oup.com", "academic.oup.com", "tandfonline.com", "plos.org", "pnas.org",
    "aps.org", "rsc.org", "cell.com", "thelancet.com", "nejm.org", "bmj.com",
    "ocw.mit.edu", "openstax.org",
}
_REFERENCE_DOMAINS = {
    "britannica.com", "ietf.org", "rfc-editor.org", "datatracker.ietf.org",
    "w3.org", "iso.org", "nist.gov", "who.int", "un.org", "worldbank.org",
    "khanacademy.org", "stanford.edu", "plato.stanford.edu",
    # Reputable educational / textbook / technical-teaching resources.
    "d2l.ai", "deeplearning.ai", "fast.ai", "distill.pub", "paperswithcode.com",
    "mathworld.wolfram.com", "ck12.org",
}
_ENCYCLOPEDIC_DOMAINS = {
    "en.wikipedia.org", "wikipedia.org", "simple.wikipedia.org",
    "developer.mozilla.org", "docs.python.org", "docs.oracle.com",
    "learn.microsoft.com", "kubernetes.io", "postgresql.org",
}
_MEDIA_DOMAINS = {
    "bbc.com", "bbc.co.uk", "reuters.com", "apnews.com", "nytimes.com",
    "economist.com", "theatlantic.com", "nationalgeographic.com",
    "scientificamerican.com", "smithsonianmag.com", "history.com",
}
_LOW_DOMAINS = {
    "quora.com", "reddit.com", "pinterest.com", "medium.com", "ehow.com",
    "w3schools.com", "tutorialspoint.com", "geeksforgeeks.org", "answers.com",
    "wikihow.com", "coursehero.com", "studocu.com", "brainly.com", "chegg.com",
}


def _host(url: str) -> str:
    try:
        host = urlsplit(url).netloc.lower()
    except ValueError:
        return ""
    if host.startswith("www."):
        host = host[4:]
    # strip port if present
    return host.split(":", 1)[0]


def score_domain(url: str) -> tuple[float, str]:
    """Return (authority_score, tier_label) for a URL's domain."""
    host = _host(url)
    if not host:
        return TIER_GENERAL

    if host in _ACADEMIC_DOMAINS or host.endswith(_ACADEMIC_SUFFIXES):
        return TIER_ACADEMIC
    if host in _REFERENCE_DOMAINS:
        return TIER_REFERENCE
    if host in _ENCYCLOPEDIC_DOMAINS:
        return TIER_ENCYCLOPEDIC
    if host in _MEDIA_DOMAINS:
        return TIER_MEDIA
    if host in _LOW_DOMAINS:
        return TIER_LOW
    return TIER_GENERAL


def rank_sources(
    results: list[dict[str, Any]],
    max_sources: int,
    authority_weight: float = 0.6,
) -> list[dict[str, Any]]:
    """Score, sort, and trim search results by blended authority + relevance.

    Each input dict may carry a ``score`` (search-engine relevance, 0..1). The output
    preserves title/url/content and adds ``authority_score``, ``authority_tier``,
    ``relevance`` and ``rank_score``, sorted best-first and capped at ``max_sources``.
    """
    rel_weight = 1.0 - authority_weight
    scored: list[dict[str, Any]] = []
    for r in results:
        url = r.get("url", "")
        authority, tier = score_domain(url)
        try:
            relevance = float(r.get("score") or 0.0)
        except (TypeError, ValueError):
            relevance = 0.0
        relevance = max(0.0, min(1.0, relevance))
        rank_score = authority_weight * authority + rel_weight * relevance
        scored.append(
            {
                "title": r.get("title", ""),
                "url": url,
                "content": r.get("content", ""),
                "relevance": round(relevance, 4),
                "authority_score": authority,
                "authority_tier": tier,
                "rank_score": round(rank_score, 4),
            }
        )
    scored.sort(key=lambda s: s["rank_score"], reverse=True)
    return scored[:max_sources]


# Tiers considered "trusted" for trusted-sources-only mode. Includes encyclopedic so
# that Wikipedia and official docs (well-curated) still qualify alongside academic and
# reference sources; general/media/low are excluded.
TRUSTED_TIERS = {"academic", "reference", "encyclopedic"}


def trusted_domains() -> list[str]:
    """Explicit high-authority domains (academic + reference), sorted.

    Useful if you want to hard-restrict a search engine server-side (e.g. Tavily's
    ``include_domains``). Note this cannot express TLD patterns like ``.edu``/``.gov``,
    so it will miss universities/government sites — prefer ``filter_trusted`` for a
    complete trusted filter that honors those suffixes.
    """
    return sorted(_ACADEMIC_DOMAINS | _REFERENCE_DOMAINS)


def filter_trusted(sources: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Keep only sources whose authority_tier is in TRUSTED_TIERS.

    Operates on the output of ``rank_sources`` (which sets ``authority_tier``), so it
    correctly retains .edu/.gov sites picked up by suffix matching.
    """
    return [s for s in sources if s.get("authority_tier") in TRUSTED_TIERS]
