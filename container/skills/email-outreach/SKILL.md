---
name: email-outreach
description: Weekly action-item nudge emails — parse ACTION_ITEMS.md owner sections, match owners to EMAIL_ALLOWLIST.md, compose per-owner nudges plus Avery's master digest as a JSON batch that the host sends. Use when the prompt says "Run weekly action item review".
---

# Email Outreach — Action Item Nudges

Use this skill when the prompt says "Run weekly action item review" or when you've just processed meeting notes with new action items.

## Weekly Review Flow

1. Pull latest repo changes:

   ```bash
   cd /workspace/extra/program-repo && git pull
   ```

2. Read the action items file:

   ```bash
   cat /workspace/extra/program-repo/discussions/ACTION_ITEMS.md
   ```

3. Read `/workspace/ipc/action_item_recipients.json`. This is the
   authoritative, host-computed audience for the current run. It resolves the
   active operating-team allowlist against owners with open items, merges
   aliases and shared sections, and includes every allowlist member who owns
   open items. It excludes only automated agent principals and unassigned
   group work, and marks Avery as `digest`. Legacy `monday-reminder:` markers
   in the allowlist role column are inert.
   Compose exactly one email for every entry in `recipients` and nobody else.
   If the file is missing or malformed, return an empty `emails` array and say
   why in `summary`; the host will fail the run loudly.

4. Parse each source owner section named in each roster entry. For each owner:
   - Collect unchecked items (`- [ ]`)
   - Skip owners with zero open items or text like "No immediate action items"
   - **AUTHORITATIVE RECIPIENT OPEN COUNT — do not hand-count.** Use the roster
     entry's `openCount` verbatim. It already merges shared sections and
     explicit owner tags for that recipient. `action_item_counts.json` remains
     authoritative only for section-level counts in Avery's full digest. The
     recipient count excludes closed `- [x]`/✅ items and multi-line _Update_
     continuations. You still read the source section bodies for the _content_
     of the recipient's top-3 items.

5. Read the email allowlist for context only:

   ```bash
   cat /workspace/extra/program-repo/program/EMAIL_ALLOWLIST.md
   ```

6. The host has already built the name→email map in the roster. Use the
   following matching rules only to locate each recipient's source sections
   and top items:
   - **Normalize first**: remove parenthetical notes and dash suffixes, e.g. `Felix (T&L) — additional from team meeting` → `Felix`
   - **Exact match first**: `Felix Stone` == `Felix Stone`
   - **Known short-name match**: read short names and aliases from the program repo's roster/allowlist (`program/EMAIL_ALLOWLIST.md` and the host roster entry). Do not rely on a remembered list of people.
   - **Substring match**: use only when it unambiguously maps to one allowlist row
   - **Compound sections**: split on `/`, `&`, `+`, and `and`, except do not split role labels like `T&L` or `Teaching & Learning`. Give each matched owner only their own relevant items when the item text identifies a person. If the section is a true shared owner section and both people are allowlisted, nudge each matched person with the shared item.
   - **Role/group sections**: `Team`, `Program Administration`, `NanoClaw / Infrastructure`, `T&L`, `Teaching & Learning`, and other non-person groups do not receive owner emails; include them in Avery's digest as unassigned/group-owned items.
   - **No match**: Flag as "unmatched" for the digest. Do not invent addresses or email anyone outside the allowlist.

7. For each roster entry with `delivery: "nudge"`, COMPOSE (do not send) a nudge email:
   - `to`: their email from the allowlist
   - `subject`: `Program Action Items — Weekly Check-in`
   - `body`: Professional, friendly nudge. Include:
     - Greeting with their first name
     - Count of open items — use this roster entry's `openCount` verbatim; never use a section count or hand-tally
     - List the top 3 most important items explicitly, then summarize remaining count (e.g., "...and 2 more")
     - Instruction: "Reply to this email or send a message to program@example.org when you have updates on any of these."
     - Sign off: "— Program Program Coordinator"

8. For the roster entry with `delivery: "digest"`, compose (do not send) the digest email to Avery:
   - `subject`: `Program Weekly Digest — Action Items`
   - `body`: Include:
     - Date
     - Open items by owner (name: count, flag if >30 days old)
     - Stale items list (>30 days since file was last modified — use git log for dates if available, otherwise flag all undated items)
     - Who is being nudged this week
     - Any unmatched owners

9. **Your FINAL output must be exactly one JSON object — nothing before or
   after it** (a ```json fence is acceptable). The HOST parses this, enforces
   the allowlist, forces Reply-To to the bot address, and sends. You have no
   email-sending tool in this run; output that is not valid batch JSON means
   NO emails go out and the failure is flagged to Avery.

   ```json
   {
     "emails": [
       {
         "to": "owner@example.edu",
         "subject": "Program Action Items — Weekly Check-in",
         "body": "..."
       },
       {
         "to": "avery@example.edu",
         "subject": "Program Weekly Digest — Action Items",
         "body": "..."
       }
     ],
     "summary": "Nudged N owners (names); digest to Avery; M unmatched owners (names)."
   }
   ```

## New items during Mode 1 (processing meeting notes)

You cannot send proactive email from a Mode 1 run (no sending tool outside
the main group). When you commit new action items, name the new items and
their owners in your reply so the sender can forward if urgent — the owners
get their nudge in the next weekly batch.

## Important

- Do NOT make any commits during outreach (Mode 3). This is read-only.
- Do NOT compose nudges for owners who have only checked-off items.
- Do NOT compose an individual nudge for Avery's own items (he gets the digest).
- The host-computed `recipients` list is the only audience. Do not add or drop anyone from memory.
- Never invent addresses; only allowlist emails. The host drops anything else.
- The host compares the final batch with `action_item_recipients.json` before
  sending. A missing, extra, or duplicated recipient cancels the entire batch
  so partial outreach cannot look successful.
