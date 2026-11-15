export interface EmailAllowlistState {
  available: boolean;
  senders: Set<string>;
  /**
   * Automated agent principals among `senders` (G52; today the PeerAgent row).
   * Set by the loaders below; snapshots rebuilt from serialized state leave
   * it undefined, and callers must then treat a sender as possibly an agent.
   */
  agentSenders?: Set<string>;
  source: string;
}

export type EmailAllowlistFallbackMode = 'closed' | 'permissive';

export function parseEmailAllowlist(content: string): Set<string> {
  const allowlist = new Set<string>();
  for (const match of content.matchAll(
    /\|\s*[^|]+\|\s*([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})\s*\|/g,
  )) {
    allowlist.add(match[1].toLowerCase());
  }
  return allowlist;
}

/**
 * True when an allowlist table row (cells between the outer pipes) belongs
 * to an automated agent principal: the `coordinator-cohort: agent` marker, an
 * `agent` tier, or the PeerAgent Agent name. Any one signal is enough, so a
 * partly edited row still counts as an agent.
 */
export function isAgentPrincipalRow(cells: string[]): boolean {
  const role = cells.slice(4).join(' ');
  return (
    /coordinator-cohort:\s*agent\b/i.test(role) ||
    /\bagent\b/i.test(cells[2] ?? '') ||
    /\(PeerAgent Agent\)/i.test(cells[0] ?? '')
  );
}

export function parseAgentPrincipals(content: string): Set<string> {
  const agents = new Set<string>();
  for (const line of content.split('\n')) {
    if (!line.trimStart().startsWith('|')) continue;
    const cells = line
      .split('|')
      .slice(1, -1)
      .map((cell) => cell.trim());
    const email = cells[1]?.toLowerCase();
    if (!email?.includes('@')) continue;
    if (isAgentPrincipalRow(cells)) agents.add(email);
  }
  return agents;
}

/** Minimal read interface — satisfied by RepoReader. */
export interface AllowlistSource {
  readFile(relPath: string): string | null;
}

const ALLOWLIST_PATH = 'program/EMAIL_ALLOWLIST.md';

export function loadEmailAllowlistFrom(
  source: AllowlistSource,
): EmailAllowlistState {
  const content = source.readFile(ALLOWLIST_PATH);
  if (content === null) {
    return { available: false, senders: new Set(), source: ALLOWLIST_PATH };
  }
  return {
    available: true,
    senders: parseEmailAllowlist(content),
    agentSenders: parseAgentPrincipals(content),
    source: ALLOWLIST_PATH,
  };
}

export async function loadEmailAllowlistFromAsync(source: {
  readFileAsync(relPath: string): Promise<string | null>;
}): Promise<EmailAllowlistState> {
  const content = await source.readFileAsync(ALLOWLIST_PATH);
  return {
    available: content !== null,
    senders: content === null ? new Set() : parseEmailAllowlist(content),
    agentSenders: content === null ? new Set() : parseAgentPrincipals(content),
    source: ALLOWLIST_PATH,
  };
}

export function normalizeEmailAllowlistFallbackMode(
  value?: string,
): EmailAllowlistFallbackMode {
  return value?.toLowerCase() === 'permissive' ? 'permissive' : 'closed';
}

export function canProcessEmailSender(
  from: string | undefined,
  state: EmailAllowlistState,
  fallbackMode: EmailAllowlistFallbackMode,
): { allowed: boolean; reason?: string } {
  const normalizedFrom = from?.toLowerCase();

  // A message with no sender identity is never processable, in ANY mode:
  // permissive fallback waives the allowlist check when the list is
  // unavailable, but it must not waive having a sender at all (there is
  // nobody to attribute, audit, or reply to).
  if (!normalizedFrom) {
    return { allowed: false, reason: 'missing sender' };
  }

  if (!state.available) {
    if (fallbackMode === 'permissive') {
      return { allowed: true };
    }
    return { allowed: false, reason: 'allowlist unavailable' };
  }

  if (!state.senders.has(normalizedFrom)) {
    return { allowed: false, reason: 'sender not on allowlist' };
  }

  return { allowed: true };
}
