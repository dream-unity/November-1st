import { serviceError } from './config.mjs';
import { instructions } from './knowledge.mjs';

export function providerParameters(schema) {
  if (Array.isArray(schema)) return schema.map(providerParameters);
  if (!schema || typeof schema !== 'object') return schema;
  const result = {};
  for (const [key, value] of Object.entries(schema)) {
    if (['format', 'uniqueItems', '$schema', 'title'].includes(key)) continue;
    if (key === 'const') result.enum = [value];
    else result[key === 'oneOf' ? 'anyOf' : key] = providerParameters(value);
  }
  return result;
}
function providerError(status, data = {}) {
  if (status === 401 || status === 403)
    return serviceError('MODEL_UNAVAILABLE', 503);
  if (status === 404) return serviceError('MODEL_UNAVAILABLE', 503);
  if (status === 400 || status === 422)
    return serviceError('PROVIDER_CONFIGURATION_ERROR', 503);
  if (status === 429) {
    if (
      [
        'insufficient_quota',
        'billing_hard_limit_reached',
        'billing_not_active',
        'credit_balance_exhausted',
        'organization_spend_limit_exceeded',
        'project_spend_limit_exceeded',
        'organization_usage_limit_exceeded',
      ].includes(data?.error?.code)
    )
      return serviceError('PROVIDER_QUOTA_EXHAUSTED', 429);
    return serviceError('PROVIDER_RATE_LIMITED', 429, true);
  }
  return serviceError('PROVIDER_UNAVAILABLE', 502, true);
}

