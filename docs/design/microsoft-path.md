# Running ProgramOS on Microsoft services

> **Design note, not implemented.** This page decides a path; it adds no code. Written 2026-11-20 for issue 18. Every Microsoft fact below comes from a public page fetched on 2026-11-20, linked where it is used. These products change often: check each page again before you act on it.

Nothing here states any institution's policy. What one university's tenant allows is in [`../illinois/microsoft-path.md`](../illinois/microsoft-path.md), as open questions.

## The problem

As shipped, the agent reaches the model with a Claude subscription token or an Anthropic API key (`CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY`). For a campus unit that is often one person's account, which is hard to approve, hand over or pay for centrally. Many institutions already license Microsoft 365, Teams and Azure. This page asks which parts of ProgramOS can move onto those services, and what each move keeps or loses of the guarantees in [`SPEC.md`](../../SPEC.md), section 11: the delivery gate, the audit log, the person allowlist and routed approvals.

## 1. Copilot Studio: front door, or replacement for the engine?

**Today.** No Teams or Copilot code is in this repo. The source deployment retired its Teams and Copilot handlers (`SPEC.md`, section 10). Channels on `main`: email through the webhook (`src/channels/webhook.ts`), Telegram, web chat. Every channel hands its reply to the delivery gate (`src/delivery-gate.ts`); the allowlist is applied before dispatch (`src/channels/webhook-allowlist.ts`, `src/sender-allowlist.ts`).

**What Microsoft documents** (fetched 2026-11-20):

