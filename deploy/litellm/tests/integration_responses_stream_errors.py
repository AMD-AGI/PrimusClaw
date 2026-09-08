#!/usr/bin/env python3
# Copyright Advanced Micro Devices, Inc.
# SPDX-License-Identifier: MIT

"""Exercise the installed LiteLLM proxy against a local synthetic upstream."""

import argparse
import contextlib
import http.server
import json
import os
from pathlib import Path
import re
import shutil
import socket
import subprocess
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request


MODEL = "gpt-5.2"
SUCCESS = "Synthetic completion."
ERROR_MESSAGE = "Synthetic upstream capacity error."
TOOL_ARGUMENTS = '{"value":"ok"}'


def response(status="in_progress", output=None):
    return {
        "id": "resp_fixture",
        "object": "response",
        "created_at": 1,
        "status": status,
        "error": None,
        "incomplete_details": None,
        "instructions": None,
        "model": MODEL,
        "output": output or [],
        "parallel_tool_calls": True,
        "tools": [],
        "tool_choice": "auto",
        "temperature": 1.0,
        "top_p": 1.0,
        "metadata": {},
        "usage": {"input_tokens": 1, "output_tokens": 2, "total_tokens": 3},
    }


def event(event_type, sequence, **fields):
    return {"type": event_type, "sequence_number": sequence, **fields}


def tool_events():
    item = {
        "id": "fc_fixture",
        "type": "function_call",
        "call_id": "call_fixture",
        "name": "fixture_tool",
        "arguments": TOOL_ARGUMENTS,
        "status": "completed",
    }
    return [
        event("response.created", 0, response=response()),
        event("response.output_item.added", 1, output_index=0,
              item={**item, "arguments": "", "status": "in_progress"}),
        event("response.function_call_arguments.delta", 2,
              item_id=item["id"], output_index=0, delta=TOOL_ARGUMENTS),
        event("response.function_call_arguments.done", 3,
              item_id=item["id"], output_index=0, arguments=TOOL_ARGUMENTS),
        event("response.output_item.done", 4, output_index=0, item=item),
        event("response.completed", 5, response=response("completed", [item])),
    ]


def message_events():
    part = {"type": "output_text", "text": SUCCESS, "annotations": []}
    item = {"id": "msg_fixture", "type": "message", "role": "assistant",
            "status": "completed", "content": [part]}
    return [
        event("response.created", 0, response=response()),
        event("response.output_item.added", 1, output_index=0,
              item={**item, "status": "in_progress", "content": []}),
        event("response.content_part.added", 2, item_id=item["id"],
              output_index=0, content_index=0, part={**part, "text": ""}),
        event("response.output_text.delta", 3, item_id=item["id"],
              output_index=0, content_index=0, delta=SUCCESS, logprobs=[]),
        event("response.output_text.done", 4, item_id=item["id"],
              output_index=0, content_index=0, text=SUCCESS, logprobs=[]),
        event("response.content_part.done", 5, item_id=item["id"],
              output_index=0, content_index=0, part=part),
        event("response.output_item.done", 6, output_index=0, item=item),
        event("response.completed", 7, response=response("completed", [item])),
    ]


def response_events(case):
    if case == "success":
        return message_events()
    if case == "tool":
        return tool_events()
    if case == "upstream_failed":
        failed = response("failed")
        failed["error"] = {"code": "server_error", "message": ERROR_MESSAGE}
        return [event("response.failed", 11, response=failed)]
    code = "server_error" if case in ("error500", "after_tool") else "rate_limit_exceeded"
    if case == "numeric429":
        code = "429"
    error_type = "server_error" if code == "server_error" else "rate_limit_error"
    if case == "numeric429":
        error_type = None
    failure = {"type": "error", "error": {"message": ERROR_MESSAGE,
               "type": error_type, "code": code, "param": "input"}}
    prefix = []
    if case == "after_created":
        prefix = [event("response.created", 4, response=response())]
    elif case == "after_tool":
        prefix = tool_events()[:3]
    return [*prefix, failure]


