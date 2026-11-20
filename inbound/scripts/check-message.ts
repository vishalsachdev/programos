// Offline check: put ONE stored message through the same code the intake
// worker and the host run, and print the sender-authentication verdict.
//
//   npx tsx inbound/scripts/check-message.ts <message.eml> \
//       --platform mx.example.net --envelope-from bounce@mail.example.edu
//
// Run it from the repo root, after `npm ci` there and in `inbound/`. It
// reads the file and prints; it sends nothing, writes nothing and needs no
// setting of a deployment. Use it on a real message before
// EMAIL_AUTH_MODE=enforce is turned on (`inbound/README.md`, "Check one real
// message offline"). A real message holds real names and addresses: keep
// the file and the output out of the repo and out of issues.
//
// What it cannot know, and takes from options instead:
// - the envelope sender (`--envelope-from`). A stored `.eml` does not hold
//   it. Without the option the `Return-Path` header is used when there is
//   one, else the envelope sender is empty;
// - what the platform's API reports for `Authentication-Results`
//   (`--platform-header`). Without the option it is every such header of
//   the message joined with ", ", which is what a `Headers` object returns
//   for a name that occurs more than once.

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import PostalMime from 'postal-mime';

import {
  emailAuthBlocks,
  emailAuthVerdict,
  readEmailAuthSettings,
  type EmailAuthDecision,
} from '../../src/email-auth.js';
import { hostNameList, type AuthRecord, type AuthTrust } from '../src/auth.js';
import { buildIntake } from '../src/mail.js';
import { authTrust } from '../src/settings.js';
import type { Env } from '../src/settings.js';

export interface CheckOptions {
  /** The worker's PLATFORM_AUTHSERV_ID. */
  platform: string;
  /** The worker's FORWARDER_AUTHSERV_IDS and FORWARDER_DOMAINS. */
  forwarderIds?: string;
  forwarderDomains?: string;
  /** The host's EMAIL_AUTH_TRUSTED_AUTHSERV_IDS. Default: every name above. */
  trusted?: string;
  /** The host's EMAIL_AUTH_REQUIRE_FROM_DOMAIN. Default: true. */
  requireFromDomain?: string;
  /** The host's EMAIL_AUTH_UNKNOWN. Default: block. */
  unknown?: string;
  envelopeFrom?: string;
  platformHeader?: string;
}

export interface CheckResult {
  from: string;
  envelopeFrom: string;
  envelopeFromSource: 'option' | 'Return-Path header' | 'none';
  /** Every `Authentication-Results` header, first header first. */
  headers: string[];
  record: AuthRecord;
  decision: EmailAuthDecision;
  /** What EMAIL_AUTH_MODE=enforce would do with this message. */
  enforceWouldDrop: boolean;
}

/** The whole check. Depends only on its arguments. */
export async function checkMessage(
  raw: Uint8Array,
  options: CheckOptions,
): Promise<CheckResult> {
  const trust: AuthTrust = authTrust({
    PLATFORM_AUTHSERV_ID: options.platform,
    FORWARDER_AUTHSERV_IDS: options.forwarderIds,
    FORWARDER_DOMAINS: options.forwarderDomains,
  } as Env);
  if (!trust.platformAuthservId) throw new Error('--platform is required');
  const trustedNames =
    options.trusted ??
    [trust.platformAuthservId, ...trust.forwarderAuthservIds].join(',');
  hostNameList(trustedNames, '--trusted');
  // The host's own reader, in enforce mode, so a combination of settings
  // the host would refuse to start with is refused here too.
  const settings = readEmailAuthSettings({
    EMAIL_AUTH_MODE: 'enforce',
    EMAIL_AUTH_TRUSTED_AUTHSERV_IDS: trustedNames,
    EMAIL_AUTH_UNKNOWN: options.unknown,
    EMAIL_AUTH_REQUIRE_FROM_DOMAIN: options.requireFromDomain,
  });

  const email = await PostalMime.parse(raw);
  const headers = email.headers
    .filter((h) => h.key === 'authentication-results')
    .map((h) => h.value);
  const returnPath = email.headers.find((h) => h.key === 'return-path')?.value;
  let envelopeFrom = '';
  let envelopeFromSource: CheckResult['envelopeFromSource'] = 'none';
  if (options.envelopeFrom !== undefined) {
    envelopeFrom = options.envelopeFrom;
    envelopeFromSource = 'option';
  } else if (returnPath !== undefined) {
    envelopeFrom = returnPath.replace(/^\s*<|>\s*$/g, '').trim();
    envelopeFromSource = 'Return-Path header';
  }
  const platformHeader =
    options.platformHeader ?? (headers.length ? headers.join(', ') : null);

  const { payload } = await buildIntake(
    raw,
    { from: envelopeFrom, to: '', authenticationResults: platformHeader },
    new Date(0),
    'discussions/raw',
    trust,
  );
  const decision = emailAuthVerdict(
    payload.from,
    payload.auth,
    settings.trusted,
    { requireFromDomain: settings.requireFromDomain },
  );
  return {
    from: payload.from,
    envelopeFrom,
    envelopeFromSource,
    headers,
    record: payload.auth,
    decision,
    enforceWouldDrop: emailAuthBlocks(settings, decision.verdict),
  };
}

