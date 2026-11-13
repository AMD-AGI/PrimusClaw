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

The worker's own settings carry the `PA_` prefix; before 0.8.1 they carried `TEAMS_`, and those names still work (see
"Setting names" at the end). A surface's own settings keep the surface's prefix (`TEAMS_STREAMING`).

[`../examples/worker.env.example`](../examples/worker.env.example) has every setting below with placeholder values,
except the feedback-plugin settings, the release gate's test entry and the Teams ingress's (a Function app's settings,
not the worker's).

Where each group is read:

- `packages/runtime/src/config/settings.ts` (`readSettings`): Claw, state, users, the exchange, review, limits.
- `packages/runtime/src/config/secrets.ts` and `packages/teams/src/azure/keyvault-config.ts`: secrets.
- `packages/teams/src/config/env.ts` (`teamsSettingsFromEnv`), `packages/teams/src/config/style.ts` and
  `packages/teams/src/azure/workload-identity.ts`: how the worker reaches Teams, the queues, its Azure identity, the reply
  style.
- `packages/runtime/src/github/feedback-worker.ts` (`workerInfoFromEnv`): the image tags a feedback report names.
- `packages/runtime/src/worker/features-switches.ts`: the feature switches.
- `packages/teams-ingress/src/settings.ts` and `packages/teams-ingress/src/auth.ts`: the Teams ingress.

### How switches read

Switches keep the readings of the worker they were ported from, so there are four kinds:

| Kind          | Reading                                                                                                                     | Settings                                                                                                                                                                                                                                                                         |
| ------------- | --------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| strict        | `1`, `true`, `yes`, `on` or `0`, `false`, `no`, `off` (any case); empty takes the default; any other word stops the worker. | `PA_ASSISTANT_UNDERSTANDING`, `PA_DIRECT_CHAT`, and the reply-style switches `TEAMS_AI_LABEL`, `TEAMS_STREAM_TEXT`, `TEAMS_ASSISTANT_RECEIPT`, `TEAMS_ASSISTANT_PROGRESS`, `TEAMS_ASSISTANT_STREAM_SAY`, `TEAMS_OWN_THUMBS_MOBILE`, `TEAMS_SUGGESTED_REPLIES`, `TEAMS_CITATIONS` |
| lenient       | On for `1`, `true`, `yes`, `on` (any case); **anything else, a typo included, is off**.                                     | `ASSISTANT_ENABLED`, `PA_EXCHANGE_ENABLED`, `PA_EXCHANGE_FOR_CHAT`, `PA_GITHUB_REVIEW_ENABLED`, `PA_CLAW_EVENTS_GONE`                                                                                                                                                            |
| exactly `1`   | On only for `1`; **anything else, `true` included, is off**.                                                                | `PROACTIVE_ENABLED`, `ASSISTANT_SCHEDULES_ENABLED`, `ASSISTANT_JOB_WATCH_ENABLED`, `BRIEF_ENABLED`, `REMOTE_AGENTS_ENABLED`                                                                                                                                                      |
| on unless off | Off for `0`, `false`, `no`, `off` (any case); **anything else, a typo included, is on**.                                    | `REMOTE_PUSH_ENABLED`                                                                                                                                                                                                                                                            |

`REMOTE_WINDOW_DEFAULT` is `chat` for `chat` and `card` for anything else. Lists are comma separated; people are named
by their Microsoft Entra object id, in any case.

## Claw and the platform

| Setting                         | Default                | Meaning                                                                                                                                                                         |
| ------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CLAW_API_URL`                  | required               | The Claw API.                                                                                                                                                                   |
| `SAFE_API_URL`                  | required               | The platform API Claw runs on ([SaFE](https://github.com/AMD-AGI/Primus-SaFE)); its `/users/self` tells whose a linked key is.                                                  |
| `PUBLIC_BASE_URL`               | required               | The worker's public origin; the exchange and credential URLs below default to paths under it.                                                                                   |
| `PERSONAL_AGENT_BOT_NAME`       | `PrimusClaw Assistant` | The name the bot goes by in this deployment: every text that names it, and what "@<name> ..." at the start of a message is read as. Set it to the name of the deployment's app. |
| `CLAW_PLUGIN_ID`                | none                   | The Claw plugin new sessions are created with; unset creates plain sessions.                                                                                                    |
| `CLAW_RULE_TOOL_ID`             | none                   | The Claw rule tool whose text rides on every message.                                                                                                                           |
| `CLAW_CLIENT_LABEL`             | `personal-agent`       | What Claw's audit trail calls this client.                                                                                                                                      |
| `PERSONAL_AGENT_MODEL`          | Claw's default         | The model of chat turns.                                                                                                                                                        |
| `PERSONAL_AGENT_FALLBACK_MODEL` | none                   | The model a turn is run once more on when it was refused for want of the person's own model key.                                                                                |
| `PERSONAL_AGENT_REVIEW_MODEL`   | none                   | The model of pull request reviews.                                                                                                                                              |

## Process and state

| Setting        | Default          | Meaning                                              |
| -------------- | ---------------- | ---------------------------------------------------- |
| `PORT`         | `8080`           | The HTTP endpoints.                                  |
| `METRICS_PORT` | `9090`           | `/metrics`; must differ from `PORT`.                 |
| `PA_DB_PATH`   | `/data/state.db` | The SQLite database; its directory must be writable. |

### Metrics

`/metrics` (Prometheus text format) writes the worker's series under the `personal_agent_` prefix:
`personal_agent_security_events_total`, `personal_agent_inbound_handled_total`, `personal_agent_inbound_failed_total`,
`personal_agent_inbound_handle_ms_total`, `personal_agent_inbound_lag_max_ms`, `personal_agent_inbound_limited_total`,
`personal_agent_event_handle_seconds`, `personal_agent_event_to_chat_seconds`, `personal_agent_files_dropped_total` and
`personal_agent_build_info`. Earlier releases named the series after the bot's earlier default name, with the `clawy_`
prefix. For one release every series except `personal_agent_build_info` is written twice, with the same values and
help: under its new name and under its `clawy_` name, which is deprecated and removed in the next minor release. Move
alert rules, dashboards and release gates to the `personal_agent_` names once a build that writes both is live; nothing
goes blind in between.

## Secrets

| Setting                     | Default  | Meaning                                                                                                                                                                            |
| --------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SECRETS_SOURCE`            | `env`    | `env`: secrets from the environment. `keyvault`: from Azure Key Vault, read as the worker identity; the environment values of the secrets are then ignored.                        |
| `KEYVAULT_URL`              | —        | With `keyvault`: `https://<name>.vault.azure.net`, nothing after the host.                                                                                                         |
| `PA_ENCRYPTION_KEYS`        | required | Comma separated Fernet keys; the first encrypts, all decrypt. At start, stored secrets are re-encrypted to the first. Generate one with `openssl rand -base64 32 \| tr '+/' '-_'`. |
| `PA_EXCHANGE_CLIENT_SECRET` | —        | Required with `PA_EXCHANGE_ENABLED`.                                                                                                                                               |

With `keyvault` the vault entries are `personal-agent-encryption-keys` and `personal-agent-exchange-client-secret`. An entry
missing under its name is read under its deprecated name (`clawy-encryption-keys`, `clawy-exchange-client-secret`), with a
warning at start; only a missing entry falls back, a refused read stops the worker. Copy each secret to its new name; the
deprecated names will be removed only in a release whose notes say so. Moving a vault over, as someone who may read and
write its secrets (the feedback App key only where it is set):

```sh
umask 077 && file="$(mktemp)"   # (the value goes through a file only you can read, never a command line)
for name in encryption-keys exchange-client-secret feedback-github-app-key; do
  if value="$(az keyvault secret show --vault-name <your-vault-name> --name "clawy-$name" --query value -o tsv)"; then
    printf '%s' "$value" > "$file"
    az keyvault secret set --vault-name <your-vault-name> --name "personal-agent-$name" --file "$file" --output none
  fi
done
rm -f "$file"; unset value
```

Restart the worker: the start-up warning no longer names a deprecated entry. Delete the `clawy-` entries once no running
worker is of an earlier release (earlier releases read only those).

## How the worker reaches Teams

| Setting                  | Default      | Meaning                                                                                                                                                                                          |
| ------------------------ | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `OUTBOUND_MODE`          | `servicebus` | `servicebus`: replies go to the outbound queue, which the ingress's outbound trigger posts. `direct`: the worker posts to the Bot Connector itself (streaming, deletes), queue as fallback.      |
| `BOT_TOKEN_SOURCE`       | see below    | The bot's token in direct mode: `imds` (managed identity), `federated` (workload identity federation) or `secret` (an app registration's client secret); `federated` and `secret` need `direct`. |
| `BOT_MSI_CLIENT_ID`      | —            | Required in direct mode with `imds` or `federated`: the bot's managed identity.                                                                                                                  |
| `BOT_CLIENT_ID`          | —            | Required with `secret`: the app registration's client id (the Teams manifest's `botId`).                                                                                                         |
| `BOT_CLIENT_SECRET`      | —            | Required with `secret`: the app registration's client secret. Never logged.                                                                                                                      |
| `BOT_TENANT_ID`          | —            | Required with `federated`, `secret` or the worker identity.                                                                                                                                      |
| `BOT_ASSERTION_KEY_FILE` | —            | Required with `federated` or the worker identity: the private key the assertions are signed with, as a mounted file.                                                                             |
| `BOT_ASSERTION_ISSUER`   | —            | Required with `federated` or the worker identity: the https issuer registered in the federated credential.                                                                                       |
| `BOT_ASSERTION_SUBJECT`  | —            | Required with `federated`.                                                                                                                                                                       |

