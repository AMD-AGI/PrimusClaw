# Copyright Advanced Micro Devices, Inc.
# SPDX-License-Identifier: MIT

"""Unit tests for prompt_cache_hook.py.

The hook imports three names from litellm, which is far too heavy to install
for a unit test and whose real classes the hook never calls into. They are
stubbed for the duration of the import only, so a litellm that happens to be
installed is left alone.

    python3 -m unittest discover -s deploy/litellm/tests -v
"""

import asyncio
import copy
import importlib.util
import logging
import sys
import types
import unittest
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Optional

HOOK_PATH = Path(__file__).resolve().parent.parent / "prompt_cache_hook.py"
HEADER = "x-auto-prompt-caching"
EPHEMERAL = {"type": "ephemeral"}
EPHEMERAL_1H = {"type": "ephemeral", "ttl": "1h"}


@dataclass
class _Auth:
    metadata: dict = field(default_factory=dict)
    key_alias: Optional[str] = None


def _load_hook() -> types.ModuleType:
    class CustomLogger:  # the hook only subclasses it
        pass

    stubs = {
        "litellm": types.ModuleType("litellm"),
        "litellm.integrations": types.ModuleType("litellm.integrations"),
        "litellm.integrations.custom_logger": types.ModuleType(
            "litellm.integrations.custom_logger"
        ),
        "litellm.proxy": types.ModuleType("litellm.proxy"),
        "litellm.proxy.proxy_server": types.ModuleType("litellm.proxy.proxy_server"),
        "litellm.types": types.ModuleType("litellm.types"),
        "litellm.types.utils": types.ModuleType("litellm.types.utils"),
    }
    stubs["litellm.integrations.custom_logger"].CustomLogger = CustomLogger
    stubs["litellm.proxy.proxy_server"].DualCache = object
    stubs["litellm.proxy.proxy_server"].UserAPIKeyAuth = _Auth
    stubs["litellm.types.utils"].CallTypesLiteral = str

    saved = {name: sys.modules.get(name) for name in stubs}
    sys.modules.update(stubs)
    try:
        spec = importlib.util.spec_from_file_location("prompt_cache_hook_under_test", HOOK_PATH)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module
    finally:
        for name, original in saved.items():
            if original is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = original


hook = _load_hook()


def run_hook(data: dict, call_type: str = "anthropic_messages", auth: Any = None) -> dict:
    auth = _Auth() if auth is None else auth
    return asyncio.run(
        hook.proxy_handler_instance.async_pre_call_hook(auth, None, data, call_type)
    )


def tool(name: str, **extra: Any) -> dict:
    return {"name": name, "description": name, "input_schema": {"type": "object"}, **extra}


def text(value: str, **extra: Any) -> dict:
    return {"type": "text", "text": value, **extra}


def request(**over: Any) -> dict:
    """An Anthropic-native /v1/messages body that asks for caching the way the
    proxy delivers a client header on that route: under litellm_metadata."""
    data = {
        "model": "claude-opus-4-7",
        "tools": [tool("a"), tool("b")],
        "messages": [
            {"role": "user", "content": "first"},
            {"role": "assistant", "content": [text("ok")]},
            {"role": "user", "content": "second"},
        ],
        "litellm_metadata": {"headers": {HEADER: "true"}},
    }
    data.update(over)
    return data