- An agent can be published to Teams and Microsoft 365 Copilot. The organization must allow Power Platform apps in Teams, and an org-wide agent is submitted for admin approval in the Teams admin center. The page warns that chat content "might flow outside of your organization's compliance and geographic or regional boundaries." [Publish to Teams](https://learn.microsoft.com/en-us/microsoft-copilot-studio/publication-add-bot-to-microsoft-teams)
- An agent can call an outside REST API from an OpenAPI description (preview), with no auth, an API key, or OAuth 2.0. [REST API tools](https://learn.microsoft.com/en-us/microsoft-copilot-studio/agent-extend-action-rest-api). Custom connectors reach "any publicly available API"; premium connectors are "available in select Copilot Studio plans". [Connectors](https://learn.microsoft.com/en-us/microsoft-copilot-studio/advanced-connectors)
- Claude models are selectable in Copilot Studio; they are marked cross-geo outside the US, and adding Anthropic as an external provider needs two admin switches (Power Platform admin center and Microsoft 365 admin center). [Choose a model](https://learn.microsoft.com/en-us/microsoft-copilot-studio/authoring-select-agent-model)
- Agent flows have "human in the loop" actions such as approval requests. [Agent flows](https://learn.microsoft.com/en-us/microsoft-copilot-studio/flows-overview)
- Billing is in Copilot Credits (since 2025-09-01). Check current pricing: [Billing and licensing](https://learn.microsoft.com/en-us/microsoft-copilot-studio/billing-licensing).
- The pages on flow approvals and event triggers returned 404 that day; the pages read did not say which identity runs a triggered flow, nor how transcripts are logged or audited.

**As a front door** (Teams users talk to Copilot Studio, which calls ProgramOS as a REST tool): ProgramOS would need a new authenticated HTTP channel that takes a question with a verified sender identity and returns the gated reply. The web chat route is the nearest code, but it has no person allowlist (shared secret only, `SPEC.md` section 11). Copilot Studio would hold the conversation: the user's words pass through Microsoft and its chosen model before ProgramOS sees them, and the reply ProgramOS gated can be rephrased by the Copilot agent before the user reads it.

**As a replacement** for parts of the engine (Copilot answers from a knowledge source; flows do the approvals): the guarantees live in host code that Copilot Studio would not run.

| Guarantee | Front door | Replacement |
|---|---|---|
| Delivery gate | Kept for what ProgramOS returns; lost for what the Copilot agent says around it | Lost |
| Audit log (host-written, committed to git) | Kept for ProgramOS's side; the Copilot conversation is logged elsewhere, if at all (UNKNOWN) | Lost |
| Person allowlist | Kept only if the channel passes a verified identity ProgramOS checks; to build | Lost; replaced by Teams access |
| Routed approvals (host checks the record against its own copy of the mail) | Not reachable from Teams without new code | Replaced by flow approvals, which check nothing ProgramOS checks |

**UNKNOWN.** Whether the tenant allows Copilot Studio, external models and custom connectors, and which plan the unit would be on: the institution's Microsoft 365 tenant administrators and Power Platform administrators. How transcripts are retained: the same, with the records office.

**Verdict.** Not for the first unit. A front door adds a second model and a second log for no gain over email; a replacement drops every guarantee in section 11.

## 2. Claude through Microsoft Foundry

**Today.** `main` has a Foundry provider ([`../model-providers.md`](../model-providers.md); `src/model-provider.ts`). `MODEL_PROVIDERS` orders `anthropic` and `foundry`; the credential proxy (`src/credential-proxy.ts`) swaps a placeholder for the real key on the host, joins a path prefix in the base URL, and fails over after three failures. The reply sensor can be sent to Foundry (`SENSOR_PROVIDER`). Issue 10's proxy and sensor items are done in that code. The provider has run against fake servers only.

**What Microsoft and Anthropic document** (fetched 2026-11-20):

- Endpoint `https://<resource>.services.ai.azure.com/anthropic/v1/messages`; auth by API key or by Microsoft Entra ID as a Bearer token with scope `https://ai.azure.com/.default`. [Microsoft: use Claude in Foundry](https://learn.microsoft.com/en-us/azure/foundry/foundry-models/how-to/use-foundry-models-claude)
- Eligibility: "a paid Azure subscription with a billing account in a country or region where Anthropic offers the models for purchase". Cloud Solution Provider subscriptions, subscriptions without pay-as-you-go billing (student, free trial, startup credit) and credit-only sponsored subscriptions are not supported. (Same page.)
- Two hosting options. Hosted on Azure: "Anthropic processes prompts and completions on Azure infrastructure and stores retained content there"; operational data "is stored on Anthropic's systems outside Azure". Deployment types: Global Standard, and US Data Zone Standard for Hosted on Azure. [Anthropic: Claude in Microsoft Foundry](https://platform.claude.com/docs/en/build-with-claude/claude-in-microsoft-foundry)
- Not supported when Hosted on Azure, and answered with HTTP 400: code execution, web search and web fetch versions later than `web_search_20250305` and `web_fetch_20250910`, Agent Skills (the API feature), programmatic tool calling, the Files API. Not supported on any hosting: among others the Models API, Message Batches and server-side `fallbacks`. (Same page.)

**What remains to build or check.**

1. Entra ID authentication. The provider is API key only (`docs/model-providers.md`). A key is a long-lived secret that someone must hold and rotate; a token from a managed identity or a service principal is the usual institutional ask. Issue 58.
2. The live checks in `docs/model-providers.md`, section 6 (issue 24).
3. Whether anything the agent sends hits the Hosted-on-Azure limits above. With web tools off (the default), the proxy already refuses web search and fetch. The model list (`/v1/models`) is one of the paths the proxy forwards, and the Models API is listed as not supported. Issue 59.

**Guarantees.** All kept: only the model endpoint changes, and the gate, audit log, allowlist and routed approvals are host code. A backup provider is a second destination for the same mail text, so each provider in `MODEL_PROVIDERS` needs its own approval.

**UNKNOWN.** Which hosting option and region scope the institution accepts for which data class: the IT security or vendor-review office and the privacy office. Whether the unit's Azure subscription is an eligible type: the institution's Azure or cloud services team.

## 3. Microsoft Graph for mail, in place of `inbound/` and the outbound provider

**Today.** Intake: the Cloudflare Email Worker in `inbound/` commits a Markdown copy and the original `.eml` to the knowledge-base repo as the intake author, then POSTs to the host webhook ([`../setup-reference.md`](../setup-reference.md), "Inbound mail: the contract"). The host trusts a committed `.eml` only when its first author is `INTAKE_GIT_AUTHOR_EMAIL`. Outbound: Resend by default (`src/outbound-email.ts`, `fetch('https://api.resend.com/emails')`), with bounces and complaints coming back by a signed webhook (`src/channels/resend-events.ts`) into the audit log. Resend sends from a domain whose DNS you control, which an institutional domain usually is not (issue 9). Since 2026-11-20 there is a second provider, authenticated SMTP submission (`OUTBOUND_MAIL_PROVIDER=smtp`, `src/outbound-email-smtp.ts`), which needs a mailbox login with a password and gets no bounce reports ([`../setup-reference.md`](../setup-reference.md), "Outbound mail over SMTP"). It is not a Graph sender.

**What Microsoft documents** (fetched 2026-11-20):

- Read: `GET /users/{id}/messages`, application permission `Mail.ReadBasic.All`, `Mail.Read` or `Mail.ReadWrite`. [List messages](https://learn.microsoft.com/en-us/graph/api/user-list-messages)
- Send: `POST /users/{id | userPrincipalName}/sendMail`, application permission `Mail.Send`. It returns 202, which "doesn't indicate that the request processing has completed"; delivery is subject to Exchange Online limits. [sendMail](https://learn.microsoft.com/en-us/graph/api/user-sendmail)
- Limiting an app to one mailbox: RBAC for Applications in Exchange Online, which "replaces Application Access Policies". An Exchange administrator creates a service principal pointer (`New-ServicePrincipal`), a management scope for the mailbox (`New-ManagementScope`), and a scoped role assignment (`New-ManagementRoleAssignment ... -CustomResourceScope`), and tests it with `Test-ServicePrincipalAuthorization`. The scoped grant must not sit beside an unscoped one: "You need to ensure that you removed the organization-wide unscoped permissions assigned in Microsoft Entra ID" (the two add up). Changes take 30 minutes to 2 hours. [RBAC for Applications](https://learn.microsoft.com/en-us/exchange/permissions-exo/application-rbac)
- New mail: change notifications to a "publicly accessible, HTTPS-secured endpoint" that echoes a validation token within 10 seconds and answers each notification within 3 seconds. A subscription on messages lasts at most 10,080 minutes (under a week) and must be renewed; `missed` and `reauthorizationRequired` lifecycle events exist, and delta query is the documented resync. [Change notifications](https://learn.microsoft.com/en-us/graph/change-notifications-overview), [webhook delivery](https://learn.microsoft.com/en-us/graph/change-notifications-delivery-webhooks), [lifecycle events](https://learn.microsoft.com/en-us/graph/change-notifications-lifecycle-events)

**What would have to be built.**

- A Graph sender: a second outbound provider behind the same outbox, gate and audit calls (issue 67; issue 9 offered it as option a). Permission: `Mail.Send`, scoped to the bot's shared mailbox by RBAC for Applications.
- Bounce reporting for that sender. Graph has no equivalent of the Resend events webhook in the pages read: a bounce returns as a non-delivery report into the mailbox. Without parsing those, "delivery events" leave the audit log for this provider.
- A Graph intake: subscribe to the shared mailbox's inbox (or poll with delta), fetch each new message's MIME, commit the Markdown copy and the `.eml` as the intake author, then POST the existing webhook. Permission: `Mail.Read` (or `Mail.ReadWrite` to move handled mail), scoped the same way. The intake must not send replies or run in the agent container. Issue 57.

**Guarantees.** All kept if both pieces keep the contract: the allowlist still reads `From` from the committed original, routed approvals still compare against the intake-authored `.eml`, and the gate and outbox are unchanged. Lost unless built: bounce events in the audit log. New risk: one app registration that can read and send as the bot's mailbox. If the RBAC scope is missing, or an unscoped Entra grant is left beside it, that app can read and send as every mailbox in the tenant.

**UNKNOWN.** Whether the tenant allows an application-permission app registration for mail at all, scoped or not, and who approves it: the institution's Microsoft 365 tenant administrators (identity and Exchange). Whether a shared mailbox for the bot can be created for the unit: the institution's mail administrators. Throttling numbers for sendMail: not on the pages read.

## 4. Teams for operator alerts and for staff questions

**Today.** `ADMIN_ALERT_ROUTE` takes `telegram`, `email`, or both (`src/admin-alert.ts`). The email route goes through the outbox and is audited; Telegram notices sent by `pingAdminViaTelegram` skip the gate (`SPEC.md`, section 11). Teams code was removed (`SPEC.md`, section 10).

**What Microsoft documents** (fetched 2026-11-20):

- "Office 365 Connectors in Teams, including connector-based Incoming Webhooks, were retired in May 2026. To receive webhook requests and post messages in Teams, use the Workflows app." A workflow webhook takes an HTTPS POST with an Adaptive Card (or MessageCard) payload, is owned by a user rather than by the team or channel, is limited to 28 KB per message, and throttles above four requests a second. [Create an Incoming Webhook](https://learn.microsoft.com/en-us/microsoftteams/platform/webhooks-and-connectors/how-to/add-incoming-webhook); [retirement notice](https://devblogs.microsoft.com/microsoft365dev/retirement-of-office-365-connectors-within-microsoft-teams/)
- Graph `POST /teams/{id}/channels/{id}/messages` with application permissions is "only supported for migration"; a normal post needs delegated `ChannelMessage.Send`, that is, a signed-in user. [Send chatMessage in a channel](https://learn.microsoft.com/en-us/graph/api/channel-post-messages)
- A bot that messages proactively must first be installed in the team or chat, from the organization's app catalog or the Teams Store, and addresses users by Entra object ID, not by email. [Proactive messages](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/conversations/send-proactive-messages)

**Alerts.** A third route, `teams`, would POST an Adaptive Card to a Workflows webhook URL kept in `.env`. It needs: the URL treated as a secret (anyone holding it can post); a size cap below 28 KB; a retry on 429; the route added to the first-start test alert. Issue 11 already asks for this. The workflow belongs to a person, so it is lost when that person's account is removed; record its owner (issue 22). Like Telegram, a direct POST would skip the gate and the audit log unless it is put through the outbox.

**Staff questions in Teams.** That is a new channel: a Teams bot (an app in the org catalog), sender identity mapped from Entra object IDs to allowlist rows, replies through the gate. The retired source code is not in this repo, and Graph cannot post as an application. Not worth bringing back for a first unit: email keeps the allowlist, the audit trail and routed approvals that already work.

**UNKNOWN.** Whether the tenant allows the Workflows app and webhook triggers, and whether a workflow can be owned by a service account: the Microsoft 365 tenant administrators. Whether an alert that names a sender and subject may go to a Teams channel: the privacy office.

## 5. SharePoint or OneDrive as the knowledge-base store

**Today.** The knowledge base is a git repo. The host commits the audit log in its own repository and pushes it (`src/host-repo.ts`, `src/audit-log.ts`). Protection rests on git: the host refuses an agent commit that changes a protected path; the push check alerts on a protected file changed by a non-admin author (`src/channels/github-push-events.ts`, `src/governance-protection.ts`); the host trusts an `.eml` by its first git author. The agent cites file paths and commits one logical change at a time (`SPEC.md`, sections 4 to 6). Read-only extra mounts can bring outside content in ([`content-sources.md`](./content-sources.md)).

**What Microsoft documents** (fetched 2026-11-20):

- `Sites.Selected` and the newer `*.SelectedOperations.Selected` scopes limit an app to one site, list, library folder or file; access is granted per site by `POST /sites/{id}/permissions`. [Selected permissions](https://learn.microsoft.com/en-us/graph/permissions-selected-overview)
- A file version records `lastModifiedBy`, `lastModifiedDateTime` and size; "OneDrive doesn't preserve the complete metadata for previous versions of a file." No message, and nothing ties changes to several files together. [List versions](https://learn.microsoft.com/en-us/graph/api/driveitem-list-versions)
- Version history can be trimmed automatically or by count and age, and trimmed versions are deleted permanently. [Version history limits](https://learn.microsoft.com/en-us/sharepoint/document-library-version-history-limits)

**The cost, plainly.** Instead of git, a SharePoint store loses: one commit for one logical change across files; a message per change; an author check the host can trust (version authors are whoever's token wrote); the host-owned repository and its fetch check; the push check on protected paths; history that is not trimmed by a site setting. Each of those is a guarantee in `SPEC.md`, section 11, and none has a drop-in replacement in the pages read. Rebuilding them on SharePoint is a new storage layer, the audit log, the governance checks and the routed-approval trust rule: months of work, not a setting.

Beside git, as a read-only source, SharePoint costs little: sync a library to a folder on the host and mount it read-only (`content-sources.md`). The agent can read it and cannot change it; facts it records still go to git.

**UNKNOWN.** Whether the tenant grants `Sites.Selected` to an outside app, and who approves it: the Microsoft 365 tenant administrators and the site owner. Whether a git host the institution controls is available: the unit's IT lead ([`../illinois/github-enterprise.md`](../illinois/github-enterprise.md) for one university).

## 6. Cost and ownership

**Cost.** No prices here. Check current pricing on the vendor's page: [Claude in Foundry](https://platform.claude.com/docs/en/build-with-claude/claude-in-microsoft-foundry) (billed through Azure Marketplace) and Azure's pricing pages for the virtual machine; [Copilot Studio billing](https://learn.microsoft.com/en-us/microsoft-copilot-studio/billing-licensing). Graph mail and a Workflows webhook add no line item in the pages read, beyond the Microsoft 365 licences the institution already holds; the support page says the Teams webhook trigger "does not require a premium license". Whether the unit is charged back for any of it: the unit's business office.

**Ownership.** [`../service-ownership.md`](../service-ownership.md) (issue 22) lists each credential, its owner role, where it is stored, and the rotation and handover steps. The Microsoft path changes who holds what:

| Credential or account | Personal-account path | Microsoft-first path |
|---|---|---|
| Model access | One person's Claude subscription or API key | A Foundry resource in the unit's Azure subscription; its key on the host (or, after the follow-up, a managed identity) |
| Mail in and out | Cloudflare account, domain, GitHub token, Resend key | One app registration, scoped to one shared mailbox; its secret or certificate on the host |
| Operator alerts | A Telegram bot token | The email route; later a Workflows URL owned by a user account |
| Host | Any machine | A virtual machine in the same Azure subscription |
| Knowledge base | A git repo | Unchanged: a git repo, ideally in an organization the institution controls |

Every row on the right is held by the unit or the tenant, not by one person, except the Workflows owner. The roles: Azure subscription owner (unit IT lead or the institution's cloud team), app registration owner (tenant administrators, with a unit service account as owner), shared mailbox owner (mail administrators). When a unit takes this path, add these rows to its copy of the inventory in `service-ownership.md`.

## Recommendation: one Microsoft-first path for a first unit

Keep the engine and the git knowledge base. Move the model, the host and the mail onto the institution's Microsoft services. In order:

| # | Step | Approvals needed (roles) |
|---|---|---|
| 0 | Before any approval: build the Graph sender (issue 67; issue 9 offered it as option a), the Graph intake (issue 57), and Entra ID auth for Foundry (issue 58), all against fake servers, as the Foundry provider was. Write the approval request from this page and [`../data-handling.md`](../data-handling.md). | None |
| 1 | Get the data-class decision in writing: may staff mail go to Claude on Foundry (which hosting option and region scope), to Exchange Online and to a VM in Azure? | Privacy office; IT security or vendor-review office; unit head signs |
| 2 | An Azure subscription for the unit, of an eligible type, with a Foundry resource (Hosted on Azure, US Data Zone if that is the approval) and a Linux VM that runs Docker (`docs/deployment.md`). | Institution's cloud services team; unit IT lead; budget owner |
| 3 | Run the Foundry live checks (`docs/model-providers.md` section 6, issue 24) with `MODEL_PROVIDERS=foundry` and the reply sensor off. | None beyond step 2 |
| 4 | A shared mailbox for the bot, and one app registration with `Mail.Read` (or `Mail.ReadWrite`) and `Mail.Send`, scoped to that mailbox by RBAC for Applications, with no unscoped grant left in Entra; checked with `Test-ServicePrincipalAuthorization` against that mailbox and one other. | Mail administrators; tenant administrators (Exchange and identity) |
| 5 | Turn on the Graph intake and sender; run the routed-approval exchange end to end; alerts by `ADMIN_ALERT_ROUTE=email`. | None beyond step 4 |
| 6 | Pilot with staff senders only and no student records (`docs/data-handling.md`, "Decide before go-live"). A Teams alert route (issue 11) can follow. | Unit head |

Until step 4 is approved, a unit can run steps 2 and 3 with the existing `inbound/` worker and an alias from an institutional address, if step 1 allows those vendors.

### Alternatives rejected

| Alternative | Why not, for a first unit |
|---|---|
| Copilot Studio as the front door | Adds a second model and a second log in front of the gate; the allowlist and routed approvals do not reach Teams users without new code; admin approvals for apps, connectors and external models |
| Copilot Studio replacing parts of the engine | Drops the delivery gate, the host-written audit log, the allowlist and the routed-approval check |
| Another approved model (not Claude) with a new agent runner | The agent, its skills and the gate reviewer run on the Claude agent SDK; a new runner is a rewrite of the container side. Claude on Foundry serves the same API |
| Staff questions in a Teams channel | A new channel with its own identity mapping; Graph posts as an application only for migration; email already carries the guarantees |
| SharePoint as the knowledge-base store | Loses atomic commits, trusted authors, the host-owned repository and the protected-path checks; months of work |
| Keep Resend and Cloudflare | Works today, but an institutional sending domain usually cannot be set up there (issue 9), and the accounts are not tenant-held |

### Follow-up issues

- [Issue 67](https://github.com/vishalsachdev/programos/issues/67): Graph sender (split from issue 9, which built the SMTP provider instead).
- Issue 11: Teams alert route through a Workflows webhook (existing); note that connector incoming webhooks are retired.
- Issue 22: service ownership (page on `main`); a unit on this path adds the rows above to its inventory.
- Issue 24: Foundry live checks (existing).
- [Issue 57](https://github.com/vishalsachdev/programos/issues/57): Mail intake from a Microsoft 365 shared mailbox through Graph.
- [Issue 58](https://github.com/vishalsachdev/programos/issues/58): Microsoft Entra ID authentication for the Foundry provider.
- [Issue 59](https://github.com/vishalsachdev/programos/issues/59): Check the agent's requests against Foundry's Hosted-on-Azure limits.
