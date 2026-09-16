import { DEFAULT_VOICE_TIER, resolveVoiceModel } from './voiceCost.js';
import { realtimeError } from './realtimeErrors.js';

/** Realtime-compatible token and SDP requests, independent of microphone/UI ownership. */
export function createRealtimeBackend({
  tokenEndpoint = '/api/realtime/token',
  statusEndpoint = '/api/realtime/status',
  callsEndpoint = 'https://api.openai.com/v1/realtime/calls',
  tokenTransport = (...args) => fetch(...args),
  statusTransport = (...args) => tokenTransport(...args),
  connectionTransport = (...args) => fetch(...args),
  timeoutMs = 30_000,
  signal: lifetime,
} = {}) {
  const scoped = (signal) =>
    AbortSignal.any(
      [lifetime, signal, AbortSignal.timeout(timeoutMs)].filter(Boolean),
    );
  return Object.freeze({
    protocol: 'openai-realtime',
    async requestAvailability({ signal } = {}) {
      signal = scoped(signal);
      signal.throwIfAborted();
      const response = await statusTransport(statusEndpoint, {
        signal,
        cache: 'no-store',
        redirect: 'error',
      });
      const data = await response.json().catch(() => null);
      signal.throwIfAborted();
      if (!response.ok || typeof data?.available !== 'boolean') {
        throw realtimeError('Could not check AI voice availability.', {
          code: data?.code || 'VOICE_STATUS_UNAVAILABLE',
          status: response.status,
          retryable: true,
        });
      }
      return data;
    },
    async requestToken({ tier = DEFAULT_VOICE_TIER, signal } = {}) {
      signal = scoped(signal);
      signal.throwIfAborted();
      const separator = tokenEndpoint.includes('?') ? '&' : '?';
      const url = `${tokenEndpoint}${separator}tier=${encodeURIComponent(resolveVoiceModel(tier).tier)}`;
      const response = await tokenTransport(url, {
        signal,
        cache: 'no-store',
        redirect: 'error',
      });
      signal.throwIfAborted();
      const data = await response.json().catch(() => null);
      signal.throwIfAborted();
      if (!response.ok) {
        const reason =
          typeof data?.error === 'string' ? data.error : data?.error?.message;
        throw realtimeError(
          reason || `Realtime token failed: HTTP ${response.status}`,
          {
            code: data?.code || data?.error?.code,
            status: response.status,
            retryable: data?.retryable,
          },
        );
      }
      const token =
        data?.value || data?.client_secret?.value || data?.client_secret;
      if (typeof token !== 'string' || !token)
        throw new Error(
          'Realtime token response did not include a client secret',
        );
      const expiresAt = data?.expires_at ?? data?.client_secret?.expires_at;
      if (
        expiresAt != null &&
        (!Number.isFinite(expiresAt) || expiresAt * 1000 <= Date.now())
      )
        throw new Error(
          'Realtime client secret has expired; reconnect to request a new one',
        );
      return {
        token,
        model:
          response.headers?.get?.('X-GEV-Voice-Model') ||
          data?.session?.model ||
          null,
        tier: response.headers?.get?.('X-GEV-Voice-Tier') || null,
        expiresAt,
      };
    },
    async negotiate({ offerSdp, credential, signal }) {
      signal = scoped(signal);
      signal.throwIfAborted();
      if (
        credential.expiresAt != null &&
        credential.expiresAt * 1000 <= Date.now()
      )
        throw new Error(
          'Realtime client secret has expired; reconnect to request a new one',
        );
      const response = await connectionTransport(callsEndpoint, {
        method: 'POST',
        body: offerSdp,
        signal,
        redirect: 'error',
        cache: 'no-store',
        headers: {
          Authorization: `Bearer ${credential.token}`,
          'Content-Type': 'application/sdp',
        },
      });
      signal.throwIfAborted();
      if (!response.ok) {
        await response.body?.cancel?.().catch(() => {});
        throw realtimeError(`Realtime SDP failed: HTTP ${response.status}`, {
          code: 'VOICE_SDP_FAILED',
          status: response.status,
        });
      }
      const answer = await response.text();
      signal.throwIfAborted();
      return answer;
    },
  });
}
