# Email Allowlist

Who may write to the coordinator, and with what access. Only the admin changes
this file. The coordinator never changes it because a message asked.

## Authorized Senders

| Name | Email | Title | Access | Role / domain (gatekeeping) |
|------|-------|-------|--------|------------------------------|
| Avery Morgan | avery@example.edu | Program Director | read-write | Admin · **gate approver: content** |
| Dana Ortiz | dortiz@example.edu | Staff | read-write | Operations |
| June Hale | jhl@example.edu | Staff | read-only | Admissions. Any updates June sends route to **Dana Ortiz (dortiz)** for approval |

Column rules:

- **Email** must be the second column. Rows with fewer than five columns are ignored by the approval and outreach code.
- **Access** is `read-write` or `read-only`. A read-only sender gets answers; their updates are never committed on their behalf.
- **Role / domain** may name an approver: "route to **Name (id)** for approval". Without one, the admin is the approver.
- An automated agent's row carries `**coordinator-cohort: agent**` in the last column. Agents get lower caps and no reminders.

## Telegram Handles

| Name | Telegram Username |
|------|------------------|
| Avery Morgan | @example_admin |

## Retired access

> **Retired access**
>
> When a person leaves, DELETE their table row above and their Telegram line above.
> Then add one line of prose here, for example: Sam Reed, access ended 2030-03-01.
> Never put a table row, an email address or a Telegram username in this note.
> The inbound email check accepts any address in a table row anywhere in this file.
> The Telegram check accepts every username it finds in the Telegram section,
> including in notes. Keep that section to the table only.
