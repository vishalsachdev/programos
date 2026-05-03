# 06 — Customization

What to change for your program.

## Branding

| Placeholder | Where it appears | Replace with |
|-------------|------------------|--------------|
| `<PROGRAM>` | JID prefixes, channel names, log paths | Short slug for your program (e.g., `myprog`) |
| `<AGENT_NAME>` | Agent persona in prompts and replies | Short, friendly bot name |
| `<ORG>` | Reply signatures, copyright | Your institution name (or omit if you'd rather not surface it) |

The agent persona name appears in:

- Every `groups/<channel>/CLAUDE.md` system prompt.
- Outbound email signatures.
- Telegram bot's display name (set in BotFather).
- Teams bot's display name (set in app manifest).
- Web chat widget's branding.

A consistent persona name across channels matters more than what the name actually is.

## What to keep generic

The following should stay institution-agnostic in your code, even if your deployment is single-program:

- The two-mode operating model (question / status-update).
- The audit-log file format.
- The program-repo directory layout.

Reason: when a colleague at another institution asks how you built this, you should be able to point them at the same spec without scrubbing.

## What to make specific

- Per-channel agent prompts. Reference your actual courses, your actual policy doc names, your actual decision-makers' titles.
- The `EMAIL_ALLOWLIST.md` content (not the filename).
- The reply signature, including your institution if you want.

## Privacy posture

Decide before launch:

- Is your **program repo** public or private? Almost always private — it contains stakeholder names, internal strategy, accreditation drafts.
- Is your **bot repo** (the NanoClaw fork) public? Up to you. If you want it public, run [`scripts/scrub.sh`](#scrub-script) below to verify there are no allowlist names, real email domains, or internal URLs in it.
- Is your **audit log** public? Almost never. It contains every inbound message verbatim.

## Scrub script (recommended)

If you ever want to make your bot fork public, add a pre-publish check that verifies the codebase has none of:

- Real email addresses from your allowlist.
- Real names from your faculty/staff.
- Internal subdomain names.
- Production secrets (even rotated ones).

A simple grep-based script suffices:

```bash
#!/usr/bin/env bash
set -e
git grep -i -E "(realnameone|realnametwo|internal\.example|secret_pattern)" -- ':!docs/' && {
  echo "Found internal references — do not publish"; exit 1;
}
echo "Clean."
```

## Branding the agent

The agent persona is a small but important UX choice:

- Short (1–2 syllables) reads better in a Telegram message header.
- Human-shaped names ("Claire", "Theo") set wrong expectations — users will ask the bot personal questions.
- Pure-functional names ("ProgramBot") feel sterile and discourage adoption.
- Two-letter or short-portmanteau names ("K-ai", "ELA", "Lex") tend to land best — short enough for chat, abstract enough not to overpromise.

## What you do NOT customize

- NanoClaw's container runner, queue, or registry. Touching these breaks future upstream rebases. Anything you'd want to change in those layers belongs in your channel handler or your agent prompt.
