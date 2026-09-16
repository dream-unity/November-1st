/** Keep setup, access, microphone and transport failures distinct. */
export function realtimeError(message, { code, status, retryable } = {}) {
  return Object.assign(new Error(message), { code, status, retryable });
}

export function describeVoiceError(error = {}) {
  const code = String(error.code || '');
  const message = String(error.message || error || '');
  const name = error.name || '';
  if (
    code === 'VOICE_NOT_CONFIGURED' ||
    /OPENAI_API_KEY.*(?:not set|missing|not configured)/i.test(message)
  ) {
    return {
      label: 'SETUP NEEDED',
      hint: 'The site owner must configure AI voice on the server. The globe and its manual controls remain available.',
      retryable: false,
      unavailable: true,
    };
  }
  if (
    code === 'VOICE_AUTH_REQUIRED' ||
    code === 'PAID_API_AUTH_REQUIRED' ||
    (error.status === 403 && !code)
  ) {
    return {
      label: 'ACCESS REQUIRED',
      hint: 'AI voice is restricted on this deployment. Ask the site owner for access; microphone settings will not resolve this.',
      retryable: false,
      unavailable: true,
    };
  }
  if (
    /VOICE_(?:PROVIDER_AUTH|PROVIDER_ACCESS_DENIED|INVALID_KEY)|invalid_api_key|authentication_error/i.test(
      code,
    ) ||
    error.status === 401 ||
    error.status === 403
  ) {
    return {
      label: 'PROVIDER ACCESS ERROR',
      hint: 'The site owner must check the voice provider credentials and model access on the server.',
      retryable: false,
    };
  }
  if (code === 'VOICE_CONFIGURATION_ERROR') {
    return {
      label: 'VOICE CONFIGURATION ERROR',
      hint: 'The site owner must check the configured voice model and session settings on the server.',
      retryable: false,
    };
  }
  if (/quota|billing|credit|budget/i.test(code + ' ' + message)) {
    return {
      label: 'VOICE LIMIT REACHED',
      hint: 'The voice provider account or spending limit needs attention from the site owner. Repeated connection attempts will not resolve this.',
      retryable: false,
    };
  }
  if (error.status === 429 || /rate.?limit/i.test(code)) {
    return {
      label: 'VOICE BUSY',
      hint: 'The voice request limit was reached. Wait before trying again.',
      retryable: true,
    };
  }
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return {
      label: 'MICROPHONE BLOCKED',
      hint: 'Allow microphone access for this site in your browser settings, then try again.',
      retryable: false,
    };
  }
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
    return {
      label: 'NO MICROPHONE',
      hint: 'Connect or enable a microphone, then try again.',
      retryable: false,
    };
  }
  if (name === 'NotReadableError' || name === 'TrackStartError') {
    return {
      label: 'MICROPHONE UNAVAILABLE',
      hint: 'Another app or your device settings may be blocking the microphone. Check the device and try again.',
      retryable: true,
    };
  }
  if (code === 'VOICE_UNSUPPORTED') {
    return {
      label: 'BROWSER UNSUPPORTED',
      hint: 'Use a browser with WebRTC and microphone support over HTTPS.',
      retryable: false,
    };
  }
  if (
    name === 'TimeoutError' ||
    code === 'VOICE_CONNECTION_TIMEOUT' ||
    code === 'VOICE_PROVIDER_TIMEOUT' ||
    error.status === 504
  ) {
    return {
      label: 'VOICE TIMED OUT',
      hint: 'The voice service did not respond in time. Check the connection and try again.',
      retryable: true,
    };
  }
  if (
    /^VOICE_(?:PROVIDER_UNREACHABLE|PROVIDER_UNAVAILABLE|INVALID_RESPONSE|STATUS_UNAVAILABLE)$/.test(
      code,
    )
  ) {
    return {
      label: 'VOICE SERVICE UNAVAILABLE',
      hint: 'The voice service could not be reached or returned an invalid response. Check the connection and try again later.',
      retryable: true,
    };
  }
  return {
    label: 'VOICE CONNECTION ERROR',
    hint: 'The voice session stopped. Check the reported service or connection error before trying again.',
    retryable: error.retryable !== false,
  };
}
