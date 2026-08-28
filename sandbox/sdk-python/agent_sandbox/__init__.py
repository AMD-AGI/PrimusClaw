# SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
# SPDX-License-Identifier: Apache-2.0

"""agent_sandbox — E2B-style Python SDK for agent-sandbox."""

# Suppress SSL warnings for self-signed certificates (default verify_ssl=False)
import urllib3
urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

from .sandbox import PortForward, Sandbox
from .exceptions import SandboxError, SandboxNotFoundError, SandboxTimeoutError

__all__ = ["PortForward", "Sandbox", "SandboxError", "SandboxNotFoundError", "SandboxTimeoutError"]
__version__ = "0.1.0"
