# Operator alerts in a Microsoft Teams channel

> **Not verified against a live Teams tenant.** The code was tested with the HTTP request mocked. The request body and the responses below come from Microsoft's public pages, read on 2026-11-20 and linked where used. These products change often: check each page again before you rely on it, and run the test in step 4 before you count on this route.

`ADMIN_ALERT_ROUTE=teams` posts each operator alert (delivery failures, gate refusals, routed-approval notices, sender caps, failed pushes) to one Teams channel. It can be combined with the other routes: `telegram,teams`, `email,teams`, `telegram,email,teams`. With several routes, an alert counts as delivered when one route delivered it. The code is `sendAdminAlertTeams` in `src/admin-alert.ts`.

## What Microsoft offers today

- Office 365 connectors, including the old "Incoming Webhook", no longer work: "Office 365 Connectors in Teams, including connector-based Incoming Webhooks, were retired in May 2026. To receive webhook requests and post messages in Teams, use the Workflows app." ([Create an Incoming Webhook](https://learn.microsoft.com/en-us/microsoftteams/platform/webhooks-and-connectors/how-to/add-incoming-webhook))
- The replacement is a workflow (a Power Automate flow) in the Workflows app, started by the trigger "When a Teams webhook request is received", from the template "Send webhook alerts to a channel" (the template's name can differ in your tenant; the same page and Microsoft's [support article](https://support.microsoft.com/en-us/office/create-incoming-webhooks-with-workflows-for-microsoft-teams-8ae491c7-0394-4861-ba59-055e33f75498) describe it).
- The workflow gives you a URL. Its host looks like `https://<something>.logic.azure.com/...` in Microsoft's examples ([Teams connector reference](https://learn.microsoft.com/en-us/connectors/teams/)); the URL carries a signature (`sig=`) in its query string ([Logic Apps security](https://learn.microsoft.com/en-us/azure/logic-apps/set-up-security-permissions)). Your tenant may give a different host. ProgramOS accepts any `https://` URL.
- Who may trigger it is a setting of the trigger: "anyone", "any user in my tenant", or "specific users in my tenant" ([Teams connector reference](https://learn.microsoft.com/en-us/connectors/teams/)). For the last two, the caller must send an authentication token. **ProgramOS sends no token**, so this route works only with "anyone": then the URL alone is the credential, and anyone who holds it can post into your channel.
- Cards appear as posted by the Workflows bot ("Flow bot"), not by a person.
- The workflow belongs to the person who made it, not to the team or channel ("Workflows are linked only to specific users ... and not to a Teams team or channel"; [Create an Incoming Webhook](https://learn.microsoft.com/en-us/microsoftteams/platform/webhooks-and-connectors/how-to/add-incoming-webhook)). Add a co-owner. See [`service-ownership.md`](./service-ownership.md).

## What ProgramOS sends

One HTTPS POST per alert, `Content-Type: application/json`, this body (the alert text goes in `text`):

```json
{
  "type": "message",
  "attachments": [
    {
      "contentType": "application/vnd.microsoft.card.adaptive",
      "contentUrl": null,
      "content": {
        "$schema": "http://adaptivecards.io/schemas/adaptive-card.json",
        "type": "AdaptiveCard",
        "version": "1.2",
        "body": [{ "type": "TextBlock", "text": "<alert text>", "wrap": true }]
      }
    }
  ]
}
```

This is the "Adaptive cards" request body example of the webhook trigger in the [Teams connector reference](https://learn.microsoft.com/en-us/connectors/teams/), plus `"wrap": true` so long lines wrap. It is built by one small function, `buildTeamsAlertPayload` in `src/admin-alert.ts`; a test (`src/admin-alert-teams.test.ts`, "pins the exact request body") holds the exact JSON.

The rest of the behaviour:

| Case | What happens |
|---|---|
| Any 2xx answer (the request trigger answers `202 Accepted` when the flow has no Response action; [Request trigger](https://learn.microsoft.com/en-us/azure/connectors/connectors-native-reqres)) | Delivered. One `[ADMIN ALERT TEAMS]` entry in the audit log, with the text as posted. A 2xx means the flow took the request; whether the card then appeared is in the flow's run history. |
| `429` or `5xx`, no answer, or no answer within 10 seconds | Failed, retryable. |
| Any other status, including a redirect | Failed, not retryable. Redirects are not followed. |
| The workflow URL is unset or not `https://` | Not sent. The startup check logs one error naming `ADMIN_ALERT_TEAMS_WORKFLOW_URL`. |
| The alert is too long | Teams refuses a message above about 28 KB ([Teams connector reference](https://learn.microsoft.com/en-us/connectors/teams/), known issues). The request body is kept under 24,000 bytes: a longer alert is cut and ends with `[Cut to fit the Teams message size limit: N characters left out.]`. It is never split into several posts. |
| An alert raised while a Teams post is in flight | Not posted to Teams (no recursion). A failed Teams post raises no alert of its own; it is logged. |

There is no retry inside the route. A dead-letter or shortfall alert that no route delivered is kept and replayed by the caller, as on the other routes. Microsoft throttles a webhook that gets more than four requests a second ([Create an Incoming Webhook](https://learn.microsoft.com/en-us/microsoftteams/platform/webhooks-and-connectors/how-to/add-incoming-webhook)), and Power Automate turns off a flow that is throttled for 14 days in a row ([limits](https://learn.microsoft.com/en-us/power-automate/limits-and-config)). Alert volume is small, but a burst of failures can produce several alerts at once.

The URL is never written to a log line, an error or the audit log. The response body is not read.

## Set it up

1. **Ask first.** Whether your tenant allows the Workflows app, a webhook trigger that "anyone" can call, and a workflow owned by a service account is a decision of your Microsoft 365 or Power Platform administrators. Whether alert text (it can hold mail addresses and subjects) may go to a Teams channel is a decision for whoever owns your data rules; see [`data-handling.md`](./data-handling.md).
2. **Create the workflow.** In Teams, open the channel's menu, choose *Workflows*, and pick the template that posts to a channel when a webhook request is received. Choose the team and channel. Copy the URL it shows at the end. Add a co-owner to the workflow in Power Automate.
3. **Store the URL.** Add to `.env` on the host (not the process environment, and never in git):

   ```
   ADMIN_ALERT_TEAMS_WORKFLOW_URL=<the URL>
   ADMIN_ALERT_ROUTE=teams
   ```

   Or `telegram,teams`, `email,teams` to keep another route. Restart.
4. **Test.** From the host, with the URL in a shell variable so it does not stay in your shell history:

   ```
   read -rs TEAMS_URL && curl -sS -o /dev/null -w '%{http_code}\n' -X POST -H 'Content-Type: application/json' --data '{"type":"message","attachments":[{"contentType":"application/vnd.microsoft.card.adaptive","contentUrl":null,"content":{"$schema":"http://adaptivecards.io/schemas/adaptive-card.json","type":"AdaptiveCard","version":"1.2","body":[{"type":"TextBlock","text":"ProgramOS test alert","wrap":true}]}}]}' "$TEAMS_URL"
   ```

   Expect `202` (or another 2xx) and a card in the channel. Then start the bot once with `ADMIN_ALERT_TEST=1` (`AGENTS.md`, "First start"): the log says `Admin alert test delivered` with `route: "teams"`, and the card arrives.

## If your workflow expects a different body

Some templates, or a workflow someone edited, may expect another shape: a MessageCard, a plain field such as `{"text": "..."}`, or a different card version. Signs: the curl test answers 2xx but no card appears and the flow's run history shows a failed step, or the trigger answers `400`.

1. Open the flow in Power Automate and look at the trigger's request schema and the step that posts the card. That step names the field it reads (for the template above, the `attachments` array).
2. Change only `buildTeamsAlertPayload` in `src/admin-alert.ts` to return that shape, and update the pinned JSON in its test.
3. Record the change: run `python3 scripts/upstream-sync/repo_patch.py` (see `CONTRIBUTING.md`).
4. Run the curl test with the new body, then `ADMIN_ALERT_TEST=1`.

## Rotate or revoke the URL

Anyone holding the URL can post to the channel. If it leaks, or its owner leaves, delete the workflow (or make a new one), store the new URL in `.env` and restart. Steps and who owns it: [`service-ownership.md`](./service-ownership.md).

## Not covered

- Staff asking the bot questions in Teams. That would be a new channel with its own sender identity checks; [`design/microsoft-path.md`](./design/microsoft-path.md), section 4, explains why it is not built.
- Trigger options that need a token ("any user in my tenant", "specific users"). Not supported.
- Government clouds: Microsoft says Flow bot is not supported in GCC, GCC High or DoD tenants ([Teams connector reference](https://learn.microsoft.com/en-us/connectors/teams/)).
