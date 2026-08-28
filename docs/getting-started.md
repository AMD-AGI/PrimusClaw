# Getting started

## Building the docs

From the repository root:

```bash
pip install -r docs/requirements.txt
sphinx-build -b html docs docs/_build/html
```

Then open `docs/_build/html/index.html`.

On a machine with `make`:

```bash
cd docs
make html
```

On Windows:

```bat
cd docs
make.bat html
```

## How the API reference is generated

The API pages use `sphinx.ext.autodoc` together with `sphinx.ext.napoleon`,
which understands **Google-style** docstrings (the `Args:`, `Returns:`, and
`Raises:` sections used throughout the codebase). Heavy third-party runtime
dependencies are listed in `autodoc_mock_imports` in `docs/conf.py`, so the
documentation builds without installing the full runtime environment.

## Scope

Only the three Python distributions are covered here: `claw_memory`
(`memory/memory-service`), `knowledge_worker` (`memory/knowledge-worker`) and
`agent_sandbox` (`sandbox/sdk-python`). The TypeScript and Go trees are the
larger part of the repository and are documented in Markdown beside the code.

## Adding another package

1. Add the package's source directory to the loop that extends `sys.path` in
   `docs/conf.py`; autodoc has to import a module to document it.
2. Add any new third-party top-level imports to `autodoc_mock_imports`, so the
   build does not need the runtime environment installed.
3. Create a page under `docs/api/` using `automodule` directives (see the three
   existing pages for the pattern) and add it to the toctree in
   `docs/api/index.md`.
