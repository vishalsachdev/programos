# Service ownership at the University of Illinois

**Status: stub. Nothing on this page that is specific to the university has been verified, and no university policy is stated.**

The page that lists every credential, its owner role, where it is stored, how to rotate it and the handover checklist is [`../service-ownership.md`](../service-ownership.md). It applies unchanged. This page holds only the questions a unit must get answered by the people who run each central service. Record each answer with its source and the date you asked.

## Open questions (not verified)

| Question | Answer |
|---|---|
| Can a unit hold a service account, or a shared mailbox with its own sign-in, to own accounts at outside services (model provider, mail provider, Cloudflare, git host)? Who creates it, and who approves? | Not verified |
| Which central service may hold a unit's secrets (an API key, a deploy key, a webhook secret)? Is there an approved secret store, or may they live in the `.env` file on the unit's machine? | Not verified |
| Who owns an Azure subscription for a unit, and can a Foundry resource and its key belong to the unit rather than to one person ([`../model-providers.md`](../model-providers.md))? Who approves the spend? | Not verified |
| Can a Claude subscription or an API workspace be held by a unit account at the university, and who pays for it? | Not verified |
| Which Shared GitHub Service organisation on github.com should hold the unit's private knowledge-base repo ([`github-enterprise.md`](./github-enterprise.md))? Can a machine user or an app token be created there, and who approves it? | Not verified |
| Who holds the DNS zone and registrar account for a domain the unit uses for the bot's address, and can the unit have two administrators on it? | Not verified |
| What does the university require when someone leaves: an access review, a list of accounts to close, a time limit? Does that process know about accounts at outside services? | Not verified |
| Is Telegram approved for operator alerts, and may a unit's bot be owned by a unit account? | Not verified |

Related: [`hosting.md`](./hosting.md) (who provides the machine and who owns it), [`data-handling.md`](./data-handling.md).
