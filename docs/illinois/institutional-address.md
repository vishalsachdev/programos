# Sending as an illinois.edu address

**Status: open items. Nothing here is verified, and no university policy is stated.** No deployment has sent mail as an `illinois.edu` address; the reference deployment sends from a domain its team controls.

## What works today

The default: the bot sends from an address on a domain your unit controls, through the default outbound provider ([`../setup-reference.md`](../setup-reference.md), `RESEND_API_KEY`). That provider needs DNS records on the sending domain, so it cannot send as `illinois.edu`.

## What sending as an institutional address needs

The code has one way to do it: `OUTBOUND_MAIL_PROVIDER=smtp` ([`../setup-reference.md`](../setup-reference.md), "Outbound mail over SMTP"). The bot logs in to a mail server as a mailbox and hands it each mail. For a mailbox in a university's Microsoft 365, that means **authenticated SMTP submission must be allowed for that mailbox**, with a login the bot can use: a username and a password or app password. The code does not implement OAuth login for SMTP, and it does not implement sending through Microsoft Graph (issue 67 tracks Graph; it would need an application registered in the university's Microsoft 365 tenant).

What a public university page says (read 2026-11-20): [Office 365, Email, Exchange, University Email with Exchange](https://answers.uillinois.edu/47591) gives "Outgoing mail server: smtp.office365.com Outgoing protocol: requires authentication, STARTTLS, port 587, OAuth2" and says "The Basic Authentication protocol is considered outdated and insecure, and was disabled for University accounts in August of 2022." A login with a username and a password is basic authentication, so per that page the SMTP provider as written is not expected to work against the university's Exchange Online. The page also lists no exception. A separate university service, the Cloud Email Delivery Service, accepts "either an API key, or SMTP credentials" ([answers.uillinois.edu/85412](https://answers.uillinois.edu/85412)); who may use it and for which From addresses is not stated there.

Whether the university allows any of these routes for a unit mailbox, and under what conditions, is **not verified**. This page does not say what the university permits. **Ask your central IT office**, and write down the answer and its date.

## Questions to ask (not verified)

| Question | Answer |
|---|---|
| May a program send mail as this mailbox by authenticated SMTP submission, given that basic authentication is disabled for university accounts (page above)? Is there an exception, or should the unit use the Cloud Email Delivery Service? If yes: the server name, the port, and STARTTLS or implicit TLS. | Not verified. |
| Which login may the program use: the mailbox password, an app password, something else? Is a login with a username and password allowed at all for this mailbox, given the multi-factor sign-in rules? | Not verified. The code needs a username and a password or app password. |
| Is there an approval step for a program that sends as a university mailbox, and who gives it? | Not verified. Not named here: no public university page was read for this. |
| Are there sending limits (mails per minute or per day, recipients per mail)? | Not verified. The bot waits 30 to 60 seconds between mails (`OUTBOUND_EMAIL_STAGGER_MS`). |
| Does the mail system keep the `Message-ID` header the program sets? Replies are threaded on it. | Not verified. Send one test mail and read its headers. |
| Where do bounces for this mailbox go, and who will read them? | Not verified. With SMTP the bot gets no bounce reports; a person must read the mailbox. |
| Is this kind of mail (the bot's replies, with the content they quote) allowed to be sent by a program from a university mailbox? | Not verified. See [`data-handling.md`](./data-handling.md). |

## If the answer is no, or not yet

Send from a domain your unit controls (the default). Colleagues can still write to a campus address that forwards to the bot's intake address; the reply then comes from the bot's own domain. [`email-quickstart.md`](./email-quickstart.md) describes that flow.
