# The Microsoft-first path at the University of Illinois

The university decisions below are open. The vendor sources explain what the services do.

The path, its steps and the Microsoft documentation are in [`../design/microsoft-path.md`](../design/microsoft-path.md). That page applies unchanged. This one lists what a unit here must find out first. Record each answer with the office that gave it and the date.

## Open questions (not verified)

| # | Question | Status | Who could answer (role) |
|---|---|---|---|
| 1 | Does the Privacy Office classify Claude in Foundry as hosted in the university subscription or as a third-party service billed through Azure under Anthropic’s terms? See [where Anthropic processes and stores data](./model-foundry.md). Is it approved for staff mail that may mention students? With which hosting option ("Hosted on Azure" or "Hosted on Anthropic") and region scope? | Not verified | The university's IT security or vendor-review office, and the privacy office |
| 2 | Can a unit get an Azure subscription of a type that Foundry's Claude models accept (a paid subscription with pay-as-you-go billing, not a Cloud Solution Provider or credit-only subscription)? How is it billed to the unit? | Not verified | The university's Azure or cloud services team; the unit's business office |
| 3 | May a unit run a Linux virtual machine with Docker in that subscription? | Not verified | The same team, and the unit's IT lead |
| 4 | Will the tenant administrators scope the application to one shared mailbox, with `Application Mail.Read` for reading and `Application Mail.Send` for sending? What review is required? | Not verified | The university's Microsoft 365 tenant administrators (identity and Exchange) |
| 5 | Can a unit get a shared mailbox with an illinois.edu address for the bot? Who owns it? | Not verified | The campus mail administrators |
| 6 | Are the Teams Workflows app and its webhook trigger allowed, and can a workflow be owned by a service account instead of a person? | Not verified | The Microsoft 365 tenant administrators |
| 7 | Are Copilot Studio, custom connectors and external (Anthropic) models enabled in the tenant? Only needed if the unit wants the rejected Copilot Studio options. | Not verified | The tenant administrators and Power Platform administrators |
| 8 | Is the knowledge-base repo allowed in the unit's private Shared GitHub Service repository on github.com for this data? | Not verified | See [`github-enterprise.md`](./github-enterprise.md) |
| 9 | Which role signs off for the unit, and does the sign-off name each vendor and the data class? | Not verified | The unit head, who can say which university office must also sign |

For item 4, `Application Mail.ReadWrite` permits changes to mail and excludes sending. `Application Mail Full Access` combines read/write and send permissions. Exchange grants add to Entra grants. An unscoped Entra mail grant can therefore give the application access beyond the shared mailbox. Ask the administrators to confirm there is no such grant. [Microsoft's Exchange Online application roles](https://learn.microsoft.com/en-us/exchange/permissions-exo/application-rbac)

The offices above are roles, not confirmed office titles. Items 1, 2 and 9 overlap with [`data-handling.md`](./data-handling.md) and [`model-foundry.md`](./model-foundry.md); answer them once and link the answer from each page.

## Until the items are answered

Do step 0 of the recommendation (build and test against fake servers); it needs no approval. Do not point the bot at a real tenant, mailbox or Foundry resource until items 1, 4 and 9 have written answers.
