<!--
Copyright Advanced Micro Devices, Inc.
SPDX-License-Identifier: MIT
-->

# Configuration

The worker reads its configuration from the environment once, at start, and stops before it takes a message when a
required setting is missing, a number is malformed, a setting another one needs is absent, or a strict switch or an
enumeration (`OUTBOUND_MODE`, `BOT_TOKEN_SOURCE`, `SECRETS_SOURCE`, `TEAMS_STREAMING`) has an unknown word. Addresses
are checked only where this page says so (`KEYVAULT_URL`, `SERVICEBUS_NAMESPACE`, `BOT_ASSERTION_ISSUER`,
`TEAMS_INSTALL_HINT_URL`); a wrong `CLAW_API_URL`, say, shows at the first request. **Not every switch is strict**,
either; see "How switches read" below, and check the spelling of the lenient ones.

[`../examples/worker.env.example`](../examples/worker.env.example) has every setting below with placeholder values,
except the feedback-plugin settings and the release gate's test entry (the last two sections).

Where each group is read:

- `packages/runtime/src/config/settings.ts` (`readSettings`): Claw, state, users, the exchange, review, limits.
- `packages/runtime/src/config/secrets.ts` and `packages/teams/src/azure/keyvault-config.ts`: secrets.
- `packages/teams/src/config/env.ts` (`teamsSettingsFromEnv`), `packages/teams/src/config/style.ts` and
  `packages/teams/src/azure/workload-identity.ts`: how the worker reaches Teams, the queues, its Azure identity, the reply
  style.