`BOT_TOKEN_SOURCE` when set always wins. Unset, it is `secret` when `BOT_CLIENT_SECRET` is set and `imds` otherwise; a
`BOT_CLIENT_SECRET` beside an explicit `imds` or `federated` is ignored (in direct mode the worker warns at start). `BOT_CLIENT_SECRET` is
read from the environment only (`SECRETS_SOURCE=keyvault` does not read it).

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

| Setting                            | Default           | Meaning                                                                                                                                                                                                                                                                                                                                                         |
| ---------------------------------- | ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PROACTIVE_ENABLED`                | off               | Exactly `1`: Claw's notifications are taken at `/claw-events/<route>` and posted into the chat.                                                                                                                                                                                                                                                                 |
| `NOTIFY_WEBHOOK_URL`               | —                 | Required with `PROACTIVE_ENABLED`: where Claw sends this worker's events (each person's route is appended), normally `<public origin>/claw-events`.                                                                                                                                                                                                             |
| `REMOTE_PUSH_ENABLED`              | on                | An attached chat hears its remote agent between turns; only with `PROACTIVE_ENABLED`; `0`, `false`, `no`, `off` turn it off.                                                                                                                                                                                                                                    |
| `PA_CLAW_EVENTS_GONE`              | off               | An event for a person with no chat is answered `410 Gone` instead of `200`.                                                                                                                                                                                                                                                                                     |
| `ASSISTANT_ENABLED`                | off               | The assistant: each person's standing agent in Claw.                                                                                                                                                                                                                                                                                                            |
| `ASSISTANT_USERS`                  | everybody         | Who has it, when the assistant is on.                                                                                                                                                                                                                                                                                                                           |
| `ASSISTANT_REPLY_WINDOW_SECONDS`   | `1800`            | After a person last wrote, how long what the assistant says counts as a reply rather than an unprompted message.                                                                                                                                                                                                                                                |
| `PA_ASSISTANT_UNDERSTANDING`       | off               | The assistant reads every message of the listed people first. Needs `ASSISTANT_ENABLED`.                                                                                                                                                                                                                                                                        |
| `PA_ASSISTANT_UNDERSTANDING_USERS` | `ASSISTANT_USERS` | Who; must be a subset of `ASSISTANT_USERS`, and someone must be named.                                                                                                                                                                                                                                                                                          |
| `ASSISTANT_SCHEDULES_ENABLED`      | off               | Exactly `1`: scheduled assistant work.                                                                                                                                                                                                                                                                                                                          |
| `ASSISTANT_JOB_WATCH_ENABLED`      | off               | Exactly `1`: the assistant watches jobs.                                                                                                                                                                                                                                                                                                                        |
| `BRIEF_ENABLED`                    | off               | Exactly `1`: `/brief` (needs Claw's trigger API).                                                                                                                                                                                                                                                                                                               |
| `REMOTE_AGENTS_ENABLED`            | off               | Exactly `1`: remote agents through claw-connector.                                                                                                                                                                                                                                                                                                              |
| `REMOTE_WINDOW_DEFAULT`            | `card`            | `chat` or `card`: how a remote agent session shows by default.                                                                                                                                                                                                                                                                                                  |
| `PA_DIRECT_CHAT`                   | off               | A chat attached to a remote agent session becomes that agent's own window.                                                                                                                                                                                                                                                                                      |
| `PA_DIRECT_CHAT_USERS`             | everybody         | For whom, when on.                                                                                                                                                                                                                                                                                                                                              |
| `PA_OBSERVE_USERS`                 | nobody            | Who may say `/observe on` in a group chat, making their assistant the group's observer.                                                                                                                                                                                                                                                                         |
| `PA_GROUP_CONTEXT_MESSAGES`        | `30`              | In a group chat that lets the bot read its messages (Teams: the app's `ChatMessage.Read.Chat` permission, granted by the chat), the newest messages that do not @mention the bot are kept in memory, never stored or answered, and go with the next @mention as untrusted background. `0` turns it off; at most `200`. A chat turns it off with `/context off`. |
| `PA_GROUP_CONTEXT_HOURS`           | `4`               | How old such a message may get before it is dropped.                                                                                                                                                                                                                                                                                                            |
| `PA_GROUP_CONTEXT_CHARS`           | `500`             | The longest text kept of one message (masked first, then cut).                                                                                                                                                                                                                                                                                                  |
| `PA_GROUP_CONTEXT_GRANTED`         | off               | Exactly `1`: the deployed chat app asks for the permission that delivers a group's other messages (Teams: `ChatMessage.Read.Chat`), so help says what is kept and how to turn it off. Off, help says the bot sees only the @mentions.                                                                                                                           |
| `PA_ON_BEHALF_USERS`               | none              | Claw user ids whose own key may post into their own chat; read for a deployment's plugins.                                                                                                                                                                                                                                                                      |

## Token exchange and review for a colleague

| Setting                           | Default                                      | Meaning                                                                                                                                                                                                                                                        |
| --------------------------------- | -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PA_EXCHANGE_ENABLED`             | off                                          | People act with tokens exchanged for them by the identity service (RFC 8693).                                                                                                                                                                                  |
| `PA_EXCHANGE_CLIENT_ID`           | —                                            | Required when on.                                                                                                                                                                                                                                              |
| `PA_EXCHANGE_TOKEN_URL`           | `PUBLIC_BASE_URL/oauth/token`                |                                                                                                                                                                                                                                                                |
| `PA_EXCHANGE_BINDING_REQUEST_URL` | `PUBLIC_BASE_URL/oauth/binding-requests`     | Where a person who is not bound yet is sent to confirm.                                                                                                                                                                                                        |
| `PA_EXCHANGE_ISSUER`              | `teams.microsoft.com`                        |                                                                                                                                                                                                                                                                |
| `PA_EXCHANGE_AUDIENCE`            | `claw-api`                                   |                                                                                                                                                                                                                                                                |
| `PA_EXCHANGE_SCOPE`               | `claw.api`                                   |                                                                                                                                                                                                                                                                |
| `PA_EXCHANGE_FOR_CHAT`            | off                                          | Ordinary chats use the exchanged token too, instead of the linked key. Needs the exchange. A person still on their linked key gets the identity card after an answer refused for want of a confirmed identity: at most once in 24 hours, never once confirmed. |
| `PA_GITHUB_REVIEW_ENABLED`        | off                                          | Review a colleague's pull request on their behalf. Needs the exchange.                                                                                                                                                                                         |
| `PA_GITHUB_REVIEW_OWNERS`         | —                                            | Required when on: the GitHub owners whose pull requests are taken.                                                                                                                                                                                             |
| `PA_REVIEW_INTENT_MODEL`          | `PERSONAL_AGENT_MODEL`                       | The model that reads a review request; empty reads it by rules alone.                                                                                                                                                                                          |
| `PA_GITHUB_CREDENTIAL_URL`        | `PUBLIC_BASE_URL/oauth/external-credentials` |                                                                                                                                                                                                                                                                |
| `PA_GITHUB_CLIENT_ID`             | the GitHub CLI's public OAuth client         | The OAuth client of the device flow that connects a GitHub account.                                                                                                                                                                                            |

