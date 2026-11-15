export interface TelegramAllowlistState {
  available: boolean;
  /** Authorized Telegram usernames, normalized: lowercase, no leading `@`. */
  handles: Set<string>;
  source: string;
}

export type TelegramAllowlistFallbackMode = 'closed' | 'permissive';

// Capture only the `## Telegram Handles` section, up to the next `##` heading
// (or end of file). Scoping to this section is essential: the same file holds
// an email table whose addresses (e.g. `avery@example.edu`) would otherwise
// match the `@handle` pattern below.
const TELEGRAM_HANDLES_SECTION =
  /##\s*Telegram Handles\s*\n([\s\S]*?)(?=\n##\s|$)/;

export function parseTelegramAllowlist(content: string): Set<string> {
  const handles = new Set<string>();
  const section = content.match(TELEGRAM_HANDLES_SECTION);
  if (!section) return handles;
  // Telegram usernames are 5–32 chars (letters, digits, underscores) and start
  // with a letter; matching is case-insensitive. We accept 3+ here to be
  // lenient and lowercase for comparison.
  for (const match of section[1].matchAll(/@([A-Za-z][A-Za-z0-9_]{2,31})\b/g)) {
    handles.add(match[1].toLowerCase());
  }
  return handles;
}

/** Minimal read interface — satisfied by RepoReader. */
export interface TelegramAllowlistSource {
  readFile(relPath: string): string | null;
}

const ALLOWLIST_PATH = 'program/EMAIL_ALLOWLIST.md';

export function loadTelegramAllowlistFrom(
  source: TelegramAllowlistSource,
): TelegramAllowlistState {
  const content = source.readFile(ALLOWLIST_PATH);
  if (content === null) {
    return { available: false, handles: new Set(), source: ALLOWLIST_PATH };
  }
  return {
    available: true,
    handles: parseTelegramAllowlist(content),
    source: ALLOWLIST_PATH,
  };
}

export function normalizeTelegramAllowlistFallbackMode(
  value?: string,
): TelegramAllowlistFallbackMode {
  return value?.toLowerCase() === 'permissive' ? 'permissive' : 'closed';
}

export function canProcessTelegramSender(
  username: string | undefined,
  state: TelegramAllowlistState,
  fallbackMode: TelegramAllowlistFallbackMode,
): { allowed: boolean; reason?: string } {
  if (!state.available) {
    if (fallbackMode === 'permissive') {
      return { allowed: true };
    }
    return { allowed: false, reason: 'allowlist unavailable' };
  }

  // Telegram usernames are optional. A sender without one can't be matched
  // against the handle list, so in closed mode they are dropped.
  const normalized = username?.toLowerCase().replace(/^@/, '');
  if (!normalized || !state.handles.has(normalized)) {
    return { allowed: false, reason: 'sender not on allowlist' };
  }

  return { allowed: true };
}