class InjectionPlacement(unittest.TestCase):
    def test_marks_last_tool_and_the_message_before_the_last(self):
        data = request()
        want = copy.deepcopy(data)
        want["tools"][1]["cache_control"] = EPHEMERAL
        want["messages"][1]["content"][0]["cache_control"] = EPHEMERAL
        self.assertEqual(run_hook(data), want)

    def test_header_location_table(self):
        # Each place LiteLLM may leave the caller's headers.
        for label, where in (
            ("litellm_metadata", lambda d, h: d.update(litellm_metadata={"headers": h})),
            ("metadata", lambda d, h: d.update(metadata={"headers": h})),
            ("extra_headers", lambda d, h: d.update(extra_headers=h)),
        ):
            with self.subTest(label):
                data = request()
                data.pop("litellm_metadata")
                where(data, {HEADER.upper(): "true"})
                out = run_hook(data)
                self.assertEqual(out["tools"][1]["cache_control"], EPHEMERAL)
                self.assertEqual(out["messages"][1]["content"][0]["cache_control"], EPHEMERAL)

    def test_ttl_table(self):
        for value, marker in (
            ("true", EPHEMERAL),
            ("1", EPHEMERAL),
            ("5m", EPHEMERAL),
            ("1h", EPHEMERAL_1H),
            (" 1H ", EPHEMERAL_1H),
        ):
            with self.subTest(value):
                data = request(litellm_metadata={"headers": {HEADER: value}})
                out = run_hook(data)
                self.assertEqual(out["tools"][1]["cache_control"], marker)
                self.assertEqual(out["messages"][1]["content"][0]["cache_control"], marker)

    def test_markers_are_independent_copies(self):
        # A marker shared with the module constant would be edited for every
        # later request, and two placements sharing one dict would be edited
        # together.
        placements = (
            ("tool", request, lambda o: o["tools"][1]),
            ("block", request, lambda o: o["messages"][1]["content"][0]),
            (
                "converted string",
                lambda **kw: request(messages=[{"role": "user", "content": "only"}], **kw),
                lambda o: o["messages"][0]["content"][0],
            ),
        )
        for setting, constant in (
            ("true", hook.CACHE_CONTROL_EPHEMERAL),
            ("1h", hook.CACHE_CONTROL_EPHEMERAL_1H),
        ):
            for label, build, pick in placements:
                with self.subTest(f"{label} {setting}"):
                    out = run_hook(build(litellm_metadata={"headers": {HEADER: setting}}))
                    self.assertIsNot(pick(out)["cache_control"], constant)
            out = run_hook(request(litellm_metadata={"headers": {HEADER: setting}}))
            self.assertIsNot(out["tools"][1]["cache_control"], out["messages"][1]["content"][0]["cache_control"])

    def test_string_content_becomes_a_marked_block(self):
        data = request(messages=[{"role": "user", "content": "only"}])
        out = run_hook(data)
        self.assertEqual(
            out["messages"], [{"role": "user", "content": [text("only", cache_control=EPHEMERAL)]}]
        )

    def test_message_ending_in_thinking_is_marked_on_the_last_markable_block(self):
        thinking = {"type": "thinking", "thinking": "hm", "signature": "s"}
        data = request(
            messages=[
                {"role": "user", "content": "q"},
                {"role": "assistant", "content": [text("a"), thinking]},
                {"role": "user", "content": "q2"},
            ]
        )
        out = run_hook(data)
        self.assertEqual(
            out["messages"][1]["content"],
            [text("a", cache_control=EPHEMERAL), thinking],
        )

    def test_unmarkable_candidate_falls_back_to_the_next_message(self):
        thinking = {"type": "thinking", "thinking": "hm", "signature": "s"}
        data = request(
            messages=[
                {"role": "user", "content": "q"},
                {"role": "assistant", "content": [thinking]},
                {"role": "user", "content": "q2"},
            ]
        )
        out = run_hook(data)
        # -2 holds nothing that may carry a marker, so -3 takes it.
        self.assertEqual(out["messages"][1]["content"], [thinking])
        self.assertEqual(out["messages"][0]["content"], [text("q", cache_control=EPHEMERAL)])
        self.assertEqual(out["messages"][2]["content"], "q2")

    def test_existing_marker_on_the_target_block_is_kept(self):
        mine = {"type": "ephemeral", "ttl": "1h"}
        data = request(
            messages=[
                {"role": "user", "content": "q"},
                {"role": "assistant", "content": [text("a", cache_control=mine)]},
                {"role": "user", "content": "q2"},
            ]
        )
        out = run_hook(data)
        self.assertEqual(out["messages"][1]["content"], [text("a", cache_control=mine)])

    def test_messages_that_are_not_a_list_are_left_alone(self):
        data = request(messages="not a list")
        want = copy.deepcopy(data)
        self.assertEqual(run_hook(data), want)


