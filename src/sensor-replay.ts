import type { SensorVerdict } from './behaviour-sensor.js';

export function readReplaySource(
  sourceFile: string,
  readFile: (file: string) => string | null,
): string {
  const source = readFile(sourceFile);
  if (source) return source;

  const activeTriage = /^discussions\/kb-triage\/([^/]+\.md)$/.exec(sourceFile);
  if (activeTriage) {
    const archived = readFile(`discussions/kb-triage/done/${activeTriage[1]}`);
    if (archived) return archived;
  }

  throw new Error(`source file not readable: ${sourceFile}`);
}

export function selectReplayCases<T extends { id: string }>(
  cases: T[],
  selectedIds?: string[],
): T[] {
  if (!selectedIds?.length) return cases;
  const selected = new Set(selectedIds);
  const known = new Set(cases.map((testCase) => testCase.id));
  const unknown = selectedIds.filter((id) => !known.has(id));
  if (unknown.length) {
    throw new Error(`unknown replay case id: ${unknown.join(', ')}`);
  }
  return cases.filter((testCase) => selected.has(testCase.id));
}

export function extractReplayReply(markdown: string, heading: string): string {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const marker = new RegExp(`^## ${escaped} — [^\\n]+$`, 'm').exec(markdown);
  if (!marker) throw new Error(`historical sensor entry ${heading} not found`);
  const afterMarker = markdown.slice(marker.index + marker[0].length);
  const nextHeading = afterMarker.search(/^## /m);
  const entry =
    nextHeading === -1 ? afterMarker : afterMarker.slice(0, nextHeading);
  const response = entry.match(
    /### Outbound response under review\s*\n+([\s\S]*?)\n+### Citation check/,
  );
  if (!response) {
    throw new Error(
      `historical sensor entry ${heading} has no outbound response`,
    );
  }
  return response[1].trim();
}

export function scoreReplayCase(
  allowed: SensorVerdict[],
  verdicts: SensorVerdict[],
): { passed: boolean; matches: number; runs: number } {
  if (verdicts.length !== 3) {
    throw new Error('sensor replay requires exactly three runs per case');
  }
  const matches = verdicts.filter((verdict) =>
    allowed.includes(verdict),
  ).length;
  return { passed: matches >= 2, matches, runs: verdicts.length };
}
