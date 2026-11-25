# ProgramOS

[![CI](https://github.com/vishalsachdev/programos/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/vishalsachdev/programos/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

A coordinator bot for a project or program team, and the knowledge base it keeps. Clone this repo, adapt it with your coding agent, and run it.

The bot answers questions from an allowlisted team by email (and Telegram for the admin), with citations into a git repo that is the team's source of truth. It records decisions, action items and open questions in that repo, sends reminders, routes approval requests to the right person, checks its replies before they are sent, and keeps an audit log.

> **Status: first public version (2026-11-14).** The code in this repo is a first export. `AGENTS.md`, the settings example and the governance doc are new. The code is the source of truth; older docs that restated it were removed.

## What you get

| Part | Where |
|---|---|
| The bot: host process, channels, delivery gate, audit log, scheduler, approvals | `src/` |
| The agent that runs in a container for each message, and its skills | `container/` |
| The agent's instructions for each channel | `groups/` |
| Setup wizard and operations script examples | `setup/`, `scripts/` |
| A mail intake worker for Cloudflare Email Routing. New, and not yet run against live services | [`inbound/`](./inbound/) |
| Instructions for your coding agent | [`AGENTS.md`](./AGENTS.md) |
| A skeleton for your knowledge-base repo | [`templates/program-repo/`](./templates/program-repo/) |
| Settings to fill in | [`config/instance.env.example`](./config/instance.env.example) |
| The rules the bot works under, and why each exists | [`docs/12-governance.md`](./docs/12-governance.md) |
| The design, as a spec | [`SPEC.md`](./SPEC.md), [`ARCHITECTURE.md`](./ARCHITECTURE.md), `docs/` |

## Where the code comes from

The code is a close copy of **K-ai**, a coordinator for one online master's program. It has been tested in production with one program since April 2026. ProgramOS includes code from [NanoClaw](https://github.com/qwibitai/nanoclaw) ([MIT](./NOTICE)) through K-ai. We removed the program's content (people, addresses, policies, history) and put placeholders in its place. We did not redesign the code. The 1,761 tests that pass in K-ai pass here. This repo adds 879 more, so CI runs 2,640 tests on every change.

Two things follow from that choice:

- **You get what was tested in real use**, not a cleaned-up rewrite that nobody has run.
- **Some identity values are still written in the code as placeholders** (the bot's name, the operator, the channel group names). Your coding agent replaces them. [`AGENTS.md`](./AGENTS.md) lists each one and where it lives.

K-ai stays the source. This repo takes its changes through a repeatable export. See [`UPSTREAM.md`](./UPSTREAM.md).

## Who this is for

A team that runs a project, a program, a grant, a lab or a unit, and wants one place where questions get answered from the record and decisions get written down. The examples in the prompts come from an academic program (courses, faculty, curriculum), because that is where the code was tested. The mechanisms are not specific to it.

You need: a host that can run Docker, a mail address for the bot, a git host for the knowledge base, and an AI service your organization allows your mail to reach. Check that last point first.

## Start

**Not technical? Read [`docs/start-here.md`](./docs/start-here.md) first.** It says in plain words what this is, what you need, and what your agent will ask you.

1. Clone this repo.
2. Open it with your coding agent (Claude Code, Codex, Cursor or another) and say: "Read `AGENTS.md` and help me adapt this for my project."
3. The agent first asks whether you are setting this up at the University of Illinois or somewhere else. That picks the pages it uses with you: the **Illinois track** ([`docs/illinois/`](./docs/illinois/README.md): what the university's public pages say, and the questions only its offices can answer) or the **general track** ([`docs/general/`](./docs/general/README.md): your own domain, a cloud virtual machine, the default mail provider or SMTP, the intake worker, Telegram or email alerts). The code is the same on both.
4. The agent explains three ways to start and asks which you want: **Try it** (one person, a laptop, Telegram only), **Pilot** (a small always-on machine, email, a handful of allowlisted colleagues; the recommended first version), or **Institutional** (the same on services your institution has approved).
5. The agent asks you six policy questions before it changes anything: which AI service is allowed, who approves, which address the bot uses, where data lives, what senders are told, and which channels you want. It asks one thing at a time, explains each choice, and writes your answers down.
6. It creates your knowledge-base repo, fills in settings, replaces placeholders, and keeps the tests passing.
7. You review a test exchange. You decide when to deploy.

## How it is kept safe

- The agent runs in a container. It sees only the folders you mount and reaches the model through a proxy on the host, which holds your credentials. On Docker Engine on Linux the container's network is restricted by default: it reaches that proxy and no outside host. Web search and web fetch are off by default. The container holds no git credential; the host pushes the agent's commits and tells the operator when a push fails.
- On email and Telegram, only allowlisted senders get an answer. The allowlist is a file in your knowledge-base repo. On email it is matched on the From header, which a sender can forge: by default the host only records whether named mail servers confirmed the sender, and it can be set to drop mail they did not confirm (`EMAIL_AUTH_MODE`; never run against live mail). Web chat is different: anyone who has its shared secret can ask. Keep web chat off if you need a check per person.
- The agent's replies and outbound mail pass a delivery gate on the host. A reply that fails the gate is not sent, and the operator is told. Operator alerts go to Telegram by default; a setting sends them by email to the operator's address, to a Microsoft Teams channel through a Workflows webhook (not verified against a live tenant), or several of these. [`AGENTS.md`](./AGENTS.md) lists the limits of each route.
- Accepted inbound messages and replies are written to an audit log in your knowledge-base repo. Some paths are not logged; `SPEC.md` section 6 lists them.
- Mail, replies and knowledge-base text reach outside services (the model provider, the mail provider, Telegram, your git host) and are stored in your knowledge-base repo, which the code never prunes. [`docs/data-handling.md`](./docs/data-handling.md) lists what goes where and what to decide before real users.
- These rules do not hold equally on every channel. [`SPEC.md`](./SPEC.md) section 11 lists where each one stops. Read it before you rely on one.
- Role and access changes are made by the admin only, never because a message asked.
- Numbered rules cover the rest. [`docs/12-governance.md`](./docs/12-governance.md) gives each rule and the failure it prevents.

## Docs

The code is the source of truth. The documents below cover what the code cannot say: the contract, the reasons for the rules, and the decisions you must make. Where a document and the code differ, the code is right; please report the difference.

| File | What it covers | Matches the code? |
|------|----------------|-------------------|
| [`SPEC.md`](./SPEC.md) | The contract: components, channels, modes, knowledge-base layout, audit log, governance | Yes (rewritten 2026-11-14) |
| [`ARCHITECTURE.md`](./ARCHITECTURE.md) | How the parts fit and who owns each | Yes (rewritten 2026-11-14) |
| [`docs/start-here.md`](./docs/start-here.md) | For the person, in plain words: what this is, what you need, the three ways to start, what your agent will ask | Yes; repeats `AGENTS.md` |
| [`AGENTS.md`](./AGENTS.md) | The guide for your coding agent: how to guide a person who is not technical, the three ways to start, every setup choice, what to replace, safety items, first start | Yes; checked against the code in review. A test checks that it names every setting |
| [`docs/setup-reference.md`](./docs/setup-reference.md) | Every setting key, the inbound mail contract, the two optional webhooks | Yes; the same test |
| [`templates/program-repo/`](./templates/program-repo/) | Starter knowledge-base repo, in the formats the code parses | Yes; `src/program-repo-template.test.ts` runs the real parsers over it |
| [`docs/general/README.md`](./docs/general/README.md) | The general track: the pages to read, in order, for a team with its own domain, a cloud virtual machine, the default mail provider or SMTP, the intake worker, and Telegram or email alerts | Index; links only |
| [`docs/illinois/README.md`](./docs/illinois/README.md) | The Illinois track: the university-specific page for each choice, in order, and the shared pages | Index; links only |
| [`docs/deployment.md`](./docs/deployment.md) | What kind of host works, what to start with, and one recipe for a virtual machine | Partly run; each step says what was checked |
| [`docs/cloud-vm.md`](./docs/cloud-vm.md) | What cloud machine to ask for, why app-hosting services that cannot start containers do not work, and the Azure specifics | Not run on Azure; Microsoft facts from public pages read 2026-11-20 |
| [`docs/costs.md`](./docs/costs.md) | Each monthly cost line (machine, model use, mail, intake, domain) with the vendor's pricing page, and a worked example with its assumptions | Prices read 2026-11-20; the example is arithmetic, not a measured bill |
| [`docs/data-handling.md`](./docs/data-handling.md) | What data reaches each outside service and each storage place, who can read it, what is and is not deleted, and what to decide before go-live | Yes; traced from the code 2026-11-19 |
| [`docs/illinois/data-handling.md`](./docs/illinois/data-handling.md) | One university's open data questions, none verified | Open items only |
| [`docs/illinois/hosting.md`](./docs/illinois/hosting.md) | Getting a virtual machine in the university's Azure: what its public pages say, and the open questions | Quotes from public pages read 2026-11-20; the rest not verified |
| [`inbound/README.md`](./inbound/README.md) | The mail intake worker: setup, the files and payload it writes, failure handling, what was not verified | Yes; its output is run through the real webhook handler in a test |
| [`docs/illinois/email-quickstart.md`](./docs/illinois/email-quickstart.md) | One university: a unit mailbox that redirects to the bot's domain, the intake worker, and the reply by the default provider or SMTP | Yes for the settings and the flow (rewritten 2026-11-20); never run end to end. University claims quoted from public pages or marked not verified |
| [`docs/illinois/institutional-address.md`](./docs/illinois/institutional-address.md) | One university: what sending as a campus address needs, and the questions to ask its central IT office | One public page quoted; the rest not verified |
| [`docs/illinois/mail-authentication.md`](./docs/illinois/mail-authentication.md) | One university: how to read the mail server names for sender authentication off a real forwarded message | Open items only; not verified |
| [`docs/illinois/github-enterprise.md`](./docs/illinois/github-enterprise.md) | Illinois Shared GitHub Service requests, access, data rules and repository address | Public guidance checked. Unit approval and live access unverified |
| [`docs/dependency-audit.md`](./docs/dependency-audit.md) | Each `npm audit` finding: fixed, not reachable (and why), or accepted (risk and owner); counts before and after | Yes; run 2026-11-20 |
| [`docs/service-ownership.md`](./docs/service-ownership.md) | Every credential and account a deployment holds: its owner role, where it is stored, how to rotate it, what breaks meanwhile, the handover checklist, the minimum for a pilot | Yes; traced from the code 2026-11-20. Provider screens and live rotation not verified |
| [`docs/illinois/service-ownership.md`](./docs/illinois/service-ownership.md) | One university's open questions about unit service accounts and who approves | Open items only; not verified |
| [`docs/teams-alerts.md`](./docs/teams-alerts.md) | Operator alerts in a Microsoft Teams channel: creating the workflow, the request body, a one-line test, what to change if your tenant expects another body | Tested with the request mocked; **not verified against a live Teams tenant** |
| [`docs/illinois/teams-alerts.md`](./docs/illinois/teams-alerts.md) | One university's open question: whether its tenant allows a Workflows webhook for a unit | Pointer and open items; not verified |
| [`docs/model-providers.md`](./docs/model-providers.md) | Claude on Microsoft Foundry (Azure) as a backup or primary model provider: deployments, hosting option, settings, failover and its limits | Yes for the code; not yet checked against a live Foundry endpoint |
| [`docs/illinois/model-foundry.md`](./docs/illinois/model-foundry.md) | One university's open questions about that provider | Pointer and open items; not verified |
| [`docs/design/microsoft-path.md`](./docs/design/microsoft-path.md) | Which parts can move onto Microsoft services (Copilot Studio, Foundry, Graph mail, Teams, SharePoint), what each keeps or loses, and one recommended Microsoft-first path | Design note; not implemented. Microsoft facts from public pages fetched 2026-11-20 |
| [`docs/illinois/microsoft-path.md`](./docs/illinois/microsoft-path.md) | One university's open questions about that path | Open items only; not verified |
| [`docs/design/`](./docs/design/) | Design notes: learning loop, outside content stores, several coordinators at one institution | Not implemented, or guidance only |
| [`docs/12-governance.md`](./docs/12-governance.md) | The numbered rules and how to change one | Draft |
| [`site/`](./site/) | The public page and its deploy script | Yes |
| [`docs/reminder-registry.md`](./docs/reminder-registry.md) | Template for the list of scheduled jobs | Yes |
| [`docs/evaluation-protocol.md`](./docs/evaluation-protocol.md), [`docs/capability-scenarios.md`](./docs/capability-scenarios.md) | How the bot is evaluated | Yes |
| [`CONTRIBUTING.md`](./CONTRIBUTING.md) | How the repo takes changes: exported code and owned files, the patch-file rule, the checks to run | Yes |
| [`SECURITY.md`](./SECURITY.md) | How to report a security problem and what is in scope | Yes |
| [`CODE_OF_CONDUCT.md`](./CODE_OF_CONDUCT.md) | The Contributor Covenant, adopted by reference | Contact address not yet filled in |

## Known issues

- `npm audit` on 2026-11-20 reports 9 findings at the root (1 high, 7 moderate, 1 low; was 24) and none in `container/agent-runner/` or `inbound/`. The high one is `xlsx`, which has no fixed version on npm and is mitigated, not fixed. Each finding and its decision: [`docs/dependency-audit.md`](./docs/dependency-audit.md).
- One timing test can fail when the machine is busy. It passes when run alone.
- Several values that should be settings are still in code. `AGENTS.md` lists them.

## Contributing

Fixes, adapters and doc corrections are welcome. Read [`CONTRIBUTING.md`](./CONTRIBUTING.md) first: most code here is exported from the reference deployment, so a change to it needs a patch file. Report a security problem privately, as [`SECURITY.md`](./SECURITY.md) describes.

## License

MIT. See [`LICENSE`](./LICENSE) and [`NOTICE`](./NOTICE).
