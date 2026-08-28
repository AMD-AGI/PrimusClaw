# Copyright Advanced Micro Devices, Inc.
# SPDX-License-Identifier: MIT

"""KB activation engine.

Implements the 4-layer activation pipeline described in
``docs/claw-memory-service-kb-extension-design.md`` (§4):

    Layer 0 — Hard tag-match (SQL fetch + Python score)
    Layer 1 — Associative spread (1-hop backlinks)
    Layer 2 — Lifecycle reweight (importance × frequency × success × recency)
    Layer 3 — Budget cap + suppression (contradicts × 0.3, token cap)

The algorithm is fully deterministic for a given ``(ActivationContext,
KB state, request params)`` triple. All intermediate counts are surfaced
through ``stats`` and per-article weight breakdowns are returned when
``include_debug=True``.

This module is pure ``async`` Python with no FastAPI / pydantic
dependency, which makes it trivial to test in isolation: substitute a
mock store with ``kb_org_candidates`` / ``kb_fetch_by_slugs`` methods.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Iterable, List, Mapping, Optional, Protocol, Tuple


# ── Tunable constants ─────────────────────────────────────────────────────

# Half-life for lifecycle decay in days (e^{-dt/HALF_LIFE_DAYS}).
_HALF_LIFE_DAYS: float = 30.0

# Floor + ceiling on the recency factor.
_RECENCY_MIN: float = 0.1
_RECENCY_NULL_DEFAULT: float = 0.7

# Suppression multiplier for rows targeted by ``contradicts`` edges.
_CONTRADICT_SUPPRESS: float = 0.3

# Layer 1 spread weight: 0.3 × max(seed.w_l0 that points to this target).
_SPREAD_WEIGHT: float = 0.3


# ── Data shapes ───────────────────────────────────────────────────────────

@dataclass
class ActivationContext:
    """Multi-dimensional vector describing a session's deployment."""

    org: str
    framework: Optional[str] = None
    model: Optional[str] = None
    model_family: Optional[str] = None
    workload: Optional[str] = None
    precision: Optional[str] = None
    scale: Optional[str] = None
    objective: Optional[str] = None

    @classmethod
    def from_dict(cls, d: Mapping[str, Any]) -> "ActivationContext":
        if not d.get("org"):
            raise ValueError("activation_context.org is required")
        return cls(
            org=str(d["org"]),
            framework=_str_or_none(d.get("framework")),
            model=_str_or_none(d.get("model")),
            model_family=_str_or_none(d.get("model_family")),
            workload=_str_or_none(d.get("workload")),
            precision=_str_or_none(d.get("precision")),
            scale=_str_or_none(d.get("scale")),
            objective=_str_or_none(d.get("objective")),
        )


@dataclass
class _Candidate:
    """Internal accumulator for an activation candidate."""

    row: dict
    layer: str
    w_l0: float = 0.0
    final_w: float = 0.0
    breakdown: dict = field(default_factory=dict)
    suppressed_by: list = field(default_factory=list)


class _StoreLike(Protocol):
    async def kb_org_candidates(
        self,
        *,
        org: str,
        kinds: Optional[list[str]] = None,
        candidate_cap: int = 200,
    ) -> list[dict]: ...

    async def kb_fetch_by_slugs(
        self,
        *,
        org: str,
        slugs: list[str],
    ) -> list[dict]: ...


# ── Public entry point ────────────────────────────────────────────────────

