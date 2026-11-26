# Claude on Microsoft Foundry (Azure) as a model provider

Status: the code path is covered by tests against local fake servers. **No request in this repo has reached a real Foundry endpoint.** Do the checklist at the end before you rely on it.

Nothing on this page states any institution's policy. Whether Foundry, a hosting option or a region is approved for a given kind of data is **not verified** here. Ask the office that approves it, and write down the answer and its date.

Not covered: Entra ID or managed identity (API key only), and how to get an Azure subscription or a virtual machine at your institution. [`illinois/model-foundry.md`](./illinois/model-foundry.md) holds one university's open questions.

## What this gives you

The agent can use two providers, in an order you set:

- `anthropic`: the Anthropic API or a Claude subscription, as before.
- `foundry`: Claude served from your own Azure subscription.

`MODEL_PROVIDERS=anthropic,foundry` makes Foundry the backup. `MODEL_PROVIDERS=foundry,anthropic` makes it the primary. `MODEL_PROVIDERS=foundry` uses it alone. With the setting absent, there is one provider, `anthropic`, and nothing on this page applies.

A backup is a second destination for your team's mail text. **Every provider in the list must be approved for your data,** not only the first.

## 1. Create the resource and the deployments

Follow Microsoft's and Anthropic's current instructions for the steps on screen; they change, and this page does not repeat them. What you need at the end:

1. A Foundry resource. Its name is `{resource}` in the endpoint `https://{resource}.services.ai.azure.com/anthropic/v1/messages`.
2. An API key for that resource.
3. Three deployments:

| Deployment for | Used by | Suggested name |
|---|---|---|
| The agent | Each turn | The model ID, for example `claude-opus-5-5` |
| The gate reviewer | The `kb-gate-reviewer` subagent, before a knowledge-base write | The model ID of the model you choose |
| The reply sensor | `src/behaviour-sensor.ts`, a Haiku-class model | `claude-haiku-5-5` |

**Name each deployment by its model ID.** The request's `model` field is the deployment name, and a default deployment name equals the model ID. Two parts of the code read the name:

- The sensor chooses its request shape from the model name (`sensorRequestShape`). A deployment named `sensor-prod` gets the fallback shape, which may not suit the model behind it.
- The agent SDK resolves the aliases `opus`, `sonnet` and `haiku` through the pins below. The gate reviewer's default model is the alias `opus`.

### Hosting option and region scope

Each deployment has a hosting option. It decides what your unit can say about where data goes.

| Choice | Meaning |
|---|---|
| Hosted on Azure | Prompts are processed on Azure, and retained content is stored on Azure |
| Hosted on Anthropic | Prompts are processed by Anthropic, reached through your Azure resource |
| Region scope "Data Zone" | Inference stays in the US |

- Fable models are offered as "Hosted on Anthropic" only. If your approval depends on "Hosted on Azure", do not deploy a Fable model.
- Check the hosting option of **each** deployment. One deployment hosted on Anthropic means that call path leaves Azure.
- This page does not say which choice your institution accepts for which data. Not verified.

## 2. Check the endpoint by hand

Run this on the host, before any setting goes into the ProgramOS agent. It sends one short message.

```
curl -sS "https://YOUR-RESOURCE.services.ai.azure.com/anthropic/v1/messages" \
  -H "api-key: $FOUNDRY_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -H "content-type: application/json" \
  -d '{"model":"claude-haiku-5-5","max_tokens":256,"messages":[{"role":"user","content":"Reply with OK."}]}'
```

A JSON body with a `content` list means the resource, the key and the deployment name are right. Repeat with each deployment name. The key also works in the `x-api-key` header. Foundry does not return Anthropic's rate-limit headers.

## 3. Settings

All of these go in `.env` (part 1 of `config/instance.env.example`). The key is a secret.

| Setting | Meaning |
|---|---|
| `MODEL_PROVIDERS` | Order, comma-separated: `anthropic`, `foundry`. Default `anthropic` |
| `ANTHROPIC_FOUNDRY_RESOURCE` | The resource name only. Or set the next line instead |
| `ANTHROPIC_FOUNDRY_BASE_URL` | `https://{resource}.services.ai.azure.com/anthropic`. Wins over the resource name |
| `ANTHROPIC_FOUNDRY_API_KEY` | The key. It stays on the host |
| `FOUNDRY_KEY_HEADER` | `api-key` (default) or `x-api-key`. Used when the caller sent no key header, and by the sensor |
| `FOUNDRY_AGENT_MODEL` | Deployment for the agent on a Foundry run. Replaces `NANOCLAW_AGENT_MODEL` for that run |
| `FOUNDRY_GATE_MODEL` | Deployment for the gate reviewer on a Foundry run. Replaces `NANOCLAW_GATE_MODEL` for that run |
| `FOUNDRY_OPUS_MODEL`, `FOUNDRY_SONNET_MODEL`, `FOUNDRY_HAIKU_MODEL` | Deployment names for the SDK's aliases. Without them an alias resolves to an older built-in default |
| `MODEL_FAILOVER_THRESHOLD` | Failures in a row before a provider is set aside. Default 3 |
| `MODEL_FAILOVER_COOLDOWN_MS` | How long it is set aside. Default 1800000 (30 minutes) |
| `SENSOR_PROVIDER` | `anthropic` or `foundry`, for the reply sensor only. Unset: the first provider in `MODEL_PROVIDERS`, else `anthropic` |
| `SENSOR_EMAIL_REPLIES` | `1` makes the reply sensor check email replies too. Unset (default): chat replies only. It does not change where the sensor sends |

