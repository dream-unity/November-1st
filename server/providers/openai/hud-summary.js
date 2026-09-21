import { keylessHudSummaryResponse } from '../../../src/hudSummaryResponse.js';
import { enforceOptInRateLimit, openAiRateLimiter } from './rate-limit.js';
import { OPENAI_HUD_SUMMARY_MODEL_DEFAULT } from './constants.js';
import {
  configuredCredential,
  voiceProviderFailure,
  sendVoiceJson,
} from './status.js';
import { readResponseTextCapped } from '../common/http.js';

function extractOpenAiResponseText(data) {
  if (typeof data?.output_text === 'string' && data.output_text.trim()) {
    return data.output_text.trim();
  }
  if (!Array.isArray(data?.output)) return '';
  return data.output
    .flatMap((item) => (Array.isArray(item?.content) ? item.content : []))
    .map((part) => part?.text || part?.output_text || '')
    .join(' ')
    .trim();
}

function toFiveWordHudSummary(value) {
  return String(value || '')
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 5)
    .join(' ');
}

/** Drain oversized requests without destroying the socket before a 413 can be delivered. */
function readHudBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let settled = false;
    const chunks = [];
    const cleanup = () => {
      req.removeListener('data', onData);
      req.removeListener('end', onEnd);
      req.removeListener('error', onError);
      req.removeListener('aborted', onAbort);
    };
    const fail = (code) => {
      if (settled) return;
      settled = true;
      cleanup();
      const error = new Error(code);
      error.code = code;
      // The caller may disconnect while an oversized body is being drained.
      // Keep an error listener until close so that expected socket errors do
      // not become an uncaught exception after this promise has rejected.
      const drainError = () => {};
      req.on('error', drainError);
      req.once('close', () => req.removeListener('error', drainError));
      req.resume?.();
      reject(error);
    };
    const onData = (value) => {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      size += chunk.length;
      if (size > limit) return fail('BODY_TOO_LARGE');
      chunks.push(chunk);
    };
    const onEnd = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(Buffer.concat(chunks).toString('utf8'));
    };
    const onError = () => fail('BODY_READ_ERROR');
    const onAbort = () => fail('BODY_READ_ERROR');
    if (Number(req.headers?.['content-length']) > limit)
      return fail('BODY_TOO_LARGE');
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
    req.on('aborted', onAbort);
  });
}

async function handleHudSummary(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return sendVoiceJson(res, 405, { error: 'Method not allowed' });
  }

  const apiKey = String(process.env.OPENAI_API_KEY ?? '').trim();
  const keyless = keylessHudSummaryResponse(
    configuredCredential(apiKey) ? apiKey : '',
  );
  if (keyless) return sendVoiceJson(res, keyless.statusCode, keyless.payload);

  // Missing configuration returns the existing successful local HUD fallback.
  if (!enforceOptInRateLimit(openAiRateLimiter(), req, res)) return;

  let context;
  try {
    const body = await readHudBody(req);
    context = JSON.parse(body || '{}');
    if (!context || typeof context !== 'object' || Array.isArray(context))
      throw new SyntaxError();
  } catch (error) {
    const tooLarge = error?.code === 'BODY_TOO_LARGE';
    return sendVoiceJson(res, tooLarge ? 413 : 400, {
      error: tooLarge
        ? 'HUD context exceeds the request size limit.'
        : 'HUD context must be a valid JSON object.',
      code: tooLarge ? 'BODY_TOO_LARGE' : 'INVALID_REQUEST',
      retryable: false,
    });
  }

  try {
    const signal = AbortSignal.timeout(30_000);
    const response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      redirect: 'error',
      signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model:
          process.env.OPENAI_HUD_SUMMARY_MODEL ||
          OPENAI_HUD_SUMMARY_MODEL_DEFAULT,
        instructions: [
          "Write one concise intelligence-HUD summary for God's Earth View.",
          'Use only the supplied place, street, nearby-place, and enabled-layer text labels.',
          'Prefer the clearest named place and include a relevant enabled layer only when useful.',
          'Do not infer from coordinates or invent a place.',
          'Output exactly five words with no title, punctuation, markdown, or introductory phrase.',
        ].join(' '),
        input: JSON.stringify(context),
        reasoning: { effort: 'minimal' },
        max_output_tokens: 100,
      }),
    });
    const responseText = await readResponseTextCapped(
      response,
      128 * 1024,
      signal,
    );
    let data;
    try {
      data = JSON.parse(responseText);
    } catch {
      data = null;
    }
    if (!response.ok)
      return sendVoiceJson(res, response.status === 429 ? 429 : 502, {
        summary: null,
        ...voiceProviderFailure(response.status, data),
      });
    const summary = toFiveWordHudSummary(extractOpenAiResponseText(data));
    if (!summary)
      return sendVoiceJson(res, 502, {
        summary: null,
        error: 'The AI summary provider returned no usable summary.',
        code: 'HUD_INVALID_RESPONSE',
        retryable: true,
      });
    return sendVoiceJson(res, 200, { summary, error: null });
  } catch (error) {
    if (error?.code === 'RESPONSE_TOO_LARGE')
      return sendVoiceJson(res, 502, {
        code: 'HUD_INVALID_RESPONSE',
        retryable: true,
        error: 'The AI summary provider returned an oversized response.',
      });
    const timedOut =
      error?.name === 'TimeoutError' || error?.name === 'AbortError';
    return sendVoiceJson(res, timedOut ? 504 : 502, {
      error: timedOut
        ? 'The AI summary provider took too long to respond.'
        : 'The AI summary provider could not be reached.',
      code: timedOut ? 'HUD_PROVIDER_TIMEOUT' : 'HUD_PROVIDER_UNREACHABLE',
      retryable: true,
    });
  }
}

export { handleHudSummary };
