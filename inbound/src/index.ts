// Cloudflare Email Worker entry. `email` runs for each message that Email
// Routing sends to this worker; `scheduled` runs on the cron trigger in
// wrangler.toml and retries what is in the buffer.

import { receive, retryPending, type InboundMessage } from './intake.js';
import type { Env } from './settings.js';

const deps = {
  fetch: (url: string, init?: RequestInit) => fetch(url, init),
  now: () => new Date(),
};

export default {
  async email(message: InboundMessage, env: Env): Promise<void> {
    const outcome = await receive(message, env, deps);
    console.log(`inbound: ${outcome}`);
  },

  async scheduled(_event: unknown, env: Env): Promise<void> {
    const summary = await retryPending(env, deps);
    if (summary.delivered || summary.waiting || summary.failed) {
      console.log(`inbound: retry run ${JSON.stringify(summary)}`);
    }
  },
};
