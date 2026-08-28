# SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
# SPDX-License-Identifier: Apache-2.0

"""File operations for the sandbox."""

from __future__ import annotations

from pathlib import Path
from typing import TYPE_CHECKING, Union

if TYPE_CHECKING:
    from .clients.data_plane import DataPlaneClient


class Files:
    """File operations; accessible as ``sbx.files``."""

    def __init__(self, client: "DataPlaneClient") -> None:
        self._client = client

    def write(self, remote_path: str, content: Union[str, bytes], mode: str = "0644") -> None:
        """Write content to a file in the sandbox."""
        if isinstance(content, str):
            content = content.encode()
        self._client.file_write(remote_path, content, mode=mode)

    def upload(self, local_path: Union[str, Path], remote_path: str) -> None:
        """Upload a local file to the sandbox."""
        self._client.file_upload(str(local_path), remote_path)

    def download(self, remote_path: str, local_path: Union[str, Path]) -> None:
        """Download a file from the sandbox to a local path."""
        self._client.file_download(remote_path, str(local_path))

    def list(self, path: str = ".") -> list[dict]:
        """List files in a sandbox directory."""
        return self._client.file_list(path)

    def delete(self, path: str) -> None:
        """Delete a file or directory in the sandbox."""
        self._client.file_delete(path)

    def read(self, remote_path: str) -> bytes:
        """Read a file from the sandbox and return its contents as bytes."""
        import tempfile, os
        with tempfile.NamedTemporaryFile(delete=False) as tmp:
            tmp_path = tmp.name
        try:
            self._client.file_download(remote_path, tmp_path)
            with open(tmp_path, "rb") as f:
                return f.read()
        finally:
            os.unlink(tmp_path)

    def read_text(self, remote_path: str, encoding: str = "utf-8") -> str:
        """Read a text file from the sandbox."""
        return self.read(remote_path).decode(encoding)
