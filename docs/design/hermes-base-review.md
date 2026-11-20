# Hermes Agent as the base for ProgramOS: a review

> **Design note, not implemented.** This page reviews a change of base; it adds no code. Written 2026-11-20 at the owner's request ("review in a separate session if we use hermes agent instead of nanoclaw as the base for programos"). Every Hermes fact below was read on 2026-11-20, in its public documentation site and in its public source at commit `2de9f51` (the docs site is built from `website/docs/` in that repository, so a docs URL below and the file of the same path say the same thing on that date). Hermes changes almost daily: check each page again before you act on it.

Labels used on each claim: **[repo]** read in this repository (file named); **[hermes]** read in Hermes documentation or source (URL named); **[inference]** my deduction (from what is said); **[unknown]** not determined.

## Recommendation

**Do not replace NanoClaw with Hermes Agent (option b). Stay on NanoClaw (option a). Do not spike Hermes as a container runner (option c) now; spike it only if the owner decides that a non-Claude model is required for a kind of data that Claude on Foundry cannot take.** The Foundry guide the owner linked shows two things ProgramOS lacks, Entra ID auth and non-Claude model families on Foundry. Entra ID is cheaper to add to ProgramOS's own credential proxy (issue 58) than by changing base. Non-Claude families are what option (c) would buy, at the cost of a second agent runtime.

Confidence: **high (about 85 percent) against option (b); medium (about 60 percent) that option (c) is not worth a spike today.**

Facts that would change it:

1. A written decision that the pilot must run on an OpenAI or Gemini model (for example, because Claude on Foundry is not approved for the data class and those are). That moves (c) from "not now" to "spike first". It does not change (b).
2. Hermes documenting a supported posture in which the agent loop runs in a per-message sandbox while the gateway, credentials and outbound delivery stay outside it. Its security policy today says the opposite: the agent process holds the credentials, and the supported posture for inbound email puts the whole process, gateway included, inside one sandbox (section 1.5).
3. The reference deployment (K-ai) changing base itself. ProgramOS's code is an export of it; a base change here alone ends that relationship (section 3).

The strongest argument against this recommendation is in section 3, "Strongest case for change".

## 0. What ProgramOS takes from NanoClaw, and what it adds

