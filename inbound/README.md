# Inbound mail intake

A Cloudflare Email Worker that receives mail for the bot's address and hands it to the ProgramOS host. For each message it:

1. refuses the message at SMTP if it is larger than `MAX_MESSAGE_BYTES`;
2. builds a Markdown copy of the message;
3. commits the Markdown copy and the original `.eml` to your knowledge-base repo, in one commit, as the git author in `GIT_AUTHOR_EMAIL`;
4. POSTs a JSON payload to the host webhook with `Authorization: Bearer <WEBHOOK_SECRET>`.

It was written from the contract in this repo (`docs/setup-reference.md`, "Inbound mail: the contract", and the handler in `src/channels/webhook.ts`). It is not a copy of the reference deployment's worker.

**Nothing here has run against a live Cloudflare account, domain, mailbox or GitHub repo.** The tests use a mocked network. Read "Not verified" before you rely on it.

It has its own `package.json`. The host's dependencies and tests do not include it.

## Setup

You need: a domain whose DNS you control and can host at Cloudflare, a Cloudflare account, your knowledge-base repo on GitHub, and a running host with its webhook reachable over HTTPS.

Cloudflare's dashboard labels change. Where a step names a screen, check Cloudflare's current documentation for Email Routing and Email Workers.

### 1. Choose the address and the domain

Pick the address people will write to, for example `program@bot.example.org`. Use a domain or subdomain that receives no other mail: Email Routing takes over the MX records of the zone it is enabled on.

