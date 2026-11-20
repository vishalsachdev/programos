# The general track

For anyone who is not following an institution-specific track: a team with a domain it controls, a virtual machine from any cloud provider, the default mail provider (or SMTP through a mail server that accepts a login), the intake worker in `inbound/`, and operator alerts by Telegram or email. This page orders the pages you need; it does not repeat them.

Your institution may still have rules about where your team's mail may go. This track does not know them. Ask your own IT or data office (`AGENTS.md`, policy questions).

## Read in this order

| # | Page | What for | `AGENTS.md`, part 5 |
|---|---|---|---|
| 1 | [`../start-here.md`](../start-here.md) | What this is, the three ways to start, what you will be asked | |
| 2 | [`../data-handling.md`](../data-handling.md) | Where messages go, who can read them, what to decide before go-live | Choice 14 |
| 3 | [`../model-providers.md`](../model-providers.md) | The model provider and the order of providers; the reply sensor's destination | Choices 1 and 2 |
| 4 | [`../cloud-vm.md`](../cloud-vm.md) | What kind of machine to rent, and why an app-hosting service does not work | Choice 8 |
| 5 | [`../deployment.md`](../deployment.md) | The supported recipe on that machine, and "Before real users" | Choice 8 |
| 6 | [`../../inbound/README.md`](../../inbound/README.md) | The intake worker on your own domain at Cloudflare | Choice 5 |
| 7 | [`../setup-reference.md`](../setup-reference.md), "Outbound mail over SMTP" and "Webhooks from other services" | The default mail provider, or SMTP; bounce reports and push events | Choices 6 and 13 |
| 8 | `AGENTS.md`, "Safety items", operator alerts | Telegram, email, or both | Choice 4 |
| 9 | [`../service-ownership.md`](../service-ownership.md) | Who holds each account and key, and the handover checklist | Choice 9 |
| 10 | [`../costs.md`](../costs.md) | Each monthly cost line, with the vendor's pricing page | |

A different mail provider for intake means writing your own intake service: [`../setup-reference.md`](../setup-reference.md), "Inbound mail: the contract".

## Shared pages, the same on both tracks

- [`../../AGENTS.md`](../../AGENTS.md): the guided setup the coding agent follows.
- [`../../SPEC.md`](../../SPEC.md) and [`../../ARCHITECTURE.md`](../../ARCHITECTURE.md): the contract and how the parts fit.
- [`../12-governance.md`](../12-governance.md): the numbered rules.
- [`../../templates/program-repo/`](../../templates/program-repo/): the knowledge-base skeleton.

If your institution needs its own set of open questions, keep them in your copy the way [`../illinois/README.md`](../illinois/README.md) does for one university.
