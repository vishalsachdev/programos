# Deployment

The code is the source of truth for how the bot runs. This page holds only what the code cannot tell you: what kind of host works, and one recipe that sets it up.

## What the host must be able to do

- **Start a Docker container for each turn.** The host process (Node) launches the agent in a new container per message. This needs a machine where you control Docker: a laptop, a small server or a cloud virtual machine. Managed "run my web app" services that do not let the app start containers will not work.
- **Keep a git checkout of your knowledge-base repo** on local disk. The host pulls and pushes it with its own git credential; the agent container has none and needs none. See `AGENTS.md`, "First start".
- **Receive HTTPS on one port** if you use email or web chat. Put a reverse proxy with TLS in front, and bind the listener to loopback.
- **Reach your AI service, your mail provider, your git host, and Telegram if you use it** on the way out. [`data-handling.md`](./data-handling.md) lists what data goes to each. This is the host. The agent container reaches only the host: on Docker Engine on Linux its network is restricted by default (`CONTAINER_NETWORK`), and web search and fetch are off (`AGENT_WEB_TOOLS`). On Docker Desktop the default network is open and the host warns at each start; `SPEC.md` section 11 says what each setting does and does not block.

## Start small

| Stage | Host | Channels | Inbound network |
|---|---|---|---|
| Trial | A laptop | Telegram only, one chat (the bot polls Telegram) | None |
| Pilot | A virtual machine, always on (the recipe below) | Telegram and email | One HTTPS endpoint behind a reverse proxy |

Email needs two things that Telegram does not: a public HTTPS endpoint and an inbound mail intake service (`AGENTS.md`, "Inbound mail"). `inbound/` holds one, for a domain on Cloudflare Email Routing; it runs at Cloudflare, not on this host, and needs a GitHub token for the knowledge-base repo. It has not been run against live services yet, so plan a real test. With another mail provider you write the service yourself. Plan for that work before you promise email to your team.

## The supported recipe: one virtual machine

One recipe is supported: Ubuntu LTS, Docker, a dedicated non-root user, and the systemd user unit that `setup/service.ts` writes. Three other files in the repo start or update the bot: `ecosystem.config.cjs`, `start.sh` and `scripts/deploy.sh`. They are examples from the reference deployment, which runs under pm2, and each says so in its first lines. Do not mix them with this recipe.

The recipe uses these names. If you change one, change it in every step.

| Name | Value |
|---|---|
| Service user | `programos` |
| Code | `/home/programos/programos` |
| Program repo checkout | `/srv/program-repo` (the code default, and the path in `seed-db.cjs` and `config-examples/mount-allowlist.json`) |
| Read mirror | `/srv/repos/program-repo-read.git` (the code default) |
| Public name | `bot.example.org`, with a DNS record that points at the machine |

"Checked" under a step says what was run for this page on 2026-11-19, in a container with Ubuntu 24.04, systemd 255 and Node 22. That container had no running systemd and no Docker daemon. A step marked "not run" comes from reading the code and each tool's own documentation.

### 1. Packages, user and folders (as an administrator)

```
sudo apt-get update
sudo apt-get install -y docker.io git curl caddy
sudo adduser --disabled-password --gecos "" programos
sudo usermod -aG docker programos
sudo loginctl enable-linger programos
sudo install -d -o programos -g programos /srv/program-repo /srv/repos
```

- A member of the `docker` group can become root on that machine. Use the machine for the bot only.
- Lingering keeps the user's services running when nobody is logged in. `setup/service.ts` also tries to turn it on.
- The host must not run as root in this recipe. As a normal user it runs its own git commands, and it starts each container with its own user and group id (`src/container-runner.ts`), so one user owns every file. The settings `CHECKOUT_OWNER_UID`, `CHECKOUT_OWNER_GID` and `CHECKOUT_OWNER_HOME` apply only to a host that runs as root; see `config/instance.env.example`.
- Open only ports 22, 80 and 443 to the internet, at your provider's firewall. A firewall on the machine itself must still let containers reach the credential proxy on the Docker bridge (`CREDENTIAL_PROXY_PORT`, default 3001). That combination was not tested.

