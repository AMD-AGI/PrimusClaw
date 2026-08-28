# SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
# SPDX-License-Identifier: Apache-2.0

"""HTTP clients used by the Python SDK and CLI."""

from .control_plane import ControlPlaneClient
from .data_plane import DataPlaneClient

__all__ = ["ControlPlaneClient", "DataPlaneClient"]
