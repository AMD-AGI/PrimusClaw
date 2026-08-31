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
# ``x-auto-prompt-caching: 1h`` asks for the hour-long entry instead of the
# five-minute default. Worth having because five minutes is not a safe default
# for agent traffic: a loop that sleeps 300 seconds inside one tool call has a
# start-to-start gap past the TTL on every cycle, so the entry expires exactly
# when it would have paid off. Measured against this gateway, a 1h marker
# writes a real ephemeral_1h entry, needs no beta header, and is not silently
# downgraded. Anything other than "1h" keeps the old behaviour.
CACHE_CONTROL_EPHEMERAL_1H: dict[str, str] = {"type": "ephemeral", "ttl": "1h"}
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


# Where LiteLLM leaves the caller's HTTP headers, in the order worth checking.
#
# ``litellm_metadata`` is the one that matters and the one this hook used to
# miss. LiteLLM routes a request's headers to ``litellm_metadata`` rather than
# ``metadata`` for every route in ``LITELLM_METADATA_ROUTES``, and that tuple
# contains ``/v1/messages`` -- the Anthropic-native endpoint, which is the only
# one Brain uses. Verified against the deployed proxy, not just the source:
# ``LITELLM_METADATA_ROUTES == ('batches', '/v1/messages', 'responses', 'files')``.
#
# So for two years this returned False on every Anthropic request and the
# caching branch below silently never ran, while the hook's other job -- the
# APIM key -- kept working and kept the whole thing looking healthy.
#
# ``extra_headers`` is kept for callers that pass the flag in the request body,
# but note it is also this hook's OWN outbound header dict (see
# ``_ensure_extra_headers``): looking for an inbound client header there was a
# category error, not a near miss.
_HEADER_CONTAINERS = ("litellm_metadata", "metadata")


def _request_headers(data: dict) -> list[Mapping[str, Any]]:
    found: list[Mapping[str, Any]] = []
    extra = data.get("extra_headers")
    if isinstance(extra, Mapping):
        found.append(extra)
    for container in _HEADER_CONTAINERS:
        holder = data.get(container)
        if isinstance(holder, Mapping):
            headers = holder.get("headers")
            if isinstance(headers, Mapping):
                found.append(headers)
    return found


def _auto_prompt_cache_setting(data: dict) -> Optional[str]:
    """The header's value if it asks for caching at all, else None."""
    for headers in _request_headers(data):
        value = _header_dict_get(headers, _AUTO_PROMPT_CACHE_HEADER)
        if value and str(value).strip().lower() not in ("0", "false", "no", "off"):
            return str(value).strip().lower()
    return None


def _wants_auto_prompt_cache(data: dict) -> bool:
    return _auto_prompt_cache_setting(data) is not None


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
        # An Anthropic-native tool is {name, description, input_schema}: no
        # "type", no "function". Requiring "function" here meant every tool on
        # the /v1/messages route was refused, so even a hook that fired left
        # the tool definitions unmarked -- and tools render FIRST in the cache
        # prefix, which makes them the largest stable thing there is to cache.
        if "input_schema" in tool and "name" in tool:
            return True
        return tool.get("function") is not None
    if t == "function" or t == "custom" or t == "":
        return True
    if t.startswith("tool_search") or t.startswith("computer_"):
        return False
    if t in ("mcp", "web_search"):
        return False
    return False


# Block types Anthropic accepts a cache_control marker on.
#
# Mirrors MARKABLE_BLOCK_TYPES in claw/packages/brain/src/llm/cache-plan.ts --
# deliberately the same rule in both halves of this change, because the guard
# was on one path and not the other. An allowlist, not a denylist of
# thinking/redacted_thinking: a marker on an ineligible block is an
# unconditional 400. Measured against this gateway:
#   messages.N.content.M.thinking.cache_control: Extra inputs are not permitted
# so a block type nobody has seen yet must default to "do not mark".
_MARKABLE_BLOCK_TYPES = frozenset(
    {"text", "tool_use", "tool_result", "image", "document"}
)

# Anthropic's hard cap on cache_control markers in one request. Measured: four
# is accepted, five is a 400.
_MAX_BREAKPOINTS = 4


