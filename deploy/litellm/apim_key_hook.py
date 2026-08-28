# Copyright Advanced Micro Devices, Inc.
# SPDX-License-Identifier: MIT

"""
Custom hook: auto-inject Ocp-Apim-Subscription-Key from Virtual Key metadata.

Usage:
  1. Create key: POST /key/generate {"metadata": {"apim_key": "xxx"}}
  2. Use key:    Authorization: Bearer sk-xxx (no extra_headers needed)

Prompt caching (Claude / Anthropic via LiteLLM):
  Send header ``x-auto-prompt-caching: true`` (HTTP header or ``extra_headers``).
  The hook injects Anthropic ``cache_control: {type: ephemeral}`` on tools and
  messages so repeat prefixes can show ``cache_read_input_tokens`` in usage.
"""
import logging
import os
from typing import Any, Mapping, Optional

from litellm.integrations.custom_logger import CustomLogger
from litellm.proxy.proxy_server import DualCache, UserAPIKeyAuth
from litellm.types.utils import CallTypesLiteral

logger = logging.getLogger("litellm.proxy.hooks.apim_key_hook")

CACHE_CONTROL_EPHEMERAL: dict[str, str] = {"type": "ephemeral"}
_AUTO_PROMPT_CACHE_HEADER = "x-auto-prompt-caching"
_COMPLETION_CALL_TYPES = frozenset(
    {"completion", "acompletion", "anthropic_messages"}
)
# Comma-separated APIM keys that share one fixed attribution user.
_HYPERLOOM_APIM_KEY_ENV = "AMD_HYPERLOOM_APIM_KEY"
_HYPERLOOM_APIM_USER_ENV = "AMD_HYPERLOOM_APIM_USER"


def _mask(key: str) -> str:
    """Show first 4 and last 4 chars, mask the rest."""
    if len(key) <= 8:
        return key[:2] + "****"
    return key[:4] + "****" + key[-4:]


def _header_dict_truthy(headers: Optional[Mapping[Any, Any]], name: str) -> bool:
    if not headers:
        return False
    want = name.lower()
    for key, value in headers.items():
        if str(key).lower() == want:
            return str(value).lower() == "true"
    return False


def _header_dict_get(headers: Optional[Mapping[Any, Any]], name: str) -> Optional[str]:
    if not headers:
        return None
    want = name.lower()
    for key, value in headers.items():
        if str(key).lower() == want and value:
            return str(value)
    return None


def _ensure_extra_headers(data: dict) -> dict:
    if not isinstance(data.get("extra_headers"), dict):
        data["extra_headers"] = {}
    return data["extra_headers"]


def _inject_user_header(data: dict, apim_key: Optional[str], key_alias: str) -> None:
    headers = _ensure_extra_headers(data)
    if _header_dict_get(headers, "user"):
        return

    user = _header_dict_get(headers, "USER-NTID")
    if not user and data.get("user"):
        user = str(data["user"])

    configured_keys = {
        k.strip() for k in os.getenv(_HYPERLOOM_APIM_KEY_ENV, "").split(",") if k.strip()
    }
    configured_user = os.getenv(_HYPERLOOM_APIM_USER_ENV, "")
    if not user and apim_key and configured_user and apim_key in configured_keys:
        user = configured_user

    if user:
        headers["user"] = user
        logger.info("[%s] injected upstream user header", key_alias)


def _wants_auto_prompt_cache(data: dict) -> bool:
    if _header_dict_truthy(data.get("extra_headers"), _AUTO_PROMPT_CACHE_HEADER):
        return True
    metadata = data.get("metadata")
    if isinstance(metadata, dict):
        return _header_dict_truthy(
            metadata.get("headers"), _AUTO_PROMPT_CACHE_HEADER
        )
    return False


def _strip_auto_cache_request_header(data: dict) -> None:
    """Avoid forwarding the control header to the upstream LLM HTTP API."""
    eh = data.get("extra_headers")
    if not isinstance(eh, dict):
        return
    drop = [k for k in eh if str(k).lower() == _AUTO_PROMPT_CACHE_HEADER]
    for k in drop:
        del eh[k]


def _is_claude_route(data: dict) -> bool:
    model = (data.get("model") or "").lower()
    return "claude" in model or model.startswith("anthropic/")


