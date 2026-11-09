# Copyright Advanced Micro Devices, Inc.
# SPDX-License-Identifier: MIT

# Use the provided base image (includes pre-built UI)
# v1.96.2 is the floor for Auto Router v2 + classifier context windows.
FROM ghcr.io/berriai/litellm:v1.108.0@sha256:c560d317136880ea92d62334d4367ab10955b1af189dd3ea24f6551290b1d6c1

WORKDIR /app
 
# ═══ Inject custom hook files ═══
# In the base image, litellm is pip-installed, so the import path resolves to
# site-packages, NOT /app. We dynamically locate the real install path and copy there.
COPY prompt_cache_hook.py /tmp/hooks/prompt_cache_hook.py
RUN HOOKS_DIR=$(python3 -c "import litellm.proxy.hooks; import os; print(os.path.dirname(litellm.proxy.hooks.__file__))") && \
    echo "Installing hooks to: $HOOKS_DIR" && \
    cp /tmp/hooks/prompt_cache_hook.py "$HOOKS_DIR/" && \
    rm -rf /tmp/hooks && \
    echo "Hook installed successfully"
 
# ═══ Patch UI basePath in pre-built static files ═══
# Skip full UI rebuild (requires Google Fonts access which is blocked).
# Instead, patch the basePath directly in the already-built static files.
RUN OUT_DIR="/app/litellm/proxy/_experimental/out" && \
    if [ -d "$OUT_DIR" ]; then \
      find "$OUT_DIR" -type f \( -name '*.html' -o -name '*.js' -o -name '*.json' \) \
        -exec sed -i 's|/ui|/llm-gateway|g' {} + && \
      echo "UI basePath patched: /ui -> /llm-gateway"; \
    else \
      echo "WARNING: UI out directory not found, skipping patch"; \
    fi
 
ENV UI_BASE_PATH="/llm-gateway"
 
# Make sure entrypoint is executable
RUN chmod +x ./docker/entrypoint.sh
 
EXPOSE 4000/tcp
 
CMD ["--port", "4000", "--config", "config.yaml"]