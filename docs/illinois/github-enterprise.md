# The University of Illinois System Shared GitHub Service

The service provides GitHub organisations on github.com under the university's
enterprise licence. What its public pages say, read 2026-11-25:

- [Campus GitHub guide](https://answers.uillinois.edu/illinois/129281) (updated
  2024-01-26): "All departments and employees within the U of I System now have
  access to a shared, enterprise wide, GitHub license."
- [Shared GitHub Service page](https://web.uillinois.edu/github) (no date shown):
  to request an org, "send an email to GitHub Shared Service Support" with the
  department name, the org title, the preferred org URL, the department's
  website, and "Organization owner information for two people: Name and NetID".
  It also says "it could take up to two weeks". Questions go to
  githubsupport@uillinois.edu.
- [Org owner instructions](https://answers.uillinois.edu/systemoffices/102099)
  (updated 2025-03-10): "SAML single sign-on MUST be left "Enabled" and
  "Required"", and this "link[s] university NetIDs to the users' GitHub accounts".

With SAML single sign-on required, a personal SSH key or token must be
authorised for the org before it can reach the org's repositories
([GitHub's SSO guide](https://docs.github.com/en/enterprise-cloud@latest/authentication/authenticating-with-single-sign-on/about-authentication-with-single-sign-on)).
Not verified: whether a repository deploy key needs the same step.

## What the repository may hold

The [End User Service Agreement](https://answers.uillinois.edu/systemoffices/102098)
(updated 2026-08-27, read 2026-11-25):

- "GitHub repositories (public, private, and internal) CANNOT be used to store
  banking information, Social Security Numbers (SSNs), passwords, API keys,
  encryption keys, or other data classified as High Risk".
- "In cases where you want to store data considered sensitive, yet not falling
  under the High Risk data classification standard, you must store that data
  within a private repository." Its examples of sensitive information include
  "Student Records (FERPA)".

The agreement does not say that a private repository is approved for student
records. Ask the Privacy Office whether the unit may store its mail copies and
audit log in this private repository. Record the office's written answer here.

## Set the repository address

Set both settings in the host process environment, in the same form as
`config/instance.env.example`. Replace `your-org` with the unit's Illinois
organisation and `your-program-repo` with the repository's exact name. In the
pattern, write any literal dot in a name as `[.]`. Keep both anchors so only
that repository matches.

```
PROGRAM_ORIGIN_URL=git@github.com:your-org/your-program-repo.git
PROGRAM_ORIGIN_PATTERN=^git@github[.]com:your-org/your-program-repo([.]git)?$
```

Prefer the SSH form with a deploy key for that one repository. If the unit can
only use HTTPS, the repository is private, so the address must carry a token:
the host reads its git credential only from the user-info part of
`PROGRAM_ORIGIN_URL` (`src/origin-credential.ts`). Use a fine-grained token
limited to that one repository and authorised for the org's single sign-on.
The address then holds a secret: keep it where `AGENTS.md`, choice 18, and
`docs/deployment.md` say (the service's `override.conf`, readable by its owner
only), never in the repository.

```
PROGRAM_ORIGIN_URL=https://<token>@github.com/your-org/your-program-repo.git
PROGRAM_ORIGIN_PATTERN=^https://([A-Za-z0-9_.~:-]+@)?github[.]com/your-org/your-program-repo([.]git)?$
```

Use github.com for these settings. On 2026-11-25, `dig +short github.illinois.edu`
returned the university web-hosting alias `github.uillinois.edu`, and
`curl https://github.illinois.edu` failed during the TLS handshake (exit 35).

## Not verified

No live test has cloned, fetched or pushed a unit repository, authorised a
credential, or received a GitHub push notification for this setup. Ask the
service team which credential the host may use. Once it is approved, check
access from the host with `npx tsx scripts/check-host-git-trust.ts --network`
before the first test message.