def _tool_may_receive_cache_control(tool: dict) -> bool:
    t = tool.get("type")
    if not isinstance(t, str):
        return tool.get("function") is not None
    if t == "function" or t == "custom" or t == "":
        return True
    if t.startswith("tool_search") or t.startswith("computer_"):
        return False
    if t in ("mcp", "web_search"):
        return False
    return False


def _inject_cache_control_on_message(msg: dict) -> None:
    """
    Put cache_control on the content block level so LiteLLM's Anthropic
    transformation always propagates it, regardless of message role.
    """
    content = msg.get("content")

    if isinstance(content, str):
        msg["content"] = [
            {"type": "text", "text": content, "cache_control": dict(CACHE_CONTROL_EPHEMERAL)}
        ]
        logger.debug(
            "apim_key_hook: injected cache_control on content block (role=%r, converted str->list)",
            msg.get("role"),
        )
    elif isinstance(content, list) and content:
        last_block = content[-1]
        if isinstance(last_block, dict) and last_block.get("cache_control") is None:
            last_block["cache_control"] = dict(CACHE_CONTROL_EPHEMERAL)
            logger.debug(
                "apim_key_hook: injected cache_control on last content block (role=%r)",
                msg.get("role"),
            )
    else:
        msg["cache_control"] = dict(CACHE_CONTROL_EPHEMERAL)
        logger.debug(
            "apim_key_hook: injected cache_control on message level (role=%r)",
            msg.get("role"),
        )


def _inject_anthropic_prompt_cache(data: dict) -> None:
    """
    Add ephemeral cache breakpoints for Claude: last eligible tool and the message
    before the final one (rolling prefix). See Anthropic prompt caching docs.
    """
    messages = data.get("messages")
    if not isinstance(messages, list):
        return

    tools = data.get("tools")
    if isinstance(tools, list) and tools:
        for tool in reversed(tools):
            if not isinstance(tool, dict):
                continue
            if not _tool_may_receive_cache_control(tool):
                continue
            if tool.get("cache_control") is not None:
                break
            func = tool.get("function")
            if isinstance(func, dict) and func.get("cache_control") is not None:
                break
            tool["cache_control"] = dict(CACHE_CONTROL_EPHEMERAL)
            logger.debug(
                "apim_key_hook: injected cache_control on tool name=%r",
                (tool.get("function") or {}).get("name"),
            )
            break

    target_msg = None
    if len(messages) >= 2:
        target_msg = messages[-2]
    elif len(messages) == 1:
        target_msg = messages[0]

    if target_msg is not None and isinstance(target_msg, dict):
        _inject_cache_control_on_message(target_msg)


class ApimKeyHook(CustomLogger):
    async def async_pre_call_hook(
        self,
        user_api_key_dict: UserAPIKeyAuth,
        cache: DualCache,
        data: dict,
        call_type: CallTypesLiteral,
    ):
        metadata = user_api_key_dict.metadata or {}
        apim_key = metadata.get("apim_key")
        key_alias = getattr(user_api_key_dict, "key_alias", None) or "unknown"

        if apim_key:
            data["extra_headers"] = _ensure_extra_headers(data)
            data["extra_headers"]["Ocp-Apim-Subscription-Key"] = apim_key
            logger.info(
                f"[{key_alias}] using METADATA apim_key: {_mask(apim_key)}"
            )
        else:
            existing = (data.get("extra_headers") or {}).get(
                "Ocp-Apim-Subscription-Key"
            )
            apim_key = existing
            if existing:
                logger.info(
                    f"[{key_alias}] using MODEL CONFIG default apim_key: {_mask(existing)}"
                )
            else:
                logger.debug(
                    f"[{key_alias}] no apim_key found (metadata or config)"
                )

        _inject_user_header(data, apim_key, key_alias)

        if (
            call_type in _COMPLETION_CALL_TYPES
            and _wants_auto_prompt_cache(data)
            and _is_claude_route(data)
        ):
            _inject_anthropic_prompt_cache(data)
            _strip_auto_cache_request_header(data)
            logger.info(
                "[%s] x-auto-prompt-caching: injected Anthropic ephemeral cache breakpoints",
                key_alias,
            )
        elif _wants_auto_prompt_cache(data):
            _strip_auto_cache_request_header(data)

        return data


proxy_handler_instance = ApimKeyHook()
