# Start here

This page is for the person who wants a coordinator for their program or project. You do not need to be technical. Your coding agent (Claude Code, Codex, Cursor or another) does the technical work and follows [`AGENTS.md`](../AGENTS.md); this page tells you what to expect.

## What this is

ProgramOS is a coordinator bot for a team. Your colleagues write to one mail address, and the bot answers from your team's own record, saying which file each answer comes from. It also writes down decisions and action items, sends an approval request to the right person, and keeps a log of what was asked and answered.

## What it will and will not do

It will:

- answer only people on a list you control (the allowlist);
- answer from your team's record, with a citation, and say when the record has no answer;
- record decisions, action items and open questions in that record;
- pass a request that needs approval to the approver you named for that sender;
- check each reply before it is sent, and tell one person (the operator) when something fails;
- keep a dated log of messages and replies.

It will not:

- serve students or the public. It is for a staff team;
- invent content. It reads and cites your record;
- change who has access because a message asked. Only the admin does that;
- delete old mail. Everything it files stays in your record until a person removes it;
- decide what your institution allows. You get that answer from your own offices.

The rules above do not hold equally on every channel. [`SPEC.md`](../SPEC.md), section 11, lists where each one stops.

## Three ways to start

Start with the smallest one that answers your question.

| | Try it | Pilot (recommended) | Institutional |
|---|---|---|---|
| For | Seeing how it behaves | A real team of a few colleagues | The same, on services your institution has approved |
| Who uses it | You alone | You and a handful of colleagues you list | The same |
| How people reach it | A private Telegram chat | Email | Email |
| Where it runs | Your laptop, while it is awake | A small server that is always on | A server your institution approves |
| What you do not get | Email, colleagues, approvals by mail | Students or the public, automatic deletion of old mail | Any new feature; it is the same bot |

**The pilot is the recommended first real version.** It is done when a real colleague has: asked a question by email and got an answer with a citation; sent an update that was recorded as a decision; made a request that reached the right approver; and each of these left an entry in the log. Your agent keeps that checklist with you.

Some parts are new and have not yet been run against live services: the mail intake service in `inbound/`, operator alerts by email, the Microsoft Foundry option, and the step-by-step server recipe. Your agent will tell you when you reach one. Plan one real test of each before you tell colleagues the address.

## What you need before you start

For **Try it**:

- a laptop, and a coding agent on it. The laptop must be able to run two free programs, Docker and Node; your agent checks for them and tells you how to install what is missing;
- an account with an AI provider that serves Claude, such as Anthropic (check the provider's current pricing);
- a Telegram account, and a bot token: a secret that Telegram gives you when you create a bot through its BotFather chat. Your agent walks you through it;
- an account at a git host such as GitHub, for a private place to keep the record.

For a **Pilot**, also:

- a small server that is always on, from a cloud provider or your institution (check the provider's current pricing);
- an account with the mail delivery service the bot uses to send, Resend (check its current pricing);
- a mail address for the bot, on an internet domain where you, or your IT office for you, can add settings (DNS records);
- a way to receive mail for that address. The one in this repo uses a Cloudflare account;
- the names and addresses of the first colleagues, and who approves requests for each;
- a decision on who the operator is: the one person who looks after the bot and gets its alerts;
- **where your institution requires it, an answer from your IT or data office** on which AI service and which mail services your team's mail may reach. Ask early; it is often the slowest step. [`data-handling.md`](./data-handling.md) is the page to take to them.

For **Institutional**, also:

- a server, an AI service, a mail route and a git host that your institution has approved for this kind of data;
- a written sign-off on data handling.

This repo does not know what your institution allows, and it does not say.

## How to begin

1. Clone this repo and open it with your coding agent.
2. Say: "Read `AGENTS.md` and help me set this up. I am not technical."
3. Your agent explains the three ways to start and asks which you want.

## What your agent will ask you

One question at a time, each with an explanation and a recommendation. You can always answer "I do not know"; the agent then helps you find who does. It writes your answers in a file named `setup-decisions.md` that you can read.

1. Which way to start.
2. Which AI service your team's mail may reach, and who said so.
3. Who the admin is, and who approves for each colleague.
4. Which address the bot sends from.
5. Where the bot runs and where the record is kept.
6. Who is on the allowlist, and what they are told about where their mail goes.
7. How people reach the bot, and how the operator is alerted (Telegram, email, or both).
8. Whether the bot sends any reminders on a schedule. For a first pilot: none.

Your agent does the file changes and the tests. Only you can create accounts, approve a cost, ask your IT office for something, or say "go live". The agent asks you before anything that costs money, sends mail, or goes live.

## How much work each path is

In steps, not hours; how long each takes depends on your accounts and your institution.

| Path | Your steps |
|---|---|
| Try it | Create three accounts (AI provider, Telegram bot, git host). Answer the questions that apply. Start the bot on your laptop with your agent. Ask it something. |
| Pilot | The steps above. Then: get a server and a name for it. Create the mail delivery account and the mail intake. Add the DNS settings, or ask your IT office to. Give the list of colleagues and approvers. Run the test exchanges with your agent. Tick the pilot checklist. Tell your colleagues. |
| Institutional | The pilot's steps, with each service replaced by the one your institution approved. Before any of it: the approvals. |

## Where to read more

- [`AGENTS.md`](../AGENTS.md): what your agent follows, including every choice and its options.
- [`data-handling.md`](./data-handling.md): where messages go and what is kept. Take it to the people who approve data use.
- [`deployment.md`](./deployment.md): the server recipe.
- [`setup-reference.md`](./setup-reference.md): every setting.
