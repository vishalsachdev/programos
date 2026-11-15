import { describe, it, expect } from 'vitest';

import { looksLikeApiError } from './agent-output.js';

describe('looksLikeApiError', () => {
  it('matches the literal API-error envelope from the 2026-06-16 incident', () => {
    expect(
      looksLikeApiError(
        'API Error: 500 {"type":"error","error":{"type":"api_error","message":"Internal server error"},"request_id":"req_x"}',
      ),
    ).toBe(true);
  });

  it('matches other HTTP status codes', () => {
    expect(looksLikeApiError('API Error: 429 rate limited')).toBe(true);
    expect(looksLikeApiError('  API Error: 529 overloaded')).toBe(true);
  });

  it('matches a raw JSON error envelope at the start', () => {
    expect(
      looksLikeApiError('{"type":"error","error":{"type":"overloaded_error"}}'),
    ).toBe(true);
    expect(
      looksLikeApiError('{"error":{"type":"api_error","message":"boom"}}'),
    ).toBe(true);
  });

  it('does NOT match ordinary prose that mentions errors', () => {
    expect(
      looksLikeApiError(
        'Hi Robin, I logged your update. There were no errors processing it.',
      ),
    ).toBe(false);
    expect(
      looksLikeApiError(
        'The API Error handling section of the docs explains the 500 status.',
      ),
    ).toBe(false);
    expect(looksLikeApiError('')).toBe(false);
    expect(
      looksLikeApiError('Your action item about the 500-level course is open.'),
    ).toBe(false);
  });
});
