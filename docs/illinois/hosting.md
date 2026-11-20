# Hosting at the University of Illinois

**Status: stub. Nothing on this page that is specific to the university has been verified.** No university policy is stated here. Ask the people who run the service before you rely on any of it.

The recipe in [`../deployment.md`](../deployment.md), "The supported recipe: one virtual machine", applies unchanged on a virtual machine that the university approves for this kind of data. The machine must allow what that page lists under "What the host must be able to do": Docker under your control, a local git checkout, one inbound HTTPS port, and outbound access to the AI service, the mail provider, Telegram and the git host.

## Open questions (not verified)

| Question | Answer |
|---|---|
| Which university service provides such a virtual machine? | Not verified |
| How does a unit request one, and who approves it? | Not verified |
| Which inbound firewall rules apply, and how are ports 80 and 443 opened to the internet? | Not verified |
| May the machine run Docker with a user in the `docker` group? | Not verified |
| Which DNS name can point at the machine? | Not verified |

Record each answer here with its source and the date you checked it.

Related: [`../09-illinois-quickstart.md`](../09-illinois-quickstart.md) (campus mail alias; not yet updated).
