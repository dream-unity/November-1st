/**
 * Optional HUD enrichment belongs to an explicitly connected legacy voice
 * session. Public configuration is checked separately; a key's presence alone
 * does not grant this browser access to paid providers.
 */
export function createHudSummaryPolicy({
  getVoice,
  signal,
  fetchImpl = (...args) => fetch(...args),
  isVisible = () => globalThis.document?.hidden !== true,
} = {}) {
  return {
    async authorize() {
      const voice = getVoice?.();
      const session = voice?.session;
      const peer = voice?.pc;
      const channel = voice?.dc;
      const epoch = voice?.startEpoch;
      const isCurrent = () =>
        !signal?.aborted &&
        !session?.signal?.aborted &&
        !voice?.lifetimeSignal?.aborted &&
        isVisible() &&
        voice != null &&
        getVoice?.() === voice &&
        voice.session === session &&
        session?.isActive?.() === true &&
        !session.disposed &&
        voice.isSessionEnding?.() !== true &&
        !['idle', 'error', 'connecting'].includes(session.state) &&
        voice.startEpoch === epoch &&
        voice.pc === peer &&
        peer?.connectionState === 'connected' &&
        voice.dc === channel &&
        channel?.readyState === 'open';
      if (!isCurrent()) return null;
      try {
        const response = await fetchImpl('/api/capabilities', {
          method: 'GET',
          credentials: 'same-origin',
          cache: 'no-store',
          redirect: 'error',
          headers: { Accept: 'application/json' },
          signal: AbortSignal.any(
            [signal, session.signal, AbortSignal.timeout(5000)].filter(Boolean),
          ),
        });
        if (!isCurrent() || !response.ok) return null;
        const data = await response.json();
        if (!isCurrent() || !Array.isArray(data?.providers)) return null;
        const voiceProviders = data.providers.filter(
          (item) => item?.id === 'voice',
        );
        const availability = voiceProviders[0];
        if (
          voiceProviders.length !== 1 ||
          availability?.status !== 'configured' ||
          availability.configured !== true ||
          availability.available !== true
        )
          return null;
        const places = data.providers.filter((item) => item?.id === 'google');
        return {
          isCurrent,
          // Google reports request authorization through its status. Protected,
          // unknown and missing configuration may use cached/local labels only.
          contextOptions: {
            cachedOnly: !(
              places.length === 1 && places[0].status === 'configured'
            ),
          },
        };
      } catch {
        return null;
      }
    },
  };
}