async function rejectedProvider(response, signal) {
  let data = {};
  if (response.status === 429) {
    try {
      const boundedSignal = AbortSignal.any([
        ...(signal ? [signal] : []),
        AbortSignal.timeout(1000),
      ]);
      data = JSON.parse(await cappedText(response, 8192, boundedSignal));
    } catch {
      /* Classification falls back to the HTTP status; no body is echoed. */
    }
  } else response.body?.cancel().catch(() => {});
  return providerError(response.status, data);
}
async function cappedText(response, max = 512 * 1024, signal) {
  if (!response.body) throw serviceError('PROVIDER_INVALID_RESPONSE', 502);
  const reader = response.body.getReader();
  const abort = () => {
    reader.cancel().catch(() => {});
  };
  signal?.addEventListener('abort', abort, { once: true });
  const parts = [];
  let total = 0;
  try {
    while (true) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      signal?.throwIfAborted();
      if (done) break;
      total += value.byteLength;
      if (total > max) throw serviceError('PROVIDER_INVALID_RESPONSE', 502);
      parts.push(value);
    }
    return Buffer.concat(parts).toString('utf8');
  } finally {
    signal?.removeEventListener('abort', abort);
    // Cancellation closes the reader immediately. Underlying transport cleanup
    // must not hold a completed/aborted request open indefinitely.
    reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export function createOpenAIProvider({ key, fetchImpl = fetch, tools }) {
  const functions = tools.map((tool) => ({
    type: 'function',
    name: tool.name,
    description: `Dream Unity operation ${tool.name}; obey current user intent and application results.`,
    parameters: providerParameters(tool.parameters),
  }));
  return {
    async createRealtime({ sdp, locale, memories, safetyId, signal }) {
      const form = new FormData();
      form.set('sdp', sdp);
      form.set(
        'session',
        JSON.stringify({
          type: 'realtime',
          model: 'gpt-realtime-2.1',
          reasoning: { effort: 'low' },
          instructions: instructions({ locale, memories }),
          audio: {
            input: {
              noise_reduction: { type: 'near_field' },
              transcription: {
                model: 'gpt-4o-mini-transcribe',
                language: 'en',
              },
              turn_detection: {
                type: 'semantic_vad',
                eagerness: 'low',
                create_response: false,
                interrupt_response: true,
              },
            },
            output: { voice: 'marin' },
          },
          truncation: {
            type: 'retention_ratio',
            retention_ratio: 0.5,
            token_limits: { post_instructions: 12000 },
          },
          tools: functions,
          tool_choice: 'auto',
        }),
      );
      let response;
      try {
        response = await fetchImpl('https://api.openai.com/v1/realtime/calls', {
          method: 'POST',
          redirect: 'error',
          headers: {
            Authorization: `Bearer ${key}`,
            'OpenAI-Safety-Identifier': safetyId,
          },
          body: form,
          signal,
        });
      } catch {
        throw serviceError('CREATION_UNCONFIRMED', 504, false);
      }
      if (!response.ok) {
        // A timeout/server failure does not prove that upstream creation never
        // happened. Keep admission held instead of issuing a fresh live slot.
        if (response.status >= 500 || response.status === 408) {
          response.body?.cancel().catch(() => {});
          throw serviceError('CREATION_UNCONFIRMED', 502, false);
        }
        throw Object.assign(await rejectedProvider(response, signal), {
          definitiveNoCall: true,
        });
      }
      const location = response.headers.get('Location');
      let callId;
      try {
        const url = new URL(location, 'https://api.openai.com');
        if (
          url.origin !== 'https://api.openai.com' ||
          url.search ||
          url.hash ||
          !/^\/v1\/realtime\/calls\/[A-Za-z0-9_-]+$/.test(url.pathname)
        )
          throw new Error();
        callId = url.pathname.split('/').at(-1);
      } catch {
        response.body?.cancel().catch(() => {});
        throw serviceError('CREATION_UNCONFIRMED', 502);
      }
      let answer;
      try {
        answer = await cappedText(response, 64 * 1024, signal);
      } catch (error) {
        throw Object.assign(error, { callId });
      }
      if (!answer.startsWith('v=0'))
        throw Object.assign(serviceError('PROVIDER_INVALID_RESPONSE', 502), {
          callId,
        });
      return { sdp: answer, callId };
    },
    async hangup(callId, signal) {
      if (!/^[A-Za-z0-9_-]+$/.test(callId))
        throw serviceError('CONTEXT_UNAVAILABLE', 409);
      const response = await fetchImpl(
        `https://api.openai.com/v1/realtime/calls/${callId}/hangup`,
        {
          method: 'POST',
          redirect: 'error',
          headers: { Authorization: `Bearer ${key}` },
          signal,
        },
      );
      response.body?.cancel().catch(() => {});
      if (response.ok || response.status === 404) return;
      throw providerError(response.status);
    },
    async text({ input, memories, safetyId, signal, onDelta }) {
      const response = await fetchImpl('https://api.openai.com/v1/responses', {
        method: 'POST',
        redirect: 'error',
        signal,
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'gpt-6.1-sol',
          reasoning: { effort: 'low' },
          store: false,
          stream: true,
          include: ['reasoning.encrypted_content'],
          safety_identifier: safetyId,
          instructions: instructions({ memories }),
          input,
          tools: functions.map((tool) => ({ ...tool, strict: true })),
          parallel_tool_calls: false,
          max_output_tokens: 1200,
        }),
      });
      if (!response.ok) {
        throw await rejectedProvider(response, signal);
      }
      if (!response.body) throw serviceError('PROVIDER_INVALID_RESPONSE', 502);
      const reader = response.body.getReader();
      const abort = () => {
        reader.cancel().catch(() => {});
      };
      signal?.addEventListener('abort', abort, { once: true });
      const decoder = new TextDecoder();
      let buffer = '';
      let total = 0;
      let completed = null;
      let terminal = false;
      function consume(block) {
        const data = block
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('\n');
        if (!data || data === '[DONE]') return;
        let event;
        try {
          event = JSON.parse(data);
        } catch {
          throw serviceError('PROVIDER_INVALID_RESPONSE', 502);
        }
        if (
          !event ||
          Array.isArray(event) ||
          typeof event.type !== 'string' ||
          terminal
        )
          throw serviceError('PROVIDER_INVALID_RESPONSE', 502);
        if (event.type === 'response.output_text.delta') {
          if (typeof event.delta !== 'string')
            throw serviceError('PROVIDER_INVALID_RESPONSE', 502);
          onDelta(event.delta);
        }
        if (event.type === 'response.completed') {
          terminal = true;
          completed = event.response;
        }
        if (
          ['response.failed', 'response.incomplete', 'error'].includes(
            event.type,
          )
        )
          throw serviceError('TURN_INCOMPLETE', 502);
      }
      try {
        while (true) {
          signal?.throwIfAborted();
          const { done, value } = await reader.read();
          signal?.throwIfAborted();
          if (done) break;
          total += value.byteLength;
          if (total > 512 * 1024)
            throw serviceError('PROVIDER_INVALID_RESPONSE', 502);
          buffer = (buffer + decoder.decode(value, { stream: true })).replace(
            /\r\n/g,
            '\n',
          );
          let boundary;
          while ((boundary = buffer.indexOf('\n\n')) !== -1) {
            consume(buffer.slice(0, boundary));
            buffer = buffer.slice(boundary + 2);
          }
        }
        buffer += decoder.decode();
        if (buffer.trim()) consume(buffer);
      } finally {
        signal?.removeEventListener('abort', abort);
        reader.cancel().catch(() => {});
        reader.releaseLock();
      }
      if (
        !completed ||
        completed.status !== 'completed' ||
        !Array.isArray(completed.output)
      )
        throw serviceError('TURN_INCOMPLETE', 502);
      if (
        completed.output.some((item) =>
          item.content?.some((part) => part.type === 'refusal'),
        )
      )
        throw serviceError('TURN_REFUSED', 422);
      return completed;
    },
  };
}
