# knowledge-worker (`knowledge_worker`)

Stateless worker that turns raw session events into structured KB articles via
the memory service's `/api/kb/*` contract. Source: `memory/knowledge-worker`.

## `knowledge_worker`

```{eval-rst}
.. automodule:: knowledge_worker
```

### Configuration and entry point

```{eval-rst}
.. automodule:: knowledge_worker.config

.. automodule:: knowledge_worker.main
```

### Pipeline

```{eval-rst}
.. automodule:: knowledge_worker.pipeline

.. automodule:: knowledge_worker.events

.. automodule:: knowledge_worker.extractor

.. automodule:: knowledge_worker.writer
```

### KB client

```{eval-rst}
.. automodule:: knowledge_worker.client
```

### Utilities

```{eval-rst}
.. automodule:: knowledge_worker.slug

.. automodule:: knowledge_worker.lint

.. automodule:: knowledge_worker.reindex

.. automodule:: knowledge_worker.testing
```
