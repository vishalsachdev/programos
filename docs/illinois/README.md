# The Illinois track

For a unit at the University of Illinois that sets up ProgramOS. It uses the same code, the same three ways to start and the same choices as everyone else (`AGENTS.md`, parts 4 and 5). What this folder adds is the university-specific part of each choice: what the university's public pages say, quoted and dated, and the questions only the university can answer.

**Nothing in this folder is a statement of university policy.** Each page marks what was read on a public university page (with the link and the date) and what is not verified. An answer counts once a named office has given it in writing; record it on the page and in `setup-decisions.md`.

## Read in this order

| # | Page | The choice it belongs to (`AGENTS.md`, part 5) |
|---|---|---|
| 1 | [`model-foundry.md`](./model-foundry.md): Claude on Microsoft Foundry in a university Azure subscription | Choice 1, model provider; policy question 1 |
| 2 | [`email-quickstart.md`](./email-quickstart.md): a unit `@illinois.edu` mailbox that redirects to the ProgramOS agent's own domain, the intake worker, and the reply | Choices 5 and 6; policy question 3 |
| 3 | [`institutional-address.md`](./institutional-address.md): what replying as an `@illinois.edu` address needs | Choice 6, option (b) |
| 4 | [`hosting.md`](./hosting.md): getting a virtual machine in the university's Azure | Choice 8 |
| 5 | [`data-handling.md`](./data-handling.md): the data questions for the privacy, security and records offices | Choice 14; policy questions 1, 4 and 5 |
| 6 | [`service-ownership.md`](./service-ownership.md): unit accounts, secrets and handover | Choice 9, "Accounts and secrets" |
| 7 | [`github-enterprise.md`](./github-enterprise.md): the knowledge-base repo on the university's GitHub Enterprise host | Choice 7 |
| 8 | [`teams-alerts.md`](./teams-alerts.md): whether the university's tenant allows a Workflows webhook for operator alerts (route not verified against a live tenant) | Choice 4 |
| 9 | [`microsoft-path.md`](./microsoft-path.md): the open questions for a Microsoft-first setup (Foundry, Graph mail, Teams) | A later step, after a pilot |

For "Try it" (one person, a laptop, test data only) only page 1 matters, and only if the person must use a university-approved model even for a trial.

## Shared pages, the same on both tracks

- [`../start-here.md`](../start-here.md): for the person, in plain words.
- [`../../AGENTS.md`](../../AGENTS.md): the guided setup the coding agent follows.
- [`../../SPEC.md`](../../SPEC.md) and [`../../ARCHITECTURE.md`](../../ARCHITECTURE.md): the contract and how the parts fit.
- [`../12-governance.md`](../12-governance.md): the numbered rules.
- [`../../templates/program-repo/`](../../templates/program-repo/): the knowledge-base skeleton.
- [`../deployment.md`](../deployment.md) and [`../cloud-vm.md`](../cloud-vm.md): the host and the machine.
- [`../setup-reference.md`](../setup-reference.md): every setting.
- [`../../inbound/README.md`](../../inbound/README.md): the intake worker.
- [`../model-providers.md`](../model-providers.md), [`../teams-alerts.md`](../teams-alerts.md), [`../data-handling.md`](../data-handling.md), [`../service-ownership.md`](../service-ownership.md), [`../costs.md`](../costs.md).
- [`../design/microsoft-path.md`](../design/microsoft-path.md): the Microsoft-first design note.

The general track is [`../general/README.md`](../general/README.md).
