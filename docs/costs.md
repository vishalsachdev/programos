# Running costs

This page lists what a deployment pays for each month, for both tracks ([`general/`](./general/README.md) and [`illinois/`](./illinois/README.md)). The code sets no price. Every number below was read on 2026-11-20 from the vendor page linked next to it. Prices change: check each page again before you quote a figure to anyone. Where a page did not show a price, this page says "check current pricing" and gives no number.

Your agent follows `AGENTS.md`, rule 6 in part 3: it does not state a price of its own. It may point you to this page, with its date.

## The cost lines

| Line | What you pay for | Vendor page (read 2026-11-20) | What the page said |
|---|---|---|---|
| Virtual machine | One always-on Linux machine that runs Docker ([`cloud-vm.md`](./cloud-vm.md)) | Azure: [Linux Virtual Machines pricing](https://azure.microsoft.com/en-us/pricing/details/virtual-machines/linux/); the page's table did not render as text. Microsoft's public [retail price list](https://prices.azure.com/api/retail/prices?$filter=serviceName%20eq%20%27Virtual%20Machines%27%20and%20armRegionName%20eq%20%27eastus%27%20and%20armSkuName%20eq%20%27Standard_B2s%27%20and%20priceType%20eq%20%27Consumption%27) | `Standard_B2s` (2 vCPUs, 4 GiB) in `eastus`, pay-as-you-go: 0.0416 USD per hour for the row without a Windows licence. Microsoft marks the B-series v1 sizes "End of Life" ([Bv1 size series](https://learn.microsoft.com/en-us/azure/virtual-machines/sizes/general-purpose/bv1-series)): for a new machine, check the current price of a current size. Another cloud provider: check its current pricing. |
| Model usage | The text of each message, the files the agent reads, and each reply, billed per token (a token is a few characters of text) | Anthropic: [Pricing](https://platform.claude.com/docs/en/about-claude/pricing) | In USD per million tokens (input / output): Claude Opus 5.5 $4 / $20; Claude Sonnet 5.5 $2 / $10; Claude Haiku 5.5 $0.10 / $0.50 for prompts up to 100,000 tokens. "For Claude 4.6 and later models, using `inference_geo: "us"` applies a 1.1x pricing multiplier." |
| Model usage on Microsoft Foundry | The same, billed through Azure | Anthropic: [Pricing](https://platform.claude.com/docs/en/about-claude/pricing), "Claude in Microsoft Foundry pricing"; Microsoft: [Claude consumption units (CCU) billing](https://learn.microsoft.com/en-us/azure/foundry/foundry-models/concepts/claude-models-billing) | "Anthropic rates your token usage in USD at standard per-model, per-feature rates, applies any negotiated discount, converts the result to CCUs at $0.01 USD per CCU". The US Data Zone Standard deployment type "applies the same 1.1x pricing multiplier". |
| Outbound mail | The service that delivers the bot's replies (choice 6) | Resend: [Pricing](https://resend.com/pricing) | Free: $0 a month, 3,000 mails a month, "limited to 100 emails per day". Pro: $20 a month, 50,000 mails a month. With SMTP through an institution's mail system (`OUTBOUND_MAIL_PROVIDER=smtp`) the cost, if any, is the institution's to state. |
| Inbound mail intake | The worker in [`inbound/`](../inbound/README.md) at Cloudflare | Cloudflare: [Email Routing](https://developers.cloudflare.com/email-routing/), [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/) | Email Routing is "Available on Free and Paid plans." Workers Free: 100,000 requests a day. Workers Paid: "a minimum charge of $5 USD per month for an account". KV on the free plan: 100,000 reads and 1,000 writes a day, 1 GB stored. |
| Domain | The domain or subdomain the bot receives and sends mail on | Cloudflare: [Registrar](https://www.cloudflare.com/products/registrar/) | "Cloudflare Registrar does not mark up domain prices at all." The page shows no price per year: check current pricing for your domain ending. A subdomain of a domain you already hold costs nothing extra. |
| Operator alerts on Telegram | The admin's Telegram bot | Telegram: [Bots FAQ](https://core.telegram.org/bots/faq) | "By default, bots are able to message their users at no cost." |
| Knowledge-base repo | A private repository | GitHub: [Pricing](https://github.com/pricing) | Free plan: $0, "Unlimited public/private repositories". An institution's own GitHub Enterprise host: ask the people who run it. |

Not on the list because the code needs nothing paid for them: Docker, Node, Caddy and the TLS certificate it obtains.

## A worked example

This is arithmetic on the prices above, not a measurement. No deployment's token counts or bills were read to write it, and the usage figures are assumptions. Put your own numbers in.

**Assumptions:**

- 300 agent turns a month (about 15 a working day), each one message in and one reply out;
- each turn sends 50,000 input tokens to the model (the message, the instructions and the files the agent reads) and gets 2,000 output tokens back. This figure is a guess; read your provider's usage page after the first week and replace it;
- the agent's default model, Claude Opus 5.5 (`claude-opus-5-5` in `container/agent-runner/src/index.ts`), at the base price, with no prompt-caching discount and no regional multiplier;
- not counted: the gate reviewer's model calls inside a turn, the reply sensor (off in a pilot), retries and failover;
- the virtual machine runs 730 hours a month (an assumption: 24 hours × about 30.4 days);
- fewer than 100 mails a day, so Resend's free plan, and the intake worker within Cloudflare's free limits.

| Line | Arithmetic | Per month (USD) |
|---|---|---|
| Model input | 300 × 50,000 = 15 million tokens × $4 | 60.00 |
| Model output | 300 × 2,000 = 0.6 million tokens × $20 | 12.00 |
| Virtual machine (`Standard_B2s`, `eastus`, retiring size) | 730 × $0.0416 | 30.37 |
| Outbound mail (Resend Free) | | 0 |
| Inbound intake (Cloudflare free limits) | | 0 |
| Telegram, GitHub Free | | 0 |
| Domain | check current pricing | not counted |
| **Total, before the domain** | | **102.37** |

**General track:** the table as it stands. A different cloud provider, a different machine size or region, or Resend Pro ($20) changes it.

**Illinois track:** the same lines, with these differences. None of them is verified for the university:

- Claude on Foundry is billed at Anthropic's rates converted to CCUs, so the model lines are the same; with US Data Zone Standard they are 1.1 times higher (72.00 × 1.1 = 79.20).
- Whether a virtual machine in the university's Azure costs the list price, and who pays it, depends on the university's agreement and the unit's billing: ask the university's cloud services team and the unit's business office ([`illinois/hosting.md`](./illinois/hosting.md)).
- If the unit sends through the university's mail system by SMTP, the outbound mail line is whatever the university says it is.

## What changes the bill most

- **Turns and tokens per turn.** The model line grows with both. A long knowledge base the agent reads on every turn raises the input count.
- **The model.** Setting `NANOCLAW_AGENT_MODEL` to a cheaper model lowers the model line; the code's tests and the reference deployment ran with the default.
- **A backup provider.** With two entries in `MODEL_PROVIDERS`, failover moves turns to the second provider, which bills at its own rate.
- **The reply sensor.** When on, it makes a model call per checked reply (`SENSOR_PROVIDER`, `SENSOR_MODEL`).
