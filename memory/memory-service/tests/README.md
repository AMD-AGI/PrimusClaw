# Memory Service Tests

Pure-Python unit tests. They do NOT require a running Postgres or
asyncpg. The activation engine tests stand up a tiny in-memory
``FakeStore`` matching the protocol consumed by ``activation.activate``.

| File | Coverage |
| --- | --- |
| `test_scope_normalization.py` | `_scope_from_string`, `_scope_to_string`, `_normalize_scope`, roundtrips |
| `test_handlers_scope.py` | request/response scope helpers in `handlers.py` |
| `test_kb_store_helpers.py` | KB constants, `_merge_edges` semantics, KB-aware `scopePath` rendering |
| `test_kb_handlers.py` | `_wrap_kb_entry`, `_validate_kind`, `_validate_scope` |
| `test_activation.py` | full 4-layer activation engine: layer scoring, spread, lifecycle reweight, contradicts suppression, budget cap, determinism |

## Run

```bash
cd memory/memory-service
pip install -e .
pip install pytest
pytest tests
```
