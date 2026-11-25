# The University of Illinois System Shared GitHub Service

The service provides GitHub Enterprise Cloud organisations on github.com. To request
one, email githubsupport@uillinois.edu. Include the department name and website,
the proposed organisation title and URL, and the names and NetIDs of two owners.
The [campus GitHub guide](https://answers.uillinois.edu/illinois/129281)
links to the service team's request instructions.

Members use Illinois single sign-on (SSO) to link their NetID to a personal
github.com account. To use a personal SSH key or personal access token with the
organisation, authorise it for that organisation. Fine-grained tokens get this
authorisation during creation. See the [Illinois owner instructions](https://answers.uillinois.edu/systemoffices/102099)
and [GitHub's SSO guide](https://docs.github.com/en/enterprise-cloud@latest/authentication/authenticating-with-single-sign-on/about-authentication-with-single-sign-on).

## What the repository may hold

The [End User Service Agreement](https://answers.uillinois.edu/systemoffices/102098)
bars High Risk data from every repository. This includes passwords and API keys.
Sensitive data, including student records covered by FERPA, requires a private
repository. The agreement gives no approval to store those records there.
Ask the Privacy Office whether the unit may store its mail copies and audit log
in this private repository. Record the office's written answer here.

## Set the repository address

Set both variables in the host process environment. Replace the organisation
and repository placeholders with the unit's exact names. In the pattern, write
any literal dot in a name as `[.]`. Keep both anchors so only that repository matches.

```sh
export PROGRAM_ORIGIN_URL='git@github.com:<illinois-org>/<repo>.git'
export PROGRAM_ORIGIN_PATTERN='^git@github[.]com:<illinois-org>/<repo>([.]git)?$'
```

For HTTPS, use the repository's HTTPS address and the matching pattern:

```sh
export PROGRAM_ORIGIN_URL='https://github.com/<illinois-org>/<repo>.git'
export PROGRAM_ORIGIN_PATTERN='^https://([A-Za-z0-9_.~:-]+@)?github[.]com/<illinois-org>/<repo>([.]git)?$'
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