def _is_markable_block(block: Any) -> bool:
    return isinstance(block, dict) and block.get("type") in _MARKABLE_BLOCK_TYPES


def _count_existing_markers(data: dict) -> int:
    """Markers the caller already placed, which count against the same cap."""
    n = 0
    tools = data.get("tools")
    if isinstance(tools, list):
        for t in tools:
            if isinstance(t, dict):
                if t.get("cache_control") is not None:
                    n += 1
                fn = t.get("function")
                if isinstance(fn, dict) and fn.get("cache_control") is not None:
                    n += 1
    for key in ("system", "messages"):
        section = data.get(key)
        if isinstance(section, str):
            continue
        for entry in section if isinstance(section, list) else []:
            if not isinstance(entry, dict):
                continue
            if entry.get("cache_control") is not None:
                n += 1
            content = entry.get("content")
            for block in content if isinstance(content, list) else []:
                if isinstance(block, dict) and block.get("cache_control") is not None:
                    n += 1
    return n


def _inject_cache_control_on_message(msg: dict, marker: dict) -> bool:
    """
    Put cache_control on a content block so LiteLLM's Anthropic transformation
    propagates it. Returns True when this message now carries a marker.
    """
    content = msg.get("content")

    if isinstance(content, str):
        msg["content"] = [
            {"type": "text", "text": content, "cache_control": dict(marker)}
        ]
        logger.debug(
            "apim_key_hook: injected cache_control on content block (role=%r, converted str->list)",
            msg.get("role"),
        )
        return True

    if isinstance(content, list):
        # Walk back to the last block that ACCEPTS a marker rather than
        # trusting the tail. The two differ exactly when a message ends in a
        # thinking block, which adaptive thinking makes ordinary.
        for block in reversed(content):
            if not _is_markable_block(block):
                continue
            if block.get("cache_control") is None:
                block["cache_control"] = dict(marker)
                logger.debug(
                    "apim_key_hook: injected cache_control on last markable block (role=%r, type=%r)",
                    msg.get("role"), block.get("type"),
                )
            return True

    # No eligible block: leave the message alone. A message-level
    # "cache_control" is not a field on an Anthropic MessageParam, so writing
    # one here only produced an invalid body.
    return False


def _inject_anthropic_prompt_cache(data: dict, marker: dict) -> None:
    """
    Add ephemeral cache breakpoints for Claude: last eligible tool and the
    message before the final one (rolling prefix). See Anthropic prompt caching
    docs.
    """
    messages = data.get("messages")
    if not isinstance(messages, list):
        return

    # Markers the caller placed already count against the same cap of four, so
    # a client that marks its own request must not be pushed over it by us.
    budget = _MAX_BREAKPOINTS - _count_existing_markers(data)
    if budget <= 0:
        logger.debug("apim_key_hook: caller already at the breakpoint cap; not injecting")
        return

    tools = data.get("tools")
    if budget > 1 and isinstance(tools, list) and tools:
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
            tool["cache_control"] = dict(marker)
            budget -= 1
            logger.debug(
                "apim_key_hook: injected cache_control on tool name=%r",
                tool.get("name") or (tool.get("function") or {}).get("name"),
            )
            break

    if budget <= 0:
        return

    # Prefer the message before the last (a rolling prefix that leaves the
    # newest turn unmarked), but fall back rather than give up when it has no
    # block that can carry a marker.
    for idx in (-2, -3, -1):
        if len(messages) < abs(idx):
            continue
        target = messages[idx]
        if isinstance(target, dict) and _inject_cache_control_on_message(target, marker):
            return


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
            setting = _auto_prompt_cache_setting(data)
            marker = (
                CACHE_CONTROL_EPHEMERAL_1H if setting == "1h" else CACHE_CONTROL_EPHEMERAL
            )
            _inject_anthropic_prompt_cache(data, marker)
            _strip_auto_cache_request_header(data)
            logger.info(
                "[%s] x-auto-prompt-caching: injected Anthropic ephemeral cache breakpoints",
                key_alias,
            )
        elif _wants_auto_prompt_cache(data):
            _strip_auto_cache_request_header(data)

        return data


proxy_handler_instance = ApimKeyHook()
