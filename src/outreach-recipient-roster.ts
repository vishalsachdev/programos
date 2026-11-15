import { parseActionItemSections } from './behaviour-sensor.js';
import { isAgentPrincipalRow } from './channels/webhook-allowlist.js';

export interface OutreachRecipient {
  name: string;
  email: string;
  openCount: number;
  sourceOwners: string[];
  delivery: 'digest' | 'nudge';
}

export interface OutreachRecipientRoster {
  recipients: OutreachRecipient[];
  unmatchedOwners: string[];
}

interface AllowlistPerson {
  name: string;
  email: string;
  eligible: boolean;
}

const OWNER_ALIASES: Record<string, string> = {
  avery: 'avery morgan',
  dana: 'dana a ortiz',
  omar: 'omar lee haddad',
  paige: 'paige e foster',
  'paige foster': 'paige e foster',
  tessa: 'tessa r bower',
  'tessa bower': 'tessa r bower',
  robin: 'robin jo keller',
  'robin keller': 'robin jo keller',
  nora: 'nora a adler',
  'nora adler': 'nora a adler',
  felix: 'felix stone',
  ines: 'ines k vance',
  sam: 'samuel caleb rivera',
  'sam rivera': 'samuel caleb rivera',
  lin: 'lin chen',
  jonas: 'jonas berg',
  arjun: 'arjun rao',
  wei: 'wei zhou',
  rohan: 'rohan sen',
  june: 'june hale',
  klara: 'clara doyle',
  clara: 'clara doyle',
  ivy: 'ivy pike',
  leena: 'lena marsh',
  lena: 'lena marsh',
  wren: 'wren tate',
  'hugo larsen': 'hugo larsen',
  peter: 'peter quill',
  caleb: 'caleb park',
  meera: 'meera iyer',
};

const GROUP_OWNER_RE =
  /^(team|program administration|nanoclaw|infrastructure|t&l|teaching & learning)\b/i;

function normalizeName(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[^a-zA-Z0-9]+/g, ' ')
    .trim()
    .toLowerCase();
}

function parseAllowlistPeople(markdown: string): AllowlistPerson[] {
  const active = markdown.split(/>\s*\*\*Retired access/i, 1)[0];
  const people: AllowlistPerson[] = [];

  for (const line of active.split('\n')) {
    if (!line.trimStart().startsWith('|')) continue;
    const cells = line
      .split('|')
      .slice(1, -1)
      .map((cell) => cell.trim());
    if (cells.length < 5 || !cells[1]?.includes('@')) continue;

    // Policy: every allowlist member is eligible to own action
    // items; only automated agent principals are excluded. Legacy
    // `monday-reminder:` markers in the role column are inert.
    people.push({
      name: cells[0],
      email: cells[1].toLowerCase(),
      eligible: !isAgentPrincipalRow(cells),
    });
  }

  return people;
}

function matchPerson(
  rawName: string,
  people: AllowlistPerson[],
): AllowlistPerson | undefined {
  const normalized = normalizeName(rawName.replace(/\([^)]*\)/g, ''));
  if (!normalized) return undefined;
  const target = OWNER_ALIASES[normalized] || normalized;

  const exact = people.filter(
    (person) => normalizeName(person.name) === target,
  );
  if (exact.length === 1) return exact[0];

  const substring = people.filter((person) => {
    const canonical = normalizeName(person.name);
    return canonical.includes(target) || target.includes(canonical);
  });
  return substring.length === 1 ? substring[0] : undefined;
}

function ownerCandidates(header: string): string[] {
  const namedGroup = header.match(
    /^(?:t&l|teaching & learning)\s*\(([^)]+)\)/i,
  );
  if (namedGroup) {
    return namedGroup[1]
      .split(/\s*(?:\/|&|\+|\band\b)\s*/i)
      .map((part) => part.trim())
      .filter(Boolean);
  }

  const withoutRoleNote = header
    .replace(/\([^)]*\)/g, '')
    .replace(/\s+[—–-]\s+.*$/, '')
    .trim();
  if (GROUP_OWNER_RE.test(withoutRoleNote)) return [];
  return withoutRoleNote
    .split(/\s*(?:\/|&|\+|\band\b)\s*/i)
    .map((part) => part.trim())
    .filter(Boolean);
}