class BlockEligibility(unittest.TestCase):
    def test_markable_types_table(self):
        # An allowlist: a marker on any other block type is a 400 upstream.
        for block_type, markable in (
            ("text", True),
            ("tool_use", True),
            ("tool_result", True),
            ("image", True),
            ("document", True),
            ("thinking", False),
            ("redacted_thinking", False),
            ("a_type_nobody_has_seen", False),
        ):
            with self.subTest(block_type):
                block = {"type": block_type}
                data = request(
                    messages=[
                        {"role": "user", "content": "q"},
                        {"role": "assistant", "content": [block]},
                        {"role": "user", "content": "q2"},
                    ]
                )
                out = run_hook(data)
                self.assertEqual("cache_control" in out["messages"][1]["content"][0], markable)
                # an unmarkable -2 is not forced: the marker moves back to -3
                earlier = out["messages"][0]["content"]
                moved_back = isinstance(earlier, list) and "cache_control" in earlier[0]
                self.assertEqual(moved_back, not markable)

    def test_marker_goes_on_the_last_markable_block_not_the_first(self):
        data = request(
            messages=[
                {"role": "user", "content": "q"},
                {"role": "assistant", "content": [text("one"), text("two")]},
                {"role": "user", "content": "q2"},
            ]
        )
        out = run_hook(data)
        self.assertEqual(out["messages"][1]["content"], [text("one"), text("two", cache_control=EPHEMERAL)])

    def test_non_dict_blocks_are_skipped(self):
        data = request(
            messages=[
                {"role": "user", "content": "q"},
                {"role": "assistant", "content": [text("one"), "stray", None]},
                {"role": "user", "content": "q2"},
            ]
        )
        out = run_hook(data)
        self.assertEqual(
            out["messages"][1]["content"],
            [text("one", cache_control=EPHEMERAL), "stray", None],
        )


class ToolEligibility(unittest.TestCase):
    def test_table(self):
        # (label, tools, indexes of the tools that end up carrying a marker)
        for label, tools, marked in (
            ("anthropic-native", [tool("a")], [0]),
            ("openai function", [{"type": "function", "function": {"name": "f"}}], [0]),
            ("custom", [{"type": "custom", "name": "c"}], [0]),
            ("empty type", [{"type": "", "name": "e"}], [0]),
            ("function key without a type", [{"function": {"name": "f"}}], [0]),
            ("server tool is walked past", [tool("a"), {"type": "web_search_20250305", "name": "w"}], [0]),
            ("tool_search is walked past", [tool("a"), {"type": "tool_search_tool_bm25", "name": "t"}], [0]),
            ("computer is walked past", [tool("a"), {"type": "computer_20250124", "name": "c"}], [0]),
            ("mcp is walked past", [tool("a"), {"type": "mcp", "name": "m"}], [0]),
            ("no recognisable shape", [{"name": "bare"}], []),
        ):
            with self.subTest(label):
                out = run_hook(request(tools=copy.deepcopy(tools)))
                got = [i for i, t in enumerate(out["tools"]) if "cache_control" in t]
                self.assertEqual(got, marked)

    def test_marker_already_on_a_tool_is_kept_and_nothing_else_is_marked(self):
        mine = {"type": "ephemeral", "ttl": "1h"}
        data = request(tools=[tool("a"), tool("b", cache_control=mine)])
        out = run_hook(data)
        self.assertNotIn("cache_control", out["tools"][0])
        self.assertEqual(out["tools"][1]["cache_control"], mine)

    def test_non_dict_tool_entries_are_skipped(self):
        data = request(tools=[tool("a"), "stray"])
        out = run_hook(data)
        self.assertEqual(out["tools"][0]["cache_control"], EPHEMERAL)
        self.assertEqual(out["tools"][1], "stray")

    def test_marker_on_the_function_body_counts(self):
        data = request(
            tools=[
                tool("a"),
                {"type": "function", "function": {"name": "f", "cache_control": EPHEMERAL}},
            ]
        )
        out = run_hook(data)
        self.assertNotIn("cache_control", out["tools"][0])
        self.assertNotIn("cache_control", out["tools"][1])