async def activate(
    store: _StoreLike,
    ac: ActivationContext,
    *,
    budget_tokens: int = 6000,
    max_articles: int = 30,
    min_weight: float = 0.10,
    kinds: Optional[Iterable[str]] = None,
    include_debug: bool = False,
    candidate_cap: int = 200,
    now: Optional[datetime] = None,
) -> dict:
    """Run the 4-layer activation engine.

    Returns a dict shaped like the ``/api/kb/activate`` response in the
    design doc::

        {
            "working_set": [<entry_dict_with_weight_layer>...],
            "stats":       {<counts>},
            "debug":       Optional[<per_article_breakdowns>],
        }
    """
    kinds_list = sorted({str(k) for k in kinds}) if kinds else None
    now = now or datetime.now(timezone.utc)

    # Layer 0: org-bounded candidate pool, then per-row max-level scoring.
    org_pool = await store.kb_org_candidates(
        org=ac.org,
        kinds=kinds_list,
        candidate_cap=candidate_cap,
    )
    seeds: list[_Candidate] = []
    for row in org_pool:
        w_l0, layer = _layer0_match(row.get("scope") or {}, ac)
        if layer == "none":
            continue
        seeds.append(_Candidate(row=row, layer=layer, w_l0=w_l0))

    after_layer0 = len(seeds)

    # Layer 1: 1-hop backlinks. Spread targets are slugs of org-scoped rows
    # not already in the seed set.
    spread = await _layer1_spread(store, ac, seeds, candidate_cap)
    candidates = seeds + spread
    after_spread = len(candidates)

    # Layer 2: lifecycle reweight — applies to every candidate (seeds and
    # spread). Spread rows already have ``w_l0`` = 0.3 × max(seed.w_l0)
    # populated by Layer 1.
    for cand in candidates:
        _apply_layer2(cand, now=now, include_debug=include_debug)
    after_lifecycle = len(candidates)

    # Layer 3: contradiction suppression + budget cap.
    suppressed_count = _layer3_suppress(candidates)
    candidates.sort(key=lambda c: c.final_w, reverse=True)

    working_set, tokens_used = _layer3_budget(
        candidates,
        budget_tokens=budget_tokens,
        max_articles=max_articles,
        min_weight=min_weight,
    )

    stats = {
        "total_candidates":         len(org_pool),
        "after_layer0":             after_layer0,
        "after_spread":             after_spread,
        "after_lifecycle":          after_lifecycle,
        "after_budget":             len(working_set),
        "tokens_used":              tokens_used,
        "suppressed_by_contradicts": suppressed_count,
    }

    debug: Optional[list] = None
    if include_debug:
        debug = [
            {
                "id":            c.row.get("memory_id"),
                "slug":          c.row.get("slug"),
                "layer":         c.layer,
                "w_l0":          round(c.w_l0, 4),
                "final_w":       round(c.final_w, 4),
                "breakdown":     {k: round(v, 4) for k, v in c.breakdown.items()},
                "suppressed_by": list(c.suppressed_by),
            }
            for c in candidates
        ]

    return {
        "working_set": [_format_working_set_entry(c) for c in working_set],
        "stats":       stats,
        "debug":       debug,
    }


# ── Layer 0: hard tag-match ───────────────────────────────────────────────

def _layer0_match(scope: Mapping[str, Any], ac: ActivationContext) -> Tuple[float, str]:
    """Return ``(w_l0, layer)`` for the highest-matching level.

    Match levels (highest wins):

    - exact:  scope ⊇ {framework, model, workload, precision} (requires all 4 in AC)
    - strong: scope ⊇ {framework, model}
    - family: scope ⊇ {framework, model_family, workload} OR
              scope ⊇ {model_family, workload}
    - weak:   scope ⊇ {framework} OR {model} OR {model_family}
    - none:   only ``scope ⊇ {org}`` matches (filtered out)
    """
    if not _scope_contains(scope, {"org": ac.org}):
        return 0.0, "none"

    exact_keys = {"framework", "model", "workload", "precision"}
    if all(getattr(ac, k) for k in exact_keys):
        if _scope_contains(scope, {k: getattr(ac, k) for k in exact_keys}):
            return 1.00, "exact"

    if ac.framework and ac.model and _scope_contains(
        scope, {"framework": ac.framework, "model": ac.model}
    ):
        return 0.70, "strong"

    if ac.workload and ac.model_family:
        if ac.framework and _scope_contains(
            scope,
            {
                "framework":    ac.framework,
                "model_family": ac.model_family,
                "workload":     ac.workload,
            },
        ):
            return 0.40, "family"
        if _scope_contains(
            scope, {"model_family": ac.model_family, "workload": ac.workload}
        ):
            return 0.40, "family"

    for key in ("framework", "model", "model_family"):
        val = getattr(ac, key)
        if val and _scope_contains(scope, {key: val}):
            return 0.20, "weak"

    return 0.0, "none"


def _scope_contains(scope: Mapping[str, Any], required: Mapping[str, Any]) -> bool:
    """Pure-python emulation of JSONB ``@>`` for shallow string maps."""
    for k, v in required.items():
        if scope.get(k) != v:
            return False
    return True


# ── Layer 1: associative spread ───────────────────────────────────────────

async def _layer1_spread(
    store: _StoreLike,
    ac: ActivationContext,
    seeds: list[_Candidate],
    candidate_cap: int,
) -> list[_Candidate]:
    if not seeds:
        return []

    seed_slugs = {c.row.get("slug") for c in seeds if c.row.get("slug")}

    # Map: target_slug -> [seed_candidates that backlink to it]
    targets: dict[str, list[_Candidate]] = {}
    for seed in seeds:
        for tgt in (seed.row.get("edges") or {}).get("backlinks") or []:
            tgt = str(tgt)
            if tgt in seed_slugs or not tgt:
                continue
            targets.setdefault(tgt, []).append(seed)

    if not targets:
        return []

    target_slugs = list(targets.keys())[:candidate_cap]
    rows = await store.kb_fetch_by_slugs(org=ac.org, slugs=target_slugs)

    spread: list[_Candidate] = []
    for row in rows:
        slug = row.get("slug")
        if not slug:
            continue
        sources = targets.get(slug) or []
        if not sources:
            continue
        max_seed_w = max(s.w_l0 for s in sources)
        spread.append(
            _Candidate(
                row=row,
                layer="spread",
                w_l0=_SPREAD_WEIGHT * max_seed_w,
            )
        )
    return spread


