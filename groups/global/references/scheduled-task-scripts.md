# Runtime procedures

Created: 2026-11-15
Last Updated: 2026-11-15

## Scheduled Task Scripts

**BEFORE scheduling ANY reminder/notification — to a stakeholder, an observer, or Avery — review the reminder registry first** (`docs/reminder-registry.md` in this repo). Never add a reminder without checking what already fires. If the request overlaps an existing job's cadence + recipient, **fold it into that job** rather than creating a second one. Adding to Avery's inward digests requires merging into the Daily Digest or Monday Health Report, not a new stream; adding an outward reminder to stakeholders requires Avery's approval AND an update to the public `/governance` "Notifications you receive" section so recipients know what they're subscribed to. After any change, update the registry and the governance reliability changelog.

For any recurring task, use `schedule_task`. Frequent agent invocations — especially multiple times a day — consume API credits and can risk account restrictions. If a simple check can determine whether action is needed, add a `script` — it runs first, and the agent is only called when the check passes. This keeps invocations to a minimum.

### How it works

1. You provide a bash `script` alongside the `prompt` when scheduling
2. When the task fires, the script runs first (30-second timeout)
3. Script prints JSON to stdout: `{ "wakeAgent": true/false, "data": {...} }`
4. If `wakeAgent: false` — nothing happens, task waits for next run
5. If `wakeAgent: true` — you wake up and receive the script's data + prompt

### Always test your script first

Before scheduling, run the script in your sandbox to verify it works:

```bash
bash -c 'node --input-type=module -e "
  const r = await fetch(\"https://api.github.com/repos/owner/repo/pulls?state=open\");
  const prs = await r.json();
  console.log(JSON.stringify({ wakeAgent: prs.length > 0, data: prs.slice(0, 5) }));
"'
```

### When NOT to use scripts

If a task requires your judgment every time (daily briefings, reminders, reports), skip the script — just use a regular prompt.

### Frequent task guidance

If a user wants tasks running more than ~2x daily and a script can't reduce agent wake-ups:

- Explain that each wake-up uses API credits and risks rate limits
- Suggest restructuring with a script that checks the condition first
- If the user needs an LLM to evaluate data, say that a model call inside the script must use the endpoint this deployment is approved for, and ask Avery first
- Help the user find the minimum viable frequency