Checked: not run.

### 2. Node and the code (as `programos`)

Log in as the service user in a way that lets `systemctl --user` work later:

```
sudo -iu programos
export XDG_RUNTIME_DIR=/run/user/$(id -u)
```

Install Node at the version in `.nvmrc` with nvm, then build:

```
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
. ~/.nvm/nvm.sh
git clone https://github.com/<your-account>/<your-copy>.git ~/programos
cd ~/programos
nvm install
npm ci
npm run build
```

`nvm install` reads `.nvmrc`. The unit in step 6 records the full path of this `node`. After a Node upgrade, run step 6 again.

Checked: `npm ci` and `npm run build` ran with Node 22. The nvm install was not run; the script address answered.

### 3. Settings (as `programos`)

```
cd ~/programos
cp config/instance.env.example .env
chmod 600 .env
mkdir -p ~/.config/nanoclaw
cp config-examples/mount-allowlist.json ~/.config/nanoclaw/mount-allowlist.json
```

Fill the PART 1 lines in `.env`. Leave the PART 2 lines commented: `.env` does nothing for them. They go in the unit in step 6.

Checked: the allowlist copy, and that the file names `/srv/program-repo`.

### 4. The program repo and its deploy key (as `programos`)

```
ssh-keygen -t ed25519 -N "" -C programos-host -f ~/.ssh/program_repo
cat ~/.ssh/program_repo.pub
```

Add the public key to the program repo at your git host as a deploy key **with write access**. A deploy key reaches that one repo only. Then put these three lines in `~/.ssh/config`:

```
Host github.com
  IdentityFile ~/.ssh/program_repo
  IdentitiesOnly yes
```

```
git clone git@github.com:your-org/your-program-repo.git /srv/program-repo
git -C /srv/program-repo pull
git -C /srv/program-repo push
```

The host refuses a checkout whose origin it does not expect, and then it does not create the read mirror. Step 6 sets `PROGRAM_ORIGIN_PATTERN` for this origin.

**This key is the only git credential, and it stays on the host.** The agent in the container commits in the mounted checkout and never talks to the git host: the container gets no home folder, no SSH agent, no SSH client and no key, and on the restricted network it has no route to the git host. The host pulls before each turn and pushes the agent's commits after each result, with this key (`src/checkout-sync.ts`). A push that fails is sent to the operator as an alert. Do not put a key or a token into the container.

Checked: the clone, pull and push against a git host were not run. The host-side pull and push are tested against a local remote (`src/checkout-sync.test.ts`), and on 2026-11-20 a commit made inside a real container on the restricted network arrived on a local remote through the host (`scripts/check-container-egress.ts`). The agent image itself was not built for that run; a stock image with git stood in for it.

### 5. Container image and channel groups (as `programos`)

```
cd ~/programos
./container/build.sh
npx tsx setup/index.ts --step register -- --jid webhook-email@program --name "Program Email" --folder program-email --trigger "@Coordinator" --channel webhook --no-trigger-required
node seed-db.cjs
```

The `register` step creates the database. `seed-db.cjs` then writes the email group again, with the program repo as a read-write mount at `/srv/program-repo`. Register the main group and the Telegram group as `AGENTS.md`, "First start", step 3 describes.

Checked: the `register` step and `seed-db.cjs` ran, and the stored row holds the mount. `container/build.sh` was not run.

### 6. The systemd unit (as `programos`)

Write the PART 2 settings first. The unit that `setup/service.ts` writes has no such lines, and that step starts the service at once. Create the folder, then save the seven lines below as `~/.config/systemd/user/nanoclaw.service.d/override.conf`:

```
mkdir -p ~/.config/systemd/user/nanoclaw.service.d
```

