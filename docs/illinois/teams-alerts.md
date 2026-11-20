# Teams alerts at one university: open questions

The route itself is described in [`../teams-alerts.md`](../teams-alerts.md). It is **not verified against a live Teams tenant**, and nothing below has been checked with the university.

None of these is answered:

- Does the university's Microsoft 365 tenant allow the Workflows app for a unit's team, and a webhook trigger that "anyone" can call (the only option ProgramOS supports)? Ask the tenant's Microsoft 365 or Power Platform administrators.
- Can the workflow be owned by a unit or service account rather than one person, and who holds that account?
- May an alert that names a mail sender and a subject be posted to a Teams channel, given who can read that channel and how long Teams keeps messages? Ask whoever owns the unit's data rules ([`data-handling.md`](./data-handling.md)).
