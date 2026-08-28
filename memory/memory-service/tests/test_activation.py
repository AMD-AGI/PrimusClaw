# Copyright Advanced Micro Devices, Inc.
# SPDX-License-Identifier: MIT

"""End-to-end tests for the 4-layer KB activation engine.

The tests stand up a tiny in-memory ``FakeStore`` matching the store
protocol consumed by ``activation.activate`` so the algorithm can be
exercised without a real Postgres instance. The fixtures intentionally
mirror the design-doc example (deepseek-r1-fp8 on sglang/decode) so the
expected layer assignments are easy to reason about.
"""

from __future__ import annotations

import asyncio
import math
import os
import sys
from datetime import datetime, timedelta, timezone
from typing import Optional

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.normpath(os.path.join(HERE, "..", "src"))
if SRC not in sys.path:
    sys.path.insert(0, SRC)

from claw_memory.storage.activation import (  # noqa: E402
    ActivationContext,
    _layer0_match,
    activate,
)


# ── Test doubles ─────────────────────────────────────────────────────────

class FakeStore:
    """Minimal stand-in for ``PostgresMemoryStore`` covering the two
    methods consumed by the activation engine."""

    def __init__(self, rows: list[dict]) -> None:
        self.rows = rows
        self.calls: list[str] = []

    async def kb_org_candidates(
        self,
        *,
        org: str,
        kinds: Optional[list[str]] = None,
        candidate_cap: int = 200,
    ) -> list[dict]:
        self.calls.append("org_candidates")
        out = [r for r in self.rows if (r.get("scope") or {}).get("org") == org]
        if kinds:
            out = [r for r in out if r.get("kind") in set(kinds)]
        # Match the storage layer's stable ordering for determinism.
        out.sort(
            key=lambda r: (
                -(r.get("importance") or 0.0),
                -(r.get("access_count") or 0),
                r.get("updated_at") or "",
            )
        )
        return out[:candidate_cap]

    async def kb_fetch_by_slugs(
        self,
        *,
        org: str,
        slugs: list[str],
    ) -> list[dict]:
        self.calls.append("fetch_by_slugs")
        slug_set = set(slugs)
        return [
            r for r in self.rows
            if r.get("slug") in slug_set
            and (r.get("scope") or {}).get("org") == org
        ]


def _row(
    *,
    memory_id: str,
    kind: str,
    slug: str,
    scope: dict,
    content: str = "x" * 200,           # ~50 token cost by /4 estimator
    importance: float = 0.5,
    access_count: int = 0,
    last_accessed: Optional[str] = None,
    success_rate: Optional[float] = None,
    edges: Optional[dict] = None,
) -> dict:
    return {
        "memory_id":     memory_id,
        "kind":          kind,
        "slug":          slug,
        "scope":         scope,
        "content":       content,
        "importance":    importance,
        "access_count":  access_count,
        "last_accessed": last_accessed,
        "success_rate":  success_rate,
        "edges":         edges or {},
        "metadata":      {},
        "created_at":    "2026-05-01T00:00:00+00:00",
        "updated_at":    "2026-05-01T00:00:00+00:00",
        "scope_path":    "",
    }


# ── Layer 0: hard tag-match ──────────────────────────────────────────────

class TestLayer0Match:
    def _ac(self, **overrides) -> ActivationContext:
        defaults = dict(
            org="hyperloom",
            framework="sglang",
            model="deepseek-r1-0528-fp8",
            model_family="deepseek",
            workload="decode",
            precision="fp8",
        )
        defaults.update(overrides)
        return ActivationContext(**defaults)

    def test_exact_match(self) -> None:
        scope = {
            "org": "hyperloom", "framework": "sglang",
            "model": "deepseek-r1-0528-fp8", "workload": "decode",
            "precision": "fp8",
        }
        w, layer = _layer0_match(scope, self._ac())
        assert layer == "exact"
        assert w == 1.00

    def test_strong_match_when_workload_or_precision_missing_in_scope(self) -> None:
        scope = {
            "org": "hyperloom", "framework": "sglang",
            "model": "deepseek-r1-0528-fp8",
        }
        w, layer = _layer0_match(scope, self._ac())
        assert layer == "strong"
        assert w == 0.70

    def test_family_match_with_framework(self) -> None:
        scope = {
            "org": "hyperloom", "framework": "sglang",
            "model_family": "deepseek", "workload": "decode",
        }
        w, layer = _layer0_match(scope, self._ac())
        assert layer == "family"
        assert w == 0.40

    def test_family_match_without_framework(self) -> None:
        scope = {
            "org": "hyperloom",
            "model_family": "deepseek", "workload": "decode",
        }
        w, layer = _layer0_match(scope, self._ac())
        assert layer == "family"
        assert w == 0.40

    def test_weak_match(self) -> None:
        scope = {"org": "hyperloom", "model_family": "deepseek"}
        w, layer = _layer0_match(scope, self._ac())
        assert layer == "weak"
        assert w == 0.20

    def test_only_org_filtered_out(self) -> None:
        scope = {"org": "hyperloom"}
        w, layer = _layer0_match(scope, self._ac())
        assert layer == "none"
        assert w == 0.0

    def test_different_org_filtered_out(self) -> None:
        scope = {
            "org": "claw", "framework": "sglang",
            "model": "deepseek-r1-0528-fp8", "workload": "decode",
            "precision": "fp8",
        }
        w, layer = _layer0_match(scope, self._ac())
        assert layer == "none"
        assert w == 0.0

    def test_exact_requires_all_four_fields_in_ac(self) -> None:
        scope = {
            "org": "hyperloom", "framework": "sglang",
            "model": "deepseek-r1-0528-fp8",
        }
        ac = self._ac(workload=None, precision=None)
        w, layer = _layer0_match(scope, ac)
        # Falls back to strong when AC has no workload/precision to assert.
        assert layer == "strong"