## Limits

| Setting                          | Default    | Meaning                                                                                                   |
| -------------------------------- | ---------- | --------------------------------------------------------------------------------------------------------- |
| `PA_USER_MESSAGE_LIMIT`          | `20`       | Messages a person may send per window.                                                                    |
| `PA_USER_MESSAGE_WINDOW_SECONDS` | `60`       |                                                                                                           |
| `PA_USER_MAX_CONCURRENT_TASKS`   | `12`       | Turns a person may have running at once.                                                                  |
| `PA_LINK_MAX_FAILURES_PER_USER`  | `5`        | Failed `/link` attempts per person per window.                                                            |
| `PA_LINK_MAX_FAILURES_GLOBAL`    | `100`      | Failed `/link` attempts in all per window.                                                                |
| `PA_LINK_ATTEMPT_WINDOW_SECONDS` | `600`      |                                                                                                           |
| `PA_LIMIT_PR_REVIEW`             | `30/3600`  | `COUNT/SECONDS` per person, or `0` for no limit: reviews started for a colleague, or held reviews posted. |
| `PA_LIMIT_PR_MERGE`              | `20/3600`  | Merges confirmed that Claw holds.                                                                         |
| `PA_LIMIT_APPROVAL`              | `120/3600` | Tool calls approved.                                                                                      |
| `PA_LIMIT_REMOTE_AGENT`          | `10/3600`  | Switches of a remote agent to a mode that does not ask.                                                   |

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

