# Deployment

The code is the source of truth for how the bot runs. This page holds only what the code cannot tell you: what kind of host works, and what to start with.

## What the host must be able to do

- **Start a Docker container for each turn.** The host process (Node) launches the agent in a new container per message. This needs a machine where you control Docker: a laptop, a small server or a cloud virtual machine. Managed "run my web app" services that do not let the app start containers will not work.
- **Keep a git checkout of your knowledge-base repo** on local disk, with push rights. See `AGENTS.md`, "First start".
- **Receive HTTPS on one port** if you use email or web chat. Put a reverse proxy with TLS in front, and bind the listener to loopback.
- **Reach your AI service, your mail provider, your git host, and Telegram if you use it** on the way out.

## Start small

| Stage | Host | Channels | Inbound network |
|---|---|---|---|
| Trial | A laptop | Telegram only, one chat (the bot polls Telegram) | None |
| Pilot | A small server or virtual machine, always on | Telegram and email | One HTTPS endpoint behind a reverse proxy |

Email needs two things that Telegram does not: a public HTTPS endpoint and the separate inbound mail service described in `AGENTS.md`, "Inbound mail". Plan for that work before you promise email to your team.

The reference deployment runs on one small virtual machine under a process manager. `ecosystem.config.cjs` and `scripts/deploy.sh` are its files, kept as examples. Read and change them before use.

## Before real users

- Operator alerts have a route that works. The default route is Telegram for the admin; `ADMIN_ALERT_ROUTE=email` mails them to the operator's address instead, and `telegram,email` does both. A test alert arrives on each route you enabled (`AGENTS.md`, "First start", step 6). The startup log has no `Admin alert setup` error.
- The reply sensor is off, or its destination is approved for your data.
- Pull, commit and push work for both writers of the knowledge-base repo.
- One plain question passes end to end on each channel you enabled.
- If email is on: one routed approval passes end to end. A sender who is not on the allowlist gets no answer, or the one courtesy reply if they are at your institution.
- If Telegram is on: only one chat uses it (see `AGENTS.md`, safety items), and a handle that is not on the list gets no answer.
- If web chat is on: a call without the secret is refused. Web chat does not check the person.
