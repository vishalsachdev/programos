// pm2 definition for the VPS process (until 2026-09 it was started from the
// CLI, which left kill_timeout at pm2's 1.6 s default).
//
// kill_timeout: shutdown() in src/index.ts awaits every step in full so an
// audit-log flush never dies mid `pull --rebase`. Its worst case: the flush
// chains behind a commit already in flight, and a failed commit restores its
// entries, so up to 2 x 7 git steps x 30 s execFile timeout, plus 2 x 10 s
// queue grace = 440 s; 450 s adds margin. A normal shutdown exits on its own in under 2 s, so the cap only
// costs time when git hangs. src/pm2-kill-timeout.test.ts keeps it in step.
module.exports = {
  apps: [
    {
      name: 'programos',
      script: './start.sh',
      interpreter: 'bash',
      cwd: __dirname,
      autorestart: true,
      merge_logs: true,
      kill_timeout: 450_000,
    },
  ],
};