| Setting                | Default | Meaning                                   |
| ---------------------- | ------- | ----------------------------------------- |
| `WORKER_IMAGE_TAG`     | none    | Named in a report, as the worker's image. |
| `CLAW_API_IMAGE_TAG`   | none    | As Claw API's image.                      |
| `CLAW_BRAIN_IMAGE_TAG` | none    | As Claw Brain's image.                    |

The public build records reports and files them nowhere: filing is a `FeedbackSink` plugin. A deployment's own `main`
can build one with runtime's `feedbackConfigFromEnv` and `feedbackSink`, which read `FEEDBACK_REPO` (`owner/name`),
`FEEDBACK_GITHUB_APP_ID`, `FEEDBACK_GITHUB_INSTALLATION_ID`, `FEEDBACK_GITHUB_KEY_FILE` and
`FEEDBACK_GITHUB_TOKEN_FILE`. The secret loader already reads the App key (`FEEDBACK_GITHUB_KEY_FILE`, or the vault entry
`personal-agent-feedback-github-app-key`, deprecated name `clawy-feedback-github-app-key`) when both App ids are set, so leave them unset unless such a plugin uses them.

## The Teams ingress

The ingress ([`packages/teams-ingress`](../packages/teams-ingress), an Azure Function app) reads its own app settings,
not the worker's. Their names are the ones the Python Function it replaces read, so an app moving to it keeps its
settings as they are. Service Bus connections follow the Functions convention: `<prefix>__fullyQualifiedNamespace` for
an identity, the setting itself for a connection string.

