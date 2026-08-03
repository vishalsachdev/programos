# 11. Multi-Program Mesh

> **Status:** Draft — based on the MSBAi reference deployment at Gies College of Business, University of Illinois (2026). Not yet implemented. This document describes the extension to ProgramOS for institutions running multiple programs on a shared agent mesh.

---

## The Problem

A single ProgramOS deployment coordinates one program. When an institution deploys multiple programs — each with its own agent, its own KB, its own stakeholder channels — new problems emerge that the base spec does not address:

1. **KB drift** — the same institutional fact (a Dean's Office policy, a shared course catalog entry, a faculty appointment) gets processed independently by each program agent and may be recorded inconsistently.
2. **Cross-agent trust** — there is no standard way for one program agent to verify a claim made by another, or to escalate a question that crosses program boundaries.
3. **Identity collapse** — if every agent is named "K-ai" and signs commits with the same author, an auditor cannot distinguish which program agent made which decision.
4. **Repeated processing** — a faculty email copied to three program coordinators triggers three independent agent sessions that may produce three different answers.

---

## The Architecture: A Two-Level Hierarchy

```
Institution Agent (root)
│   Owns: Gies-KB (shared policies, faculty directory, course catalog)
│   Identity: one A2A Agent Card + one Nostr keypair per institution
│   Channels: Dean's Office email, provost communications
│
├── Program Agent A (e.g. MSBAi-K-ai)
│   Owns: MSBAi-KB (program-specific decisions, curriculum, cohort)
│   Reads: Gies-KB (read-only subscription)
│   Identity: own A2A Agent Card + own Nostr keypair
│
├── Program Agent B (e.g. MBA-ai)
│   Owns: MBA-KB
│   Reads: Gies-KB (read-only)
│   Identity: own A2A Agent Card + own Nostr keypair
│
└── ... (MAccy, iMBA, BADM, ExEd, etc.)
```

**The key rules:**

- Program agents own their program KB. No program agent writes to another program's KB.
- Only the institution agent (or a human with write access) writes to the shared KB.
- Program agents escalate cross-program or institution-level questions up to the institution agent via A2A.
- Every agent has a unique, persistent cryptographic identity (Nostr keypair). Every audit log entry is signed.

---

## KB Hierarchy

### Shared KB (institution-level)

Contains facts that apply across programs:

- Institutional policies (Dean's Office memos, accreditation requirements, faculty handbook)
- Faculty directory (appointments, titles, teaching assignments)
- Shared course catalog (cross-listed courses, prerequisites)
- Institutional calendar (enrollment deadlines, add/drop windows)

Mounted read-only into every program agent container at `/workspace/extra/institution-kb/`.

The institution agent is the only automated writer. Human administrators can commit directly. Program agents MUST NOT write here — any attempt to do so routes to a human review queue.

### Program KB (program-level)

The existing ProgramOS program repo (see [`docs/02-program-repo.md`](./02-program-repo.md)), unchanged. Program-specific decisions, curriculum, cohort data, action items, open questions.

### Precedence rule

When a program agent answers a question that touches both KBs:

1. If the shared KB has an authoritative entry, cite it and use it. Do not override it with program-level content.
2. If the shared KB is silent, use the program KB and note the gap in OPEN_QUESTIONS.md.
3. If the two conflict, route to the institution agent for resolution before answering.

---

## Agent Identity

Each deployed agent gets a **persistent cryptographic keypair** using the [Nostr](https://github.com/nostr-protocol/nostr) identity standard:

- `NOSTR_SECRET_KEY` — stored in the agent's `.env` on the host. Never committed, never logged.
- `npub` — the agent's public identity. Published in the program repo README and in the A2A Agent Card.

**Why Nostr over git commit authorship:**

Git commit authorship is host-configurable and not cryptographically bound to the agent runtime. Two agents on different VPSes can both commit as "K-ai" with no way to distinguish them. A Nostr keypair is generated once, stored securely, and produces a verifiable signature on every audit log entry — independent of infrastructure.

**Why Nostr alongside A2A (not instead of):**

- A2A handles agent-to-agent *communication* (routing, task lifecycle, capability discovery).
- Nostr handles agent *identity* (who signed this, is this the same agent I talked to last month).
- They are complementary. A2A Agent Cards should include the agent's `npub` as a verifiable identity anchor.

### Signing audit log entries

Every audit log entry written by an agent MUST include:

```
nostr_pubkey: <hex pubkey>
nostr_sig: <hex signature over the entry content>
```

Verifiers can confirm the signature using the agent's published `npub` without needing access to the host or git history.

Implementation: `nostr-tools` (`npm install nostr-tools`) — ~20 lines wrapping the existing `writeAuditEntry()` call. See §Implementation Notes below.

---

## Cross-Agent Communication (A2A)

Agents communicate via the [Agent-to-Agent (A2A) protocol](https://google.github.io/A2A/). Each agent exposes an Agent Card at `/.well-known/agent.json`.

### Escalation protocol

When a program agent receives a question that:
- References a shared KB fact it cannot find in its program KB
- Conflicts with a known shared KB entry
- Explicitly addresses multiple programs or the institution as a whole

It MUST:
1. Note the escalation in its own audit log (`mode: escalated`, `to: institution-agent`)
2. Forward the query to the institution agent via A2A task
3. Await a signed response
4. Record the signed response in its audit log (`mode: institution-reply`, `nostr_sig: ...`)
5. Reply to the stakeholder citing the institution agent's answer

### Cross-program deduplication

When the same message is received by multiple program agents (e.g. a faculty email CC'd to three coordinators):

Each agent detects the duplicate by checking for a matching `Message-ID` header in the shared KB's audit index (if available) or via A2A query to sibling agents before processing.

**Simple rule:** the first agent to acquire a processing lock on a given `Message-ID` handles it. Others reply "this was handled by [program-agent npub], see [audit-log citation]."

This requires a shared coordination surface — either a lightweight shared SQLite on a common host, or a shared channel in the institution KB repo (a `discussions/cross-agent/` directory that agents commit to with a simple lock file pattern).

---

## Deployment Pattern

### Minimum viable mesh (2 programs, same VPS)

```
/root/
  nanoclaw-msbai/       # MSBAi program agent
  nanoclaw-mba/         # MBA program agent
  nanoclaw-institution/ # Institution agent (lightweight, low traffic)
  repos/
    msba-online/        # MSBAi KB (mounted into nanoclaw-msbai)
    mba-online/         # MBA KB (mounted into nanoclaw-mba)
    gies-kb/            # Shared KB (mounted read-only into all agents)
```

Each agent runs on a different port (3003, 3004, 3005). Each has its own PM2 process, its own `.env`, its own Nostr keypair.

### Scaling out

As the number of programs grows, agents can move to separate VPSes or containers. The A2A protocol handles cross-host communication. The shared KB remains a single git repo — agents read it via a bare mirror on each host (same pattern as MSBAi's `msba-online-read.git`).

---

## Governance Implications

### Accreditation (AACSB)

The mesh produces a verifiable, tamper-evident record of which agent processed which communication, what it committed to the KB, and whether that decision was escalated to an institution-level authority. Nostr signatures on audit entries mean this record can be verified by an external auditor without access to git history or server logs.

### Consistency monitoring

The institution agent (or a lightweight cron job) should periodically:
- Scan all program KBs for entries that reference shared KB topics
- Flag divergences (two programs recorded different answers to the same policy question)
- Surface them to a human reviewer via the standard exceptions digest (see [`docs/05-audit-logging.md`](./05-audit-logging.md))

---

## Implementation Notes

### Generating a Nostr keypair for an agent

```typescript
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { nsecEncode, npubEncode } from 'nostr-tools/nip19'

const sk = generateSecretKey()
const pk = getPublicKey(sk)

console.log('NOSTR_SECRET_KEY=' + Buffer.from(sk).toString('hex'))
console.log('npub=' + npubEncode(pk))
// Store NOSTR_SECRET_KEY in .env, publish npub in README
```

### Signing an audit log entry

```typescript
import { finalizeEvent } from 'nostr-tools/pure'
import { hexToBytes } from 'nostr-tools/utils'

function signAuditEntry(entry: AuditEntry, secretKeyHex: string): SignedAuditEntry {
  const sk = hexToBytes(secretKeyHex)
  const event = finalizeEvent({
    kind: 1,
    created_at: Math.floor(Date.now() / 1000),
    tags: [['t', 'audit-log']],
    content: JSON.stringify(entry),
  }, sk)
  return {
    ...entry,
    nostr_pubkey: event.pubkey,
    nostr_sig: event.sig,
  }
}
```

### A2A Agent Card additions

Add to each agent's `/.well-known/agent.json`:

```json
{
  "name": "MSBAi-K-ai",
  "description": "AI program coordinator for the MSBAi online program at Gies College of Business",
  "url": "https://msbaiclaw.illinihunt.org",
  "nostr_pubkey": "<hex pubkey>",
  "npub": "<npub1...>",
  "mesh_role": "program",
  "institution_agent": "https://gies.illinois.edu/.well-known/agent.json"
}
```

---

## What This Is Not

- **Not a replacement for human governance.** The mesh routes, coordinates, and signs — it does not replace program directors, faculty governance, or the Dean's Office.
- **Not a shared agent.** Each program has its own agent with its own KB and its own identity. There is no single "Gies-ai" that speaks for all programs by default.
- **Not Buzz.** The mesh uses existing channels (email, Telegram, Teams) that stakeholders already use. It does not require adopting a new workspace platform.

---

## Open Questions

1. **Shared coordination surface** — SQLite on a common host vs. lock file pattern in the shared KB repo? The SQLite approach is faster; the git approach is more auditable.
2. **Institution agent scope** — Is the institution agent a full ProgramOS deployment (with its own channels and KB) or a lightweight routing-and-signing service only?
3. **Second adopter requirement** — This spec generalizes from a single reference deployment. Before hardening it, a second institution should validate the hierarchy and identity assumptions.
4. **Conflict resolution authority** — When the institution agent and a program agent disagree, who wins? The current spec says institution agent wins, but this has governance implications for program autonomy.

---

*First drafted: 2026-08-02. Reference deployment: MSBAi K-ai at Gies College of Business, University of Illinois.*
