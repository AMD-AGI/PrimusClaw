<!--
Copyright Advanced Micro Devices, Inc.
SPDX-License-Identifier: MIT
-->

# Quick start

Run your own personal agent from the published artifacts: first on your own machine without Teams, then as a Microsoft
Teams bot that people talk to, and finally with a developer machine connected through claw-connector.

| Artifact                                      | Version | Where                                                                                                                                                                                                                                                                       |
| --------------------------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The Teams worker, as npm packages             | 0.7.1   | [`@primusclaw/personal-agent-teams`](https://www.npmjs.com/package/@primusclaw/personal-agent-teams) (with [`-runtime`](https://www.npmjs.com/package/@primusclaw/personal-agent-runtime) and [`personal-agent`](https://www.npmjs.com/package/@primusclaw/personal-agent)) |
| The Teams worker, as an image                 | 0.7.1   | [`docker.io/primussafe/personal-agent-teams:0.7.1`](https://hub.docker.com/r/primussafe/personal-agent-teams) (linux/amd64, runs as uid 65534)                                                                                                                              |
| The Teams ingress, as an Azure Function       | 0.7.1   | `personal-agent-teams-ingress-0.7.1.zip` on the GitHub Release `personal-agent-v0.7.1` ([step 4](#4-the-ingress))                                                                                                                                                           |
| claw-connector, for a developer's own machine | 0.1.23  | [`@primusclaw/connector`](https://www.npmjs.com/package/@primusclaw/connector)                                                                                                                                                                                              |

The worker holds no model and no sandbox: every answer comes from a [Claw](../../claw/README.md) deployment, which runs
the agent loop against your LLM gateway. What you bring, and what this page sets up:

| Part                                                | Published here  | You provide                                                                                                 |
| --------------------------------------------------- | --------------- | ----------------------------------------------------------------------------------------------------------- |
| The worker (chat logic, Teams cards, its own store) | yes             | a host to run it, one Fernet key                                                                            |
| Claw and its LLM gateway                            | yes, separately | a running deployment ([`deploy/`](../../deploy/README.md)) and its SaFE endpoint, a Claw API key per person |
| Teams bot registration and app package              | no              | an Azure Bot, an app registration with a client secret (or a managed identity), a Teams app manifest        |
| Service Bus queues                                  | no              | an Azure Service Bus namespace with two queues                                                              |
| The ingress between the bot and the inbound queue   | yes             | an Azure Function app (Flex Consumption, Node 24+) to deploy it to ([step 4](#4-the-ingress))               |

## Prerequisites

- **Node 26** for the worker from npm (Docker instead: any recent Docker Engine on linux/amd64), plus `curl`, `sed` and
  `openssl`.
- For the local try: nothing else. With your own Claw, its API URL and a Claw API key.
- For Teams: an Azure subscription and the `az` CLI, a Microsoft 365 tenant where you may upload a custom Teams app, a
  public HTTPS origin for the worker, and a Claw deployment reachable from the worker.
- For a developer machine: Node.js 22 or newer and a working Claude Code, Codex or Cursor CLI on it.

## Try it locally

About five minutes, no Teams, no Azure, no cluster. The worker runs with the release gate's **test entry**: no Service
Bus, its HTTP server on `127.0.0.1` only, a person's message posted to it over HTTP, and every reply sent to a stand-in
Bot Connector that prints it. This is how the project's release checks drive the worker; it is not a production mode.

`/metrics` has a listener of its own (port 9090), which listens on every interface here as everywhere: it answers
counters and the build's version without asking who is calling. On a machine other people can reach, firewall that
port (`METRICS_PORT` changes the port, not the interfaces).

1. Install the worker and fetch the three files of [`examples/local-taste`](../examples/local-taste):

   ```bash
   mkdir personal-agent-try && cd personal-agent-try
   npm init -y >/dev/null
   npm install @primusclaw/personal-agent-teams@0.7.1
   base=https://raw.githubusercontent.com/AMD-AGI/PrimusClaw/main/personal-agent/examples/local-taste
   curl -fsSL --remote-name-all "$base/stand-in-connector.mjs" "$base/message.json" "$base/try.env.example"
   ```

2. Make the configuration, with a fresh encryption key:

   ```bash
   sed "s|<fernet-key>|$(openssl rand -base64 32 | tr '+/' '-_')|" try.env.example > try.env
   ```

3. In a second terminal (same directory), start the stand-in Bot Connector; it prints
   `stand-in Bot Connector on http://127.0.0.1:3978`:

   ```bash
   node stand-in-connector.mjs
   ```

4. In a third terminal, start the worker, with its store in the current directory instead of `/data`:

   ```bash
   TEAMS_DB_PATH=./state.db node --env-file=try.env node_modules/@primusclaw/personal-agent-teams/dist/main.js
   ```

   It logs `WARN release gate test entry: outbound to the recording connector only; no queue` and keeps running.

5. Back in the first terminal, check it and send it a message:

   ```bash
   curl -fsS http://127.0.0.1:8080/healthz; echo                      # ok
   curl -fsS http://127.0.0.1:9090/metrics | grep build_info           # personal_agent_build_info{version="0.7.1",...} 1
   say() { n=$((n + 1)); sed "s|__ID__|$(date +%s)-$n|; s|__TEXT__|$1|" message.json |
     curl -fsS -H 'content-type: application/json' --data @- http://127.0.0.1:8080/gate/v1/activity; echo; }
   say hello                                                           # {"status":"handled"}
   ```

   The stand-in connector prints the reply the person would have seen in Teams: the worker asks them to connect their
   account first (`To use Clawy, connect your PrimusClaw account first. ...`). Each message needs an id of its own; the
   worker drops a repeated one, which is why `say` makes one up.

**With your own Claw.** Stop the worker, set `CLAW_API_URL` (and `SAFE_API_URL`) in `try.env` to your deployment, start
it again, and link the made-up person to your Claw API key the way a real person would:

```bash
read -rs CLAW_KEY                                                      # paste your Claw API key; it is not echoed
code=$(printf '{"key":"%s"}' "$CLAW_KEY" | curl -fsS -H 'content-type: application/json' --data @- \
  http://127.0.0.1:8080/primus-claw-agent/link | sed 's/.*"code":"\([^"]*\)".*/\1/')
say "/link $code"                                                      # Connected ...
say "write a haiku about message queues"                                # a turn in a Claw session
say "/help"
```

`/primus-claw-agent/link` answers `{"code":"...","expires_in":600}` for a key Claw accepts and `422 key_rejected`
otherwise. The answer to a message arrives in the stand-in connector's terminal once Claw has finished the turn. The key goes to
`curl` on its standard input, so it never appears in a command line or the shell's history.

**From the image instead of npm** (Linux only: the test entry listens on the host's loopback, so the container shares
the host's network; the stand-in connector runs on the host as above):

```bash
docker run --rm --network host --env-file try.env docker.io/primussafe/personal-agent-teams:0.7.1
```

**Claw's tool layer, without a cluster.** To see the part of Claw that edits files and runs commands for an agent, clone
the repository and run `make demo` ([root README](../../README.md#evaluate-locally-without-a-cluster)).

## Deploy for Microsoft Teams

How a message travels, and which parts are yours:

```text
Teams --> Azure Bot Service --> the ingress (Azure Function) --> Service Bus inbound queue (one session per conversation)
      --> worker --> Claw API ...  worker --> Bot Connector (OUTBOUND_MODE=direct) --> Teams
```

The steps below use the `az` CLI. Names in angle brackets are yours to choose.

### 1. Claw

You need a Claw API URL the worker can reach (`CLAW_API_URL`, for example `https://claw.example.com/claw-api`) and the
SaFE endpoint Claw authenticates with (`SAFE_API_URL`): the worker asks its `/users/self` whose a linked key is. Each
person links their own Claw API key to their Teams account, so every turn runs with that person's identity and models.
To install Claw, see [`deploy/README.md`](../../deploy/README.md) and [`claw/deploy/README.md`](../../claw/deploy/README.md).

### 2. The bot's identity and registration

The worker posts to Teams as the bot, with a Bot Connector token it gets from Entra ID. The bot is one of two kinds of
identity; pick one:

- **An app registration with a client secret** (`BOT_TOKEN_SOURCE=secret`): the usual choice, and it works on any host.
  It needs a worker of 0.3.0 or later (0.1.1 and 0.2.0 do not have it).
- **A user-assigned managed identity**, with no secret at all: its token comes from the Azure host it runs on (`imds`)
  or, anywhere else, by workload identity federation with a key of yours (`federated`).

#### 2a. App registration and client secret

Register an application in your tenant, give it a service principal and a client secret, and register the bot to it,
with the ingress's URL (step 4) as the messaging endpoint; then switch the Teams channel on:

```bash
az ad app create --display-name <bot-name> --sign-in-audience AzureADMyOrg --query appId -o tsv    # BOT_CLIENT_ID
az account show --query tenantId -o tsv                                                            # BOT_TENANT_ID
az ad sp create --id <app-id>
# The secret goes into a file only you can read, never onto the screen or into the shell's history.
(umask 077; az ad app credential reset --id <app-id> --display-name personal-agent --years 1 \
  --query password -o tsv > bot-client-secret)
az bot create -g <group> -n <bot-name> --app-type SingleTenant --appid <app-id> --tenant-id <tenant-id> \
  --endpoint https://<your-ingress>/api/messages
az bot msteams create -g <group> -n <bot-name>
```

In the portal the same is **Microsoft Entra ID > App registrations > New registration** (single tenant), then
**Certificates & secrets > New client secret** (copy the _Value_, not the _Secret ID_), then an **Azure Bot** resource
with _Type of App_ **Single Tenant** and _Use existing app registration_ naming that application.

Permissions: none to add. The worker asks Entra ID only for the Bot Connector scope
(`https://api.botframework.com/.default`) with the client credentials grant, which an app registered as a bot gets
without any API permission or admin consent; leave **API permissions** as they are (no Microsoft Graph permission is
used). The service principal (`az ad sp create`) must exist in the tenant, or Entra ID answers `AADSTS7000229`.

The settings are `BOT_CLIENT_ID` (the application's client id), `BOT_TENANT_ID` and `BOT_CLIENT_SECRET`. The worker
puts the secret only into its token request: it is never logged, never shown in an error, and Entra ID's error
descriptions (which can echo the request) are reduced to their `AADSTS` codes. A client secret expires (one year
above); before it does, add a new one with the same command plus `--append` (without it the old secret is removed at
once), put it in `.env`, restart the worker, then delete the old one (`az ad app credential delete`). An expired or wrong secret shows in the
log as `Entra ID answered 401 (invalid_client: AADSTS7000222)` or `AADSTS7000215`.

Which source the worker uses: `BOT_TOKEN_SOURCE` when it is set, always; when it is unset, `secret` if
`BOT_CLIENT_SECRET` is set, else `imds`. So with `BOT_TOKEN_SOURCE=imds` or `federated` a `BOT_CLIENT_SECRET` is
ignored, and the worker says so in a warning at start (`BOT_CLIENT_SECRET is set but not used`). Every source but
`imds` needs `OUTBOUND_MODE=direct`.

#### 2b. Managed identity

Create the identity and a bot registered to it, with the ingress's URL (step 4) as the messaging endpoint, and switch
the Teams channel on:

```bash
az identity create -g <group> -n <bot-identity>
az identity show -g <group> -n <bot-identity> --query '{clientId:clientId, tenantId:tenantId, id:id}'
az bot create -g <group> -n <bot-name> --app-type UserAssignedMSI \
  --appid <client-id> --tenant-id <tenant-id> --msi-resource-id <identity-resource-id> \
  --endpoint https://<your-ingress>/api/messages
az bot msteams create -g <group> -n <bot-name>
```

The identity's client id is `BOT_MSI_CLIENT_ID`. The worker gets its Bot Connector token one of two ways:

- **On Azure** (a VM or an AKS node with the identity assigned): from the instance metadata service. This is the
  default, `BOT_TOKEN_SOURCE=imds`, and needs nothing else.
- **Anywhere else**: by workload identity federation, `BOT_TOKEN_SOURCE=federated`. The worker signs a short assertion
  with an RSA key of yours and Entra ID trades it for the identity's token. Make the key, publish its public half under
  an HTTPS issuer you control, and trust that issuer on the identity:

  ```bash
  openssl genrsa -out assertion-key.pem 2048
  # The key set: the public key, with the key id the worker puts in its assertions (the RFC 7638 thumbprint).
  node -e '
    const c = require("node:crypto"), fs = require("node:fs");
    const j = c.createPublicKey(fs.readFileSync("assertion-key.pem")).export({ format: "jwk" });
    const kid = c.createHash("sha256").update(JSON.stringify({ e: j.e, kty: "RSA", n: j.n })).digest("base64url");
    console.log(JSON.stringify({ keys: [{ kty: "RSA", use: "sig", alg: "RS256", kid, n: j.n, e: j.e }] }));
  ' > jwks.json
  az identity federated-credential create -g <group> --identity-name <bot-identity> -n personal-agent \
    --issuer https://issuer.example.com --subject personal-agent --audiences api://AzureADTokenExchange
  ```

  Serve `https://issuer.example.com/.well-known/openid-configuration` (at least `issuer`, and `jwks_uri` pointing at
  `jwks.json`) and `jwks.json` itself from any static HTTPS host. The issuer and subject are `BOT_ASSERTION_ISSUER` and
  `BOT_ASSERTION_SUBJECT`; the tenant id is `BOT_TENANT_ID`; the key file is `BOT_ASSERTION_KEY_FILE`. See Microsoft's
  [workload identity federation](https://learn.microsoft.com/en-us/entra/workload-id/workload-identity-federation)
  overview.

Finally, make a Teams app package (a `manifest.json` whose `bots` entry names the bot's client id as `botId`:
`BOT_CLIENT_ID` for an app registration, `BOT_MSI_CLIENT_ID` for a managed identity; with `personal` scope, plus its
two icons) and upload it to your tenant. See Microsoft's
[app manifest reference](https://learn.microsoft.com/en-us/microsoftteams/platform/resources/schema/manifest-schema).

### 3. Service Bus

Two queues: the inbound one with sessions enabled (one session per conversation keeps a conversation's messages in
order), and the outbound one, which direct mode uses as its fallback.

```bash
az servicebus namespace create -g <group> -n <namespace> --sku Standard
az servicebus queue create -g <group> --namespace-name <namespace> -n primusclaw-inbound --enable-session true
az servicebus queue create -g <group> --namespace-name <namespace> -n primusclaw-outbound
az servicebus namespace authorization-rule create -g <group> --namespace-name <namespace> -n worker-listen --rights Listen
az servicebus namespace authorization-rule create -g <group> --namespace-name <namespace> -n worker-send --rights Send
az servicebus namespace authorization-rule keys list -g <group> --namespace-name <namespace> -n worker-listen \
  --query primaryConnectionString -o tsv    # SERVICEBUS_LISTEN_CONNECTION_STRING
az servicebus namespace authorization-rule keys list -g <group> --namespace-name <namespace> -n worker-send \
  --query primaryConnectionString -o tsv    # SERVICEBUS_SEND_CONNECTION_STRING
```

(The worker can also reach the namespace as an Entra identity instead of by connection strings: `SERVICEBUS_NAMESPACE`
and the `WORKER_IDENTITY_*` settings in the [configuration reference](configuration.md#service-bus-and-the-worker-identity).)

### 4. The ingress

The ingress is the bot's messaging endpoint: an Azure Function that checks the Bot Framework token of every request
Azure Bot Service sends, binds it to the activity's `serviceUrl` (the same Bot Connector host rule the worker applies),
and puts the activity on the inbound queue, its content unchanged, with the conversation as its session. It answers at once: `200`
for a message, a placeholder card for a card button (`adaptiveCard/action`), an empty `200` for the feedback buttons
(`message/submitAction`), an empty result for any other invoke, `401` without a valid token, and `500` when the queue
cannot take the activity (Teams then retries; the worker drops a repeated activity id). It is
[`packages/teams-ingress`](../packages/teams-ingress); each release attaches it ready to deploy as
`personal-agent-teams-ingress-<version>.zip` (with its `.sha256`), a Function app package that installs and builds
nothing on the app.

Create a Function app on the Flex Consumption plan with Node.js 24 (or later) and a system-assigned identity, and give
that identity the right to send to the inbound queue:

```bash
az storage account create -g <group> -n <ingress-storage> --sku Standard_LRS
az functionapp create -g <group> -n <ingress-app> --storage-account <ingress-storage> \
  --flexconsumption-location <region> --runtime node --runtime-version 24 --assign-identity '[system]'
principal=$(az functionapp identity show -g <group> -n <ingress-app> --query principalId -o tsv)
az role assignment create --assignee-object-id "$principal" --assignee-principal-type ServicePrincipal \
  --role "Azure Service Bus Data Sender" \
  --scope "$(az servicebus queue show -g <group> --namespace-name <namespace> -n primusclaw-inbound --query id -o tsv)"
az functionapp config appsettings set -g <group> -n <ingress-app> --settings \
  PRIMUSCLAW_BOT_APP_ID=<bot-client-id> \
  PRIMUSCLAW_SERVICEBUS__fullyQualifiedNamespace=<namespace>.servicebus.windows.net \
  PRIMUSCLAW_SERVICEBUS__credential=managedidentity
```

`<bot-client-id>` is `BOT_CLIENT_ID` (step 2a) or `BOT_MSI_CLIENT_ID` (step 2b): the token's audience. Instead of the
identity, `PRIMUSCLAW_SERVICEBUS_CONNECTION_STRING` can hold a connection string with the right to send (step 3's
`worker-send`). [configuration.md](configuration.md#the-teams-ingress) lists every setting.

Deploy the release's zip, after checking it is the one the release names. A Flex Consumption app takes a package
through One Deploy as `application/zip`:

```bash
v=0.7.1
gh release download "personal-agent-v$v" -R AMD-AGI/PrimusClaw -p "personal-agent-teams-ingress-$v.zip*"
sha256sum -c "personal-agent-teams-ingress-$v.zip.sha256"
gh attestation verify "personal-agent-teams-ingress-$v.zip" --repo AMD-AGI/PrimusClaw
host=$(az functionapp show -g <group> -n <ingress-app> --query "properties.defaultHostName || defaultHostName" -o tsv)
scm=$(az functionapp show -g <group> -n <ingress-app> \
  --query "(properties.hostNameSslStates || hostNameSslStates)[?hostType=='Repository'].name | [0]" -o tsv)
# The management token goes to curl in a file only you can read, never onto a command line.
(umask 077; printf 'header = "Authorization: Bearer %s"\n' \
  "$(az account get-access-token --resource https://management.azure.com --query accessToken -o tsv)" > curl-auth)
curl -fsS -K curl-auth -X POST "https://$scm/api/publish?type=zip&RemoteBuild=false" \
  -H "Content-Type: application/zip" --data-binary @"personal-agent-teams-ingress-$v.zip"
rm curl-auth
```

The deployment takes a minute; then a request without a token is refused, and the function's log shows one
`token_rejected` event for it:

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST "https://$host/api/messages" -d '{}'    # 401
```

Set the bot's messaging endpoint (the `--endpoint` of step 2) to `https://<host>/api/messages`:
`az bot update -g <group> -n <bot-name> --endpoint "https://$host/api/messages"`.

**The outbound queue.** With the worker's default `OUTBOUND_MODE=servicebus`, the same Function app posts what the
worker puts on the outbound queue. That needs a bot that is a user-assigned managed identity (step 2b), assigned to the
Function app, and the app's identity allowed to receive from the outbound queue:

```bash
az functionapp identity assign -g <group> -n <ingress-app> --identities <identity-resource-id>
az role assignment create --assignee-object-id "$principal" --assignee-principal-type ServicePrincipal \
  --role "Azure Service Bus Data Receiver" \
  --scope "$(az servicebus queue show -g <group> --namespace-name <namespace> -n primusclaw-outbound --query id -o tsv)"
az functionapp config appsettings set -g <group> -n <ingress-app> --settings \
  PRIMUSCLAW_OUTBOUND_SERVICEBUS__fullyQualifiedNamespace=<namespace>.servicebus.windows.net \
  PRIMUSCLAW_OUTBOUND_SERVICEBUS__credential=managedidentity
```

Without those settings the outbound trigger is not registered and the app serves the messaging endpoint alone; the
worker then needs `OUTBOUND_MODE=direct`.

### 5. Configure the worker

Copy [`examples/minimal-teams/.env.example`](../examples/minimal-teams/.env.example) to `.env` and fill it in. Keep the
filled-in file out of any repository; it holds the encryption key, the bot's client secret and the connection strings.

| Setting                                                                    | What to put there                                                                   |
| -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `CLAW_API_URL`, `SAFE_API_URL`                                             | step 1                                                                              |
| `PUBLIC_BASE_URL`                                                          | the worker's public https origin (your reverse proxy in front of port 8080)         |
| `TEAMS_ENCRYPTION_KEYS`                                                    | `openssl rand -base64 32 \| tr '+/' '-_'`; it encrypts the linked keys in the store |
| `SERVICEBUS_LISTEN_CONNECTION_STRING`, `SERVICEBUS_SEND_CONNECTION_STRING` | step 3                                                                              |
| `OUTBOUND_MODE=direct`                                                     | the worker posts to the Bot Connector itself                                        |
| `BOT_CLIENT_ID`, `BOT_TENANT_ID`, `BOT_CLIENT_SECRET`                      | step 2a; paste the secret from `bot-client-secret` with an editor, then delete it   |
| `BOT_MSI_CLIENT_ID`, `BOT_TOKEN_SOURCE=federated` and the four after it    | step 2b instead of 2a; on an Azure host delete the five federated lines (`imds`)    |

Everything else has a default; [configuration.md](configuration.md) describes every setting. The default
`OUTBOUND_MODE=servicebus` posts through the ingress's outbound trigger ([step 4](#4-the-ingress), a managed-identity
bot only); `direct` needs nothing more than the bot's identity in the worker's settings.

### 6. Run it

With Docker Compose, from a copy of [`examples/minimal-teams`](../examples/minimal-teams) holding your `.env` (and
`assertion-key.pem` for the federated token, which the image reads as uid 65534; uncomment its line in
`docker-compose.yml` for that source only, and drop the `-v ...assertion-key.pem...` below for the others):

```bash
sudo chown 65534 assertion-key.pem && sudo chmod 0400 assertion-key.pem   # federated token only
docker compose up -d
```

With plain Docker:

```bash
docker run -d --name personal-agent --env-file .env -p 127.0.0.1:8080:8080 -p 127.0.0.1:9090:9090 \
  -v personal-agent-data:/data -v "$PWD/assertion-key.pem:/run/secrets/assertion-key.pem:ro" \
  docker.io/primussafe/personal-agent-teams:0.7.1
```

From npm (Node 26), with the store in a directory the user running it can write (SQLite creates the file, not the
directory):

```bash
npm install @primusclaw/personal-agent-teams@0.7.1
mkdir -p "$HOME/personal-agent"
TEAMS_DB_PATH="$HOME/personal-agent/state.db" \
  node --env-file=.env node_modules/@primusclaw/personal-agent-teams/dist/main.js
```

(set `BOT_ASSERTION_KEY_FILE` to the key's real path when you run it this way).

Port 8080 is plain HTTP, and its account-link endpoint receives Claw API keys: reach it only through an HTTPS reverse
proxy at `PUBLIC_BASE_URL`. The Compose file and the `docker run` above publish it on `127.0.0.1` only, for a proxy on
the same host; with a proxy elsewhere, publish it on a private address or firewall it, and do the same for the npm
worker, which listens on every interface. Keep 9090 (`/metrics`) private too: the worker serves it on every
interface, and the Compose file and `docker run` publish it on `127.0.0.1` only. `SIGTERM` finishes the work in hand and
exits.

### 7. Verify

```bash
curl -fsS http://127.0.0.1:8080/healthz                    # ok
curl -fsS http://127.0.0.1:9090/metrics | grep build_info   # personal_agent_build_info{version="0.7.1",node="v26..."} 1
```

`/healthz` says the process is up, not that it reaches anything. Read the start of the log too: it names the outbound
mode and the token source (`outbound mode: direct to the Bot Connector`, `bot token source: secret ...` or
`federated` or `imds`), and
repeated `inbound receiver error` lines mean the inbound queue cannot be read.

Then the first message. In Teams, open a chat with the app and say `hello`: the bot answers that you need to connect
your account first. Link your Claw API key through the worker's public origin and send the code:

```bash
read -rs CLAW_KEY    # your Claw API key, not echoed
printf '{"key":"%s"}' "$CLAW_KEY" | curl -fsS -H 'content-type: application/json' --data @- \
  https://agent.example.com/primus-claw-agent/link    # {"code":"7KQ3M9XP","expires_in":600}
```

In the chat, send `/link 7KQ3M9XP` (your code; it works once, within 10 minutes). The bot confirms the account, and
from then on each message is a turn in that person's Claw session. `/help` lists what it can do.

The setup message points people at `<PUBLIC_BASE_URL>/primus-claw/teams-link`, a console page that makes the key and
calls the link endpoint for them. That page is not part of this repository; until you host one, give people the `curl`
above.

## Connect a dev machine

With remote agents switched on, a person drives Claude Code, Codex or Cursor on their own machine from the chat. The
machine runs claw-connector, which only makes outbound HTTPS requests to Claw; the worker never talks to the machine.

1. On Claw's API, set `CLAW_REMOTE_AGENTS_ENABLED=true` (with the Helm chart, through `api.extraEnv`): without it the
   remote-agent routes do not exist and no connector can register. To hear a remote agent between turns, also set
   `CLAW_NOTIFICATIONS_ENABLED=true`. See [remote-agents.md](../../claw/docs/remote-agents.md).
2. On the worker, add `REMOTE_AGENTS_ENABLED=1`, and for those notifications `PROACTIVE_ENABLED=1` and
   `NOTIFY_WEBHOOK_URL=<PUBLIC_BASE_URL>/claw-events`. Both switches are on for exactly `1` only. Claw sends
   notifications only to public https addresses, or to hosts its operator lists in Claw's
   `NOTIFY_WEBHOOK_ALLOWED_HOSTS`. Restart the worker.
3. On the developer machine (Node.js 22 or newer):

   ```bash
   npm install -g @primusclaw/connector@0.1.22
   claw-connector --version        # 0.1.22
   claw-connector init             # writes agents.toml and prints its path
   read -rs CLAW_CONNECTOR_KEY && export CLAW_CONNECTOR_KEY   # the same person's Claw API key, not echoed
   claw-connector login --server https://claw.example.com/claw-api && unset CLAW_CONNECTOR_KEY
   claw-connector service install  # keeps it running (systemd --user on Linux, launchd on macOS)
   claw-connector doctor           # one line per check, with the fix for each problem
   ```

   In `agents.toml`, set `roots`, the directories an agent may work in. The file `init` writes offers Claude Code;
   to offer Codex or Cursor instead or as well, remove the `#` in front of its block and set its `roots` too (see
   [agents.toml](../../connector/README.md#agentstoml)).

   The connector calls a key sign-in a development key and stores the key as it is (in a file of mode 0600). If your
   Claw deployment runs an identity service with device sign-in, use
   `claw-connector login --server <claw-api-url> --identity-url <identity-url>` instead: the connector then holds a
   rotating token rather than the key. See the [connector README](../../connector/README.md#quick-start-about-5-minutes).

4. In Teams, say `show my agents`: the card lists the machine and its agents, and starts a session on one.

## Troubleshooting

| What you see                                                                                     | What it means, and the fix                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| The worker exits at once with `CRITICAL the worker does not start: ...` (status 1)               | A required setting is missing, a number is malformed, or a strict switch has an unknown word; the line names it. Status 2 with `CRITICAL secrets: ...` means a secret is missing or could not be loaded (`TEAMS_ENCRYPTION_KEYS` unset, say); a key that is not a Fernet key stops it with status 1 and a decoding error.                                                            |
| `/healthz` answers, but Teams messages get no reply and the log repeats `inbound receiver error` | The worker cannot read the inbound queue: check the listen connection string, the queue's name, and that sessions are enabled on it. No `inbound message` lines at all, and no errors: nothing reaches the queue, so look at the ingress and the bot's messaging endpoint.                                                                                                           |
| The log says `direct send not delivered, handing it to the queue`                                | The Bot Connector refused the post or the bot's token could not be had: check the client id and tenant (and for `secret` the secret's expiry; the `AADSTS` code in `Entra ID answered ...` names the cause), and for `federated` the issuer, subject and the published key set. Without the ingress's outbound trigger (step 4), a reply that went to the queue never reaches Teams. |
| `/primus-claw-agent/link` answers `422 key_rejected`                                             | Claw refused the key, or the worker cannot reach `CLAW_API_URL`. Check the key with `printf 'Authorization: Bearer %s\n' "$CLAW_KEY" \| curl -fsS -H @- '<CLAW_API_URL>/v1/sessions?limit=1'`.                                                                                                                                                                                       |
| A switch seems to do nothing                                                                     | Some switches read anything but their own words as off: `PROACTIVE_ENABLED` and `REMOTE_AGENTS_ENABLED` are on for exactly `1` (`true` is off). See [How switches read](configuration.md#how-switches-read).                                                                                                                                                                         |

A store the worker cannot write stops the start with `CRITICAL the worker does not start: unable to open database file`.
The image runs as uid 65534, so a bind-mounted host directory must be writable by that user.

## Where to go next

- [configuration.md](configuration.md): every setting, including the assistant (`ASSISTANT_ENABLED`), token exchange
  instead of linked keys, and review for a colleague.
- [The personal agent's README](../README.md): architecture, the packages, building the image yourself, and
  `buildWorker(env, plugins, options)` for a deployment that adds its own integrations.
- [The connector's README](../../connector/README.md): `agents.toml`, what the connector enforces, keeping it running.
- [Claw's README](../../claw/README.md) and [design notes](../../claw/docs/README.md), including
  [remote agents](../../claw/docs/remote-agents.md).
- Security reports go through [SECURITY.md](../../SECURITY.md), never a public issue.