| Setting                                                   | Default                                                                                | Meaning                                                                                                                                                                                                        |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PRIMUSCLAW_BOT_APP_ID`                                   | —                                                                                      | The bot's client id, the audience every token must name. Unset, every request is refused (`401`). Also the user-assigned identity the inbound sender and the outbound trigger's Bot Connector token use.       |
| `PRIMUSCLAW_SERVICEBUS__fullyQualifiedNamespace`          | —                                                                                      | `<name>.servicebus.windows.net` (an `sb://` URL is read too): the inbound queue is reached as an identity, which needs Azure Service Bus Data Sender on it.                                                    |
| `PRIMUSCLAW_SERVICEBUS__credential`                       | unset                                                                                  | `managedidentity`: the app's system-assigned identity (or `__clientId`'s). Unset: the bot's identity (`PRIMUSCLAW_BOT_APP_ID`) or `__clientId`'s. Anything else is refused.                                    |
| `PRIMUSCLAW_SERVICEBUS__clientId`                         | —                                                                                      | A user-assigned identity for the inbound queue.                                                                                                                                                                |
| `PRIMUSCLAW_SERVICEBUS_CONNECTION_STRING`                 | —                                                                                      | Without the namespace setting: a connection string with Send on the inbound queue. Ignored (with a warning) when the namespace is set.                                                                         |
| `PRIMUSCLAW_SERVICEBUS_QUEUE`                             | `primusclaw-inbound`                                                                   | The inbound queue: the worker's `INBOUND_QUEUE`.                                                                                                                                                               |
| `PRIMUSCLAW_OUTBOUND_SERVICEBUS__fullyQualifiedNamespace` | —                                                                                      | Registers the outbound trigger, reading the outbound queue as an identity (Azure Service Bus Data Receiver on it; `__credential`/`__clientId` as above, read by the Functions host).                           |
| `PRIMUSCLAW_OUTBOUND_SERVICEBUS`                          | —                                                                                      | Registers the outbound trigger with a connection string (Listen on the outbound queue) instead. With neither, the trigger is not registered and the app serves `/api/messages` alone.                          |
| `PRIMUSCLAW_OUTBOUND_QUEUE`                               | `primusclaw-outbound`                                                                  | The outbound queue: the worker's `OUTBOUND_QUEUE`.                                                                                                                                                             |
| `BOT_TOKEN_ISSUERS`                                       | `https://api.botframework.com`                                                         | The issuers a token may name, `;`-separated.                                                                                                                                                                   |
| `BOT_OPENID_CONFIG_URL`                                   | `https://login.botframework.com/v1/.well-known/openidconfiguration`                    | Where the signing keys are found (cached for an hour; the key set is refetched for a key id it lacks).                                                                                                         |
| `BOT_SERVICE_URL_HOSTS`, `BOT_SERVICE_URL_SUFFIXES`       | `smba.trafficmanager.net`; `.botframework.com`, `.teams.microsoft.com` and their `.us` | The Bot Connector hosts an activity's `serviceUrl` (and so the bot's token) may name, `;`- or `,`-separated: the worker's rule. A set value replaces the default; an entry that is not a host name is ignored. |

