/// <reference types="vitest/globals" />
/**
 * `scripts/fetch-binaries.mjs` — giving a flaky CDN a second chance.
 *
 * WHAT IS BEING GUARDED. The vendored engines and ffmpeg come from third-party
 * release hosts, and the first run of the release workflow died on a single
 * `HTTP 504` from one of them, inside `npm ci`, before anything had been built.
 * Nothing was wrong: not the URL, not the pin, not the network. The far end was
 * briefly unhappy and the script gave up on the spot — while printing "retrying
 * usually works" to a human who then had to press the button again.
 *
 * A release that needs four large downloads from two hosts to all succeed on
 * the first attempt is a release that fails for reasons no one can act on. The
 * two halves pinned here are: retry the failures that repetition can fix, and
 * do NOT retry the ones it cannot — a 404 means the manifest points at an asset
 * that is not there, and asking four times turns a clear error into a slow one.
 */

import { HttpStatusError, isRetryable, withRetries } from '../../scripts/fetch-binaries.mjs';

describe('isRetryable', () => {
  it.each([500, 502, 503, 504, 408, 429])('retries on %i — the far end saying "not now"', (status) => {
    expect(isRetryable(new HttpStatusError(status))).toBe(true);
  });

  it.each([400, 401, 403, 404, 410])('does not retry on %i — repetition cannot fix it', (status) => {
    expect(isRetryable(new HttpStatusError(status))).toBe(false);
  });

  it('retries a stalled socket', () => {
    const timeout = new Error('The operation was aborted due to timeout');
    timeout.name = 'TimeoutError';
    const aborted = new Error('This operation was aborted');
    aborted.name = 'AbortError';
    expect(isRetryable(timeout)).toBe(true);
    expect(isRetryable(aborted)).toBe(true);
  });

  it("retries fetch's own network failure, which arrives as a TypeError", () => {
    expect(isRetryable(new TypeError('fetch failed'))).toBe(true);
  });

  it('does not retry a programming mistake', () => {
    expect(isRetryable(new Error('the response carried no body'))).toBe(false);
  });
});

describe('withRetries', () => {
  /*
   * The backoff is handed in rather than faked. `vi.useFakeTimers()` does not
   * replace `node:timers/promises`, which is where the real sleep comes from,
   * so a test that faked the clock would sit through 2s + 4s + 8s and time out
   * at the fourth attempt — which is precisely the attempt worth proving.
   *
   * `waits` doubles as the record of what was slept for, so the shape of the
   * backoff is asserted rather than assumed.
   */
  let waits: number[];
  const nap = (ms: number): Promise<void> => { waits.push(ms); return Promise.resolve(); };

  beforeEach(() => { waits = []; });

  it('returns the first answer when there is nothing to retry', async () => {
    const attempt = vi.fn().mockResolvedValue('bytes');
    await expect(withRetries('https://example.invalid/a.zip', attempt, { wait: nap })).resolves.toBe('bytes');
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(waits).toEqual([]);
  });

  it('survives the 504 that killed the first release run', async () => {
    const attempt = vi.fn().mockRejectedValueOnce(new HttpStatusError(504)).mockResolvedValue('bytes');
    await expect(withRetries('https://example.invalid/ffmpeg.zip', attempt, { wait: nap })).resolves.toBe('bytes');
    expect(attempt).toHaveBeenCalledTimes(2);
  });

  it('gives up after four attempts rather than looping on a host that is down', async () => {
    const attempt = vi.fn().mockRejectedValue(new HttpStatusError(503));
    await expect(withRetries('https://example.invalid/a.zip', attempt, { wait: nap })).rejects.toThrow(/HTTP 503/);
    expect(attempt).toHaveBeenCalledTimes(4);
    // Doubling, and no sleep after the last attempt — waiting to give up is
    // eight seconds of a release job spent on nothing.
    expect(waits).toEqual([2000, 4000, 8000]);
  });

  it('fails immediately on a 404, so a bad pin is reported fast and plainly', async () => {
    const attempt = vi.fn().mockRejectedValue(new HttpStatusError(404));
    await expect(withRetries('https://example.invalid/gone.zip', attempt, { wait: nap })).rejects.toThrow(/HTTP 404/);
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(waits).toEqual([]);
  });

  it('names the url in whatever it finally throws', async () => {
    const attempt = vi.fn().mockRejectedValue(new HttpStatusError(404));
    await expect(withRetries('https://example.invalid/gone.zip', attempt, { wait: nap })).rejects.toThrow(
      /example\.invalid\/gone\.zip/,
    );
  });
});