# ── End-to-end activation ────────────────────────────────────────────────

def _ac_dict() -> dict:
    return {
        "org":          "hyperloom",
        "framework":    "sglang",
        "model":        "deepseek-r1-0528-fp8",
        "model_family": "deepseek",
        "workload":     "decode",
        "precision":    "fp8",
        "scale":        "8xMI300",
        "objective":    "throughput",
    }


class TestActivateE2E:
    def setup_method(self) -> None:
        self.now = datetime(2026, 5, 7, 12, 0, 0, tzinfo=timezone.utc)
        # Mix of layer levels + spread target + cross-org noise.
        self.rows = [
            _row(  # exact match
                memory_id="mem_exact_1",
                kind="pitfall",
                slug="torch-compile-incompatible-mla-fp8",
                scope={
                    "org": "hyperloom", "framework": "sglang",
                    "model": "deepseek-r1-0528-fp8",
                    "workload": "decode", "precision": "fp8",
                },
                importance=0.9,
                access_count=10,
                last_accessed=self.now.isoformat(),
                edges={"backlinks": ["mla-fp8-incompatibility"]},
            ),
            _row(  # strong match
                memory_id="mem_strong_1",
                kind="technique",
                slug="sglang-cuda-graph-tuning",
                scope={
                    "org": "hyperloom", "framework": "sglang",
                    "model": "deepseek-r1-0528-fp8",
                },
                importance=0.7,
                last_accessed=self.now.isoformat(),
            ),
            _row(  # family match
                memory_id="mem_family_1",
                kind="technique",
                slug="deepseek-decode-tricks",
                scope={
                    "org": "hyperloom", "framework": "sglang",
                    "model_family": "deepseek", "workload": "decode",
                },
                importance=0.6,
                last_accessed=self.now.isoformat(),
            ),
            _row(  # weak match
                memory_id="mem_weak_1",
                kind="pitfall",
                slug="some-other-deepseek-pitfall",
                scope={"org": "hyperloom", "model_family": "deepseek"},
                importance=0.5,
                last_accessed=self.now.isoformat(),
            ),
            _row(  # spread target — referenced by the exact match's backlinks
                memory_id="mem_spread_target",
                kind="model_profile",
                slug="mla-fp8-incompatibility",
                scope={"org": "hyperloom"},
                importance=0.8,
                last_accessed=self.now.isoformat(),
            ),
            _row(  # cross-org noise — must be filtered out
                memory_id="mem_other_org",
                kind="technique",
                slug="claw-memory-tricks",
                scope={"org": "claw", "user": "abc"},
                importance=0.9,
                last_accessed=self.now.isoformat(),
            ),
            _row(  # below-threshold weight after reweight
                memory_id="mem_lowimp",
                kind="pitfall",
                slug="lowimp-pitfall",
                scope={"org": "hyperloom", "framework": "sglang"},
                importance=0.1,
                # very stale: recency factor floors at 0.1.
                last_accessed=(self.now - timedelta(days=3650)).isoformat(),
            ),
        ]
        self.store = FakeStore(self.rows)

    def _run(self, **kwargs) -> dict:
        ac = ActivationContext.from_dict(_ac_dict())
        return asyncio.run(activate(self.store, ac, now=self.now, **kwargs))

    def test_layer_assignment(self) -> None:
        out = self._run(min_weight=0.0)
        layers = {e["id"]: e["layer"] for e in out["working_set"]}
        assert layers.get("mem_exact_1")        == "exact"
        assert layers.get("mem_strong_1")       == "strong"
        assert layers.get("mem_family_1")       == "family"
        assert layers.get("mem_weak_1")         == "weak"
        assert layers.get("mem_spread_target")  == "spread"
        # Cross-org row never appears.
        assert "mem_other_org" not in layers

    def test_stats_counts(self) -> None:
        out = self._run(min_weight=0.0)
        s = out["stats"]
        assert s["total_candidates"] == 6  # all hyperloom rows
        # 4 layer-0 hits (exact/strong/family/weak) + 1 below-min later.
        # Layer 0 also keeps mem_lowimp because framework=sglang gives weak.
        assert s["after_layer0"] >= 5
        # Spread adds the spread target.
        assert s["after_spread"] == s["after_layer0"] + 1
        assert s["after_lifecycle"] == s["after_spread"]
        assert s["after_budget"] == len(out["working_set"])

    def test_min_weight_filters_low_weight(self) -> None:
        out = self._run(min_weight=0.20)
        ids = {e["id"] for e in out["working_set"]}
        # mem_lowimp has importance=0.1 + 10y old → below 0.20.
        assert "mem_lowimp" not in ids

    def test_max_articles_caps_output(self) -> None:
        out = self._run(min_weight=0.0, max_articles=2)
        assert len(out["working_set"]) == 2
        assert out["stats"]["after_budget"] == 2

    def test_budget_tokens_caps_output(self) -> None:
        # Each row content is ~200 chars → 50 tokens.
        out = self._run(min_weight=0.0, budget_tokens=120)
        # Sum of tokens picked must not exceed the budget.
        assert out["stats"]["tokens_used"] <= 120
        assert len(out["working_set"]) <= 3

    def test_kinds_filter_restricts_layer0_pool(self) -> None:
        out = self._run(min_weight=0.0, kinds=["pitfall"])
        # ``kinds`` restricts the Layer 0 candidate pool. Layer 1 spread
        # by design follows ``edges.backlinks`` regardless of kind, so the
        # working set may include other kinds via the spread layer (this
        # matches §4.3 of the design doc).
        seed_kinds = {e["kind"] for e in out["working_set"] if e["layer"] != "spread"}
        assert seed_kinds.issubset({"pitfall"})

    def test_results_sorted_by_weight_desc(self) -> None:
        out = self._run(min_weight=0.0)
        weights = [e["weight"] for e in out["working_set"]]
        assert weights == sorted(weights, reverse=True)

    def test_exact_dominates_weak_after_lifecycle(self) -> None:
        out = self._run(min_weight=0.0)
        ws = {e["id"]: e["weight"] for e in out["working_set"]}
        # Exact match must score higher than weak match for the same recency.
        assert ws["mem_exact_1"] > ws["mem_weak_1"]

    def test_debug_breakdowns(self) -> None:
        out = self._run(min_weight=0.0, include_debug=True)
        assert out["debug"] is not None
        # Each debug entry sums up the documented breakdown fields.
        for d in out["debug"]:
            br = d["breakdown"]
            for k in ("w_l0", "importance_factor", "freq_factor",
                      "success_factor", "recency_factor"):
                assert k in br
            recomputed = (
                br["w_l0"] * br["importance_factor"] * br["freq_factor"]
                * br["success_factor"] * br["recency_factor"]
            )
            assert math.isclose(recomputed, d["final_w"], rel_tol=1e-3)

    def test_deterministic_for_same_inputs(self) -> None:
        out1 = self._run(min_weight=0.0)
        out2 = self._run(min_weight=0.0)
        ids1 = [e["id"] for e in out1["working_set"]]
        ids2 = [e["id"] for e in out2["working_set"]]
        assert ids1 == ids2


