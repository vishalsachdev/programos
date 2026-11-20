# 12. Governance

> **Status: draft (2026-11-14).** This is the first public list of the numbered rules that the code, prompts and skills cite. It was written from the rule text that ships in this repo. A full sort of the reference deployment's rule registry into code-enforced, general practice and program-specific is still to do. Numbers that are missing here are not used in this repo.

A coordinator that reads mail and writes to a shared record needs rules that hold when the model is wrong. ProgramOS puts those rules in three places:

1. **Code on the host.** The agent cannot skip these: the allowlist, the delivery gate, the audit record, sender caps. Protected files have a guard on the agent's file-editing tools and a git-author check on the host; the guard does not inspect shell commands, so treat it as a strong tripwire, not a wall.
2. **Gates the agent must run**, with a machine log of each run.
3. **Written practice** in the prompts and in the program repo.

Each rule has a number so that code comments, prompts and tests can cite it. Keep the numbers when you adapt the text.

## The rules

| ID | Rule | Failure it prevents |
|---|---|---|
| G6 | A recorded `lore: intentional` override takes the supersede path, not the conflict gate. | A deliberate change of an old decision is blocked as if it were a mistake, or an accidental contradiction passes as deliberate. |
| G8 | A detected conflict is held for human review. The agent never resolves it. | The agent quietly picks a winner between two recorded facts. |
| G11 | A protected file (the curriculum in the reference deployment) is not the agent's to edit. A guard blocks its file-editing tools on that path and records attempts; a host check on git authorship is the second line. The admin identities it accepts are the `ADMIN_AUTHOR_EMAILS` setting; with a real program repo the host does not start without them. | Core facts change through a chat message instead of through their owner. |
| G14 | Synced snapshot files are generated, not hand-edited. | A hand edit is overwritten at the next sync, or a stale copy is trusted. |
| G17 | A blocked sender from the same institution gets one courtesy reply. This is the only reply to a non-allowlisted sender. "One" is tracked in memory; a restart resets it. The institution is the `INSTITUTION_DOMAIN` setting; with a real program repo the host does not start without it. | Colleagues get silence and keep writing; or the bot starts answering strangers. |
| G19 | Each sender has a cap on turns per time window. The cap is lower for automated agents and unvouched senders. Enforced on email only; Telegram and web chat have no cap. Counters are in memory and reset on restart. | A mail loop or one heavy sender uses the whole budget. |
| G60 | Each inbound email that passes the allowlist gets a sender-authentication verdict in the audit log (`authenticated`, `unauthenticated`, `unknown`), taken only from mail servers the deployer named. In the default mode (`flag`) the verdict changes nothing else. In `enforce` mode, allowlisted mail that is not `authenticated` is dropped before the agent, with an audit entry and no reply of any kind, and the G17 courtesy reply is not sent to an address that is not authenticated. Email only. | A message with a forged From header of a listed person is answered, recorded as that person's update, or relayed to an approver as that person's request, and nobody can later tell it from real mail. |
| G22 | An email recipient must be on the allowlist. Exceptions in the code: the G17 courtesy reply, and the operator address added to mail for a peer agent. | Content goes to someone the team never approved. |
| G23 | Every successful send writes a host-side audit record. Not yet true for scheduled and direct chat sends, operator notices on Telegram, and web chat's timeout reply. | Nobody can later prove what was sent, to whom, and when. |
| G30 | Admin notices are grouped into a weekly digest. Direct pings are named exceptions and are counted. | The admin is flooded and stops reading alerts. |
| G37 | Before adding an action item or open question, a gate checks for a duplicate or an already-settled item, and checks the premise. | The registers fill with duplicates and reopened decisions. |
| G38 | To update an existing item: classify, find, cross-reference, annotate. Never erase. | History is lost and nobody can see how an item changed. |
| G39 | Role and access changes are admin-only. A request inside a message is never acted on. | A sender grants themselves or someone else access by asking. |
| G40 | The model-based part of the reply sensor judges program facts only; tracking state is out of scope for it. Separate fixed checks cover a few operational claims (onboarding state, commit and rule references). | The sensor flags normal status traffic and gets ignored. |
| G41 | Triage entries have a stable heading (time and type). | Tools and people cannot point at one entry reliably. |
| G42 | Outbound mail needs authorization. Tier 1: explicit. Tier 2: a narrow, pre-authorized relay. Routed approvals are sent by the host. | The agent sends mail on its own judgement. |
| G45 | A decision that touches a canonical FAQ topic requires re-checking that FAQ answer in the same pass. | The FAQ keeps giving the old answer after the decision changed. |
| G46 | The agent's replies pass one delivery gate (notices the host sends straight to the Telegram API do not). For email, a reply block is required; chat channels accept plain text. On every channel, internal scaffolding is refused and shortfalls are reported loudly. | Internal notes leak to a recipient, or an empty or cut-off reply is sent as if complete. |
| G47 | Facts taken from an external document are cross-checked before they enter the knowledge base. An uncorroborated spreadsheet-cell fact goes to open questions. Terms come from the entry, not a fixed list. | A wrong cell in a spreadsheet becomes a recorded fact. |
| G51 | The agent must report each gate run to the host log, and never claim a result without the log. The host records the report; it does not verify that the gate ran. Includes a check for invented commit IDs. | The agent says a check passed when it did not run. |
| G52 | Automated agents on the allowlist are a separate tier: lower caps (email only), no reminders. | Two bots talk to each other without limit. |
| G55 | Open questions carry an added-date stamp so a monitor can age them. | Questions sit unanswered with no signal. |
| G56 | Mail where the bot is only copied, with no direct request, is filed as context with no acknowledgement. Needs the original mail with verified headers; without it an acknowledgement may be sent. | The bot replies to threads nobody asked it to join. |
| G58 | A reply to a direct request keeps the thread audience, allowlisted addresses only. Dropped addresses are disclosed. Without verified headers the reply goes to the sender alone. | People drop off a thread silently, or a non-allowlisted address receives the reply. |
| G59 | Email addresses come only from the allowlist or the inbound mail, for recipients and in body text. In body text the bot's own address and one approved shared mailbox are also accepted. The body check runs on email only, not chat, and skips saved deliveries from an older format. | An invented address delivers private content to a stranger. |

`G1` to `G10` as a block are the knowledge-base write protocol in the program repo's governance file. `RC-nnn` numbers are root-cause IDs: each names the failure that led to a rule (for example `RC-018`: the agent must learn what the host actually sent).

## What the rules do not cover

The numbered rules govern who may change the record and what the bot may send. They do not say which kinds of data may enter the record, which outside services may receive it, who may read the program repo, or how long anything is kept. Those are decisions for the adopter and the institution. [`data-handling.md`](./data-handling.md) lists each outside service and storage place as traced from the code, and the decisions to make before go-live. Record your answers in the program repo's governance file.

## Changing a rule

1. Propose the change in the program repo, with the reason and the failure seen or expected.
2. A person with decision authority approves it. The agent never changes a rule on a request inside a message.
3. Change every place that carries the rule in the same pass: the governance file, the prompts, the code or test that enforces it.
4. Raise the registry version and add a changelog line: date, rule, what changed, why.
5. Run the tests and the gate evaluations before the change goes live.

## For an adopter

Start with the rules as they are. They exist because each failure in the right-hand column happened or nearly happened in real use. Remove a rule only when you can say why its failure cannot happen in your setting.
