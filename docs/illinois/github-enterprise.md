# Illinois: the knowledge-base repo on github.illinois.edu

> **Not verified.** Nobody has run this repo's code against github.illinois.edu.
> The host name comes from issue 14. The URL forms below are the standard
> GitHub Enterprise Server forms and have not been checked on that host.
> Whether a unit may keep this kind of data there, and which accounts may hold a
> deploy key or token, are questions for the unit's IT staff; this page states
> no university policy.

The generic instructions are in `config/instance.env.example` (the
`PROGRAM_ORIGIN_PATTERN` key) and in the placeholder table in `AGENTS.md`. This
page only fills in the host name.

## The setting

The host accepts a program repo only when its git origin URL matches
`PROGRAM_ORIGIN_PATTERN` (`isExpectedOrigin` in `src/repo-reader.ts`). With the
setting empty, only the placeholder repo on github.com passes, so a repo on
github.illinois.edu is refused and the read mirror is not created.

Export one of these in the process environment (a line in `.env` does nothing
for this key). Replace `your-org/your-program-repo`.

For an SSH origin (`git@github.illinois.edu:your-org/your-program-repo.git`):

```
PROGRAM_ORIGIN_PATTERN=^git@github[.]illinois[.]edu:your-org/your-program-repo([.]git)?$
```

For an HTTPS origin, with or without a token in the URL:

```
PROGRAM_ORIGIN_PATTERN=^https://([^@/?#\s]+@)?github[.]illinois[.]edu/your-org/your-program-repo([.]git)?$
```

Keep `^` and `$`. When the setting is present the URL is checked against the
pattern only, so an open-ended pattern accepts more than you mean.

## What is covered by a test, and what is not

- Covered: `src/repo-reader.test.ts` checks both pattern shapes against a
  GitHub Enterprise style host (`git.example.edu`), including the URLs they must
  refuse.
- Not covered: a clone, fetch or push against github.illinois.edu; campus login
  (SSO) for a deploy key or token; the push webhook
  (`src/channels/github-push-events.ts`) receiving deliveries from that host;
  network reach from your bot host to github.illinois.edu.

Before the first test message, run the check in `AGENTS.md` ("First start",
step 5): `npx tsx scripts/check-host-git-trust.ts --network`. Only the host
needs a credential for this git host; the container gets none.
