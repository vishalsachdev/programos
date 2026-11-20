# Security policy

ProgramOS handles a team's mail and holds credentials on its host. Reports are welcome.

## How to report

Use GitHub private vulnerability reporting for this repo: the **Security** tab, then **Report a vulnerability** (https://github.com/vishalsachdev/programos/security/advisories/new). Do not open a public issue, and do not put the details in a pull request.

Include the commit you tested, the steps, and what an attacker gains. Use placeholders for people and addresses. Never include real mail content, tokens or keys; if you found a live secret, say where it is and do not copy it.

This is a small project with one maintainer. There is no bounty and no fixed response time. You will get an answer in the advisory thread, and credit in the fix if you want it.

## In scope

The code in this repo as it is shipped:

- A way around the sender allowlist on email or Telegram.
- A reply or outbound mail that leaves the host without passing the delivery gate, on a path that `SPEC.md` says is gated.
- The agent in the container reaching files outside its mounts, the host's credentials, or the model provider without the host proxy.
- A webhook that accepts a request with a missing or wrong secret or signature (`src/channels/webhook.ts`, `src/channels/resend-events.ts`, `src/channels/github-push-events.ts`).
- A change to a protected governance file that the guard and the git-author check both miss.
- A message that makes the bot change roles or access, send mail to an address that is in neither the allowlist nor the inbound mail, or write a false entry to the audit log.
- A real secret or a real person's data in this repo or its history.
- A fault in the export tool (`scripts/upstream-sync/`) that would let private content through its scan.

## Known limits (not new reports)

`SPEC.md` section 11, "Where the guarantees stop", lists the places where a rule holds on some paths only: web chat checks a shared secret and not the person, sender caps exist on email only, some host notices skip the gate, the protected-file guard does not inspect shell commands, the reply sensor calls the model provider directly, and others. `AGENTS.md`, "Safety items you must handle", and the README's "Known issues" add the setup risks and the inherited dependency findings. These are documented behaviour. A report is useful when it shows that one of them reaches further than the text says.

## Out of scope

- An adopter's own deployment, host, mail provider or changed code. Report those to whoever runs them.
- The reference deployment. It is private and is not tested through this repo.
- The upstream framework and third-party packages. Report those to their projects; tell us too if the fault is reachable here.
- The inbound mail intake service. None is in this repo.
- Findings that need the admin's own credentials or access to the host.