**From the framework** [repo]. `SPEC.md` section 2 lists "Container runtime, channel registry, message router, group queue, SQLite store" as `src/` "from the NanoClaw framework", and `ARCHITECTURE.md` ("Who owns what") adds the container runner and the credential proxy to the framework layer. Files: `src/index.ts`, `src/container-runner.ts`, `src/container-runtime.ts`, `src/group-queue.ts`, `src/router.ts`, `src/db.ts`, `src/ipc.ts`, `src/task-scheduler.ts`, `src/credential-proxy.ts`, `src/mount-security.ts`, `src/group-folder.ts`, `src/channels/registry.ts`, plus `container/agent-runner/` (the runner that calls `query()` from `@anthropic-ai/claude-agent-sdk`, `container/agent-runner/src/index.ts`). Those framework-named files hold about 7,400 of about 33,900 non-test lines in `src/` [inference: line counts on `main` at `86a14f4`; several of those files, `src/index.ts` and `src/credential-proxy.ts` above all, carry ProgramOS code too, so 7,400 is an upper bound on what is still NanoClaw's].

**ProgramOS's own host-side controls** [repo], which any base would need: the email channel (`src/channels/webhook.ts`, 2,086 lines) with the allowlist (`src/channels/webhook-allowlist.ts`), sender caps (`src/channels/sender-quota.ts`) and sender authentication (`src/email-auth.ts`, `inbound/src/auth.ts`); the delivery gate (`src/delivery-gate.ts`); the durable outbox with its attempt budget (`src/outbound-email-outbox.ts`, `beginAttempt`) and two providers (`src/outbound-email.ts`, `src/outbound-email-smtp.ts`); signed delivery state (`src/delivery-state.ts`); the host-written audit log (`src/audit-log.ts`); routed approvals (`src/routed-approvals.ts`); the host-owned repository and the rule that host git never runs in the agent's checkout (`src/host-repo.ts`, `src/host-git-trust.test.ts`); the restricted container network (`src/container-runtime.ts`, `CONTAINER_NETWORK`) and web-tool refusal at the proxy (`src/web-tools.ts`, `checkProxyRequest`); model providers with failover (`src/model-provider.ts`); retention (`src/retention.ts`); operator alerts (`src/admin-alert.ts`); the intake worker (`inbound/`); and 141 test files, about 2,640 tests (`CLAUDE.md`, session log 2026-11-20).

**What is written for the Claude Agent SDK** [repo]: the runner passes `hooks` (a `PreToolUse` write guard, `container/agent-runner/src/protected-write-guard.ts`, and a `PreCompact` hook), `agents` (the `kb-gate-reviewer` subagent), `settingSources: ['project','user']` (which loads `CLAUDE.md` files and skills), `permissionMode: 'bypassPermissions'`, `allowedTools`/`disallowedTools`, an MCP server for IPC (`container/agent-runner/src/ipc-mcp-stdio.ts`), and the `claude_code` system-prompt preset with `groups/global/CLAUDE.md` appended (`container/agent-runner/src/index.ts`, lines 536 to 582). The skills in `container/skills/` and the prompts in `groups/` assume those features. The proxy's web-tool check is written against the type definitions of `@anthropic-ai/sdk` 0.93.0 (`SPEC.md` section 11, "Web tools off").

**Two facts that bound the answer** [repo]. The code is an export of K-ai, which is built on NanoClaw (`UPSTREAM.md`); every change ProgramOS made to exported code is held in one consolidated patch against that export (`scripts/upstream-sync/README.md`). And the guarantees ProgramOS states (`SPEC.md` section 11) are almost all host code, not framework code.

## 1. What Hermes Agent is and is not

### 1.1 Architecture

- "Hermes Agent is a single-tenant personal agent." [hermes: https://github.com/NousResearch/hermes-agent/blob/main/SECURITY.md, section 2]
- The messaging gateway is one long-lived background process that connects every platform, keeps sessions and runs cron. [hermes: https://hermes-agent.nousresearch.com/docs/user-guide/messaging/ and https://hermes-agent.nousresearch.com/docs/developer-guide/architecture]
- The agent loop runs in that Python process. Tools that run shell or files go to a "terminal backend"; "The default runs commands directly on the host." Others: docker, ssh, daytona, modal, vercel_sandbox, plugin backends. [hermes: SECURITY.md section 2.1; https://hermes-agent.nousresearch.com/docs/user-guide/features/tools]
- Docker backend: "One persistent container, shared across the whole process ... for the lifetime of the Hermes process." [hermes: https://hermes-agent.nousresearch.com/docs/user-guide/features/tools]. An option, `container_persistent: false`, gives one container per session (conversation), and "`delegate_task` subagents still share their parent session's container." [hermes: https://hermes-agent.nousresearch.com/docs/user-guide/configuration]. Per message, as ProgramOS runs: not documented [unknown].
- What a terminal backend does not confine: "the code-execution tool (spawned as a host subprocess), MCP subprocesses ..., plugin loading, hook dispatch, and skill loading (all imported into the agent interpreter)." [hermes: SECURITY.md section 2.2]. The tools page says `execute_code` goes through `docker exec` into the container [hermes: features/tools]. The two pages disagree on where code execution runs [hermes, both pages; unresolved].
- Library use: `from run_agent import AIAgent`; `agent.chat(...)` or `run_conversation(...)`. "Hermes does not publish a supported wheel or source distribution"; you use a source checkout. [hermes: https://hermes-agent.nousresearch.com/docs/guides/python-library]. A single-query CLI mode (`hermes chat -q`) exists [hermes: tools and security pages, as reported by the fetch; output format not checked].

### 1.2 Models and the Foundry guide

- Providers include native Anthropic, OpenAI, Gemini, Vertex AI, AWS Bedrock, Microsoft Foundry, OpenRouter and about thirty others. [hermes: https://hermes-agent.nousresearch.com/docs/integrations/providers]
- Foundry, two wire formats on one resource: OpenAI-style (`/v1/chat/completions`, and the Responses API for GPT-5.x, codex and o-series, which Hermes selects by model name) for "GPT-4.x, GPT-5.x, Llama, Mistral, and most open-weight models"; and Anthropic-style (`/v1/messages` on `https://<resource>.services.ai.azure.com/anthropic`) for Claude. [hermes: https://hermes-agent.nousresearch.com/docs/guides/azure-foundry]
- Auth: an API key, or Microsoft Entra ID through `azure-identity`'s `DefaultAzureCredential` (managed identity, workload identity, service principal, `az login`), scope `https://ai.azure.com/.default`, role "Azure AI User", for both formats. (Same page.)
- The page contradicts itself twice [hermes, same page]: on the Anthropic route it says Bearer auth is required, then that `provider: anthropic` with an Azure URL uses `x-api-key`; and it says GPT-5.x is Responses-only, then in Troubleshooting that "Azure serves gpt-5.x on `/chat/completions`". ProgramOS's own Foundry page records that the key works in `api-key` and `x-api-key` headers [repo: `docs/model-providers.md`, section 2]; which is right on a live endpoint is [unknown].
- Credentials sit in `~/.hermes/.env` (or Bitwarden or 1Password at start). In Entra mode no secret is in `.env`. [hermes: azure-foundry; https://hermes-agent.nousresearch.com/docs/user-guide/secrets/]

### 1.3 Messaging

- About thirty platforms, including Telegram, Teams and email. [hermes: messaging index]
- Email is IMAP polling and SMTP sending with Python's standard library, a mailbox login with an app password, a sender allowlist (`EMAIL_ALLOWED_USERS`), and sender authentication: it acts only when the topmost `Authentication-Results` header, pinned by `EMAIL_AUTHSERV_ID`, authenticates the From domain (DMARC, or aligned SPF/DKIM). [hermes: https://hermes-agent.nousresearch.com/docs/user-guide/messaging/email]. This is close to ProgramOS's own design (`src/email-auth.ts`) and, unlike ProgramOS's default `flag`, enforcing by default [inference from both].
- The email adapter's `send` builds a message and calls `smtplib` directly (`plugins/platforms/email/adapter.py`, `_send_email`). [hermes: source]. The gateway keeps a "Delivery Reliability" ledger in `state.db`: "honest at-least-once", three attempts with 30-second and 2-minute backoff within 24 hours. [hermes: messaging index, "Delivery Reliability"]. No delivery gate that checks the reply's content before sending, no recipient rule beyond replying to the sender, and no host-written audit trail in a git repository is documented [unknown whether one exists; none found in the pages read].
- Replies can attach host files with `MEDIA:/path`, limited by an allowlist of folders (`gateway/media_policy.py`). [hermes: email page; source]
- "Within the authorized set, all callers are equally trusted. Hermes Agent does not model per-caller capabilities inside a single adapter." [hermes: SECURITY.md section 2.6]. ProgramOS's allowlist rows carry an access tier and an approver (`SPEC.md` sections 4 and 5) [repo].

### 1.4 Memory and skills

- The agent writes its own memory (`MEMORY.md`, `USER.md`) and its own skills (`skill_manage`); a background review after turns can write both; the approval gates for those writes (`memory.write_approval`, `skills.write_approval`) default to off. [hermes: https://hermes-agent.nousresearch.com/docs/user-guide/features/memory, .../features/skills]. ProgramOS puts "autonomous skill creation or self-modification" out of scope (`SPEC.md` section 9) [repo]; on Hermes both would have to be turned off and kept off.
- Hermes reads `CLAUDE.md` as a context file, but loads only one project context type per session (first of `.hermes.md`, `AGENTS.override.md`, `AGENTS.md`, `CLAUDE.md`, `.cursorrules`). [hermes: https://hermes-agent.nousresearch.com/docs/user-guide/features/context-files]. Skills use a `SKILL.md` format [hermes: features/skills]. A `pre_tool_call` hook can block a tool call and fails closed on timeout. [hermes: https://hermes-agent.nousresearch.com/docs/user-guide/features/hooks]. So ProgramOS's write guard, skills and prompts have counterparts; whether they behave the same is [unknown].

### 1.5 Isolation and security model

- "The only security boundary against an adversarial LLM is the operating system. Nothing inside the agent process constitutes containment — not the approval gate, not output redaction, not any pattern scanner, not any tool allowlist." [hermes: SECURITY.md section 2.2]
- For "inbound email, multi-user channels" the supported posture is whole-process wrapping: Hermes's own Docker image, or NVIDIA OpenShell. "Operators running the default local backend with untrusted input surfaces ... are operating outside the supported security posture." (Same section.)
- Credentials: shell, MCP and code-execution children get a filtered environment, which "reduces casual exfiltration. It is not containment. Any component running inside the agent process ... can read whatever the agent itself can read, including in-memory credentials." [hermes: SECURITY.md section 2.3]
- Egress: an optional credential-injecting proxy (iron-proxy) for the Docker terminal backend only ("Modal, Daytona, SSH, and Singularity do not receive proxy env vars"), and it "does not rewrite credentials for in-process LLM calls the host process makes." [hermes: https://hermes-agent.nousresearch.com/docs/user-guide/egress/iron-proxy]. A Docker network-isolation recipe with an allowlisting egress proxy is documented as an operator guide. [hermes: .../egress/network-isolation]
- Command approval is skipped on container backends "because the container itself is the security boundary." [hermes: https://hermes-agent.nousresearch.com/docs/user-guide/security]
- Prompt injection "per se" is out of scope for vulnerability reports. [hermes: SECURITY.md section 3.2]

**What this means for a hostile email** [inference from the lines above]. In Hermes the model's tool calls are made by the process that holds the model key and the gateway credentials. If that process runs on the host, the boundary is a heuristic. If it runs in a sandbox, as the policy requires for email, the mail login, the outbound SMTP path and any audit writer are inside the same sandbox as the agent that read the hostile message. ProgramOS separates them: the agent is in a per-message container with no credential and no outside network (`SPEC.md` section 11, "Container network restricted"; `docs/model-providers.md`, section 4), and the gate, outbox and audit log are host code it cannot reach.

### 1.6 Licence and maturity

- MIT, "Copyright (c) 2025 Nous Research". [hermes: https://github.com/NousResearch/hermes-agent/blob/main/LICENSE]
- Releases: calendar tags from `v2026.3.12` to `v2026.9.24`, then semantic tags `v0.21.6` to `v0.23.3`, with daily canary tags and many abandoned release candidates (for example 38 for `v0.21.5`). [hermes: `git ls-remote --tags`, 2026-11-20]. Latest stable `v0.23.3`, 19 November 2026; "about 370 PRs and 60 closed issues since v0.23.2" (16 November); the GitHub page showed "5k+" open issues and "5k+" open pull requests. [hermes: https://github.com/NousResearch/hermes-agent/releases and repository page, as reported by the fetch; the API was not reachable from this session, so exact counts are unknown]. `pyproject.toml` says version `0.0.0` [hermes: source].
- Maintainer: Nous Research; releases published by one account. [hermes: releases page, as reported by the fetch]
- Running unattended: `hermes gateway install` makes a systemd or launchd service, with a watchdog. [hermes: messaging index]. Tool calls can be logged to a rotating file (`~/.hermes/logs/tool_calls.log`, 5 MB × 3). [hermes: messaging index, as reported]. No document on running for a team with a host-side audit trail was found.

My reading [inference]: very active, pre-1.0, broad scope (desktop app, browser vault, kanban, voice, pets), and changing faster than ProgramOS could re-verify a pin. A wrong-release rate is not something I could measure.

## 2. The guarantees in `SPEC.md` section 11, on a Hermes base

"Provides" means Hermes does it as documented; "helps" means a part exists to build on; "neutral" means it would be ProgramOS code either way; "harder" means the base works against it.

| Guarantee (`SPEC.md` §11) | On Hermes | Why |
|---|---|---|
| Per-message isolation (one container per message, `src/container-runner.ts`) | **Harder** | Per process, or per session at best (§1.1); the agent loop and in-process tools are outside the terminal sandbox (§1.5) |
| A credential the agent cannot read (`docs/model-providers.md` §4) | **Harder** | The agent process holds the model key in memory; iron-proxy covers sandboxed tools only, not the loop's own model calls (§1.5) |
| Egress boundary (`CONTAINER_NETWORK=restricted`) | **Harder** | Possible only by wrapping the whole process; then the gateway's IMAP and SMTP traffic needs the same hole the agent would use [inference] |
| Web tools off, checked at the proxy (`src/web-tools.ts`) | **Harder** | Hermes's model calls do not pass a host proxy; an SSRF filter exists for web tools only (§1.5, security page) |
| Host-side delivery gate (`src/delivery-gate.ts`) | Neutral at best | No equivalent found; it would be new code in the gateway's send path, which runs in the agent's process |
| Durable outbox with attempt budget (`src/outbound-email-outbox.ts`) | Helps a little | An at-least-once ledger with three tries exists (§1.3); ProgramOS's budget, dead letters and alerts would be ported |
| Recipient only from allowlist or inbound mail (G22) | Neutral | Hermes replies to the sender; the thread-audience rule and outreach would be ported |
| Host-written audit log, committed by the host (`src/audit-log.ts`, `src/host-repo.ts`) | **Harder** | The writer would share a process (or sandbox) with the agent, so "the agent cannot change an entry before it is committed" (`SPEC.md` §6) no longer holds by construction |
| Host git obeys nothing the agent can write (`src/host-git-trust.test.ts`) | **Harder** | Same reason: no host side separate from the agent |
| Person allowlist (email, Telegram) | Provides | `EMAIL_ALLOWED_USERS`, default deny (§1.3); but no access tier or approver per row |
| Sender authentication | Provides (comparable) | DMARC or aligned SPF/DKIM with an `authserv_id` pin, enforcing by default (§1.3). ProgramOS's version also handles a forwarder and records a verdict per message |
| Sender caps | Unknown | Pairing has rate limits; turn caps per sender were not found |
| Routed approvals (`src/routed-approvals.ts`) | Neutral | Ported as new code |
| Protected files (write guard + host push check) | Helps for the first half | `pre_tool_call` can block (§1.4); the host push check has no host to live on |
| Signed delivery state (`src/delivery-state.ts`) | Neutral | Ported |
| Model provider failover | Provides | Fallback providers are documented [hermes: features/fallback-providers, not read in full] |
| Reply sensor | Neutral | Ported |
| Gate results logged | Neutral | Ported |

**Summary** [inference from the table]: Hermes provides the allowlist, sender authentication and failover, which ProgramOS already has. It works against exactly the guarantees that rest on a host the agent cannot reach.

## 3. The options

### (a) Stay on NanoClaw

- Gained: every guarantee in section 11 stays as tested; the export from K-ai continues; the 2,640 tests stay meaningful.
- Lost: nothing ProgramOS has. Still missing: Entra ID for Foundry (issue 58); a non-Claude model; the live checks the docs already list.
- Rebuild or re-verify: nothing new.
- New risk: none. Existing risk: NanoClaw is a small framework and the agent is tied to one SDK and one model family [inference].

### (b) Replace the base with Hermes and port the host controls

- Rebuild: the container-per-message runner (or accept per-session), the credential proxy and its web-tool parser (for every API shape the Hermes loop speaks), the restricted network, the email channel on the webhook contract (or switch to IMAP and drop `inbound/`'s commit-before-dispatch contract), the delivery gate, outbox and attempt budget, signed delivery state, audit log, host-owned repository and git trust rules, routed approvals, retention, operator alerts; the write guard as a `pre_tool_call` hook; the skills and prompts for Hermes's context-file and skill model; the gate reviewer as a delegated subagent. That is most of `src/` in a second language (Python).
- Re-verify: all 2,640 tests are TypeScript against this code; none carries over [inference]. Every row of section 11 would need checking again.
- Export relationship: ends. K-ai stays on NanoClaw; each later fix there would be reimplemented by hand [inference from `UPSTREAM.md`].
- Gained: many channels, many providers, Entra ID, an active community.
- New risk: the agent's process holds the credentials and runs the gateway (§1.5), so several guarantees can only be approximated; a base that releases daily at 0.x; self-writing memory and skills to keep disabled.
- Verdict: no.

### (c) Keep the ProgramOS host; run Hermes inside the container as a second agent runner

The host, the gate, the outbox, the audit log and the proxy stay. Only `container/agent-runner/` gets a sibling: a Python runner that calls `AIAgent` for one turn, in the same per-message container, with the restricted network.

- What it would buy: OpenAI and Gemini models (directly or on Foundry), which the Claude Agent SDK does not drive. The owner has said OpenAI and Gemini are approved for sensitive data at their university [not verified here].
- `docs/design/microsoft-path.md` rejected "another approved model (not Claude) with a new agent runner" because "a new runner is a rewrite of the container side" [repo]. Tested again: Hermes makes the runner itself cheaper than a rewrite from nothing, because it already has a tool loop, a blocking `pre_tool_call` hook, `SKILL.md` skills, MCP client support and a `CLAUDE.md` reader (§1.4) [hermes]. It does not remove the rest of the cost:
  - The proxy. ProgramOS's boundary for "the agent asks the provider to reach outside" is a parser of Anthropic request bodies (`src/web-tools.ts`). OpenAI's Responses API and Gemini have their own server-side tools (web search, file search, code execution, remote MCP) [inference from general knowledge of those APIs; not read today]. A parser per API shape would be new security-critical code, the same kind as `checkProxyRequest`.
  - Credentials in the container. The Hermes loop reads its key from its own environment or config. The placeholder-and-swap pattern works only if Hermes sends the key in a header the proxy can replace and honours a base URL pointing at the proxy; for Foundry with Entra ID the token would have to be minted on the host, not by `azure-identity` in the container [inference from §1.2 and `docs/model-providers.md` §4].
  - Behaviour parity. The prompts, skills, the gate reviewer (`agents:` in the SDK) and `bypassPermissions` semantics were tuned on Claude through the SDK; the evaluation in `docs/evaluation-protocol.md` would have to be run again per model [inference].
  - Hermes's own defaults to turn off in the container: memory and skill writes, background review, browser and web tools, approvals mode (unattended `deny` refuses dangerous commands, which may refuse git the agent needs) [hermes: §1.4, security page].
  - Dependency weight: a Python source checkout with no supported package, pinned in the image, re-checked at each bump of a project that releases daily [hermes: python-library; inference].
- Tests: the host tests stay; the runner needs its own suite. The export relationship: the second runner is ProgramOS-owned code, as `inbound/` is, and the K-ai export is unaffected [inference from `CLAUDE.md`, "Scope of this repo"].
- New risk: two agent runtimes whose guard behaviour can differ; a proxy that must understand two or three API families; a fast-moving dependency inside the boundary.
- Verdict: possible, and the cheapest way to run a non-Claude model with the guarantees intact. Worth a spike only when a non-Claude model is required.

### (d) Cheaper paths to what the Foundry guide offers

- **Entra ID for Claude on Foundry:** issue 58, in `src/credential-proxy.ts`. The host gets a token for scope `https://ai.azure.com/.default` from a managed identity or service principal and puts it in the `Authorization` header in place of the key. The container is unchanged. [inference from `docs/model-providers.md` §4 and the scope in `docs/design/microsoft-path.md` §2]
- **A non-Claude model for host-side single calls only:** the reply sensor is one request from the host (`src/behaviour-sensor.ts`; `SENSOR_PROVIDER`). Adding an OpenAI-style sensor provider uses the approved family without touching the agent [inference]. It does not move the agent.
- **A translating gateway under the Claude Agent SDK** (Anthropic Messages in, another model out): not recommended. The SDK and Claude Code assume Claude features, and the proxy would be checking a format that is translated after it [inference; not tested].

### Strongest case for change

ProgramOS's host code is what matters, and only about a fifth of `src/` is framework [inference, §0]. NanoClaw is small; Hermes is very active, ships Entra ID, enforcing DMARC on email, a delivery ledger and dozens of providers, and its licence is the same. A team that wants OpenAI or Gemini now will get there faster with Hermes than by waiting for the Claude Agent SDK. Answer: that argues for option (c), not (b). The reason not to take (b) is not Hermes's quality; it is that its stated security model puts the agent, the credentials and the gateway in one process, and ProgramOS's guarantees depend on keeping them apart.

## 4. What the linked Foundry guide changes

- Claude on Foundry: nothing new. ProgramOS `main` already routes Claude to Foundry behind its proxy, with failover (`src/model-provider.ts`, `docs/model-providers.md`) [repo]. Hermes calls the same `/anthropic/v1/messages` endpoint [hermes: azure-foundry].
- Entra ID: Hermes has it; ProgramOS does not (issue 58) [repo; hermes]. Obtainable more cheaply on the host (option d).
- Other model families on Foundry (GPT, Llama, Mistral, DeepSeek): Hermes reaches them; ProgramOS's agent cannot, because the Claude Agent SDK does not drive them [hermes; repo: `container/agent-runner/src/index.ts`]. Obtainable only through a second runner (option c).
- Hosted-on-Azure limits for Claude (no web search or fetch beyond older versions, no Files API, no Models API) apply to any client of that endpoint, Hermes included [repo: `docs/design/microsoft-path.md` §2, from Anthropic's page read on 2026-11-20]. The guide does not address them [hermes: azure-foundry].
- Worth a change of base: no [inference from §2 and §3].

## 5. What could not be determined, and who could settle it

| Open point | How to settle it |
|---|---|
| Whether Hermes can run one turn per message inside a per-message container with no network but a proxy, with every model call going through that proxy and no key in the container | A spike (option c): build a container image with a pinned Hermes checkout, run `AIAgent.run_conversation` once against a local stand-in provider on the restricted network, and record every request the proxy sees, as was done for the SDK on 2026-11-20 (`SPEC.md` §11, "Web tools off") |
| Whether Hermes sends the provider key in a header the proxy can swap, for each provider family | The same spike, with a placeholder key |
| Where `execute_code` runs on the Docker backend (the security policy and the tools page disagree) | Hermes maintainers (issue or discussion), or read `tools/` in the source |
| Which header the Foundry Anthropic route takes (the guide says both Bearer and `x-api-key`) | A live call (`docs/model-providers.md` §2 already lists one) |
| Exact open issue and pull request counts, regressions per release | GitHub API with access, or the Hermes maintainers |
| Whether Hermes's prompts and skills format reproduces ProgramOS's behaviour on Claude, OpenAI and Gemini | The evaluation in `docs/evaluation-protocol.md`, per model, after a spike |
| Whether a non-Claude model is required at all | The owner and the approving office (below) |

**Not verified (one institution).** The owner has said that at the University of Illinois, OpenAI and Gemini models are approved for sensitive data. That is not checked here, and nothing in this repo records it. If it is true and Claude on Foundry is not approved for the same data class, point 1 of the recommendation applies.

## Sources

Hermes Agent, all read on 2026-11-20 (docs site, or the same file under `website/docs/` at source commit `2de9f51`):

- https://hermes-agent.nousresearch.com/docs/guides/azure-foundry
- https://hermes-agent.nousresearch.com/docs/integrations/providers
- https://hermes-agent.nousresearch.com/docs/user-guide/messaging/
- https://hermes-agent.nousresearch.com/docs/user-guide/messaging/email
- https://hermes-agent.nousresearch.com/docs/user-guide/security
- https://hermes-agent.nousresearch.com/docs/user-guide/features/tools
- https://hermes-agent.nousresearch.com/docs/user-guide/features/memory
- https://hermes-agent.nousresearch.com/docs/user-guide/features/skills
- https://hermes-agent.nousresearch.com/docs/user-guide/features/hooks
- https://hermes-agent.nousresearch.com/docs/user-guide/features/context-files
- https://hermes-agent.nousresearch.com/docs/user-guide/configuration
- https://hermes-agent.nousresearch.com/docs/user-guide/secrets/
- https://hermes-agent.nousresearch.com/docs/user-guide/egress/iron-proxy
- https://hermes-agent.nousresearch.com/docs/user-guide/egress/network-isolation
- https://hermes-agent.nousresearch.com/docs/guides/python-library
- https://hermes-agent.nousresearch.com/docs/developer-guide/architecture
- https://github.com/NousResearch/hermes-agent/blob/main/SECURITY.md
- https://github.com/NousResearch/hermes-agent/blob/main/LICENSE
- https://github.com/NousResearch/hermes-agent/releases (as reported by the fetch)
- Source files: `plugins/platforms/email/adapter.py`, `gateway/media_policy.py`, `pyproject.toml`; tags by `git ls-remote --tags`

Pages not read: the API server page, bot mode, the work-machine guide, fallback providers in full. No live endpoint was called and no Hermes code was run.

ProgramOS: `SPEC.md` (sections 2, 3, 6, 9, 10, 11), `ARCHITECTURE.md`, `UPSTREAM.md`, `NOTICE`, `CLAUDE.md`, `docs/design/microsoft-path.md`, `docs/model-providers.md`, `docs/data-handling.md`, `docs/12-governance.md`, `scripts/upstream-sync/README.md`, `container/agent-runner/src/index.ts`, `container/agent-runner/src/protected-write-guard.ts`, and the `src/` files named above.