Set at least `FOUNDRY_OPUS_MODEL`, or set both `FOUNDRY_AGENT_MODEL` and `FOUNDRY_GATE_MODEL` to full deployment names. Otherwise the gate reviewer's `opus` alias is not pinned.

A provider in `MODEL_PROVIDERS` without its settings stops the host at startup with a message that names the missing setting. It is not skipped. Listing `anthropic` requires one of `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_AUTH_TOKEN`.

### The reply sensor

The sensor is a second call path. It calls the provider directly from the host, not through the proxy, and it does not fail over. By default it checks chat replies (Telegram and web chat) only; with `SENSOR_EMAIL_REPLIES=1` it also checks each delivered email reply, and the rules below apply to those calls unchanged. It goes where the agent's first choice goes:

- Provider: `SENSOR_PROVIDER` when set; otherwise the first provider in `MODEL_PROVIDERS`; otherwise `anthropic`. With `MODEL_PROVIDERS=foundry,anthropic` the sensor uses Foundry, even though the agent may fail over to Anthropic. An unknown first name is an error, not a fallback.
- `anthropic`: `ANTHROPIC_BASE_URL` when set (its host, with a path prefix joined before `/v1/messages`, as the proxy does), else `api.anthropic.com`. The key is `ANTHROPIC_API_KEY`: a subscription token cannot call this API, so with only a token the sensor reports `no-api-key` and sends nothing.
- `foundry`: `{Foundry base URL}/v1/messages` with the Foundry key; `SENSOR_MODEL` (process environment) is then a deployment name. Incomplete Foundry settings report `no-foundry-settings`.
- When the settings for the chosen provider are missing, the sensor makes no request to any other host.
- The host logs the provider and host once (never the key or path). An API error in the log names the provider.

To keep the sensor off a destination, set `SENSOR_PROVIDER` or keep `BEHAVIOUR_SENSOR_DISABLED=1`.

## 4. How the key stays out of the container

Same rule as before: the container never holds a real credential. On a Foundry run the container gets `CLAUDE_CODE_USE_FOUNDRY=1`, the key `placeholder`, and a base URL that points at the host proxy. The proxy swaps in the real key and forwards to Foundry. Tests check that no real key is in the container's arguments.

The per-run proxy token travels in a header and also in the base URL path (`/_t/<token>/`). The reason: it is not verified that the SDK sends its custom header in Foundry mode, and the proxy rejects a request with no token. The token is removed before the request leaves the host, and it is redacted in logs.

## 5. How failover behaves

- The proxy counts results per provider. A network error or a 401, 403, 429 or 5xx answer is a failure. A 2xx answer to a model call (a POST to `v1/messages` or `v1/complete` itself) resets the count; a 2xx answer to anything else (the sign-in key exchange, the model list, token counting, batches) does not, because it says nothing about model calls. Other answers (a 400, for example) change nothing.
- At the threshold the provider is set aside for the cooldown. New runs use the next provider in the list. Answers that arrive during the cooldown, from runs that began before it, change nothing: a late success does not end it and a late failure does not extend it.
- After the cooldown the first provider is tried again. One failure sets it aside again at once; a 2xx restores the full threshold.
- If every provider is set aside, the first in the list is used.
- Each change is logged at warn level and sent to the operator alert chat. The text names the old provider, the new one, and the class of failure. It holds no message content.
- A 429 on a subscription counts. A rate limit can therefore move runs to Foundry, which is billed to your Azure subscription.

### Limits

- **The turn that hits the failure still fails.** The existing retry with backoff runs it again in a new container, and that run picks a provider again. So the sender waits for the backoff.
- **Breaker state is in memory.** A restart forgets it and starts on the first provider.
- **A session started on one provider and resumed on the other is untested.**
- **The audit log has no per-turn provider field.** The switch is in the host log, the run log (`Provider:` line) and the alert only.
- **Only the agent's traffic feeds the breaker.** The sensor does not, and does not switch.
- **API key only.** Entra ID and managed identity are not implemented.

## 6. Verify live before relying on it

Tests here use fake servers. Each line below needs a real key. Record the date and result of each.

- [ ] One real turn straight on Foundry (`MODEL_PROVIDERS=foundry`): skills load, the IPC tool server works, the write guard blocks a protected path, the gate reviewer runs on its deployment.
- [ ] The same turn through the proxy, with the key only on the host: the container's environment holds `placeholder`, and the request succeeds.
- [ ] Whether the SDK sends the custom header in Foundry mode. Look at the proxy: does a request arrive with `x-nanoclaw-proxy-token`, or only with the path token?
- [ ] A session started on one provider and resumed on the other, in both directions.
- [ ] A forced failover: put a wrong primary key in `.env`, send turns until the threshold, and confirm the next run uses the backup and the operator alert arrives.
- [ ] The reply sensor with `SENSOR_PROVIDER=foundry`, and with `MODEL_PROVIDERS=foundry,...` alone: one verdict comes back and the log names Foundry. Also with `ANTHROPIC_BASE_URL` set. Tested with fake servers only.
- [ ] The reply sensor on one email reply with `SENSOR_EMAIL_REPLIES=1`: the mail arrives first, then the `[sensor: ...]` line appears in its `[OUTBOUND EMAIL]` audit entry. Tested with the provider stubbed only.
- [ ] The hosting option and region scope of each deployment, as shown in Azure on that day.
