/** Presence validation only; this never authenticates with a paid provider. */
export function configuredCredential(value) {
  const text = String(value ?? '').trim();
  return (
    text.length > 0 &&
    !/^(?:your[ _-]|replace[ _-]|example(?:$|[ _-])|changeme$|change_me$|paste[ _-]|<.*>$)/i.test(
      text,
    ) &&
    !/[\s\u0000-\u001f\u007f]/.test(text)
  );
}

export function voiceAvailability({ apiKey, authorized = true } = {}) {
  const configured = configuredCredential(apiKey);
  if (!configured)
    return {
      available: false,
      configured: false,
      status: 'not-configured',
      code: 'VOICE_NOT_CONFIGURED',
      message:
        'AI voice has not been enabled on this deployment. The site owner must configure the OpenAI service; your microphone is not the problem.',
      retryable: false,
    };
  if (!authorized)
    return {
      available: false,
      configured: true,
      status: 'protected',
      code: 'VOICE_AUTH_REQUIRED',
      message:
        'AI voice requires access to this deployment. Sign in before starting voice.',
      retryable: false,
    };
  return {
    available: true,
    configured: true,
    status: 'configured',
    code: 'VOICE_READY',
    message:
      'AI voice is configured. Provider access and microphone permission are checked when a session starts.',
    retryable: true,
  };
}

export function sendVoiceJson(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(payload));
}

export function createRealtimeStatusHandler({
  resolveApiKey = () => process.env.OPENAI_API_KEY,
} = {}) {
  return (req, res) => {
    if (!['GET', 'HEAD'].includes(req.method)) {
      res.setHeader('Allow', 'GET, HEAD');
      return sendVoiceJson(res, 405, {
        error: 'Method not allowed',
        code: 'METHOD_NOT_ALLOWED',
      });
    }
    return sendVoiceJson(
      res,
      200,
      voiceAvailability({ apiKey: resolveApiKey() }),
    );
  };
}

/** Errors are actionable without echoing provider bodies, URLs or credentials. */
export function voiceProviderFailure(status, data = {}) {
  const code = data?.error?.code;
  if (status === 401 || status === 403)
    return {
      code: 'VOICE_PROVIDER_ACCESS_DENIED',
      retryable: false,
      error:
        'The voice provider rejected this deployment’s credentials or permissions. The site owner must check the OpenAI service configuration.',
    };
  if (
    status === 429 &&
    [
      'insufficient_quota',
      'billing_hard_limit_reached',
      'billing_not_active',
    ].includes(code)
  )
    return {
      code: 'VOICE_QUOTA_EXHAUSTED',
      retryable: false,
      error:
        'The deployment’s voice allowance is exhausted. The site owner must check the provider quota or billing.',
    };
  if (status === 429)
    return {
      code: 'VOICE_RATE_LIMITED',
      retryable: true,
      error:
        'The voice service is receiving too many requests. Wait briefly before trying again.',
    };
  if (status >= 400 && status < 500)
    return {
      code: 'VOICE_CONFIGURATION_ERROR',
      retryable: false,
      error:
        'The voice provider rejected the session configuration. The site owner must check the model and voice settings.',
    };
  return {
    code: 'VOICE_PROVIDER_UNAVAILABLE',
    retryable: true,
    error: 'The voice provider is temporarily unavailable. Try again shortly.',
  };
}
