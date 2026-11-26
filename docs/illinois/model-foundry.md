# Claude on Microsoft Foundry at the University of Illinois

Anthropic operates both hosting options. With “Hosted on Azure”, it processes prompts and replies on Azure and keeps retained content there. Its own systems outside Azure store operational data such as identifiers and usage, excluding prompts and replies. [Claude in Microsoft Foundry](https://platform.claude.com/docs/en/build-with-claude/claude-in-microsoft-foundry)

The provider setting, the Foundry setup steps, failover and the live checks are in [`../model-providers.md`](../model-providers.md). That page applies unchanged.

## Open questions (not verified)

| Question | Answer |
|---|---|
| Does the Privacy Office classify this deployment as a model hosted in the university’s Azure subscription or as a third-party AI service billed through Azure under Anthropic’s terms? | Not verified. Record the office’s written answer here for the chosen hosting option. |
| Is Claude on Microsoft Foundry approved for this kind of data, and with which hosting option and region scope? | Not verified. Ask the office that approves it; write down the answer and its date. |
| How does a unit get an Azure subscription, and is it an eligible type for Foundry's Claude models? | The request page and its quotes are in [`hosting.md`](./hosting.md); eligibility is not verified. What Microsoft requires of the subscription: [`../cloud-vm.md`](../cloud-vm.md), "Claude on Microsoft Foundry". |
| What does Foundry cost the unit? | Anthropic's rates converted to CCUs, from the vendor pages in [`../costs.md`](../costs.md). Whether the unit is billed back, and how: not verified; the unit's business office. |
