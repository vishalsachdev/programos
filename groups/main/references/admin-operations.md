# Runtime procedures

Created: 2026-11-15
Last Updated: 2026-11-15

## Container Mounts

Main has read-only access to the project, read-write access to the store (SQLite DB), and read-write access to its group folder:

| Container Path | Host Path | Access |
|----------------|-----------|--------|
| `/workspace/project` | Project root | read-only |
| `/workspace/project/store` | `store/` | read-write |
| `/workspace/group` | `groups/main/` | read-write |

Key paths inside the container:
- `/workspace/project/store/messages.db` - SQLite database (read-write)
- `/workspace/project/store/messages.db` (registered_groups table) - Group config
- `/workspace/project/groups/` - All group folders

---


## Configured channels

ProgramOS currently routes email, Telegram, and web chat. It does not register WhatsApp, Slack, or Discord channel factories. Telegram inbound traffic uses the fixed JID `tg-program@program`; web chat uses `web-chat-program@program` and host-derived conversation JIDs.

Group registration alone does not wire a new transport or create a Telegram reply target. Do not offer to discover or add arbitrary chats with `refresh_groups` or `register_group`. Ask the host operator to configure supported channels and verify their routing. Do not edit the database to remove a channel from a live deployment.

For read-only inspection, query the `registered_groups` table in `/workspace/project/store/messages.db`; use an existing, configured JID for a requested task. Host sender-allowlist configuration and changes are the operator's responsibility; the host path is not writable from this container.

## Scheduling for Other Groups

When scheduling tasks for other groups, use the `target_group_jid` parameter with the group's JID from the `registered_groups` table in `/workspace/project/store/messages.db`:
- `schedule_task(prompt: "...", schedule_type: "cron", schedule_value: "0 9 * * 1", target_group_jid: "<existing-configured-jid>")`

The task will run in that group's context with access to their files and memory.

---


## Task Scripts

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
- If the user needs an LLM to evaluate data, say that a model call inside the script must use the endpoint this deployment is approved for, and ask the admin first
- Help the user find the minimum viable frequency