The outbound trigger posts as the bot, with a token from the app's identity endpoint for `PRIMUSCLAW_BOT_APP_ID`: the
bot must be a user-assigned managed identity assigned to the Function app. The Functions host's own settings
(`AzureWebJobsStorage`, `APPLICATIONINSIGHTS_CONNECTION_STRING`, the deployment storage) are Azure's.

## Release gate only

`TEAMS_GATE_ENTRY`, `GATE_RUN_ID` and `TEAMS_GATE_CONNECTOR_URL` turn on a test entry that a release gate drives from
outside the process, against a recording Bot Connector on `127.0.0.1`. Production never sets them: the entry is on only
when `TEAMS_GATE_ENTRY` is exactly `1`, `GATE_RUN_ID` is set and the connector is a loopback address, and any other
value of `TEAMS_GATE_ENTRY` stops the worker.

## Setting names

The settings every chat surface shares are read under the `PA_` prefix (personal agent). `PA_` and not `WORKER_`:
`WORKER_IDENTITY_*` and `WORKER_IMAGE_TAG` are already Teams and feedback settings, and the prefix should say whose a
setting is, as `TEAMS_STREAMING` says it is Teams'. Releases up to 0.8.0 read the names below with the `TEAMS_` prefix
only; from 0.8.1 each is read under either name, so a deployment written for an older release starts unchanged:

- The `PA_` name is read when it is set and not blank; otherwise the `TEAMS_` name, when it is set; otherwise the `PA_`
  name as it is (unset takes the default; a blank value reads as that setting reads a blank one).
- A `TEAMS_` name in use is named in one warning at start, with its `PA_` replacement (`deprecated setting names:
TEAMS_DB_PATH (now PA_DB_PATH), ...`); a `TEAMS_` name set beside its `PA_` name gets a warning that it is ignored.
  No value is ever logged.
- A message about a malformed value names the variable it was read from.
- With `SECRETS_SOURCE=env` the secrets are read the same way; the vault entries keep their names.

Moving a deployment over is renaming the variables; the order does not matter, since the `PA_` name wins as soon as it
is set. The `TEAMS_` names will be removed only in a release whose notes say so.

The model settings were first named after the bot's earlier default name, with the `CLAWY_` prefix; they now carry
`PERSONAL_AGENT_`, and the `CLAWY_` names are read the same way (the new name wins; an old name in use is named in the
start-up warning). They are listed in the table below too.