# ── Suppression by contradicts ───────────────────────────────────────────

class TestContradictsSuppression:
    def test_contradicted_row_downweighted(self) -> None:
        now = datetime(2026, 5, 7, 12, 0, 0, tzinfo=timezone.utc)
        ac = ActivationContext(
            org="hyperloom",
            framework="sglang",
            model="m1",
            model_family="m1f",
            workload="decode",
            precision="fp8",
        )
        rows = [
            _row(  # exact match, importance 0.5; will contradict the second row.
                memory_id="mem_a",
                kind="pitfall",
                slug="slug-a",
                scope={
                    "org": "hyperloom", "framework": "sglang",
                    "model": "m1", "workload": "decode", "precision": "fp8",
                },
                importance=0.5,
                last_accessed=now.isoformat(),
                edges={"contradicts": ["slug-b"]},
            ),
            _row(  # exact match, slightly higher importance — would normally
                memory_id="mem_b",
                kind="pitfall",
                slug="slug-b",
                scope={
                    "org": "hyperloom", "framework": "sglang",
                    "model": "m1", "workload": "decode", "precision": "fp8",
                },
                importance=0.55,
                last_accessed=now.isoformat(),
            ),
        ]
        out = asyncio.run(
            activate(FakeStore(rows), ac, now=now, min_weight=0.0)
        )
        ws = {e["id"]: e["weight"] for e in out["working_set"]}
        # mem_b downweighted by 0.3 → mem_a now scores higher despite lower
        # raw importance.
        assert ws["mem_a"] > ws["mem_b"]
        assert out["stats"]["suppressed_by_contradicts"] == 1


# ── Activation context parsing ───────────────────────────────────────────

class TestActivationContextFromDict:
    def test_org_required(self) -> None:
        try:
            ActivationContext.from_dict({})
        except ValueError as e:
            assert "org" in str(e)
        else:  # pragma: no cover
            raise AssertionError("expected ValueError")

    def test_optional_fields_default_to_none(self) -> None:
        ac = ActivationContext.from_dict({"org": "hyperloom"})
        assert ac.org == "hyperloom"
        assert ac.framework is None
        assert ac.model is None
