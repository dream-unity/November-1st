/** Remove only the redundant parameter produced by /api/:path* -> /api.
 * Preserve the original path and all application query values for provider
 * validation. Vercel forwards unused rewrite captures as query parameters. */
export function originalProviderRequestUrl(value) {
  if (typeof value !== 'string' || !value.startsWith('/api/')) return value;
  const separator = value.indexOf('?');
  if (separator < 0) return value;
  const pathname = value.slice(0, separator);
  const query = new URLSearchParams(value.slice(separator + 1));
  let captured;
  try {
    captured = decodeURIComponent(pathname.slice('/api/'.length));
  } catch {
    return value;
  }
  if (query.getAll('path').length !== 1 || query.get('path') !== captured)
    return value;
  query.delete('path');
  const remaining = query.toString();
  return pathname + (remaining ? `?${remaining}` : '');
}