| Setting                            | Older name, still read                |
| ---------------------------------- | ------------------------------------- |
| `PA_DB_PATH`                       | `TEAMS_DB_PATH`                       |
| `PA_ENCRYPTION_KEYS`               | `TEAMS_ENCRYPTION_KEYS`               |
| `PA_CLAW_EVENTS_GONE`              | `TEAMS_CLAW_EVENTS_GONE`              |
| `PA_ON_BEHALF_USERS`               | `TEAMS_ON_BEHALF_USERS`               |
| `PA_OBSERVE_USERS`                 | `TEAMS_OBSERVE_USERS`                 |
| `PA_DIRECT_CHAT`                   | `TEAMS_DIRECT_CHAT`                   |
| `PA_DIRECT_CHAT_USERS`             | `TEAMS_DIRECT_CHAT_USERS`             |
| `PA_ASSISTANT_UNDERSTANDING`       | `TEAMS_ASSISTANT_UNDERSTANDING`       |
| `PA_ASSISTANT_UNDERSTANDING_USERS` | `TEAMS_ASSISTANT_UNDERSTANDING_USERS` |
| `PA_GROUP_CONTEXT_MESSAGES`        | `TEAMS_GROUP_CONTEXT_MESSAGES`        |
| `PA_GROUP_CONTEXT_HOURS`           | `TEAMS_GROUP_CONTEXT_HOURS`           |
| `PA_GROUP_CONTEXT_CHARS`           | `TEAMS_GROUP_CONTEXT_CHARS`           |
| `PA_GROUP_CONTEXT_GRANTED`         | `TEAMS_GROUP_CONTEXT_GRANTED`         |
| `PA_EXCHANGE_ENABLED`              | `TEAMS_EXCHANGE_ENABLED`              |
| `PA_EXCHANGE_CLIENT_ID`            | `TEAMS_EXCHANGE_CLIENT_ID`            |
| `PA_EXCHANGE_CLIENT_SECRET`        | `TEAMS_EXCHANGE_CLIENT_SECRET`        |
| `PA_EXCHANGE_TOKEN_URL`            | `TEAMS_EXCHANGE_TOKEN_URL`            |
| `PA_EXCHANGE_BINDING_REQUEST_URL`  | `TEAMS_EXCHANGE_BINDING_REQUEST_URL`  |
| `PA_EXCHANGE_ISSUER`               | `TEAMS_EXCHANGE_ISSUER`               |
| `PA_EXCHANGE_AUDIENCE`             | `TEAMS_EXCHANGE_AUDIENCE`             |
| `PA_EXCHANGE_SCOPE`                | `TEAMS_EXCHANGE_SCOPE`                |
| `PA_EXCHANGE_FOR_CHAT`             | `TEAMS_EXCHANGE_FOR_CHAT`             |
| `PA_GITHUB_REVIEW_ENABLED`         | `TEAMS_GITHUB_REVIEW_ENABLED`         |
| `PA_GITHUB_REVIEW_OWNERS`          | `TEAMS_GITHUB_REVIEW_OWNERS`          |
| `PA_REVIEW_INTENT_MODEL`           | `TEAMS_REVIEW_INTENT_MODEL`           |
| `PA_GITHUB_CREDENTIAL_URL`         | `TEAMS_GITHUB_CREDENTIAL_URL`         |
| `PA_GITHUB_CLIENT_ID`              | `TEAMS_GITHUB_CLIENT_ID`              |
| `PA_USER_MESSAGE_LIMIT`            | `TEAMS_USER_MESSAGE_LIMIT`            |
| `PA_USER_MESSAGE_WINDOW_SECONDS`   | `TEAMS_USER_MESSAGE_WINDOW_SECONDS`   |
| `PA_USER_MAX_CONCURRENT_TASKS`     | `TEAMS_USER_MAX_CONCURRENT_TASKS`     |
| `PA_LINK_MAX_FAILURES_PER_USER`    | `TEAMS_LINK_MAX_FAILURES_PER_USER`    |
| `PA_LINK_MAX_FAILURES_GLOBAL`      | `TEAMS_LINK_MAX_FAILURES_GLOBAL`      |
| `PA_LINK_ATTEMPT_WINDOW_SECONDS`   | `TEAMS_LINK_ATTEMPT_WINDOW_SECONDS`   |
| `PA_LIMIT_PR_REVIEW`               | `TEAMS_LIMIT_PR_REVIEW`               |
| `PA_LIMIT_PR_MERGE`                | `TEAMS_LIMIT_PR_MERGE`                |
| `PA_LIMIT_APPROVAL`                | `TEAMS_LIMIT_APPROVAL`                |
| `PA_LIMIT_REMOTE_AGENT`            | `TEAMS_LIMIT_REMOTE_AGENT`            |
| `PERSONAL_AGENT_MODEL`             | `CLAWY_MODEL`                         |
| `PERSONAL_AGENT_FALLBACK_MODEL`    | `CLAWY_FALLBACK_MODEL`                |
| `PERSONAL_AGENT_REVIEW_MODEL`      | `CLAWY_REVIEW_MODEL`                  |
