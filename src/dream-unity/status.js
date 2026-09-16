const STATUS_LABELS = Object.freeze({
  keyless: 'No account needed',
  configured: 'Configured',
  'not-configured': 'Not configured',
  'requires-persistent-service': 'Persistent service needed',
  protected: 'Access protected',
});

export function providerStatusLabel(value) {
  return STATUS_LABELS[value] || 'Status unknown';
}

/** Health confirms our service answered; it does not validate external feeds. */
export async function readDeploymentStatus({
  fetchImpl = (...args) => fetch(...args),
  signal,
} = {}) {
  const scopedSignal = AbortSignal.any(
    [signal, AbortSignal.timeout(10_000)].filter(Boolean),
  );
  const request = async (path) => {
    const response = await fetchImpl(path, {
      signal: scopedSignal,
      cache: 'no-store',
      credentials: 'same-origin',
      redirect: 'error',
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) throw new Error(`Data service HTTP ${response.status}`);
    return response.json();
  };
  const [health, capabilities] = await Promise.all([
    request('/api/health'),
    request('/api/capabilities'),
  ]);
  if (
    health?.status !== 'ok' ||
    health?.service !== 'dream-unity-gods-eye' ||
    !Array.isArray(capabilities?.providers)
  )
    throw new Error('The data service did not return a recognised status');
  return {
    health,
    providers: capabilities.providers.filter(
      (provider) =>
        provider &&
        typeof provider.id === 'string' &&
        typeof provider.label === 'string',
    ),
  };
}

export function startupFailureCopy(error) {
  const message = String(error?.message || error || 'Unknown startup error');
  const causes = Array.isArray(error?.errors)
    ? error.errors.map((cause) => String(cause?.message || cause)).join(' ')
    : '';
  const graphics = /webgl|web gl|graphics context|context creation|gpu/i.test(
    `${message} ${causes}`,
  );
  return {
    title: graphics
      ? 'The 3D globe could not start'
      : 'The globe could not finish loading',
    guidance: graphics
      ? 'This globe needs WebGL graphics. Try reloading, closing other graphics-heavy tabs, or opening this page in another current browser. On a desktop, check that browser hardware acceleration is enabled.'
      : 'Check your connection and reload to try again. If the problem continues, the error details below can help identify it.',
    detail: message,
  };
}