/** The report a person reads. One fact a line. */
export function report(result: CheckResult): string {
  const lines = [
    `From address the allowlist is matched against: ${result.from || '(none)'}`,
    `Envelope sender used: ${result.envelopeFrom || '(empty)'} (from: ${result.envelopeFromSource})`,
    `Authentication-Results headers in the message: ${result.headers.length}`,
    ...result.headers.map((h, i) => `  ${i + 1}. ${h.replace(/\s+/g, ' ')}`),
    `What the worker says of the platform's result: ${result.record.platform_status}`,
    `From headers: ${result.record.from_headers}; addresses counted in the first: ${result.record.from_mailboxes}${result.record.from_display_commas ? ' (commas in the display name only)' : ''}`,
  ];
  for (const r of result.record.results) {
    lines.push(
      `Read from ${r.source} ${r.authserv_id}: spf=${r.spf || '(none)'}${r.spf_domain ? ` for ${r.spf_domain}` : ''}; dkim=${r.dkim.map((d) => `${d.result}${d.domain ? ` (${d.domain})` : ''}`).join(', ') || '(none)'}; dmarc=${r.dmarc}${r.dmarc_from ? ` for ${r.dmarc_from}` : ' (no From domain named)'}`,
    );
  }
  lines.push(
    `VERDICT: ${result.decision.verdict}`,
    `Reason: ${result.decision.reason}`,
    `With EMAIL_AUTH_MODE=enforce this message would be ${result.enforceWouldDrop ? 'DROPPED' : 'processed'}.`,
  );
  if (result.envelopeFromSource !== 'option')
    lines.push(
      'Note: the envelope sender was not given (--envelope-from). The worker gets it from the mail platform; a wrong one here can change the SPF part of the result.',
    );
  return lines.join('\n');
}

const USAGE = `Usage: npx tsx inbound/scripts/check-message.ts <message.eml> --platform <authserv-id>
  [--envelope-from <address>] [--platform-header <value>]
  [--forwarder-ids <ids> --forwarder-domains <domains>]
  [--trusted <ids>] [--require-from-domain true|false] [--unknown block|allow]`;

const FLAGS: Record<string, keyof CheckOptions> = {
  '--platform': 'platform',
  '--forwarder-ids': 'forwarderIds',
  '--forwarder-domains': 'forwarderDomains',
  '--trusted': 'trusted',
  '--require-from-domain': 'requireFromDomain',
  '--unknown': 'unknown',
  '--envelope-from': 'envelopeFrom',
  '--platform-header': 'platformHeader',
};

export function parseArgs(argv: string[]): {
  file: string;
  options: CheckOptions;
} {
  const options: Partial<CheckOptions> = {};
  let file = '';
  for (let i = 0; i < argv.length; i++) {
    const key = FLAGS[argv[i]];
    if (key) {
      const value = argv[++i];
      if (value === undefined) throw new Error(`${argv[i - 1]} needs a value`);
      options[key] = value;
    } else if (argv[i].startsWith('--') || file) {
      throw new Error(`Unknown argument ${argv[i]}`);
    } else file = argv[i];
  }
  if (!file || !options.platform) throw new Error(USAGE);
  return { file, options: options as CheckOptions };
}

async function main(): Promise<void> {
  const { file, options } = parseArgs(process.argv.slice(2));
  console.log(report(await checkMessage(readFileSync(file), options)));
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
