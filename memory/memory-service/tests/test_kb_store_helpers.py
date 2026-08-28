# Copyright Advanced Micro Devices, Inc.
# SPDX-License-Identifier: MIT

"""Unit tests for the KB extension helpers in postgres_store.py.

Pure-Python tests that do not touch a database.
"""

from __future__ import annotations

import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.normpath(os.path.join(HERE, "..", "src"))
if SRC not in sys.path:
    sys.path.insert(0, SRC)

from claw_memory.storage.postgres_store import (  # noqa: E402
    KB_FALLBACK_CATEGORY,
    KB_USER_SENTINEL,
    KB_VALID_KINDS,
    _merge_edges,
    _merge_metadata,
    _scope_to_string,
)


class TestKBConstants:
    def test_user_sentinel(self) -> None:
        assert KB_USER_SENTINEL == "__kb__"

    def test_fallback_category(self) -> None:
        assert KB_FALLBACK_CATEGORY == "env_fact"

    def test_valid_kinds(self) -> None:
        assert KB_VALID_KINDS == frozenset(
            {
                "model_profile",
                "technique",
                "pitfall",
                "params_catalog",
                "experience",
                "skill",
            }
        )

    def test_kinds_immutable(self) -> None:
        assert isinstance(KB_VALID_KINDS, frozenset)


class TestMergeEdges:
    def test_union_backlinks_dedupes(self) -> None:
        out = _merge_edges(
            {"backlinks": ["a", "b"]},
            {"backlinks": ["b", "c"]},
        )
        assert out["backlinks"] == ["a", "b", "c"]

    def test_union_contradicts_dedupes(self) -> None:
        out = _merge_edges(
            {"contradicts": ["x"]},
            {"contradicts": ["y", "x", "z"]},
        )
        assert out["contradicts"] == ["x", "y", "z"]

    def test_supersededby_overwrites_when_non_null(self) -> None:
        out = _merge_edges(
            {"superseded_by": "old-slug"},
            {"superseded_by": "new-slug"},
        )
        assert out["superseded_by"] == "new-slug"

    def test_supersededby_null_does_not_overwrite(self) -> None:
        out = _merge_edges(
            {"superseded_by": "keep-me"},
            {"superseded_by": None},
        )
        assert out["superseded_by"] == "keep-me"

    def test_does_not_mutate_inputs(self) -> None:
        cur = {"backlinks": ["a"]}
        add = {"backlinks": ["b"]}
        _merge_edges(cur, add)
        assert cur == {"backlinks": ["a"]}
        assert add == {"backlinks": ["b"]}

    def test_unknown_keys_pass_through_and_overwrite(self) -> None:
        out = _merge_edges({"backlinks": ["x"], "owner": "alice"}, {"owner": "bob"})
        assert out == {"backlinks": ["x"], "owner": "bob"}

    def test_none_current(self) -> None:
        out = _merge_edges(None, {"backlinks": ["a", "b"]})
        assert out == {"backlinks": ["a", "b"]}

    def test_empty_current_and_addition(self) -> None:
        assert _merge_edges({}, {}) == {}

    def test_only_addition_keys_appear(self) -> None:
        # If current has contradicts but addition only touches backlinks,
        # contradicts is preserved unchanged.
        out = _merge_edges(
            {"contradicts": ["x"]},
            {"backlinks": ["a"]},
        )
        assert out == {"contradicts": ["x"], "backlinks": ["a"]}

    def test_backlinks_empty_addition_preserves_existing(self) -> None:
        out = _merge_edges(
            {"backlinks": ["a", "b"]},
            {"backlinks": []},
        )
        # Empty addition still triggers the merge branch but produces the
        # same set as the current value.
        assert out["backlinks"] == ["a", "b"]


class TestMergeMetadata:
    def test_deep_merges_dicts(self) -> None:
        out = _merge_metadata(
            {"evidence": {"a": 1}, "owner": "old"},
            {"evidence": {"b": 2}},
        )
        assert out == {"evidence": {"a": 1, "b": 2}, "owner": "old"}

    def test_merges_lists_without_duplicates(self) -> None:
        out = _merge_metadata({"tags": ["a", "b"]}, {"tags": ["b", "c"]})
        assert out["tags"] == ["a", "b", "c"]

    def test_overwrites_scalar_values(self) -> None:
        out = _merge_metadata({"source_type": "old"}, {"source_type": "new"})
        assert out["source_type"] == "new"


class TestScopeStringWithKBKeys:
    """The legacy ``scopePath`` projection must include KB-extension keys
    in a deterministic order so any older client still rendering the
    string form sees stable values for KB rows."""

    def test_kb_scope_canonical_order(self) -> None:
        s = _scope_to_string(
            {
                "framework":    "sglang",
                "model":        "deepseek-r1-0528-fp8",
                "model_family": "deepseek",
                "workload":     "decode",
                "precision":    "fp8",
                "scale":        "8xMI300",
                "objective":    "throughput",
                "org":          "hyperloom",
            }
        )
        # ``org`` first (per _SCOPE_KEY_ORDER), then framework, then
        # model_family, then model, then workload/precision/scale/objective.
        assert s == (
            "org:hyperloom/framework:sglang/model_family:deepseek/"
            "model:deepseek-r1-0528-fp8/workload:decode/precision:fp8/"
            "scale:8xMI300/objective:throughput"
        )

    def test_legacy_scope_unchanged_by_extra_keys(self) -> None:
        # Adding new keys to the canonical order must not shift the
        # rendering of pre-existing memory scopes.
        assert _scope_to_string({"org": "claw", "user": "abc"}) == (
            "org:claw/user:abc"
        )