```
[Service]
Environment=PROGRAM_REPO=/srv/program-repo
Environment=PROGRAM_READ_MIRROR=/srv/repos/program-repo-read.git
Environment=PROGRAM_ORIGIN_PATTERN=^git@github[.]com:your-org/your-program-repo([.]git)?$
Environment=WEBHOOK_HOST=127.0.0.1
Environment=BEHAVIOUR_SENSOR_DISABLED=1
TimeoutStopSec=450
```

```
cd ~/programos
npx tsx setup/index.ts --step service
systemctl --user status nanoclaw
```

- The step builds the code, writes `~/.config/systemd/user/nanoclaw.service`, and enables and starts it. The unit is named `nanoclaw` because the code is a copy of that framework. Running the step again replaces the unit and keeps `override.conf`.
- systemd drops an `Environment=` line that holds a backslash escape it does not know, such as `\.`. Write `[.]` for a dot. Write `%%` for a percent sign.
- `TimeoutStopSec=450`: a clean stop can wait for git for up to 440 seconds (the sum is in `ecosystem.config.cjs`). The systemd default is 90 seconds.
- Remove the `BEHAVIOUR_SENSOR_DISABLED` line only when the sensor's destination is approved for your data (`AGENTS.md`, question 1).
- After a change to `override.conf`: `systemctl --user daemon-reload`, then `systemctl --user restart nanoclaw`.
- Logs: `~/programos/logs/nanoclaw.log` and `~/programos/logs/nanoclaw.error.log`.

Checked: `systemd-analyze verify` (systemd 255) accepted these lines, and reported the `\.` form as "Invalid syntax, ignoring". The unit text is covered by `setup/service.test.ts`. On a machine without systemd the `service` step writes a `nohup` script instead; that is what it did in the container. The systemd path and `systemctl --user` were not run.

### 7. Reverse proxy with TLS (as an administrator)

The bot now listens on `127.0.0.1:3003` only. Replace the content of `/etc/caddy/Caddyfile` with:

```
bot.example.org {
    reverse_proxy 127.0.0.1:3003
}
```

```
sudo systemctl reload caddy
curl https://bot.example.org/health
```

Caddy gets and renews the certificate itself. It needs ports 80 and 443 and the DNS record. The answer to the last command is JSON with `"ok": true`.

Checked: not run. The `/health` route and the listener address come from `src/channels/webhook.ts`.

### 8. Update later (as `programos`)

```
cd ~/programos
git pull
npm ci
npm run build
systemctl --user restart nanoclaw
```

Run `./container/build.sh` too when `container/` changed.

Checked: not run as a sequence.

## Before real users

Go through this list at the end of the recipe.

- The people who approve data use at your institution have seen [`data-handling.md`](./data-handling.md), and its "Decide before go-live" list has an answer on each line.
- Operator alerts have a route that works. The default route is Telegram for the admin; `ADMIN_ALERT_ROUTE=email` mails them to the operator's address instead, and `telegram,email` does both. A test alert arrives on each route you enabled (`AGENTS.md`, "First start", step 7). The startup log has no `Admin alert setup` error.
- The reply sensor is off, or its destination is approved for your data.
- `npx tsx scripts/check-container-egress.ts` prints PASS on every line: the container cannot reach the outside (restricted network), and a commit made in the container arrives on a remote through the host's push.
- A failed knowledge-base push reaches the admin as an alert (to test: make the remote unreachable for one turn that commits).
- One plain question passes end to end on each channel you enabled.
- If email is on: the intake service files a test message (two files in `discussions/raw/`, by the expected git author), and one routed approval passes end to end. A sender who is not on the allowlist gets no answer, or the one courtesy reply if they are at your institution.
- If email is on: the mail provider's events webhook answers 200 to a test event, and a bounce reaches the admin on Telegram (`AGENTS.md`, "Webhooks from other services").
- If the program repo is on GitHub: its push webhook shows a 200 delivery, or you have decided to run without it.
- If Telegram is on: only one chat uses it (see `AGENTS.md`, safety items), and a handle that is not on the list gets no answer.
- If web chat is on: a call without the secret is refused. Web chat does not check the person.
