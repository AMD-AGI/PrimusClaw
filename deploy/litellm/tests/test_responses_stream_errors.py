# Copyright Advanced Micro Devices, Inc.
# SPDX-License-Identifier: MIT

import copy
import importlib.util
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest


PATCHES = Path(__file__).resolve().parents[1] / "patches"


def load_module(name):
    spec = importlib.util.spec_from_file_location(name, PATCHES / (name + ".py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


helper = load_module("responses_stream_errors")
installer = load_module("apply_responses_stream_errors")


class UpstreamError(Exception):
    def __init__(self, status_code, message="Synthetic upstream failure"):
        super().__init__(message)
        self.status_code = status_code
        self.message = message


def decode_failure(frame):
    assert frame.startswith("event: response.failed\ndata: "), frame
    assert frame.endswith("\n\n"), frame
    return json.loads(frame.splitlines()[1][6:])


class ResponsesStreamErrorTests(unittest.TestCase):
    def test_rate_limit_and_service_failure_are_responses_events(self):
        for status, code in ((429, "rate_limit_exceeded"), (500, "server_error")):
            with self.subTest(status=status):
                state = helper.ResponsesStreamErrorState()
                failure = decode_failure(state.format_failure(UpstreamError(status)))
                self.assertEqual(failure["type"], "response.failed")
                self.assertEqual(failure["sequence_number"], 0)
                response = failure["response"]
                self.assertTrue(response["id"].startswith("resp_"))
                self.assertEqual(response["object"], "response")
                self.assertEqual(response["status"], "failed")
                self.assertEqual(response["output"], [])
                self.assertEqual(response["error"], {
                    "code": code, "message": "Synthetic upstream failure"})

    def test_created_response_identity_and_next_sequence_are_preserved(self):
        state = helper.ResponsesStreamErrorState()
        state.observe_chunk(SimpleNamespace(type="response.created", sequence_number=8,
                            response=SimpleNamespace(id="resp_existing", model="gpt-5.2",
                                                     created_at=123)))
        state.observe_chunk({"type": "response.output_text.delta", "sequence_number": 3})
        failure = decode_failure(state.format_failure(UpstreamError(500)))
        self.assertEqual(failure["sequence_number"], 9)
        self.assertEqual(failure["response"]["id"], "resp_existing")
        self.assertEqual(failure["response"]["model"], "gpt-5.2")
        self.assertEqual(failure["response"]["created_at"], 123)

    def test_tool_chunk_is_not_mutated_or_replayed_as_output(self):
        state = helper.ResponsesStreamErrorState()
        chunk = {"type": "response.function_call_arguments.delta", "sequence_number": 6,
                 "response_id": "resp_tools", "delta": '{"value":"partial'}
        before = copy.deepcopy(chunk)
        state.observe_chunk(chunk)
        failure = decode_failure(state.format_failure(UpstreamError(500)))
        self.assertEqual(chunk, before)
        self.assertEqual(failure["response"]["id"], "resp_tools")
        self.assertEqual(failure["sequence_number"], 7)
        self.assertEqual(failure["response"]["output"], [])

    def test_terminal_response_cannot_be_followed_by_a_second_terminal(self):
        for terminal in ("response.completed", "response.failed", "response.incomplete"):
            with self.subTest(terminal=terminal):
                state = helper.ResponsesStreamErrorState()
                state.observe_chunk({"type": terminal, "sequence_number": 7})
                self.assertIsNone(state.format_failure(UpstreamError(500)))

    def test_emitted_failure_is_terminal(self):
        state = helper.ResponsesStreamErrorState()
        self.assertIsNotNone(state.format_failure(UpstreamError(429)))
        self.assertIsNone(state.format_failure(UpstreamError(500)))

    def test_failure_serializing_a_terminal_chunk_still_reports_an_error(self):
        state = helper.ResponsesStreamErrorState()
        state.observe_chunk({"type": "response.completed", "sequence_number": 7}, emitted=False)
        failure = decode_failure(state.format_failure(UpstreamError(500, "Serialization failed")))
        self.assertEqual(failure["type"], "response.failed")
        self.assertEqual(failure["response"]["error"]["message"], "Serialization failed")

    def test_successfully_serialized_terminal_chunk_prevents_a_later_failure(self):
        state = helper.ResponsesStreamErrorState()
        state.observe_chunk({"type": "response.completed", "sequence_number": 7}, emitted=False)
        state.mark_emitted()
        self.assertIsNone(state.format_failure(UpstreamError(500)))

    def test_error_metadata_survives_a_fallback_wrapper_without_changing_status(self):
        upstream = UpstreamError(500, "Mapped transport exception")
        error = {"message": "Original provider message", "code": "429", "param": "input"}
        helper.preserve_upstream_error(upstream, error)
        wrapper = Exception("Router fallback exhausted")
        wrapper.original_exception = upstream
        failure = decode_failure(helper.ResponsesStreamErrorState().format_failure(wrapper))
        self.assertEqual(upstream.status_code, 500)
        self.assertEqual(failure["response"]["error"], {
            "code": "rate_limit_exceeded", "message": "Original provider message"})

    def test_numeric_and_named_rate_limits_are_not_reported_as_server_errors(self):
        for code in (429, "429", "rate_limit_exceeded", "insufficient_quota"):
            with self.subTest(code=code):
                upstream = UpstreamError(500)
                helper.preserve_upstream_error(upstream, {"code": code})
                failure = decode_failure(helper.ResponsesStreamErrorState().format_failure(upstream))
                expected = "insufficient_quota" if code == "insufficient_quota" else "rate_limit_exceeded"
                self.assertEqual(failure["response"]["error"]["code"], expected)
                self.assertEqual(upstream.status_code, 500)

    def test_failed_upstream_event_keeps_its_identity_when_no_chunk_was_emitted(self):
        upstream = UpstreamError(500)
        event = {"type": "response.failed", "sequence_number": 11,
                 "response": {"id": "resp_upstream", "created_at": 12}}
        helper.preserve_upstream_error(upstream, {"code": "server_error"}, event)
        failure = decode_failure(helper.ResponsesStreamErrorState().format_failure(upstream))
        self.assertEqual(failure["sequence_number"], 11)
        self.assertEqual(failure["response"]["id"], "resp_upstream")
        self.assertEqual(failure["response"]["created_at"], 12)

    def test_raw_upstream_id_cannot_replace_an_already_visible_response_id(self):
        state = helper.ResponsesStreamErrorState()
        state.observe_chunk({"type": "response.created", "sequence_number": 0,
                             "response": {"id": "resp_client_visible"}})
        upstream = UpstreamError(500)
        event = {"type": "response.failed", "sequence_number": 11,
                 "response": {"id": "resp_upstream_raw"}}
        helper.preserve_upstream_error(upstream, {"code": "server_error"}, event)
        failure = decode_failure(state.format_failure(upstream))
        self.assertEqual(failure["response"]["id"], "resp_client_visible")
        self.assertEqual(failure["sequence_number"], 11)

    def test_error_messages_cannot_break_sse_framing(self):
        message = 'Line one\n\ndata: forged event\n"quoted" ☃'
        failure = decode_failure(helper.ResponsesStreamErrorState().format_failure(
            UpstreamError(500, message)))
        self.assertEqual(failure["response"]["error"]["message"], message)

    def test_missing_response_ids_are_unique_between_requests(self):
        first = decode_failure(helper.ResponsesStreamErrorState().format_failure(UpstreamError(500)))
        second = decode_failure(helper.ResponsesStreamErrorState().format_failure(UpstreamError(500)))
        self.assertNotEqual(first["response"]["id"], second["response"]["id"])


class InstallerTests(unittest.TestCase):
    def test_unknown_upstream_version_fails_before_writing_any_files(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            originals = {}
            for relative in installer.BASE_SHA256:
                path = root / relative
                path.parent.mkdir(parents=True, exist_ok=True)
                originals[path] = b"# An unsupported upstream source version.\n"
                path.write_bytes(originals[path])
            with self.assertRaisesRegex(ValueError, "Unsupported LiteLLM source"):
                installer.apply_patch(root)
            for path, content in originals.items():
                self.assertEqual(path.read_bytes(), content)
            self.assertFalse((root / "proxy" / installer.HELPER_NAME).exists())


if __name__ == "__main__":
    unittest.main()
