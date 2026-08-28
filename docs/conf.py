# Copyright Advanced Micro Devices, Inc.
# SPDX-License-Identifier: MIT

"""Sphinx configuration for the PrimusClaw Python packages.

This site covers the repository's Python packages only. PrimusClaw is mostly
TypeScript and Go, and those trees are documented in Markdown next to the code
(see the repository README) rather than here.

The build uses ``sphinx.ext.napoleon`` so the Google-style docstrings in those
packages render as structured API documentation, and ``autodoc_mock_imports`` so
the API pages build without installing every runtime dependency.
"""

from __future__ import annotations

import os
import sys

# -- Package source roots ----------------------------------------------------

# autodoc imports the modules it documents, so every documented package needs to
# be importable. These are the three Python distributions in the repository;
# paths are relative to this file so the build works from any directory.
_DOCS_DIR = os.path.dirname(os.path.abspath(__file__))
_REPO_ROOT = os.path.dirname(_DOCS_DIR)

for _src in (
    "memory/memory-service/src",
    "memory/knowledge-worker/src",
    "sandbox/sdk-python",
):
    sys.path.insert(0, os.path.join(_REPO_ROOT, _src))

# -- Project information -----------------------------------------------------

project = "PrimusClaw"
copyright = "Advanced Micro Devices, Inc."
author = "Advanced Micro Devices, Inc."

# -- General configuration ---------------------------------------------------

extensions = [
    "sphinx.ext.autodoc",
    "sphinx.ext.autosummary",
    "sphinx.ext.napoleon",
    "sphinx.ext.viewcode",
    "sphinx.ext.intersphinx",
    "myst_parser",
]

templates_path = ["_templates"]
exclude_patterns = ["_build", "Thumbs.db", ".DS_Store"]

source_suffix = {
    ".rst": "restructuredtext",
    ".md": "markdown",
}

# -- napoleon (Google-style docstrings) --------------------------------------

napoleon_google_docstring = True
napoleon_numpy_docstring = False
napoleon_include_init_with_doc = True
napoleon_use_param = True
napoleon_use_rtype = True
napoleon_preprocess_types = True

# -- autodoc / autosummary ---------------------------------------------------

autosummary_generate = True
autodoc_default_options = {
    "members": True,
    "undoc-members": True,
    "show-inheritance": True,
}
autodoc_typehints = "description"

# Third-party runtime dependencies that need not be installed to build the
# docs. autodoc replaces them with mock objects during import. This list is the
# set of non-stdlib top-level imports actually reachable from the three
# documented packages; entries for libraries the code does not import would be
# silently useless, so keep it in step with the source.
autodoc_mock_imports = [
    "asyncpg",
    "fastapi",
    "httpx",
    "prometheus_client",
    "pydantic",
    "requests",
    "urllib3",
    "uvicorn",
    "websockets",
]

# -- intersphinx -------------------------------------------------------------

intersphinx_mapping = {
    "python": ("https://docs.python.org/3", None),
}

# -- HTML output -------------------------------------------------------------

html_theme = "furo"
html_title = "PrimusClaw Python API reference"