- `packages/runtime/src/github/feedback-worker.ts` (`workerInfoFromEnv`): the image tags a feedback report names.
- **[#615]** `packages/teams/src/assembly/features-switches.ts`: the feature switches marked [#615] below. They, and the
  process that calls every function above, arrive with pull request
  [#615](https://github.com/AMD-AGI/PrimusClaw/pull/615).

### How switches read

Switches keep the readings of the worker they were ported from, so there are four kinds:

| Kind          | Reading                                                                                                                     | Settings                                                                                                                                                                                                                                                                               |
| ------------- | --------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| strict        | `1`, `true`, `yes`, `on` or `0`, `false`, `no`, `off` (any case); empty takes the default; any other word stops the worker. | `TEAMS_ASSISTANT_UNDERSTANDING`, `TEAMS_DIRECT_CHAT`, and the reply-style switches `TEAMS_AI_LABEL`, `TEAMS_STREAM_TEXT`, `TEAMS_ASSISTANT_RECEIPT`, `TEAMS_ASSISTANT_PROGRESS`, `TEAMS_ASSISTANT_STREAM_SAY`, `TEAMS_OWN_THUMBS_MOBILE`, `TEAMS_SUGGESTED_REPLIES`, `TEAMS_CITATIONS` |
| lenient       | On for `1`, `true`, `yes`, `on` (any case); **anything else, a typo included, is off**.                                     | `ASSISTANT_ENABLED`, `TEAMS_EXCHANGE_ENABLED`, `TEAMS_EXCHANGE_FOR_CHAT`, `TEAMS_GITHUB_REVIEW_ENABLED`, `TEAMS_CLAW_EVENTS_GONE`                                                                                                                                                      |
| exactly `1`   | On only for `1`; **anything else, `true` included, is off**.                                                                | `PROACTIVE_ENABLED`, `ASSISTANT_SCHEDULES_ENABLED`, `ASSISTANT_JOB_WATCH_ENABLED`, `BRIEF_ENABLED`, `REMOTE_AGENTS_ENABLED` [#615]                                                                                                                                                     |
| on unless off | Off for `0`, `false`, `no`, `off` (any case); **anything else, a typo included, is on**.                                    | `REMOTE_PUSH_ENABLED` [#615]                                                                                                                                                                                                                                                           |

`REMOTE_WINDOW_DEFAULT` is `chat` for `chat` and `card` for anything else. Lists are comma separated; people are named
by their Microsoft Entra object id, in any case.

## Claw and the platform

| Setting                | Default        | Meaning                                                                                                                        |
| ---------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `CLAW_API_URL`         | required       | The Claw API.                                                                                                                  |
| `SAFE_API_URL`         | required       | The platform API Claw runs on ([SaFE](https://github.com/AMD-AGI/Primus-SaFE)); its `/users/self` tells whose a linked key is. |
| `PUBLIC_BASE_URL`      | required       | The worker's public origin; the exchange and credential URLs below default to paths under it.                                  |
| `CLAW_PLUGIN_ID`       | none           | The Claw plugin new sessions are created with; unset creates plain sessions.                                                   |
| `CLAW_RULE_TOOL_ID`    | none           | The Claw rule tool whose text rides on every message.                                                                          |
| `CLAW_CLIENT_LABEL`    | `clawy`        | What Claw's audit trail calls this client.                                                                                     |
| `CLAWY_MODEL`          | Claw's default | The model of chat turns.                                                                                                       |
| `CLAWY_FALLBACK_MODEL` | none           | The model a turn is run once more on when it was refused for want of the person's own model key.                               |
| `CLAWY_REVIEW_MODEL`   | none           | The model of pull request reviews.                                                                                             |

## Process and state

| Setting         | Default          | Meaning                                              |
| --------------- | ---------------- | ---------------------------------------------------- |
| `PORT`          | `8080`           | The HTTP endpoints.                                  |
| `METRICS_PORT`  | `9090`           | `/metrics`; must differ from `PORT`.                 |
| `TEAMS_DB_PATH` | `/data/state.db` | The SQLite database; its directory must be writable. |

## Secrets

| Setting                        | Default  | Meaning                                                                                                                                                                            |
| ------------------------------ | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SECRETS_SOURCE`               | `env`    | `env`: secrets from the environment. `keyvault`: from Azure Key Vault, read as the worker identity; the environment values of the secrets are then ignored.                        |
| `KEYVAULT_URL`                 | —        | With `keyvault`: `https://<name>.vault.azure.net`, nothing after the host.                                                                                                         |
| `TEAMS_ENCRYPTION_KEYS`        | required | Comma separated Fernet keys; the first encrypts, all decrypt. At start, stored secrets are re-encrypted to the first. Generate one with `openssl rand -base64 32 \| tr '+/' '-_'`. |
| `TEAMS_EXCHANGE_CLIENT_SECRET` | —        | Required with `TEAMS_EXCHANGE_ENABLED`.                                                                                                                                            |

With `keyvault` the vault entries are `clawy-encryption-keys` and `clawy-exchange-client-secret`.

## How the worker reaches Teams

| Setting                  | Default      | Meaning                                                                                                                                                     |
| ------------------------ | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OUTBOUND_MODE`          | `servicebus` | `servicebus`: replies go to the outbound queue for a relay. `direct`: the worker posts to the Bot Connector itself (streaming, deletes), queue as fallback. |
| `BOT_TOKEN_SOURCE`       | `imds`       | The bot's token in direct mode: `imds` (managed identity) or `federated` (workload identity federation; needs `direct`).                                    |
| `BOT_MSI_CLIENT_ID`      | —            | Required in direct mode: the bot's identity.                                                                                                                |
| `BOT_TENANT_ID`          | —            | Required with `federated` or the worker identity.                                                                                                           |
| `BOT_ASSERTION_KEY_FILE` | —            | Required with `federated` or the worker identity: the private key the assertions are signed with, as a mounted file.                                        |
| `BOT_ASSERTION_ISSUER`   | —            | Required with `federated` or the worker identity: the https issuer registered in the federated credential.                                                  |
| `BOT_ASSERTION_SUBJECT`  | —            | Required with `federated`.                                                                                                                                  |

## Service Bus and the worker identity

| Setting                               | Default               | Meaning                                                                                                     |
| ------------------------------------- | --------------------- | ----------------------------------------------------------------------------------------------------------- |
| `SERVICEBUS_NAMESPACE`                | none                  | `<name>.servicebus.windows.net`: the queues are reached as the worker identity.                             |
| `SERVICEBUS_LISTEN_CONNECTION_STRING` | —                     | Required without `SERVICEBUS_NAMESPACE`.                                                                    |
| `SERVICEBUS_SEND_CONNECTION_STRING`   | —                     | Required without `SERVICEBUS_NAMESPACE`.                                                                    |
| `INBOUND_QUEUE`                       | `primusclaw-inbound`  | Sessions must be enabled on it (one session per conversation).                                              |
| `OUTBOUND_QUEUE`                      | `primusclaw-outbound` |                                                                                                             |
| `RECEIVER_COUNT`                      | `8`                   | How many conversations are handled at once.                                                                 |
| `WORKER_IDENTITY_CLIENT_ID`           | —                     | Required with `SERVICEBUS_NAMESPACE` or `SECRETS_SOURCE=keyvault`: the worker's own user-assigned identity. |
| `WORKER_IDENTITY_SUBJECT`             | —                     | Required with it: the subject its federated credential names.                                               |

The worker identity signs with the `BOT_ASSERTION_*` key, issuer and tenant, but is a separate identity from the bot's.

## Features

| Setting                               | Default           | Meaning                                                                                                                                             |
| ------------------------------------- | ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PROACTIVE_ENABLED` [#615]            | off               | Exactly `1`: Claw's notifications are taken at `/claw-events/<route>` and posted into the chat.                                                     |
| `NOTIFY_WEBHOOK_URL` [#615]           | —                 | Required with `PROACTIVE_ENABLED`: where Claw sends this worker's events (each person's route is appended), normally `<public origin>/claw-events`. |
| `REMOTE_PUSH_ENABLED` [#615]          | on                | An attached chat hears its remote agent between turns; only with `PROACTIVE_ENABLED`; `0`, `false`, `no`, `off` turn it off.                        |
| `TEAMS_CLAW_EVENTS_GONE`              | off               | An event for a person with no chat is answered `410 Gone` instead of `200`.                                                                         |
| `ASSISTANT_ENABLED`                   | off               | The assistant: each person's standing agent in Claw.                                                                                                |
| `ASSISTANT_USERS`                     | everybody         | Who has it, when the assistant is on.                                                                                                               |
| `ASSISTANT_REPLY_WINDOW_SECONDS`      | `1800`            | After a person last wrote, how long what the assistant says counts as a reply rather than an unprompted message.                                    |
| `TEAMS_ASSISTANT_UNDERSTANDING`       | off               | The assistant reads every message of the listed people first. Needs `ASSISTANT_ENABLED`.                                                            |
| `TEAMS_ASSISTANT_UNDERSTANDING_USERS` | `ASSISTANT_USERS` | Who; must be a subset of `ASSISTANT_USERS`, and someone must be named.                                                                              |
| `ASSISTANT_SCHEDULES_ENABLED` [#615]  | off               | Exactly `1`: scheduled assistant work.                                                                                                              |
| `ASSISTANT_JOB_WATCH_ENABLED` [#615]  | off               | Exactly `1`: the assistant watches jobs.                                                                                                            |
| `BRIEF_ENABLED` [#615]                | off               | Exactly `1`: `/brief` (needs Claw's trigger API).                                                                                                   |
| `REMOTE_AGENTS_ENABLED` [#615]        | off               | Exactly `1`: remote agents through claw-connector.                                                                                                  |
| `REMOTE_WINDOW_DEFAULT` [#615]        | `card`            | `chat` or `card`: how a remote agent session shows by default.                                                                                      |
| `TEAMS_DIRECT_CHAT`                   | off               | A chat attached to a remote agent session becomes that agent's own window.                                                                          |
| `TEAMS_DIRECT_CHAT_USERS`             | everybody         | For whom, when on.                                                                                                                                  |
| `TEAMS_OBSERVE_USERS`                 | nobody            | Who may say `/observe on` in a group chat, making their assistant the group's observer.                                                             |
| `TEAMS_ON_BEHALF_USERS`               | none              | Claw user ids whose own key may post into their own chat; read for a deployment's plugins.                                                          |

## Token exchange and review for a colleague

| Setting                              | Default                                      | Meaning                                                                                    |
| ------------------------------------ | -------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `TEAMS_EXCHANGE_ENABLED`             | off                                          | People act with tokens exchanged for them by the identity service (RFC 8693).              |
| `TEAMS_EXCHANGE_CLIENT_ID`           | —                                            | Required when on.                                                                          |
| `TEAMS_EXCHANGE_TOKEN_URL`           | `PUBLIC_BASE_URL/oauth/token`                |                                                                                            |
| `TEAMS_EXCHANGE_BINDING_REQUEST_URL` | `PUBLIC_BASE_URL/oauth/binding-requests`     | Where a person who is not bound yet is sent to confirm.                                    |
| `TEAMS_EXCHANGE_ISSUER`              | `teams.microsoft.com`                        |                                                                                            |
| `TEAMS_EXCHANGE_AUDIENCE`            | `claw-api`                                   |                                                                                            |
| `TEAMS_EXCHANGE_SCOPE`               | `claw.api`                                   |                                                                                            |
| `TEAMS_EXCHANGE_FOR_CHAT`            | off                                          | Ordinary chats use the exchanged token too, instead of the linked key. Needs the exchange. |
| `TEAMS_GITHUB_REVIEW_ENABLED`        | off                                          | Review a colleague's pull request on their behalf. Needs the exchange.                     |
| `TEAMS_GITHUB_REVIEW_OWNERS`         | —                                            | Required when on: the GitHub owners whose pull requests are taken.                         |
| `TEAMS_REVIEW_INTENT_MODEL`          | `CLAWY_MODEL`                                | The model that reads a review request; empty reads it by rules alone.                      |
| `TEAMS_GITHUB_CREDENTIAL_URL`        | `PUBLIC_BASE_URL/oauth/external-credentials` |                                                                                            |
| `TEAMS_GITHUB_CLIENT_ID`             | the GitHub CLI's public OAuth client         | The OAuth client of the device flow that connects a GitHub account.                        |

## Limits

| Setting                             | Default    | Meaning                                                                                                   |
| ----------------------------------- | ---------- | --------------------------------------------------------------------------------------------------------- |
| `TEAMS_USER_MESSAGE_LIMIT`          | `20`       | Messages a person may send per window.                                                                    |
| `TEAMS_USER_MESSAGE_WINDOW_SECONDS` | `60`       |                                                                                                           |
| `TEAMS_USER_MAX_CONCURRENT_TASKS`   | `12`       | Turns a person may have running at once.                                                                  |
| `TEAMS_LINK_MAX_FAILURES_PER_USER`  | `5`        | Failed `/link` attempts per person per window.                                                            |
| `TEAMS_LINK_MAX_FAILURES_GLOBAL`    | `100`      | Failed `/link` attempts in all per window.                                                                |
| `TEAMS_LINK_ATTEMPT_WINDOW_SECONDS` | `600`      |                                                                                                           |
| `TEAMS_LIMIT_PR_REVIEW`             | `30/3600`  | `COUNT/SECONDS` per person, or `0` for no limit: reviews started for a colleague, or held reviews posted. |
| `TEAMS_LIMIT_PR_MERGE`              | `20/3600`  | Merges confirmed that Claw holds.                                                                         |
| `TEAMS_LIMIT_APPROVAL`              | `120/3600` | Tool calls approved.                                                                                      |
| `TEAMS_LIMIT_REMOTE_AGENT`          | `10/3600`  | Switches of a remote agent to a mode that does not ask.                                                   |

## Reply style in Teams

| Setting                      | Default              | Meaning                                                                               |
| ---------------------------- | -------------------- | ------------------------------------------------------------------------------------- |
| `TEAMS_INSTALL_HINT_URL`     | none                 | An `https` Teams deep link to the app, offered on review cards to people who lack it. |
| `TEAMS_AI_LABEL`             | on                   | Answers carry Teams' "AI generated" label.                                            |
| `TEAMS_STREAMING`            | `personal,groupChat` | The chat kinds where a turn shows Teams' live status (direct mode only), or `off`.    |
| `TEAMS_STREAM_TEXT`          | off                  | The agent's text is streamed into the answer.                                         |
| `TEAMS_ASSISTANT_RECEIPT`    | on                   | The assistant's receipt.                                                              |
| `TEAMS_ASSISTANT_PROGRESS`   | on                   | The assistant's live steps.                                                           |
| `TEAMS_ASSISTANT_STREAM_SAY` | on                   | The assistant's streamed words.                                                       |
| `TEAMS_OWN_THUMBS_MOBILE`    | on                   | On mobile clients, the worker's own feedback buttons under an answer.                 |
| `TEAMS_SUGGESTED_REPLIES`    | on                   | Suggested replies.                                                                    |
| `TEAMS_CITATIONS`            | off                  | Citations.                                                                            |

## Feedback reports

| Setting                       | Default | Meaning                                   |
| ----------------------------- | ------- | ----------------------------------------- |
| `WORKER_IMAGE_TAG` [#615]     | none    | Named in a report, as the worker's image. |
| `CLAW_API_IMAGE_TAG` [#615]   | none    | As Claw API's image.                      |
| `CLAW_BRAIN_IMAGE_TAG` [#615] | none    | As Claw Brain's image.                    |

The public build records reports and files them nowhere: filing is a `FeedbackSink` plugin. A deployment's own `main`
can build one with runtime's `feedbackConfigFromEnv` and `feedbackSink`, which read `FEEDBACK_REPO` (`owner/name`),
`FEEDBACK_GITHUB_APP_ID`, `FEEDBACK_GITHUB_INSTALLATION_ID`, `FEEDBACK_GITHUB_KEY_FILE` and
`FEEDBACK_GITHUB_TOKEN_FILE`. The secret loader already reads the App key (`FEEDBACK_GITHUB_KEY_FILE`, or the vault entry
`clawy-feedback-github-app-key`) when both App ids are set, so leave them unset unless such a plugin uses them.

## Release gate only

`TEAMS_GATE_ENTRY`, `GATE_RUN_ID` and `TEAMS_GATE_CONNECTOR_URL` turn on a test entry that a release gate drives from
outside the process, against a recording Bot Connector on `127.0.0.1`. Production never sets them: the entry is on only
when `TEAMS_GATE_ENTRY` is exactly `1`, `GATE_RUN_ID` is set and the connector is a loopback address, and any other
value of `TEAMS_GATE_ENTRY` stops the worker.