If your team should write to an address at your institution instead, ask your mail administrators for a rule or alias that passes mail from that address to the one above. The worker reads the sender from the `From` header, so the rule must keep the original sender there: in Microsoft 365, a redirect does ("A redirected message keeps the original sender on the From line") and a forward does not ([Microsoft Support, rules in Outlook](https://support.microsoft.com/en-us/office/use-inbox-rules-in-outlook-c24f5dea-9465-4df4-ad17-a50704d66c59), read 2026-11-20). Check one message's `From:` line in the committed copy before colleagues use the address.

### 2. Turn on Email Routing (MX)

Add the domain to Cloudflare, then enable Email Routing for it. Cloudflare sets the MX records and an SPF record for the zone. Confirm with `dig MX <your domain>` that the MX records point to Cloudflare before you test.

### 3. Create the GitHub token

Create a fine-grained personal access token (or a GitHub App installation token) with:

- repository access: **only** the knowledge-base repo;
- repository permissions: **Contents: Read and write**. Nothing else.

The token can write any path in that repo, not only the inbox folder; the worker writes only under `INBOX_DIR`. The host's push check (`src/channels/github-push-events.ts`) alerts the operator if a commit by a non-admin author changes a protected file, and the intake author is not an admin author. Do not add the intake author to the host setting `ADMIN_AUTHOR_EMAILS`.

If the branch is protected, the token's owner must be allowed to push to it. The worker never force-pushes.

### 4. Fill in the settings

Edit `wrangler.toml`. Every value in it is a placeholder.

| Setting | Meaning | Default |
|---|---|---|
| `GITHUB_REPO` | The knowledge-base repo, `owner/name` | none |
| `GITHUB_BRANCH` | Branch to commit to. The host reads `main`. | `main` |
| `GITHUB_API_URL` | API root, for GitHub Enterprise Server | `https://api.github.com` |
| `INBOX_DIR` | Folder for inbound mail. The host reads originals only under `discussions/raw/`. | `discussions/raw` |
| `GIT_AUTHOR_NAME`, `GIT_AUTHOR_EMAIL` | Author and committer of each intake commit | `Email Inbox`, `email-inbox@example.org` |
| `HOST_WEBHOOK_URL` | The host webhook, `https://` only | none |
| `MAX_MESSAGE_BYTES` | Largest message accepted | `10485760` (10 MiB) |
| `MAX_ATTEMPTS` | Attempts before a message is set aside | `12` |

Create the retry buffer and put its id in `wrangler.toml`:

```
npx wrangler kv namespace create PENDING
```

Set the two secrets. `WEBHOOK_SECRET` is the same value as `WEBHOOK_SECRET` in the host's `.env`.

```
npx wrangler secret put GITHUB_TOKEN
npx wrangler secret put WEBHOOK_SECRET
```

**The git author.** When the host reads a committed `.eml`, it accepts the file only if the commit that first added it has the author email in the host setting `INTAKE_GIT_AUTHOR_EMAIL` (`.env`; the default is `email-inbox@example.org`). `src/repo-reader.ts` and the bot-author list in `src/channels/github-push-events.ts` both read that setting. Keep the worker's default, or set the host setting and the worker's `GIT_AUTHOR_EMAIL` to the same address. With a different author on one side only, plain questions still work, but routed approvals are held: the host has no copy of the sender's words. `src/channels/webhook-inbound-intake.test.ts` shows both cases.

### 5. Deploy and route

```
npm ci
npm test
npx wrangler deploy
```

Then, in Email Routing, add a rule for your address with the action that sends mail to a Worker, and choose `programos-inbound`.

### 6. Send a test message

1. From an address on the allowlist, send a plain question. Watch `npx wrangler tail`: the worker logs `inbound: delivered`. The knowledge-base repo gets one commit with two files. The host answers.
2. Send one routed-approval exchange: a message from a read-only sender whose allowlist row names an approver. The approver should receive the relay with the sender's exact words. `AGENTS.md` asks for this test, and it is the one that depends on the git author.
3. Send a message from an address that is not on the allowlist. The files are committed (the worker does not know the allowlist) and the host does not answer.
4. Stop the host, send a message, and check that a `pending:` key appears (`npx wrangler kv key list --binding PENDING`). Start the host and check that the message is delivered within the retry delay.

## What the worker writes

For a message received on 2026-11-19 with the subject "Budget 2027", two files:

```
discussions/raw/2026-11-19-budget-2027-<8 hex>.md     the Markdown copy
discussions/raw/2026-11-19-budget-2027-<8 hex>.eml    the original, byte for byte
```

The date is the day of receipt (UTC). The eight hex characters are the start of the SHA-256 of the raw message, so two different messages never share a name and a retry of the same message always builds the same name.

### The Markdown copy

No fixture in the host pinned a format, so this worker defines one. `fixtures/*.expected.md` are full examples.

```
From: "Name" <address>
To: ...
Cc: ...                      (when present)
Date: ...
Subject: ...
Message-ID: ...              (these and the lines below: copied when present)
In-Reply-To: ...
References: ...
Auto-Submitted: ...
Precedence: ...
List-Id: ...
List-Unsubscribe: ...
X-Autoreply: ...
X-Autorespond: ...
X-Mailer: ...
X-Intake-Authentication: ...   (always; written by the worker, see "Sender authentication")

# <subject>

<the text body>

## Attachments               (when the message has any)

1. `name` (type, size in bytes)

---

Original message: `<path of the .eml>`
```

The first block is a set of mail header lines, ended by a blank line. That is deliberate. The host runs its auto-reply and mailing-list guard (`src/email-loop-detection.ts`) on the file named in `raw_file_path`, which is this Markdown copy. The guard parses the file as mail and reads its headers, so the headers it checks must be in the copy, or an out-of-office reply from an allowlisted sender would be answered. Each value is written on one line with control characters removed, so text from a sender cannot add a header line.

### The payload

```json
{
  "filename": "2026-11-19-budget-2027-1a2b3c4d.md",
  "subject": "Budget 2027",
  "from": "sender@example.edu",
  "to": "program@example.org",
  "cc": "",
  "date": "2026-11-19T15:12:00.000Z",
  "message_id": "<id@example.edu>",
  "raw_file_path": "discussions/raw/2026-11-19-budget-2027-1a2b3c4d.md",
  "eml_file_path": "discussions/raw/2026-11-19-budget-2027-1a2b3c4d.eml",
  "attachment_count": 0,
  "attachment_state": "ready"
}
```

- `from` is the address in the `From` header, in lower case. The envelope sender is used only when there is no `From` header.
- `raw_file_path` is the Markdown copy. The agent is told to read this file, and a routed-approval record cites it.
- `eml_file_path` is the original. The host takes the real subject, Message-ID, To and Cc from it, and the sender's words for routed approvals.
- The body is not in the payload. The worker does not send `raw_email` or `inbound_text`: the committed `.eml` is the one copy of the original, and the host reads it at the commit that added it.
- `phase` is not sent. It belongs to a two-step flow for messages with many attachments, which this worker does not need.

`fixtures/` is shared with the host suite. The worker's tests prove it builds `*.expected.md` and `*.expected.json` from `*.eml`; `src/channels/webhook-inbound-intake.test.ts` feeds those files to the real webhook handler. After an intended format change, run `UPDATE_FIXTURES=1 npm test` here and then the host test.

## Decisions

### Attachments: kept inside the `.eml`, state `ready`

The worker does not store attachments as separate files. They stay inside the committed `.eml`, and the Markdown copy lists each one. `attachment_count` counts the parts that are real attachments; inline parts, such as a logo in a signature, are listed and not counted. `attachment_state` is always `ready`, because the list is complete when it is written: the same commit adds the `.eml` that holds every file. Of the three states the host knows (`ready`, `partial`, `pending`), this is the only one that needs no second step.

Two consequences:

- **The host does not extract text from PDF, Word or Excel attachments of mail filed by this worker.** That extraction runs on the file in `raw_file_path` and looks for MIME attachments there. The Markdown copy has none. The agent sees the list and can find the files only inside the `.eml`.
- With more than 10 counted attachments the host records a receipt, tells the operator, and tells the agent to use the list. `ready` lets that proceed at once.

### The commit fails: park in the buffer, refuse only as a last resort

If the commit fails for any reason (GitHub down, a bad token, a missing setting), the raw message is written to the KV buffer and retried by the cron run. The worker does not refuse the message at that point.

Reason: refusing would hand the problem to the sending server, and this worker cannot verify whether Cloudflare turns `setReject` into a temporary or a permanent SMTP error. A permanent error is a bounce, not a retry. A buffer the worker controls has a behavior that can be tested here. If the buffer write fails too, the worker does refuse the message, so that the sender's server reports the failure. A message is committed, parked, or refused; it is never dropped without a trace.

### The commit succeeds and the POST fails: retry from the buffer

Only the payload is kept; the message is already in the repo. The cron run (every 5 minutes) retries with delays of 5, 10, 20, 40 minutes and so on, up to 6 hours between attempts. With the default of 12 attempts that is about 35 hours.

- A 2xx answer ends it. That includes the host's "duplicate" and "sender not on allowlist" answers.
- Any other answer or no answer is retried, including 401: a wrong secret is fixed by a person, and the message should still be there.
- 400, 413 and 422 are not retried. The host refused the payload itself, and the same bytes would fail again.

**How a repeated POST is made safe.** The host keeps the Message-ID of each message it handled (the last 500, in memory) and answers a repeat with 200 `duplicate`. While a message is being processed it answers 503, and the worker retries later. The worker always sends the same bytes with the same `message_id`. The host's memory is lost when the host restarts, so the worker does not lean on it more than it must: it repeats a POST only when it did not see a 2xx answer. A message whose answer was lost and whose retry arrives after a host restart can be processed twice.

If the POST fails and the buffer cannot be written, the worker refuses the message at SMTP although it is already committed. A sender who sends it again produces a second pair of files; the host recognises the Message-ID and skips it.

### After the last attempt

The record moves from `pending:<id>` to `failed:<id>` in the buffer, and the worker logs an error. For a failed commit the raw message stays at `raw:<id>`. Nothing deletes these keys. To retry one by hand, copy the value of `failed:<id>` to `pending:<id>` with `"attempts": 1` and `"nextAttemptAt": 0`.

**The worker does not alert the operator.** It has no channel of its own; the host's alerts go through Telegram from the host. Check the worker's logs and the `failed:` keys, or add an alert that suits your setup.

### One commit, through the git data API

Both files go in one commit, so the repo never holds a Markdown copy without its original. If the branch moved between reading it and updating it (the agent pushed), the commit is rebuilt on the new tip, up to four times, and never forced. Before committing, the worker checks whether the `.eml` is already on the branch; if it is, an earlier attempt landed and nothing is written.

### Size limit: refuse, do not truncate

A message over `MAX_MESSAGE_BYTES` is refused at SMTP with a reason that states the limit. The worker never truncates: a cut `.eml` loses attachments and can lose the words a routed approval is checked against. The default of 10 MiB is below the host's 16 MiB limit for reading an original and below the 25 MiB limit of a KV value.

## Sender authentication

The worker checks no signature itself. It reads what named mail servers wrote in `Authentication-Results` headers and passes it to the host, which makes the verdict (`docs/setup-reference.md`, "Sender authentication for inbound mail", has the whole rule and its limits).

| Setting (`wrangler.toml`) | Default | Meaning |
|---|---|---|
| `PLATFORM_AUTHSERV_ID` | empty | The server name the mail platform writes first in its `Authentication-Results` header. Cloudflare documents `mx.cloudflare.net` ([email handler](https://developers.cloudflare.com/email-service/api/route-emails/email-handler/)). Only the first such header of the message is read, and only when it carries this name, no second header carries it, and `message.headers` reports the same header first |
| `FORWARDER_AUTHSERV_IDS` | empty | For a mailbox elsewhere that forwards to this address: the server name(s) that mail system writes. Comma-separated |
| `FORWARDER_DOMAINS` | empty | The domain(s) that system's servers send forwarded mail as (the envelope sender after forwarding). Set together with the line above |

With all three empty nothing is read: the payload carries `"results": []`, the Markdown copy says `X-Intake-Authentication: no trusted result`, and the host's verdict is `unknown`. A forwarder's header is read only when the platform's own result shows the message came through the forwarder (SPF pass for an envelope sender in `FORWARDER_DOMAINS`). A header is dropped whole when it holds two DMARC results or two SPF results, a comment that is still open at its end, or the same property twice in one result; a dropped forwarder header keeps its place, so no header below it is read in its stead. A wrong value (not a host name, a forwarder without a platform, one of the two forwarder settings alone) is a settings error: the message waits in the buffer until it is fixed.

To find the names, send yourself a message through the real path, open the committed `.eml`, and read the `Authentication-Results` headers from the top: the text before the first `;` is the server name. Put the same names in the host's `EMAIL_AUTH_TRUSTED_AUTHSERV_IDS`.

The payload field, for a message the platform checked:

```json
"auth": {
  "version": 1,
  "envelope_from_domain": "mail.example.edu",
  "from_headers": 1,
  "from_mailboxes": 1,
  "results": [
    { "source": "platform", "authserv_id": "mx.platform.example", "spf": "pass", "spf_domain": "mail.example.edu",
      "dkim": [{ "result": "pass", "domain": "example.edu" }], "dmarc": "pass", "dmarc_from": "example.edu", "arc": "" }
  ]
}
```

`from_mailboxes` counts the different addresses in the From header, display name included (a character outside ASCII in an address counts as one more). A display name that holds another address than the mailbox makes it 2, and the host then never calls the message authenticated; the same address written twice counts once. It is 1 only for a header every reader takes as the same single mailbox, and only when that mailbox is the `from` of the payload. It is 2 when `from` is the envelope sender (the parser read no address from the From header) or another address than the one counted, and for any form two readers can take differently: a comma, colon, semicolon or backslash outside a quoted display name, more than one address in angle brackets, a space or a comment next to `@`, a comment inside the brackets or beside an address without brackets, an unclosed quote or comment, a control character. So `Lee, Dana <dlee@example.edu>` (comma, no quotes) and `dlee@example.edu (Dana Lee)` count 2; `"Lee, Dana" <dlee@example.edu>` counts 1.

## Limits

- **Sender authentication is read, not done.** The worker trusts what the named servers wrote and checks no SPF record, DKIM signature or ARC chain itself. With no server named (the default) the host records `unknown` for every message and a forged `From` of an allowlisted person is filed and answered, as before. With servers named, the host still answers such mail unless it runs with `EMAIL_AUTH_MODE=enforce`.
- **Mail from senders who are not on the allowlist is still committed.** The worker does not read the allowlist. Anyone who knows the address can add files to `discussions/raw/`, up to the size limit each.
- **One cron run handles at most five waiting messages**, oldest first, to stay inside a Worker's request limits. A long outage drains at that rate.
- **Text extraction of attachments does not happen** (see "Attachments").
- **The buffer is Workers KV**, which is eventually consistent. A record written by one run can be invisible to a run that starts within the next minute.

## Not verified

No live Cloudflare account, domain, mailbox or GitHub repo was available. None of this has run end to end:

- that `message.raw` holds the `Authentication-Results` header the platform prepends (its documentation names `message.headers`), that this header is always the first one, what the platform does with a header in the incoming message that already carries its name, and which properties (`header.d`, `header.from`) it writes. The worker compares the first raw header with what `message.headers` reports first and reads nothing when they differ, so a platform that keeps its header out of `message.raw` gives `unknown`. A platform whose `message.headers` reports a sender-written header first would have that header believed; this was not ruled out on a live domain;
- any forwarding mail system: its server name, whether it removes a planted header carrying that name, and whether it rewrites the envelope sender;
- that Email Routing delivers to this worker, and what `message.from`, `message.to`, `message.raw` and `message.rawSize` hold for real mail;
- what `setReject` does at SMTP (temporary or permanent error), and what the sender sees;
- that the worker stays inside CPU, memory and request limits for a message near 10 MiB, on any plan;
- a deployment. `npx wrangler deploy --dry-run` (wrangler 4.165.0) bundles the worker and reads `wrangler.toml` with its placeholders; whether Cloudflare accepts the KV and cron settings on a real deploy was not tried;
- the GitHub calls against the real API, including the token permission named above and a protected branch;
- the POST against a real host through a reverse proxy;
- a routed-approval exchange with real mail. The host test proves it with files committed the way this worker commits them, on a local git mirror.

What the tests do cover, with a mocked network: MIME parsing (multipart, attachment, inline part, non-ASCII subject and names, quoted-printable), which `Authentication-Results` headers are read and which are ignored, the exact Markdown and payload, the commit author, the Bearer header, the size limit, both failure paths, the backoff, and the host's acceptance of the result.

## Tests

```
npm ci
npm run typecheck
npm test
```

The host-side tests are in `src/channels/webhook-inbound-intake.test.ts` and run with the host suite from the repo root.
