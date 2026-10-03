import { randomUUID } from 'node:crypto';
import { serviceError } from './config.mjs';

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
    message: error.code || 'The request could not be completed.',
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
