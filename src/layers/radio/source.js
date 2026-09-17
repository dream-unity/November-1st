import { DIRECTORY_ENDPOINT, RADIO_UUID_RE } from './policy.js';

async function requestWithin(signal, timeoutMs, operation) {
  signal?.throwIfAborted();
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(
    () =>
      controller.abort(
        new DOMException('Radio request timed out', 'TimeoutError'),
      ),
    timeoutMs,
  );
  timer?.unref?.();
  try {
    const result = await operation(controller.signal);
    controller.signal.throwIfAborted();
    return result;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}

/** Supply directory metadata and click reporting; audio stays with the broadcaster. */
export function createRadioSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  return {
    async getDirectory({ signal } = {}) {
      return requestWithin(signal, 60_000, async (requestSignal) => {
        const response = await fetchImpl(DIRECTORY_ENDPOINT, {
          signal: requestSignal,
        });
        if (!response.ok)
          throw new Error(`Radio directory returned ${response.status}`);
        return response.json();
      });
    },
    async recordClick(id, { signal } = {}) {
      if (typeof id !== 'string' || !RADIO_UUID_RE.test(id))
        throw new Error('Invalid radio station id');
      return requestWithin(signal, 10_000, async (requestSignal) => {
        const response = await fetchImpl(
          `/api/radio/click/${encodeURIComponent(id)}`,
          { method: 'POST', signal: requestSignal },
        );
        if (!response.ok)
          throw new Error(`Radio click returned ${response.status}`);
      });
    },
  };
}
