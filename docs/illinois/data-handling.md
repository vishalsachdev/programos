# Data handling: University of Illinois open items

This page is for a team at the University of Illinois that runs ProgramOS. It adds nothing to the facts in [`../data-handling.md`](../data-handling.md); read that page first. It lists the questions a team here must get answered by the university.

**Nothing on this page is verified.** It does not say what university policy requires. No policy was read to write it, so it cites none. It is not legal advice on FERPA or on anything else. Each item is open until a named person at the university answers it in writing; record the answer, the person and the date here or in the program repo's governance file.

## Open items

| # | Question | Status | Who to ask |
|---|---|---|---|
| 1 | Which university data classification applies to staff mail that mentions students (a name with a course, a grade, an accommodation, a conduct or advising matter)? Does the same class apply to the audit log and the raw mail copies that hold that mail? | Not verified | The university's privacy office, and the registrar for student-record questions |
| 2 | Has the model provider gone through the university's vendor review for that class of data, on the agent path (the endpoint set in `ANTHROPIC_BASE_URL`)? | Not verified | The university's IT security or vendor-review office |
| 3 | Has the reply sensor's destination been reviewed? It calls its provider directly from the host, not through the proxy; where it sends is in [`../model-providers.md`](../model-providers.md), "The reply sensor". By default it reads chat replies only. Has reading email replies too (`SENSOR_EMAIL_REPLIES=1`) been reviewed? | Not verified | Same |
| 4 | Has the outbound mail provider gone through vendor review? | Not verified | Same |
| 5 | Has the inbound mail intake service, and the provider it runs at, gone through vendor review? If campus mail is used instead, what does that path store? | Not verified | Same, and the campus mail administrators |
| 6 | Has Telegram gone through vendor review for operator alerts that carry addresses and subject lines? | Not verified | Same |
| 7 | Has the git host of the knowledge-base repo gone through vendor review for that class of data? Is the repo in an organization the university controls? | Not verified | Same |
| 8 | Is the machine that runs the ProgramOS agent an approved place for that class of data? | Not verified | Same, and the unit's IT staff |
| 9 | Who signs off: which role approves this use of data for the unit, and does the sign-off name the vendors and the data class? | Not verified | The unit head, who can say which university office must also sign |
| 10 | Which records-retention schedule applies to the audit log and the mail copies, and who performs a removal from git history when one is required? | Not verified | The university's records office |
| 11 | What must senders be told before they write to the agent? | Not verified | The privacy office |

The office names above are roles, not confirmed office titles. Find the current office for each role and write its name in the table when you have it.

The code can send the agent's and the sensor's calls to Claude on Microsoft Foundry in the unit's own Azure subscription (`MODEL_PROVIDERS`, [`../model-providers.md`](../model-providers.md)); its questions are in [`model-foundry.md`](./model-foundry.md). If the university's agreement covers that endpoint, items 2 and 3 change; they still need an answer in writing.

## Until the items are answered

Use the conservative default in [`../data-handling.md`](../data-handling.md), "Decide before go-live": staff senders only, no student records, the reply sensor off. Tell the pilot team in writing that mail naming a student does not go to the ProgramOS agent. That default is a way to limit exposure while the questions are open. It is not a statement that the pilot meets university policy or FERPA; only the offices above can say that.
