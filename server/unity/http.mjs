import { randomUUID } from 'node:crypto';
import { serviceError } from './config.mjs';

const ERROR_MESSAGES = Object.freeze({
  SERVICE_NOT_READY:
    'AI conversation is awaiting private service configuration. You can continue exploring the views and your notes.',
  ACCESS_DENIED:
    'This private invitation or session access is invalid, expired, or revoked. Enter your invitation again.',
  ACCESS_RATE_LIMITED:
    'Too many invitation attempts. Wait a minute before trying again.',
  MODEL_UNAVAILABLE:
    'The provider rejected this deployment’s model access or credentials. The site owner must check the AI service configuration.',
  PROVIDER_RATE_LIMITED:
    'The AI provider is receiving too many requests. Wait briefly before trying again.',
  PROVIDER_CONFIGURATION_ERROR:
    'The AI provider rejected this deployment’s session settings. The site owner must check the model and service configuration.',
  PROVIDER_QUOTA_EXHAUSTED:
    'This deployment has reached its provider credit, spend, or usage allowance. The site owner must check its AI account limits before conversation can continue.',
  PROVIDER_UNAVAILABLE:
    'The AI provider is temporarily unavailable. Try again shortly.',
  PROVIDER_INVALID_RESPONSE:
    'The AI provider returned an invalid reply. No action from that reply was accepted.',
  CREATION_UNCONFIRMED:
    'The voice connection could not be confirmed. Its reserved allowance remains held until cleanup is confirmed; you can continue by writing.',
  VOICE_QUOTA_REACHED:
    'This private preview has reached its voice allowance or active-session limit. Try writing or return later.',
  TEXT_QUOTA_REACHED:
    'This private preview has reached its text allowance. Return later to continue the AI conversation.',
  TURN_CANCELLED: 'This reply was cancelled.',
  TURN_SUPERSEDED: 'A newer intention replaced this reply.',
  TURN_TIMEOUT: 'The AI reply took too long. Try again with a new message.',
  TURN_INCOMPLETE: 'The AI reply did not finish. Try again with a new message.',
  TURN_REFUSED:
    'The AI service could not answer that request. Try phrasing your intention differently.',
  TOOL_BUDGET_EXHAUSTED:
    'This reply reached its action limit. Continue with a new message.',
  CANON_VERSION_MISMATCH:
    'The conversation and published guidance versions differ. Reload this page before reconnecting.',
  BODY_TOO_LARGE:
    'This request is too large. Shorten your message or selected note context.',
  CONTEXT_LIMIT_REACHED:
    'This conversation reached its context limit. Clear the conversation and begin again.',
  INVALID_INPUT:
    'This request did not match the conversation service requirements.',
});

/** Public messages are fixed; upstream bodies and credentials never reach the UI. */
export const serviceMessage = (code) =>
  Object.hasOwn(ERROR_MESSAGES, code)
    ? ERROR_MESSAGES[code]
    : 'The conversation service could not complete this request. Try again with a new message.';

export function sendJSON(res, status, body) {
  if (res.headersSent || res.destroyed) return;
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(body));
}
export function sendError(res, error, requestId = randomUUID()) {
  if (
    typeof requestId !== 'string' ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(
      requestId,
    )
  )
    requestId = randomUUID();
  sendJSON(res, error.status || 500, {
    version: 1,
    requestId,
    code: error.code || 'SERVICE_UNAVAILABLE',
    retryable: Boolean(error.retryable),
    message: serviceMessage(error.code),
  });
}
export async function readJSON(req, maximum) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || ''))
    throw serviceError('INVALID_CONTENT_TYPE', 415);
  const length = Number(req.headers['content-length']);
  if (Number.isFinite(length) && length > maximum)
    throw serviceError('BODY_TOO_LARGE', 413);
  let total = 0;
  const parts = [];
  for await (const part of req) {
    total += part.length;
    if (total > maximum) throw serviceError('BODY_TOO_LARGE', 413);
    parts.push(part);
  }
  try {
    return JSON.parse(Buffer.concat(parts).toString('utf8'));
  } catch {
    throw serviceError('INVALID_INPUT', 400);
  }
}
export function startEvents(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();
  return (event, payload) => {
    if (!res.destroyed && !res.writableEnded)
      res.write(
        `event: ${event}\ndata: ${JSON.stringify({ version: 1, ...payload })}\n\n`,
      );
  };
}
