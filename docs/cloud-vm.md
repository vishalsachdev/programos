# Running the host on a cloud virtual machine

This page says what kind of cloud machine the host needs and what to ask for, with the specifics for Microsoft Azure. The setup steps on the machine are in [`deployment.md`](./deployment.md), "The supported recipe: one virtual machine"; this page does not repeat them. Prices are in [`costs.md`](./costs.md).

**Not verified.** No deployment of this repo has run on an Azure virtual machine. The Azure facts below are quoted from Microsoft's public documentation, read on 2026-11-20 and linked where used. Microsoft changes these pages often; check them again before you act.

## Why a virtual machine, and not an app-hosting service

The host starts a new Docker container for each message (`src/container-runner.ts`) and keeps a git checkout on its own disk ([`deployment.md`](./deployment.md), "What the host must be able to do"). So it needs a machine where it controls a Docker daemon. A service that runs your app inside a container it manages, without letting the app start containers of its own, does not work.

On Azure that rules out the two app-hosting services:

- **Azure Container Apps.** Microsoft's page [Containers in Azure Container Apps](https://learn.microsoft.com/en-us/azure/container-apps/containers), "Limitations": "Azure Container Apps doesn't allow privileged containers mode with host-level access."
- **Azure App Service.** No Microsoft page read for this one says whether an app can reach a Docker daemon and start containers; none documents a way to do it. Treat it as unsuitable unless Microsoft documents one. The [App Service on Linux FAQ](https://learn.microsoft.com/en-us/troubleshoot/azure/app-service/faqs-app-service-linux-new) also says, of exposing more than one port from a custom container: "This isn't supported."

The same reasoning applies at other cloud providers: choose their plain virtual machine product.

## What to ask for

Use this list when you request a machine, from a cloud provider or from your institution's cloud team.

| Item | What to ask for | Why |
|---|---|---|
| Operating system | Ubuntu LTS | The recipe in `deployment.md` is written for it. Docker's [Install Docker Engine on Ubuntu](https://docs.docker.com/engine/install/ubuntu/) lists 26.04 LTS, 24.04 LTS and 22.04 LTS among the supported versions |
| Size | A small general-purpose machine. This repo has no measured minimum. The reference deployment's machine size is not recorded here | Each message runs one container; a pilot has few messages at a time |
| Disk | Room for the code, Docker images and the knowledge-base repo, which grows with every mail filed (the code never deletes from it) | `docs/data-handling.md`, "Retention and deletion" |
| Login | SSH with a key, for the administrators only | |
| Inbound ports | 22 (administrators), 80 and 443 (the reverse proxy and its certificate) | `deployment.md`, step 1 and step 7 |
| Outbound | HTTPS to the model provider, the mail provider, the git host and Telegram; SSH to the git host if the repo uses an SSH origin | `deployment.md`, "What the host must be able to do" |
| A DNS name | A name that points at the machine's public address | The reverse proxy gets its certificate for that name |
| Who owns it | A unit or service account, not one person | [`service-ownership.md`](./service-ownership.md) |
| Data | Approval that this machine may hold the team's mail and the knowledge base | [`data-handling.md`](./data-handling.md) |

## Azure specifics

What a unit needs to know to request or create a machine in Azure. Every item is from Microsoft's documentation, read 2026-11-20.

- **A subscription.** The portal quickstart starts: "If you don't have an Azure subscription, create a free account before you begin." ([Quickstart: Create a Linux VM in the Azure portal](https://learn.microsoft.com/en-us/azure/virtual-machines/linux/quick-create-portal)). At an institution the subscription usually comes from its cloud team; ask them.
- **Region.** "Every region is contained within a single geography that serves as a fixed data residency boundary. If you have data residency requirements, it's important that you select regions within the required geography." ([What Are Azure Regions?](https://learn.microsoft.com/en-us/azure/reliability/regions-overview)). Ask the office that approves data use which geography is allowed. If you also use Claude on Microsoft Foundry, the regions that serve it are listed on [Foundry Models from partners and community](https://learn.microsoft.com/en-us/azure/foundry/foundry-models/concepts/models-from-partners).
- **Image and size.** The quickstart: "Choose Ubuntu Server 22.04 LTS - Gen2 for your Image. ... The default size and pricing is only shown as an example. Size availability and pricing are dependent on your region and subscription." Microsoft marks the B-series v1 sizes (for example `Standard_B2s`, 2 vCPUs and 4 GiB) "End of Life" and says to "use Current sizes for new deployments" ([Bv1 size series](https://learn.microsoft.com/en-us/azure/virtual-machines/sizes/general-purpose/bv1-series)).
- **Login.** "Under Administrator account, for Authentication type, select SSH public key." (quickstart)
- **Inbound ports.** The quickstart's step allows "SSH (22) and HTTP (80)"; it does not add 443, which the reverse proxy needs. Ports are controlled by a network security group: "A network security group contains security rules that allow or deny inbound network traffic to, or outbound network traffic from, several types of Azure resources." Its default rules deny other inbound traffic, and "You can't remove the default rules, but you can override them by creating rules with higher priorities." ([Network security groups overview](https://learn.microsoft.com/en-us/azure/virtual-network/network-security-groups-overview)). Add a rule for 443.
- **Outbound mail port.** The same page says that on pay-as-you-go subscriptions "Outbound port 25 communication is blocked from all resources." The bot does not use port 25: the default provider is reached over HTTPS, and the SMTP provider uses an encrypted mode on the port you set (`SMTP_PORT`).
- **A DNS name.** A public IP address can carry a DNS name label: "This selection creates a mapping for domainnamelabel.location.cloudapp.azure.com to the public IP in the Azure-managed DNS." ([Public IP addresses in Azure](https://learn.microsoft.com/en-us/azure/virtual-network/ip-services/public-ip-addresses)). The portal steps are on [Create and use a custom domain](https://learn.microsoft.com/en-us/azure/virtual-machines/custom-domain). You can use that name for the reverse proxy, or point a name on your own domain at the address.
- **Then** follow [`deployment.md`](./deployment.md) from step 1. `docker.io` from Ubuntu's archive is what step 1 installs; Docker's own page above is the alternative.

### Claude on Microsoft Foundry in the same subscription

Only if the model provider is Foundry ([`model-providers.md`](./model-providers.md)). From [Deploy and use Claude models in Microsoft Foundry](https://learn.microsoft.com/en-us/azure/foundry/foundry-models/how-to/use-foundry-models-claude):

- the subscription must be "An Azure subscription with a valid payment method"; subscriptions without an active pay-as-you-go billing method ("for example, student, free trial, or startup credit–based accounts") and Cloud Solution Provider subscriptions are not supported;
- "All Claude models (Hosted on Azure and Hosted on Anthropic infrastructure) support Global Standard deployments. The Hosted on Azure versions of some Claude models are also available for Data Zone Standard (US) deployment.";
- the base URL has the form `https://<resource name>.services.ai.azure.com/anthropic` (the host setting is `ANTHROPIC_FOUNDRY_RESOURCE` or `ANTHROPIC_FOUNDRY_BASE_URL`).

The key: "Go to your resource in the Azure portal. The Keys & Endpoint section can be found in the Resource Management section. ... You can use either KEY1 or KEY2." ([Authentication in Foundry Tools](https://learn.microsoft.com/en-us/azure/ai-services/authentication)). It goes in `ANTHROPIC_FOUNDRY_API_KEY` in `.env`, never in the container. The code supports a key only, not Microsoft Entra ID (issue 58).

## What was not checked

- the recipe on an Azure machine, any size, any region;
- whether the Docker bridge, the restricted container network (`CONTAINER_NETWORK=restricted`) and a network security group work together as `deployment.md` expects;
- the time and cost of a machine at any provider beyond the list price in `costs.md`.

One university's open questions about getting such a machine are in [`illinois/hosting.md`](./illinois/hosting.md).