# ── Layer 2: lifecycle reweight ───────────────────────────────────────────

def _apply_layer2(cand: _Candidate, *, now: datetime, include_debug: bool) -> None:
    importance = float(cand.row.get("importance") or 0.0)
    importance_factor = max(0.1, min(1.0, importance))

    access_count = int(cand.row.get("access_count") or 0)
    freq_factor = 1.0 + math.log1p(max(0, access_count)) / 10.0

    success = cand.row.get("success_rate")
    success_factor = float(success) if success is not None else 0.5

    last_accessed = _parse_ts(cand.row.get("last_accessed"))
    if last_accessed is None:
        recency_factor = _RECENCY_NULL_DEFAULT
    else:
        dt_days = max(0.0, (now - last_accessed).total_seconds() / 86400.0)
        recency_factor = max(_RECENCY_MIN, math.exp(-dt_days / _HALF_LIFE_DAYS))

    cand.final_w = (
        cand.w_l0
        * importance_factor
        * freq_factor
        * success_factor
        * recency_factor
    )
    if include_debug:
        cand.breakdown = {
            "w_l0":              cand.w_l0,
            "importance_factor": importance_factor,
            "freq_factor":       freq_factor,
            "success_factor":    success_factor,
            "recency_factor":    recency_factor,
        }


# ── Layer 3: suppression + budget cap ─────────────────────────────────────

def _layer3_suppress(candidates: list[_Candidate]) -> int:
    by_slug: dict[str, _Candidate] = {}
    for c in candidates:
        slug = c.row.get("slug")
        if slug:
            by_slug[slug] = c

    suppressed: set[str] = set()
    for c in candidates:
        edges = c.row.get("edges") or {}
        for tgt_slug in edges.get("contradicts") or []:
            tgt = by_slug.get(str(tgt_slug))
            if tgt is None:
                continue
            tgt.final_w *= _CONTRADICT_SUPPRESS
            tgt.suppressed_by.append(c.row.get("slug") or c.row.get("memory_id"))
            suppressed.add(str(tgt.row.get("memory_id")))
    return len(suppressed)


def _layer3_budget(
    candidates: list[_Candidate],
    *,
    budget_tokens: int,
    max_articles: int,
    min_weight: float,
) -> Tuple[List[_Candidate], int]:
    """Sorted-greedy budget cap. Skips entries that would overflow the token
    budget but does not break — a small entry behind a large one can still
    fit. Stops as soon as ``min_weight`` cuts in or ``max_articles`` is
    reached."""
    selected: list[_Candidate] = []
    tokens_used = 0
    for cand in candidates:
        if cand.final_w < min_weight:
            break
        if len(selected) >= max_articles:
            break
        cost = max(1, len(cand.row.get("content") or "") // 4)
        if tokens_used + cost > budget_tokens:
            continue
        selected.append(cand)
        tokens_used += cost
    return selected, tokens_used


# ── Output formatting ─────────────────────────────────────────────────────

def _format_working_set_entry(cand: _Candidate) -> dict:
    """Slim entry shape for the ``working_set`` array.

    Keeps the same field names as ``_wrap_kb_entry`` so the agent can use
    a single deserializer for both ``/api/kb/list`` and
    ``/api/kb/activate``.
    """
    row = cand.row
    return {
        "id":            row.get("memory_id"),
        "kind":          row.get("kind"),
        "slug":          row.get("slug"),
        "scope":         row.get("scope") or {},
        "scopePath":     row.get("scope_path") or "",
        "content":       row.get("content"),
        "importance":    row.get("importance"),
        "access_count":  row.get("access_count", 0),
        "last_accessed": row.get("last_accessed"),
        "success_rate":  row.get("success_rate"),
        "edges":         row.get("edges") or {},
        "metadata":      row.get("metadata") or {},
        "weight":        round(cand.final_w, 4),
        "layer":         cand.layer,
    }


# ── Helpers ───────────────────────────────────────────────────────────────

def _str_or_none(v: Any) -> Optional[str]:
    if v is None:
        return None
    s = str(v).strip()
    return s or None


def _parse_ts(v: Any) -> Optional[datetime]:
    if v is None:
        return None
    if isinstance(v, datetime):
        return v if v.tzinfo else v.replace(tzinfo=timezone.utc)
    if isinstance(v, str) and v:
        try:
            dt = datetime.fromisoformat(v.replace("Z", "+00:00"))
        except ValueError:
            return None
        return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
    return None
