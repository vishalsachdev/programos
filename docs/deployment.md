# Deployment

The code is the source of truth for how the bot runs. This page holds only what the code cannot tell you: what kind of host works, and what to start with.

## What the host must be able to do

- **Start a Docker container for each turn.** The host process (Node) launches the agent in a new container per message. This needs a machine where you control Docker: a laptop, a small server or a cloud virtual machine. Managed "run my web app" services that do not let the app start containers will not work.
- **Keep a git checkout of your knowledge-base repo** on local disk. The host pulls and pushes it with its own git credential; the agent container has none and needs none. See `AGENTS.md`, "First start".
- **Receive HTTPS on one port** if you use email or web chat. Put a reverse proxy with TLS in front, and bind the listener to loopback.
- **Reach your AI service, your mail provider, Telegram and your git host** on the way out. This is the host. The agent container reaches only the host: on Docker Engine on Linux its network is restricted by default (`CONTAINER_NETWORK`), and web search and fetch are off (`AGENT_WEB_TOOLS`). On Docker Desktop the default network is open and the host warns at each start; `SPEC.md` section 11 says what each setting does and does not block.

## Start small

| Stage | Host | Channels | Inbound network |
|---|---|---|---|
| Trial | A laptop | Telegram only, one chat (the bot polls Telegram) | None |
| Pilot | A small server or virtual machine, always on | Telegram and email | One HTTPS endpoint behind a reverse proxy |

Email needs two things that Telegram does not: a public HTTPS endpoint and the separate inbound mail service described in `AGENTS.md`, "Inbound mail". Plan for that work before you promise email to your team.

The reference deployment runs on one small virtual machine under a process manager. `ecosystem.config.cjs` and `scripts/deploy.sh` are its files, kept as examples. Read and change them before use.

## Before real users

- Telegram is set up for the admin, and a test alert arrives. Operator alerts go there.
- The reply sensor is off, or its destination is approved for your data.
- `npx tsx scripts/check-container-egress.ts` prints PASS on every line: the container cannot reach the outside (restricted network), and a commit made in the container arrives on a remote through the host's push.
- A failed knowledge-base push reaches the admin as an alert (to test: make the remote unreachable for one turn that commits).
- One plain question passes end to end on each channel you enabled.
- If email is on: one routed approval passes end to end. A sender who is not on the allowlist gets no answer, or the one courtesy reply if they are at your institution.
- If email is on: the mail provider's events webhook answers 200 to a test event, and a bounce reaches the admin on Telegram (`AGENTS.md`, "Webhooks from other services").
- If the program repo is on GitHub: its push webhook shows a 200 delivery, or you have decided to run without it.
- If Telegram is on: only one chat uses it (see `AGENTS.md`, safety items), and a handle that is not on the list gets no answer.
- If web chat is on: a call without the secret is refused. Web chat does not check the person.
