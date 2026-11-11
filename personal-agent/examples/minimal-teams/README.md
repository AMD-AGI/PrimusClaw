<!--
Copyright Advanced Micro Devices, Inc.
SPDX-License-Identifier: MIT
-->

# Minimal Teams deployment

The smallest configuration of the personal agent's Teams worker that answers real people, run from the published image
`docker.io/primussafe/personal-agent-teams:0.1.1`.

| File                                       | What it is                                                                                   |
| ------------------------------------------ | -------------------------------------------------------------------------------------------- |
| [`.env.example`](.env.example)             | The required settings, with placeholders. Copy it to `.env` and fill it in; never commit it. |
| [`docker-compose.yml`](docker-compose.yml) | The worker, its state volume, `/healthz` on port 8080 and `/metrics` on 9090 (local only).   |

```bash
cp .env.example .env    # fill it in
docker compose up -d
curl -fsS http://127.0.0.1:8080/healthz
```

The worker alone does not reach Teams: it needs a bot registration, a Service Bus namespace and an ingress in front of
the inbound queue. Follow the [quick start](../../docs/quickstart.md#deploy-for-microsoft-teams), which sets each of
them up and explains every line of these two files.