class BreakpointBudget(unittest.TestCase):
    def test_four_existing_markers_means_nothing_is_added(self):
        data = request(
            system=[text(str(i), cache_control=EPHEMERAL) for i in range(4)],
        )
        want = copy.deepcopy(data)
        self.assertEqual(run_hook(data), want)

    def test_one_slot_left_goes_to_the_messages_not_the_tools(self):
        data = request(system=[text(str(i), cache_control=EPHEMERAL) for i in range(3)])
        out = run_hook(data)
        self.assertNotIn("cache_control", out["tools"][1])
        self.assertEqual(out["messages"][1]["content"][0]["cache_control"], EPHEMERAL)

    def test_two_slots_left_marks_both(self):
        data = request(system=[text(str(i), cache_control=EPHEMERAL) for i in range(2)])
        out = run_hook(data)
        self.assertEqual(out["tools"][1]["cache_control"], EPHEMERAL)
        self.assertEqual(out["messages"][1]["content"][0]["cache_control"], EPHEMERAL)

    def test_each_kind_of_existing_marker_is_counted(self):
        # Three existing markers leave one slot, which the message takes; a
        # miscount in either direction puts a marker on the last tool or
        # leaves the message bare.
        for label, build in (
            ("system blocks", lambda d: d.update(system=[text(str(i), cache_control=EPHEMERAL) for i in range(3)])),
            ("tool entries", lambda d: d.update(
                tools=[tool("a", cache_control=EPHEMERAL), tool("b")],
                system=[text(str(i), cache_control=EPHEMERAL) for i in range(2)])),
            ("tool function bodies", lambda d: d.update(
                tools=[
                    {"type": "function", "function": {"name": "f", "cache_control": EPHEMERAL}},
                    {"type": "function", "function": {"name": "g"}},
                ],
                system=[text(str(i), cache_control=EPHEMERAL) for i in range(2)])),
            ("message blocks", lambda d: d.update(messages=[
                {"role": "user", "content": [text("m0", cache_control=EPHEMERAL)]},
                {"role": "assistant", "content": [text("m1", cache_control=EPHEMERAL)]},
                {"role": "user", "content": [text("m2", cache_control=EPHEMERAL)]},
                {"role": "assistant", "content": "m3"},
                {"role": "user", "content": "m4"},
            ])),
            ("message entries", lambda d: d.update(messages=[
                {"role": "user", "content": "m0", "cache_control": EPHEMERAL},
                {"role": "assistant", "content": "m1", "cache_control": EPHEMERAL},
                {"role": "user", "content": "m2", "cache_control": EPHEMERAL},
                {"role": "assistant", "content": "m3"},
                {"role": "user", "content": "m4"},
            ])),
        ):
            with self.subTest(label):
                data = request()
                build(data)
                out = run_hook(data)
                self.assertNotIn("cache_control", out["tools"][-1])
                self.assertEqual(out["messages"][-2]["content"][-1]["cache_control"], EPHEMERAL)

    def test_markers_on_messages_and_tool_function_bodies_count(self):
        data = request(
            tools=[{"type": "function", "function": {"name": "f", "cache_control": EPHEMERAL}}],
            messages=[
                {"role": "user", "content": [text("q", cache_control=EPHEMERAL)]},
                {"role": "assistant", "content": [text("a", cache_control=EPHEMERAL)]},
                {"role": "user", "content": "q2", "cache_control": EPHEMERAL},
            ],
        )
        want = copy.deepcopy(data)
        self.assertEqual(run_hook(data), want)