function explicitItemOwners(sectionText: string): string[] {
  const owners: string[] = [];
  for (const line of sectionText.split('\n')) {
    if (!/^\s*- \[ \]/.test(line)) continue;
    const match = line.match(/\(Owner:\s*([^;)]+)/i);
    if (!match) continue;
    owners.push(
      ...match[1]
        .split(/\s*(?:\/|&|\+|\band\b)\s*/i)
        .map((owner) => owner.trim())
        .filter(Boolean),
    );
  }
  return owners;
}

export function buildOutreachRecipientRoster(
  actionItemsMarkdown: string,
  allowlistMarkdown: string,
): OutreachRecipientRoster {
  const people = parseAllowlistPeople(allowlistMarkdown);
  const activeEmails = new Set<string>();
  for (const person of people.filter((candidate) => candidate.eligible)) {
    if (activeEmails.has(person.email)) {
      throw new Error(
        `Outreach allowlist has duplicate active email: ${person.email}`,
      );
    }
    activeEmails.add(person.email);
  }

  const operatorRows = people.filter(
    (person) => person.eligible && person.email === 'avery@example.edu',
  );
  if (operatorRows.length !== 1) {
    throw new Error(
      `Outreach allowlist must contain exactly one active Avery row; found ${operatorRows.length}`,
    );
  }

  const aggregates = new Map<
    string,
    { openCount: number; sourceOwners: string[] }
  >();
  const unmatchedOwners: string[] = [];
  aggregates.set(operatorRows[0].email, { openCount: 0, sourceOwners: [] });

  const sections = parseActionItemSections(actionItemsMarkdown);
  if (sections.length === 0) {
    throw new Error('Action-item tracker has no owner sections');
  }

  const add = (person: AllowlistPerson, count: number, sourceOwner: string) => {
    if (!person.eligible || count <= 0) return;
    const current = aggregates.get(person.email) || {
      openCount: 0,
      sourceOwners: [],
    };
    current.openCount += count;
    if (!current.sourceOwners.includes(sourceOwner)) {
      current.sourceOwners.push(sourceOwner);
    }
    aggregates.set(person.email, current);
  };

  for (const section of sections) {
    if (section.openCount === 0) continue;
    const candidates = ownerCandidates(section.owner);
    const directMatches = candidates
      .map((candidate) => matchPerson(candidate, people))
      .filter((person): person is AllowlistPerson => person !== undefined);
    const directEmails = new Set(directMatches.map((person) => person.email));
    const isNamedGroupSection = /^(?:t&l|teaching & learning)\s*\(/i.test(
      section.owner,
    );

    if (directMatches.length > 0) {
      for (const person of directMatches) {
        add(person, section.openCount, section.owner);
      }
      if (!isNamedGroupSection) continue;
    }

    let explicitMatches = 0;
    for (const owner of explicitItemOwners(section.text)) {
      const person = matchPerson(owner, people);
      if (person?.eligible) {
        if (!directEmails.has(person.email)) {
          add(person, 1, section.owner);
        }
        explicitMatches++;
      }
    }

    const knownButExcluded = candidates.some((candidate) =>
      matchPerson(candidate, people),
    );
    if (
      explicitMatches === 0 &&
      !knownButExcluded &&
      !/^greta\b/i.test(section.owner)
    ) {
      unmatchedOwners.push(section.owner);
    }
  }

  const recipients = people.flatMap((person): OutreachRecipient[] => {
    const aggregate = aggregates.get(person.email);
    if (!person.eligible || !aggregate) return [];
    return [
      {
        name: person.name,
        email: person.email,
        openCount: aggregate.openCount,
        sourceOwners: aggregate.sourceOwners,
        delivery: person.email === 'avery@example.edu' ? 'digest' : 'nudge',
      },
    ];
  });

  return { recipients, unmatchedOwners };
}