def chat_events():
    chunk = {"id": "chatcmpl-fixture", "object": "chat.completion.chunk",
             "created": 1, "model": MODEL}
    return [
        {**chunk, "choices": [{"index": 0, "delta": {"role": "assistant",
          "content": SUCCESS}, "finish_reason": None}]},
        {**chunk, "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}]},
    ]


class FixtureHandler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def do_POST(self):
        payload = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        match = re.search(r"PROBE_CASE:([a-z0-9_]+)", json.dumps(payload))
        case = match.group(1) if match else "success"
        self.server.requests_seen.append((self.path, case))
        if self.path.endswith("/chat/completions"):
            chunks = chat_events()
            if case == "chat_error":
                chunks = chunks[:1] + [{"error": {"message": ERROR_MESSAGE,
                          "type": "server_error", "code": "server_error"}}]
            body = "".join("data: " + json.dumps(chunk) + "\n\n" for chunk in chunks)
            body += "data: [DONE]\n\n"
        elif self.path.endswith("/responses"):
            body = "".join("event: " + chunk["type"] + "\ndata: "
                           + json.dumps(chunk) + "\n\n" for chunk in response_events(case))
        else:
            self.send_error(404, "Unexpected synthetic upstream path")
            return
        encoded = body.encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Content-Length", str(len(encoded)))
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(encoded)
        self.wfile.flush()
        self.close_connection = True

    def log_message(self, *args):
        pass


def parse_sse(body):
    events = []
    for frame in body.replace("\r\n", "\n").split("\n\n"):
        name = None
        data = []
        for line in frame.splitlines():
            if line.startswith("event:"):
                name = line[6:].strip()
            elif line.startswith("data:"):
                data.append(line[5:].lstrip())
        if data and data != ["[DONE]"]:
            events.append((name, json.loads("\n".join(data))))
    return events


def post_raw(gateway_url, path, case, chat=False):
    payload = {"model": MODEL, "stream": True}
    prompt = "PROBE_CASE:" + case
    if chat:
        payload["messages"] = [{"role": "user", "content": prompt}]
    else:
        payload["input"] = prompt
    request = urllib.request.Request(gateway_url + path, json.dumps(payload).encode(),
                                     {"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(request, timeout=30) as result:
            return result.status, result.headers.get_content_type(), result.read().decode()
    except urllib.error.HTTPError as error:
        return error.code, error.headers.get_content_type(), error.read().decode()


def post(gateway_url, path, case, chat=False):
    status, content_type, body = post_raw(gateway_url, path, case, chat=chat)
    assert status == 200, (status, body)
    assert content_type == "text/event-stream", (content_type, body)
    return parse_sse(body)


def check_failure(gateway_url, case, expected_code, prefix_types):
    frames = post(gateway_url, "/v1/responses", case)
    assert frames, f"{case}: empty SSE stream"
    name, failure = frames[-1]
    assert name == "response.failed", (case, frames)
    assert failure["type"] == "response.failed", failure
    failed_response = failure["response"]
    assert failed_response["object"] == "response", failed_response
    assert failed_response["status"] == "failed", failed_response
    assert failed_response["id"], failed_response
    assert ERROR_MESSAGE in failed_response["error"]["message"], failure
    assert failed_response["error"]["code"] == expected_code, failure
    prefix = [data for _, data in frames[:-1]]
    assert [data["type"] for data in prefix] == prefix_types, frames
    assert failure["sequence_number"] > max(
        (data.get("sequence_number", -1) for data in prefix), default=-1
    ), frames
    if prefix:
        assert failed_response["id"] == prefix[0]["response"]["id"], frames
    if case == "after_tool":
        assert prefix[-1]["delta"] == TOOL_ARGUMENTS, frames
    if case == "upstream_failed":
        assert failure["sequence_number"] == 11, frames


def check_success(gateway_url, case):
    events = [data for _, data in post(gateway_url, "/v1/responses", case)]
    expected = response_events(case)
    assert [data["type"] for data in events] == [data["type"] for data in expected], events
    assert [data["sequence_number"] for data in events] == list(range(len(events))), events
    completed = events[-1]["response"]
    assert completed["status"] == "completed", completed
    if case == "tool":
        assert events[2]["delta"] == TOOL_ARGUMENTS, events
        assert completed["output"][0]["arguments"] == TOOL_ARGUMENTS, completed
    else:
        assert events[3]["delta"] == SUCCESS, events
        assert completed["output"][0]["content"][0]["text"] == SUCCESS, completed


def check_chat(gateway_url, path="/v1/chat/completions", response_input=False):
    frames = post(gateway_url, path, "success", chat=not response_input)
    chunks = [data for _, data in frames]
    assert chunks and all(chunk["object"] == "chat.completion.chunk" for chunk in chunks), chunks
    assert all(name != "response.failed" for name, _ in frames), frames
    text = "".join(choice["delta"].get("content", "")
                   for chunk in chunks for choice in chunk["choices"])
    assert text == SUCCESS, chunks
    assert chunks[-1]["choices"][0]["finish_reason"] == "stop", chunks


def check_legacy_failure(gateway_url, path, case, chat):
    frames = post(gateway_url, path, case, chat=chat)
    assert frames, "Empty legacy error stream"
    assert all(name != "response.failed" and data.get("type") != "response.failed"
               for name, data in frames), frames
    name, failure = frames[-1]
    assert name is None, frames
    assert ERROR_MESSAGE in failure["error"]["message"], frames


def check_cursor_pre_stream_failure(gateway_url):
    status, content_type, body = post_raw(gateway_url, "/cursor/chat/completions", "error500")
    assert status == 500, (status, body)
    assert content_type == "application/json", (content_type, body)
    failure = json.loads(body)
    assert set(failure) == {"error"}, failure
    assert failure["error"]["code"] == "500", failure
    assert ERROR_MESSAGE in failure["error"]["message"], failure


def run_http_checks(gateway_url):
    cases = [
        ("error429", "rate_limit_exceeded", []),
        ("error500", "server_error", []),
        ("numeric429", "rate_limit_exceeded", []),
        ("upstream_failed", "server_error", []),
        ("after_created", "rate_limit_exceeded", ["response.created"]),
        ("after_tool", "server_error", ["response.created", "response.output_item.added",
                                        "response.function_call_arguments.delta"]),
    ]
    for case, code, prefix in cases:
        check_failure(gateway_url, case, code, prefix)
        print(f"PASS Responses {case}", flush=True)
    for case in ("success", "tool"):
        check_success(gateway_url, case)
        print(f"PASS Responses {case}", flush=True)
    check_chat(gateway_url)
    print("PASS Chat Completions success", flush=True)
    check_legacy_failure(gateway_url, "/v1/chat/completions", "chat_error", chat=True)
    print("PASS Chat Completions streaming error", flush=True)
    check_chat(gateway_url, "/cursor/chat/completions", response_input=True)
    print("PASS Cursor Responses bridge success", flush=True)
    check_cursor_pre_stream_failure(gateway_url)
    print("PASS Cursor Responses bridge pre-stream JSON error", flush=True)
    check_legacy_failure(gateway_url, "/cursor/chat/completions", "after_tool", chat=False)
    print("PASS Cursor Responses bridge streaming error after tool delta", flush=True)


def free_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def wait_ready(process, url, log_path):
    deadline = time.monotonic() + 90
    while process.poll() is None and time.monotonic() < deadline:
        try:
            with urllib.request.urlopen(url + "/health/readiness", timeout=2) as result:
                if result.status == 200:
                    return
        except (OSError, urllib.error.URLError):
            time.sleep(0.2)
    raise RuntimeError("Synthetic proxy failed to start:\n" + log_path.read_text()[-12000:])


@contextlib.contextmanager
def synthetic_proxy(port, host):
    binary = shutil.which("litellm")
    if not binary:
        raise RuntimeError("Run this check in the patched LiteLLM image; litellm CLI is missing")
    upstream = http.server.ThreadingHTTPServer(("127.0.0.1", 0), FixtureHandler)
    upstream.requests_seen = []
    threading.Thread(target=upstream.serve_forever, daemon=True).start()
    process = None
    with tempfile.TemporaryDirectory(prefix="responses-stream-test-") as directory:
        root = Path(directory)
        config = {"model_list": [{"model_name": MODEL, "litellm_params": {
            "model": "openai/" + MODEL,
            "api_base": f"http://127.0.0.1:{upstream.server_port}/v1",
            "api_key": "unused-fixture-key"}}],
            "router_settings": {"num_retries": 0},
            "litellm_settings": {"num_retries": 0, "request_timeout": 15}}
        config_path = root / "config.json"
        config_path.write_text(json.dumps(config))
        log_path = root / "proxy.log"
        selected_port = port or free_port()
        url = f"http://127.0.0.1:{selected_port}"
        env = {key: value for key, value in os.environ.items()
               if key not in ("DATABASE_URL", "DIRECT_URL", "LITELLM_MASTER_KEY")}
        try:
            with log_path.open("w") as log:
                process = subprocess.Popen([binary, "--config", str(config_path),
                                            "--port", str(selected_port), "--host", host],
                                           env=env, stdout=log, stderr=subprocess.STDOUT)
                wait_ready(process, url, log_path)
                yield url, upstream
        except BaseException:
            print(log_path.read_text()[-12000:], flush=True)
            raise
        finally:
            if process is not None and process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()
            upstream.shutdown()
            upstream.server_close()


def run_codex_checks(url, binary):
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme != "http" or parsed.hostname not in ("127.0.0.1", "localhost", "::1"):
        raise ValueError("--codex-url must point to the loopback synthetic proxy")
    with tempfile.TemporaryDirectory(prefix="codex-stream-test-") as directory:
        for case in ("error429", "error500", "success"):
            output = Path(directory) / (case + ".txt")
            provider = ('{name="Synthetic integration",base_url=' + json.dumps(url + "/v1")
                        + ',wire_api="responses",requires_openai_auth=false,'
                        'request_max_retries=0,stream_max_retries=0,stream_idle_timeout_ms=10000}')
            command = [binary, "exec", "--ignore-user-config", "--ignore-rules", "--ephemeral",
                       "--skip-git-repo-check", "--json", "--sandbox", "read-only",
                       "-C", directory, "--output-last-message", str(output),
                       "-c", 'model_provider="synthetic_test"',
                       "-c", "model_providers.synthetic_test=" + provider,
                       "-c", 'model_reasoning_effort="low"',
                       "-m", MODEL, "PROBE_CASE:" + case]
            result = subprocess.run(command, capture_output=True, text=True, timeout=40)
            combined = result.stdout + result.stderr
            if case == "success":
                assert result.returncode == 0, combined
                assert output.exists() and SUCCESS in output.read_text(), combined
            else:
                assert result.returncode != 0, combined
                assert ERROR_MESSAGE in combined, combined
                assert "stream closed before response.completed" not in combined, combined
            print(f"PASS Codex {case}", flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--serve", action="store_true", help="Keep the tested synthetic proxy running")
    parser.add_argument("--port", type=int, default=0)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--codex-url", help="Test a local port-forward to the synthetic proxy")
    parser.add_argument("--codex-bin", default="codex")
    args = parser.parse_args()
    if args.codex_url:
        run_codex_checks(args.codex_url.rstrip("/"), args.codex_bin)
        return
    with synthetic_proxy(args.port, args.host) as (url, upstream):
        run_http_checks(url)
        assert upstream.requests_seen, "No requests reached the synthetic upstream"
        print(json.dumps({"status": "ready", "gateway_url": url,
                          "synthetic_requests": len(upstream.requests_seen)}), flush=True)
        if args.serve:
            threading.Event().wait()


if __name__ == "__main__":
    main()
