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
| Instructions for your coding agent | [`AGENTS.md`](./AGENTS.md) |
| A skeleton for your knowledge-base repo | [`templates/program-repo/`](./templates/program-repo/) |
| Settings to fill in | [`config/instance.env.example`](./config/instance.env.example) |
| The rules the bot works under, and why each exists | [`docs/12-governance.md`](./docs/12-governance.md) |
| The design, as a spec | [`SPEC.md`](./SPEC.md), [`ARCHITECTURE.md`](./ARCHITECTURE.md), `docs/` |

## Where the code comes from

The code is a close copy of **K-ai**, a coordinator for one online master's program. It has been tested in production with one program since April 2026. K-ai is built on [NanoClaw](https://github.com/qwibitai/nanoclaw) (MIT; see [`NOTICE`](./NOTICE)). We removed the program's content (people, addresses, policies, history) and put placeholders in its place. We did not redesign the code. The 1,761 tests that pass in K-ai pass here.

Two things follow from that choice:

- **You get what was tested in real use**, not a cleaned-up rewrite that nobody has run.
- **Some identity values are still written in the code as placeholders** (the bot's name, the operator, the channel group names). Your coding agent replaces them. [`AGENTS.md`](./AGENTS.md) lists each one and where it lives.

K-ai stays the source. This repo takes its changes through a repeatable export. See [`UPSTREAM.md`](./UPSTREAM.md).

## Who this is for

A team that runs a project, a program, a grant, a lab or a unit, and wants one place where questions get answered from the record and decisions get written down. The examples in the prompts come from an academic program (courses, faculty, curriculum), because that is where the code was tested. The mechanisms are not specific to it.

You need: a host that can run Docker, a mail address for the bot, a git host for the knowledge base, and an AI service your organization allows your mail to reach. Check that last point first.

## Start

1. Clone this repo.
2. Open it with your coding agent (Claude Code, Codex, Cursor or another) and say: "Read `AGENTS.md` and help me adapt this for my project."
3. The agent asks you six questions before it changes anything: which AI service is allowed, who approves, which address the bot uses, where data lives, what senders are told, and which channels you want.
4. It creates your knowledge-base repo, fills in settings, replaces placeholders, and keeps the tests passing.
5. You review a test exchange. You decide when to deploy.

## How it is kept safe

- The agent runs in a container. It sees only the folders you mount and is set to reach the model through a proxy on the host, which holds your credentials.
- On email and Telegram, only allowlisted senders get an answer. The allowlist is a file in your knowledge-base repo. Web chat is different: anyone who has its shared secret can ask. Keep web chat off if you need a check per person.
- The agent's replies and outbound mail pass a delivery gate on the host. A reply that fails the gate is not sent, and the operator is told. Operator alerts go to Telegram by default; a setting sends them by email to the operator's address, or both ways. [`AGENTS.md`](./AGENTS.md) lists the limits of each route.
- Accepted inbound messages and replies are written to an audit log in your knowledge-base repo. Some paths are not logged; `SPEC.md` section 6 lists them.
- Mail, replies and knowledge-base text reach outside services (the model provider, the mail provider, Telegram, your git host) and are stored in your knowledge-base repo, which the code never prunes. The container's network is not restricted. [`docs/data-handling.md`](./docs/data-handling.md) lists what goes where and what to decide before real users.
- These rules do not hold equally on every channel. [`SPEC.md`](./SPEC.md) section 11 lists where each one stops. Read it before you rely on one.
- Role and access changes are made by the admin only, never because a message asked.
- Numbered rules cover the rest. [`docs/12-governance.md`](./docs/12-governance.md) gives each rule and the failure it prevents.

## Docs

The code is the source of truth. The documents below cover what the code cannot say: the contract, the reasons for the rules, and the decisions you must make. Where a document and the code differ, the code is right; please report the difference.

| File | What it covers | Matches the code? |
|------|----------------|-------------------|
| [`SPEC.md`](./SPEC.md) | The contract: components, channels, modes, knowledge-base layout, audit log, governance | Yes (rewritten 2026-11-14) |
| [`ARCHITECTURE.md`](./ARCHITECTURE.md) | How the parts fit and who owns each | Yes (rewritten 2026-11-14) |
| [`AGENTS.md`](./AGENTS.md) | The guide for your coding agent: what to ask, what to replace, safety items, first start | Yes; checked against the code in review |
| [`templates/program-repo/`](./templates/program-repo/) | Starter knowledge-base repo, in the formats the code parses | Yes; `src/program-repo-template.test.ts` runs the real parsers over it |
| [`docs/deployment.md`](./docs/deployment.md) | What kind of host works, what to start with, and one recipe for a virtual machine | Partly run; each step says what was checked |
| [`docs/data-handling.md`](./docs/data-handling.md) | What data reaches each outside service and each storage place, who can read it, what is and is not deleted, and what to decide before go-live | Yes; traced from the code 2026-11-19 |
| [`docs/illinois/data-handling.md`](./docs/illinois/data-handling.md) | One university's open data questions, none verified | Open items only |
| [`docs/illinois/hosting.md`](./docs/illinois/hosting.md) | The same recipe on a university virtual machine: open questions | Stub; not verified |
| [`docs/09-illinois-quickstart.md`](./docs/09-illinois-quickstart.md) | One university's recipe for a campus mail alias | Not yet updated |
| [`docs/illinois/github-enterprise.md`](./docs/illinois/github-enterprise.md) | One university's host name for the knowledge-base repo setting | Not verified |
| [`docs/illinois/model-foundry.md`](./docs/illinois/model-foundry.md) | Claude on Microsoft Foundry (Azure) as a backup or primary model provider: deployments, hosting option, settings, failover and its limits | Yes for the code; not yet checked against a live Foundry endpoint |
| [`docs/design/`](./docs/design/) | Design notes: learning loop, outside content stores, several coordinators at one institution | Not implemented, or guidance only |
| [`docs/12-governance.md`](./docs/12-governance.md) | The numbered rules and how to change one | Draft |
| [`site/`](./site/) | The public page and its deploy script | Yes |
| [`docs/reminder-registry.md`](./docs/reminder-registry.md) | Template for the list of scheduled jobs | Yes |
| [`docs/evaluation-protocol.md`](./docs/evaluation-protocol.md), [`docs/capability-scenarios.md`](./docs/capability-scenarios.md) | How the bot is evaluated | Yes |
| [`docs/framework/`](./docs/framework/) | NanoClaw's own reference docs | Upstream text |
| [`CONTRIBUTING.md`](./CONTRIBUTING.md) | How the repo takes changes: exported code and owned files, the patch-file rule, the checks to run | Yes |
| [`SECURITY.md`](./SECURITY.md) | How to report a security problem and what is in scope | Yes |
| [`CODE_OF_CONDUCT.md`](./CODE_OF_CONDUCT.md) | The Contributor Covenant, adopted by reference | Contact address not yet filled in |

## Known issues

- The dependency audit reports 26 findings inherited from the source. They are reported there; this repo keeps the source's exact versions until it fixes them.
- One timing test can fail when the machine is busy. It passes when run alone.
- Several values that should be settings are still in code. `AGENTS.md` lists them.

## Contributing

Fixes, adapters and doc corrections are welcome. Read [`CONTRIBUTING.md`](./CONTRIBUTING.md) first: most code here is exported from the reference deployment, so a change to it needs a patch file. Report a security problem privately, as [`SECURITY.md`](./SECURITY.md) describes.

## License

MIT. The code derived from NanoClaw carries NanoClaw's MIT notice in [`NOTICE`](./NOTICE).
