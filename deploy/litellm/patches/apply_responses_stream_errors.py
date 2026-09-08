# Copyright Advanced Micro Devices, Inc.
# SPDX-License-Identifier: MIT

from __future__ import annotations

import argparse
import ast
import hashlib
import importlib.util
from pathlib import Path


BASE_SHA256 = {
    "proxy/proxy_server.py": "f63cd83c5c4459d84dbfbd350a460caf9e2907389f19d2c3090fe24ad937f47b",
    "proxy/response_api_endpoints/endpoints.py": "563b462e7c36e729869d0acdc016a54c2e99ec07f70a3f6ea17482b1dbf11e4f",
    "responses/streaming_iterator.py": "e25f32c3bf3e1815f08a5f2e328d4b32359d189d386780a7b9b4640bdbe4e56a",
}
HELPER_NAME = "responses_stream_errors.py"


def _replace_once(source: str, before: str, after: str) -> str:
    count = source.count(before)
    if count != 1:
        raise ValueError(f"Expected exactly one patch context, found {count}: {before[:80]!r}")
    return source.replace(before, after, 1)


def _native_responses_endpoint(source: str) -> str:
    function = next(node for node in ast.parse(source).body if isinstance(node, ast.AsyncFunctionDef) and node.name == "responses_api")
    lines = source.splitlines(keepends=True)
    start, end = function.lineno - 1, function.end_lineno
    block = "".join(lines[start:end])
    block = _replace_once(block, "        select_data_generator,\n", "        select_responses_data_generator as select_data_generator,\n")
    return "".join(lines[:start]) + block + "".join(lines[end:])


def _responses_iterator(source: str) -> str:
    before = """        if 400 <= status_code < 500 and status_code != 429:
            raise mapped_exception
"""
    after = """        from litellm.proxy.responses_stream_errors import preserve_upstream_error

        preserve_upstream_error(mapped_exception, error_obj, result)
        if 400 <= status_code < 500 and status_code != 429:
            raise mapped_exception
"""
    return _replace_once(source, before, after)


def _proxy_generator(source: str) -> str:
    before = """async def async_data_generator(
    response,
    user_api_key_dict: UserAPIKeyAuth,
    request_data: dict,
    request: Request | None = None,
):
    verbose_proxy_logger.debug("inside generator")
    stream_completed = False
    client_disconnected = False
"""
    after = """async def async_data_generator(
    response,
    user_api_key_dict: UserAPIKeyAuth,
    request_data: dict,
    request: Request | None = None,
    *,
    responses_stream_errors: bool = False,
):
    from litellm.proxy.responses_stream_errors import ResponsesStreamErrorState

    verbose_proxy_logger.debug("inside generator")
    stream_completed = False
    client_disconnected = False
    error_state = ResponsesStreamErrorState() if responses_stream_errors else None
"""
    source = _replace_once(source, before, after)
    source = _replace_once(source, "            raw_passthrough = False\n", "            if error_state is not None:\n                error_state.observe_chunk(chunk, emitted=False)\n            raw_passthrough = False\n")
    before = """        if isinstance(e, HTTPException):
            raise e
        elif isinstance(e, StreamingCallbackError):
"""
    after = """        if error_state is not None:
            stream_completed = True
            error_frame = error_state.format_failure(e)
            if error_frame is not None:
                yield error_frame
            return
        if isinstance(e, HTTPException):
            raise e
        elif isinstance(e, StreamingCallbackError):
"""
    source = _replace_once(source, before, after)
    before = '''                    yield _format_streaming_sse_chunk(chunk=chunk)
                except Exception as e:
                    yield f"data: {e}\\n\\n"
'''
    after = '''                    formatted_chunk = _format_streaming_sse_chunk(chunk=chunk)
                    if error_state is not None:
                        error_state.mark_emitted()
                    yield formatted_chunk
                except Exception as e:
                    if error_state is not None:
                        raise
                    yield f"data: {e}\\n\\n"
'''
    return _replace_once(source, before, after)


def _responses_selector(source: str) -> str:
    before = "\ndef select_data_generator(\n"
    after = """
def select_responses_data_generator(
    response,
    user_api_key_dict: UserAPIKeyAuth,
    request_data: dict,
    request: Request | None = None,
):
    return async_data_generator(
        response=response,
        user_api_key_dict=user_api_key_dict,
        request_data=request_data,
        request=request,
        responses_stream_errors=True,
    )


def select_data_generator(
"""
    return _replace_once(source, before, after)


def apply_patch(package_root: Path) -> None:
    sources: dict[str, str] = {}
    for relative, expected in BASE_SHA256.items():
        content = (package_root / relative).read_bytes()
        actual = hashlib.sha256(content).hexdigest()
        if actual != expected:
            raise ValueError(f"Unsupported LiteLLM source {relative}: expected SHA-256 {expected}, found {actual}")
        sources[relative] = content.decode("utf-8")
    helper = Path(__file__).with_name(HELPER_NAME).read_text()
    target_helper = package_root / "proxy" / HELPER_NAME
    if target_helper.exists():
        raise ValueError(f"Refusing to replace an existing {target_helper}")
    sources["proxy/proxy_server.py"] = _responses_selector(_proxy_generator(sources["proxy/proxy_server.py"]))
    sources["proxy/response_api_endpoints/endpoints.py"] = _native_responses_endpoint(sources["proxy/response_api_endpoints/endpoints.py"])
    sources["responses/streaming_iterator.py"] = _responses_iterator(sources["responses/streaming_iterator.py"])
    for relative, source in sources.items():
        compile(source, relative, "exec")
    compile(helper, HELPER_NAME, "exec")
    for relative, source in sources.items():
        (package_root / relative).write_text(source)
    target_helper.write_text(helper)


def main() -> None:
    parser = argparse.ArgumentParser(description="Apply the checked Responses stream error patch to LiteLLM 1.99.0.")
    parser.add_argument("package_root", nargs="?", type=Path)
    parser.add_argument("--package-dir", type=Path)
    args = parser.parse_args()
    if args.package_root is not None and args.package_dir is not None:
        parser.error("Specify either package_root or --package-dir, not both")
    package_root = args.package_dir or args.package_root
    if package_root is None:
        spec = importlib.util.find_spec("litellm")
        if spec is None or spec.origin is None:
            raise RuntimeError("Cannot locate the installed litellm package")
        package_root = Path(spec.origin).parent
    apply_patch(package_root)
    print("Applied the Responses stream error patch to LiteLLM 1.99.0.")


if __name__ == "__main__":
    main()
