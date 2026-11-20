# Hosting at the University of Illinois

**Status: open items. The university-specific statements below are quoted from public university pages read on 2026-11-20, with the link; everything else is not verified.** No university policy is stated here. Ask the people who run the service before you rely on any of it.

The machine the host needs, why an app-hosting service does not work, and what to ask for on Azure are in [`../cloud-vm.md`](../cloud-vm.md). The setup on the machine is [`../deployment.md`](../deployment.md), "The supported recipe: one virtual machine", unchanged. Costs: [`../costs.md`](../costs.md).

## What the university's public pages say

- [Azure, How to Request a Subscription](https://answers.uillinois.edu/91014) (updated 2022-10-31, an older page): "The following form is used to request an Azure subscription:" (the form is linked on that page). "An Azure Support Team member will then follow-up with you." "A CFOP account number is required for rebilling of the Azure resource usage." The page does not say who approves a request.
- [Microsoft Azure Dev/Test Subscription](https://answers.uillinois.edu/158338) (updated 2026-02-17): "The new Subscription must be created as part of University's Microsoft Azure Enterprise Agreement" and "A University CFOP must be provided for billing of any Azure services." A Dev/Test subscription is for development and testing, not for a service colleagues rely on; check with the Azure support team which kind fits a pilot.

## Open questions (not verified)

| Question | Answer |
|---|---|
| Which subscription should a unit use for this: a new one through the request form, an existing unit subscription, or another? | Not verified. Ask the university's Azure support team |
| Who approves the request, and does the approval cover holding staff mail on the machine? | Not verified. The request page names no approver. See [`data-handling.md`](./data-handling.md), item 8 |
| Is a subscription from the university's agreement an eligible type for Claude on Microsoft Foundry ([`../cloud-vm.md`](../cloud-vm.md), "Claude on Microsoft Foundry")? | Not verified. Same team |
| Which regions may the unit use for this data? | Not verified. The office that approves data use |
| Which inbound firewall rules apply, and may ports 80 and 443 be open to the internet? | Not verified |
| May the machine run Docker with a user in the `docker` group? | Not verified |
| Which DNS name can point at the machine: an `illinois.edu` name, the Azure DNS label, or the unit's own domain? | Not verified |
| Who in the unit owns the subscription and the machine, and who pays (the CFOP)? | Not verified. The unit's business office; [`service-ownership.md`](./service-ownership.md) |

Record each answer here with its source and the date you checked it.

Related: [`email-quickstart.md`](./email-quickstart.md) (the mail flow), [`model-foundry.md`](./model-foundry.md).
