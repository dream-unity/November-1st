const STATUS_LABELS = Object.freeze({
  keyless: 'No account needed',
  configured: 'Configured',
  'not-configured': 'Not configured',
  'requires-persistent-service': 'Persistent service needed',
  protected: 'Access protected',
});

export function providerStatusLabel(value) {
  return Object.hasOwn(STATUS_LABELS, value)
    ? STATUS_LABELS[value]
    : 'Status unknown';
}

/** Keep setup/access instructions visible alongside configuration metadata. */
export function providerStatusDetails(provider) {
  return [...new Set([provider?.message, provider?.guidance, provider?.detail])]
    .filter((value) => typeof value === 'string' && value.trim())
    .map((value) => value.trim());
}

export function deploymentStatusFailureCopy(error) {
  if (error?.status === 401 || error?.status === 403)
    return 'Source configuration requires access to this deployment. Ask the site owner for access, then check again.';
  if (error?.status === 404)
    return 'This deployment does not expose source configuration. Individual map layers report their own availability.';
  if (error?.name === 'TimeoutError')
    return 'The source status check timed out. The service may be busy; check again shortly.';
  if (error?.code === 'INVALID_STATUS')
    return 'The data service returned an unrecognised status. Reload the page and check again; if this continues, the deployment needs attention.';
  if (Number.isInteger(error?.status))
    return `The source status service returned HTTP ${error.status}. Check again shortly; individual map layers report their own availability.`;
  return 'Source status could not be checked. Check your connection and try again; individual map layers report their own availability.';
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
    if (!response.ok)
      throw Object.assign(new Error(`Data service HTTP ${response.status}`), {
        status: response.status,
      });
    try {
      return await response.json();
    } catch (error) {
      if (scopedSignal.aborted) throw scopedSignal.reason;
      throw Object.assign(new Error('The data service returned invalid JSON'), {
        code: 'INVALID_STATUS',
        cause: error,
      });
    }
  };
  const [health, capabilities] = await Promise.all([
    request('/api/health'),
    request('/api/capabilities'),
  ]);
  if (
    health?.status !== 'ok' ||
    health?.service !== 'dream-unity-gods-eye' ||
    !Array.isArray(capabilities?.providers) ||
    !capabilities.providers.length ||
    capabilities.providers.some(
      (provider) =>
        !provider ||
        typeof provider.id !== 'string' ||
        !provider.id.trim() ||
        typeof provider.label !== 'string' ||
        !provider.label.trim() ||
        typeof provider.status !== 'string',
    )
  )
    throw Object.assign(
      new Error('The data service did not return a recognised status'),
      {
        code: 'INVALID_STATUS',
      },
    );
  return {
    health,
    providers: capabilities.providers,
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
      : 'Reload to try again. If the problem continues, share the error details below so the startup failure can be identified.',
    detail: causes ? `${message}\n${causes}` : message,
  };
}
