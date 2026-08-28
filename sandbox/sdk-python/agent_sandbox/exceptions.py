# SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Exception types for agent_sandbox SDK."""


class SandboxError(Exception):
    """Base class for agent_sandbox errors."""


class SandboxNotFoundError(SandboxError):
    """Raised when a sandbox or session cannot be found."""


class SandboxTimeoutError(SandboxError):
    """Raised when waiting for a sandbox times out."""


class SandboxCommandError(SandboxError):
    """Raised when a command exits with a non-zero exit code."""

    def __init__(self, message: str, exit_code: int, stdout: str = "", stderr: str = "") -> None:
        super().__init__(message)
        self.exit_code = exit_code
        self.stdout = stdout
        self.stderr = stderr