class WhenItDoesNotInject(unittest.TestCase):
    def assert_untouched_except_header(self, data: dict, out: dict) -> None:
        want = copy.deepcopy(data)
        want.get("extra_headers", {}).pop(HEADER, None)
        self.assertEqual(out, want)

    def test_no_header_means_no_change_and_no_header_dict_is_created(self):
        data = request()
        data.pop("litellm_metadata")
        want = copy.deepcopy(data)
        out = run_hook(data)
        self.assertEqual(out, want)
        self.assertNotIn("extra_headers", out)

    def test_off_values_table(self):
        for value in ("0", "false", "No", "OFF", "", " false ", " Off\t"):
            with self.subTest(repr(value)):
                data = request(litellm_metadata={"headers": {HEADER: value}})
                want = copy.deepcopy(data)
                self.assertEqual(run_hook(data), want)

    def test_non_claude_route_is_not_marked_but_the_control_header_is_stripped(self):
        data = request(model="gpt-4o", extra_headers={HEADER: "true", "x-keep": "1"})
        out = run_hook(data)
        self.assertEqual(out["extra_headers"], {"x-keep": "1"})
        self.assert_untouched_except_header(data, out)

    def test_other_call_type_is_not_marked_but_the_control_header_is_stripped(self):
        data = request(extra_headers={HEADER: "true"})
        out = run_hook(data, call_type="embeddings")
        self.assertEqual(out["extra_headers"], {})
        self.assert_untouched_except_header(data, out)

    def test_call_type_table(self):
        for call_type, injects in (
            ("completion", True),
            ("acompletion", True),
            ("anthropic_messages", True),
            ("responses", False),
            ("embeddings", False),
        ):
            with self.subTest(call_type):
                out = run_hook(request(), call_type=call_type)
                self.assertEqual("cache_control" in out["tools"][1], injects)

    def test_anthropic_prefix_counts_as_claude(self):
        out = run_hook(request(model="anthropic/some-model"))
        self.assertEqual(out["tools"][1]["cache_control"], EPHEMERAL)

    def test_model_name_table(self):
        for model, injects in (
            ("claude-auto", True),
            ("Claude-Sonnet", True),
            ("anthropic/x", True),
            ("smart-router", False),
            ("", False),
            (None, False),
        ):
            with self.subTest(model):
                out = run_hook(request(model=model))
                self.assertEqual("cache_control" in out["tools"][1], injects)


class ControlHeader(unittest.TestCase):
    def test_stripped_from_the_outbound_headers_after_injection(self):
        data = request(extra_headers={HEADER.title(): "true", "x-keep": "1"})
        out = run_hook(data)
        self.assertEqual(out["extra_headers"], {"x-keep": "1"})

    def test_inbound_copy_is_left_where_it_is(self):
        out = run_hook(request())
        self.assertEqual(out["litellm_metadata"], {"headers": {HEADER: "true"}})

    def test_non_dict_extra_headers_does_not_raise(self):
        data = request(extra_headers=None, model="gpt-4o")
        data["litellm_metadata"] = {"headers": {HEADER: "true"}}
        self.assertEqual(run_hook(data)["extra_headers"], None)


class NothingElseIsInjected(unittest.TestCase):
    """The hook has one job. It must not add credentials, identity or any other
    header of its own, whatever the key it runs for carries."""

    def test_key_metadata_never_becomes_a_header(self):
        data = request(user="someone")
        auth = _Auth(metadata={"gateway_key": "k-123", "anything": "else"}, key_alias="team-a")
        out = run_hook(data, auth=auth)
        self.assertNotIn("extra_headers", out)
        self.assertEqual(out["user"], "someone")

    def test_a_request_with_no_key_alias_or_metadata_runs(self):
        self.assertEqual(
            run_hook(request(), auth=types.SimpleNamespace(metadata=None))["tools"][1]["cache_control"],
            EPHEMERAL,
        )


class Wiring(unittest.TestCase):
    def test_entrypoint_is_the_instance_the_chart_names(self):
        self.assertIsInstance(hook.proxy_handler_instance, hook.PromptCacheHook)

    def test_logger_name_matches_the_module_path_the_proxy_imports(self):
        self.assertEqual(hook.logger.name, "litellm.proxy.hooks.prompt_cache_hook")
        self.assertIsInstance(hook.logger, logging.Logger)

    def test_injection_is_logged_once_with_the_key_alias(self):
        with self.assertLogs(hook.logger, level="INFO") as captured:
            run_hook(request(), auth=_Auth(key_alias="team-a"))
        self.assertEqual(len(captured.records), 1)
        self.assertIn("[team-a]", captured.records[0].getMessage())

    def test_no_log_line_when_nothing_was_injected(self):
        with self.assertNoLogs(hook.logger, level="INFO"):
            data = request()
            data.pop("litellm_metadata")
            run_hook(data)


if __name__ == "__main__":
    unittest.main()
