# SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Session and Terminal abstractions for persistent tmux sessions."""

from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .clients.data_plane import DataPlaneClient


class Session:
    """
    A persistent tmux session inside the sandbox.

    Example::

        session = sbx.session.create()
        session.exec("cd /home/code")
        session.exec("ls")          # still in /home/code
        session.exec("export FOO=bar")
        print(session.exec("echo $FOO").output)  # "bar"
    """

    def __init__(self, terminal_id: str, client: "DataPlaneClient") -> None:
        self._id = terminal_id
        self._client = client

    @property
    def id(self) -> str:
        return self._id

    def exec(self, command: str, timeout: str = "30s", working_dir: str = "") -> "ExecResult":
        """Execute a command in this tmux session (cwd/env persist between calls)."""
        resp = self._client.session_exec(self._id, command, timeout=timeout, working_dir=working_dir)
        return ExecResult(
            output=resp.get("output", ""),
            exit_code=resp.get("exit_code", 0),
        )

    def output(self) -> str:
        """Return the current tmux pane content."""
        return self._client.session_output(self._id)

    def send_keys(self, keys: list[str]) -> None:
        """Send raw key sequences (supports Ctrl+C, Enter, etc.)."""
        self._client.send_keys(self._id, keys)

    def screen(self) -> "ScreenSnapshot":
        """Get the current terminal screen snapshot."""
        resp = self._client.screen(self._id)
        return ScreenSnapshot(
            content=resp.get("content", ""),
            cursor_x=resp.get("cursor_x", 0),
            cursor_y=resp.get("cursor_y", 0),
            width=resp.get("width", 200),
            height=resp.get("height", 50),
        )

    def close(self) -> None:
        """Destroy this tmux session."""
        self._client.session_delete(self._id)

    def __enter__(self) -> "Session":
        return self

    def __exit__(self, *_) -> None:
        self.close()


class SessionManager:
    """Factory for creating persistent sessions; accessible as ``sbx.session``."""

    def __init__(self, client: "DataPlaneClient") -> None:
        self._client = client

    def create(self) -> Session:
        """Create a new tmux session and return a Session handle."""
        terminal_id = self._client.session_create()
        return Session(terminal_id, self._client)


class ExecResult:
    """Result of a session exec call."""

    def __init__(self, output: str, exit_code: int) -> None:
        self.output = output
        self.exit_code = exit_code

    def __repr__(self) -> str:
        return f"ExecResult(exit_code={self.exit_code}, output={self.output!r})"


class ScreenSnapshot:
    """A snapshot of the terminal screen."""

    def __init__(self, content: str, cursor_x: int, cursor_y: int, width: int, height: int) -> None:
        self.content = content
        self.cursor_x = cursor_x
        self.cursor_y = cursor_y
        self.width = width
        self.height = height

    def __repr__(self) -> str:
        return f"ScreenSnapshot(cursor=({self.cursor_x},{self.cursor_y}), size={self.width}x{self.height})"
