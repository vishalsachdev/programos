# Illinois: sender authentication for forwarded campus mail

> **Not verified.** Nobody has looked at a real message forwarded from a
> University of Illinois mailbox for this page. Which server name (authserv-id)
> the university's mail system writes in `Authentication-Results`, whether it
> writes one at all, whether it removes such a header from mail it receives,
> whether it rewrites the envelope sender when it forwards, and which ARC
> sealer domain it uses are all unknown here. This page states no university
> policy and names no value to copy.

The generic rule is in [`../setup-reference.md`](../setup-reference.md),
"Sender authentication for inbound mail". This page is only about the case
issue 20 describes: a campus mailbox forwards to the bot's own domain.

## Why it matters

Forwarding makes SPF fail for the original sender at the bot's domain and can
break the sender's DKIM signature. So the mail platform at the bot's domain can
report "not authenticated" for real mail from a colleague. The check the campus
mail system made when it first received the message is the useful one, and the
intake worker reads it only when it is told that system's names
(`FORWARDER_AUTHSERV_IDS`, `FORWARDER_DOMAINS`).

## How to read the values off a real message

Do this with someone from the unit's IT staff, on the real forwarding path,
before any setting is changed.

1. From a campus mailbox, send a message to the address that forwards to the bot.
2. Open the committed original (`discussions/raw/<name>.eml` in the program
   repo) and read the header lines from the top.
3. The first `Authentication-Results:` line is the bot domain's mail platform.
   The text before its first `;` is the value for `PLATFORM_AUTHSERV_ID`.
4. Lower down, find the `Authentication-Results:` line the campus system
   added when it received the message. The text before its first `;` is a
   candidate for `FORWARDER_AUTHSERV_IDS`. **If that line starts with a result
   such as `spf=pass` and has no server name in front, it cannot be named and
   this code will not read it.** Then the forwarder settings cannot be used;
   record that on issue 20.
5. In the first line (step 3), look at SPF: a pass for an envelope sender in
   a campus domain (the forwarder rewrote the sender). That domain is the
   candidate for `FORWARDER_DOMAINS`. If SPF did not pass for a campus domain,
   the worker cannot tell forwarded mail from mail sent straight to the bot,
   and it will ignore the campus line.
6. Ask the mail administrators the two questions the rule depends on: does the
   system remove an `Authentication-Results` header carrying its own name from
   mail it receives, and can anyone outside the university send mail that
   passes SPF for the domain from step 5? Anyone with a campus account can
   pass that proof by sending straight to the bot; decide whether that is
   acceptable before naming the forwarder.
7. Run the offline check on that same `.eml`
   (`npx tsx inbound/scripts/check-message.ts`, see `inbound/README.md`, "Check
   one real message offline") with the names from steps 3 to 5. It prints what
   the bot reads from the two lines and the verdict. If it says a pass names no
   From domain, see `EMAIL_AUTH_REQUIRE_FROM_DOMAIN` in
   `docs/setup-reference.md`.
8. Set the values, keep `EMAIL_AUTH_MODE=flag`, and read the `[EMAIL AUTH]`
   entries in the audit log for a week of real mail before considering
   `enforce`.

`ARC-Seal` and `ARC-Authentication-Results` lines may be present. This code
does not read them: it validates no ARC signature.
