// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** LiteLLM Auto Router writes the backend it picked here. */
export const LITELLM_ROUTED_MODEL_HEADER = "x-litellm-model-name";

/**
 * Slot filled by {@link wrapFetchCaptureRoutedModel} on each HTTP response.
 *
 * The wrapper is the sink's only writer, and it writes on every successful
 * attempt including the header-absent case (as `undefined`). Callers must not
 * clear it themselves: the SDK cannot hand back a stream without a successful
 * response having passed through the wrapper first, so the slot is always
 * freshly written before it is read, and a caller-side reset is a second
 * writer that no path needs.
 */
export interface RoutedModelSink {
  headerModel?: string;
}

function trimModel(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

/**
 * LiteLLM provider prefixes we will strip. A closed list, not a pattern.
 *
 * The first version tested the prefix against `^[a-z][a-z0-9_]*$` after
 * lowercasing, i.e. "anything that looks like an identifier". That is also
 * what a Hugging Face org name looks like, so it ate them: `Qwen/Qwen3-235B`
 * became `Qwen3-235B` and `mistralai/Mixtral-8x7B-Instruct-v0.1` became
 * `Mixtral-8x7B-Instruct-v0.1`, while `deepseek-ai/DeepSeek-V3` and
 * `meta-llama/Llama-3.3-70B` survived only because a hyphen failed the
 * pattern. Same class of id, opposite result. On a vLLM or SGLang backend
 * that leaves `routed_model` holding something that is not the model id, and
 * cannot be reconciled against the serving config.
 */
const LITELLM_PROVIDER_PREFIXES = new Set([
  "anthropic", "openai", "azure", "azure_ai", "azure_text",
  "bedrock", "bedrock_converse", "vertex_ai", "vertex_ai_beta", "gemini",
  "cohere", "cohere_chat", "mistral", "deepseek", "groq", "xai",
  "ollama", "ollama_chat", "openrouter", "together_ai", "fireworks_ai",
  "hosted_vllm", "vllm", "sagemaker", "databricks", "watsonx", "nvidia_nim",
  "text-completion-openai", "custom_openai", "litellm_proxy",
]);

/**
 * LiteLLM's `x-litellm-model-name` is a deployment string like
 * `anthropic/claude-haiku-4-5`. SSE `routed_model` uses the public model id.
 * Anything whose first segment is not a known provider is left alone, so an
 * `<org>/<model>` id survives intact.
 */
function stripLiteLlmProviderPrefix(model: string): string {
  const slash = model.indexOf("/");
  if (slash <= 0) return model;
  if (!LITELLM_PROVIDER_PREFIXES.has(model.slice(0, slash).toLowerCase())) return model;
  const rest = model.slice(slash + 1).trim();
  return rest || model;
}

function modelFromHeaders(headers: unknown): string | undefined {
  if (!headers || typeof (headers as Headers).get !== "function") return undefined;
  return trimModel((headers as Headers).get(LITELLM_ROUTED_MODEL_HEADER));
}

// There is deliberately no "did a router pick this" discriminator.
//
// An earlier version returned one, on the assumption that the presence of
// `x-litellm-model-name` meant an Auto Router had chosen a backend. It does
// not. In v1.96.2 `get_custom_headers()` writes that header on every proxied
// response, from `litellm_params.metadata["deployment"]`, which the Router
// stamps for *any* model_list entry (router.py sets it alongside model_info
// and api_base on every call). Only an empty value is filtered out. So the
// header is present for every deployment behind LiteLLM, router or not, and
// anything gated on it fires everywhere.
//
// Comparing against the requested model does not rescue it either: a gateway
// that maps an alias to a different backend -- observed live, `claude-opus-4-7`
// served by `claude-opus-4-8` -- differs on every single turn.

/**
 * Prefer the LiteLLM header (the backend the Auto Router picked) over the
 * stream body `model` (often the request alias, e.g. `claude-auto`).
 *
 * There is deliberately no fall back to the requested model: `routed_model`
 * is contracted as "the backend that served this turn", and echoing the alias
 * back when nothing reported a backend would make the field a lie exactly
 * when a reader most needs to know the router did not answer.
 */
export function resolveRoutedModel(opts: {
  bodyModel?: unknown;
  headerModel?: unknown;
}): string | undefined {
  const raw = trimModel(opts.headerModel) ?? trimModel(opts.bodyModel);
  return raw ? stripLiteLlmProviderPrefix(raw) : undefined;
}

/** Best-effort: some SDK stream objects expose a Fetch `Response`. */
function headersFromSdkStream(stream: unknown): Headers | undefined {
  if (!stream || typeof stream !== "object") return undefined;
  const response = (stream as { response?: unknown }).response;
  if (!response || typeof response !== "object") return undefined;
  const headers = (response as { headers?: unknown }).headers;
  if (!headers || typeof (headers as Headers).get !== "function") return undefined;
  return headers as Headers;
}

export function headerModelFromStream(stream: unknown): string | undefined {
  return modelFromHeaders(headersFromSdkStream(stream));
}

/**
 * Anthropic/OpenAI `Stream` does not expose the underlying `Response`. Wrap
 * the client's `fetch` so each attempt records `x-litellm-model-name`.
 */
export function wrapFetchCaptureRoutedModel(
  sink: RoutedModelSink,
  baseFetch: typeof fetch = globalThis.fetch.bind(globalThis),
): typeof fetch {
  return (async (input, init) => {
    const res = await baseFetch(input, init);
    // A 429/5xx retry must not wipe a later 200's header (or keep a stale
    // one from the previous turn). Only a successful attempt is the backend.
    if (res.ok) sink.headerModel = modelFromHeaders(res.headers);
    return res;
  }) as typeof fetch;
}
