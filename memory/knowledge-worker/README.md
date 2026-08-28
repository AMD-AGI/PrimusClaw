# knowledge-worker

Stateless worker that turns **raw session events** into **structured KB articles**
in the knowledge base. It is the upstream producer for `kb-service`.

> Clean rewrite sharing no code with the earlier extraction implementation,
> which is not part of this repository. All KB writes go through the memory
> service `/api/kb/*` contract via `knowledge_worker.client.KBClient`.

## Pipeline

```
raw events (JSONL)            ArticleDraft list                      kb_articles
+----------------+   extract  +-------------------+    write_via_SDK +------------+
|  events.jsonl  | ---------> |  + classify       | ---------------> | kb-service |
|                |            |  + compute slug   |                  |  /upsert   |
|                |            |  + scope          |                  |            |
|                |            |  + importance     |  on error -+     |  /edges    |
+----------------+            +-------------------+            |     +------------+
                                                               v
                                                   +-----------------------+
                                                   | dead-letter JSONL file|
                                                   |  (PVC, replay via SDK)|
                                                   +-----------------------+
```

The four contract stages (`extract`, `write_or_merge`, `reindex`, `lint`) are
implemented as pluggable steps in `pipeline.py`. The MVP ships a rule-based
extractor; a `LLMExtractor` protocol is provided so the team can swap in a real
LLM call without touching the orchestration layer.

## Layout

```
src/knowledge_worker/
  config.py         # env-driven configuration
  events.py         # RawEvent dataclass + JSONL reader
  extractor.py      # ArticleDraft + RuleBasedExtractor + LLMExtractor protocol
  writer.py         # write drafts via KBClient + dead-letter on failure
  pipeline.py       # 4-stage orchestration (extract -> write -> reindex -> lint)
  reindex.py        # placeholder hook (no-op in MVP)
  lint.py           # placeholder hook (no-op in MVP)
  main.py           # CLI entrypoint
tests/              # uses InMemoryKBClient from the SDK (no service required)
```

## Configuration

| Env var | Default | Notes |
|---|---|---|
| `KB_BASE_URL` | `http://localhost:8765` | kb-service base URL |
| `WORKER_INPUT_PATH` | `/var/lib/knowledge-worker/events.jsonl` | raw event JSONL file |
| `WORKER_DEAD_LETTER_PATH` | `/var/lib/knowledge-worker/dead-letter.jsonl` | failed writes for later replay |
| `WORKER_DRY_RUN` | `false` | skip KB writes, log only |
| `WORKER_LOG_LEVEL` | `INFO` | |

## Running

```bash
claw-knowledge-worker            # the console script this package installs
# or, against the in-memory client (no kb-service required):
python -m knowledge_worker.main --backend memory --input ./events.jsonl
```
