import test from 'node:test';
import assert from 'node:assert/strict';
import { createOpenAIProvider } from './provider.mjs';
import { toolDefinitions } from './contracts.mjs';

test('unified SDP fixes model, server instructions, interruption and secret boundary', async () => {
  let seen;
  const provider = createOpenAIProvider({
    key: 'test-server-key',
    tools: toolDefinitions.tools,
    fetchImpl: async (url, options) => {
      seen = { url, options };
      return new Response('v=0\nanswer', {
        status: 201,
        headers: { Location: '/v1/realtime/calls/rtc_owned' },
      });
    },
  });
  const result = await provider.createRealtime({
    sdp: 'v=0\noffer',
    locale: 'en-AU',
    memories: [],
    safetyId: 'hashed-test-id',
  });
  assert.equal(seen.url, 'https://api.openai.com/v1/realtime/calls');
  assert.equal(seen.options.headers.Authorization, 'Bearer test-server-key');
  const session = JSON.parse(seen.options.body.get('session'));
  assert.equal(session.model, 'gpt-realtime-2.1');
  assert.equal(session.audio.output.voice, 'marin');
  assert.equal(session.audio.input.turn_detection.interrupt_response, true);
  assert.equal(session.audio.input.turn_detection.create_response, false);
  assert.deepEqual(session.audio.input.transcription, {
    model: 'gpt-4o-mini-transcribe',
    language: 'en',
  });
  assert.match(
    session.instructions,
    /Responsibility follows participation|suffering does not establish/,
  );
  assert.match(session.instructions, /Published grounding/);
  assert.equal(session.tools.length, toolDefinitions.tools.length);
  assert.equal(result.callId, 'rtc_owned');
  assert.equal(result.sdp, 'v=0\nanswer');
  assert.doesNotMatch(JSON.stringify(session), /test-server-key/);
});

test('untrusted Location is never accepted as an owned cleanup destination', async () => {
  const provider = createOpenAIProvider({
    key: 'test-server-key',
    tools: [],
    fetchImpl: async () =>
      new Response('v=0\nanswer', {
        status: 201,
        headers: {
          Location: 'https://evil.invalid/v1/realtime/calls/rtc_other',
        },
      }),
  });
  await assert.rejects(
    provider.createRealtime({ sdp: 'v=0\noffer', memories: [] }),
    { code: 'CREATION_UNCONFIRMED' },
  );
});

test('Responses parses fragmented SSE, fixes stateless reasoning/tool bounds and never executes partial tools', async () => {
  let seen;
  const output = {
    type: 'response.completed',
    response: {
      status: 'completed',
      output: [
        {
          type: 'function_call',
          name: 'navigate',
          call_id: 'c1',
          arguments: '{"destination":"earth"}',
        },
      ],
      usage: { input_tokens: 4, output_tokens: 6 },
    },
  };
  const payload = `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'Opening' })}\r\n\r\ndata: ${JSON.stringify(output)}\r\n\r\n`;
  const bytes = new TextEncoder().encode(payload);
  const stream = new ReadableStream({
    start(controller) {
      for (let i = 0; i < bytes.length; i += 7)
        controller.enqueue(bytes.slice(i, i + 7));
      controller.close();
    },
  });
  const provider = createOpenAIProvider({
    key: 'test-server-key',
    tools: toolDefinitions.tools,
    fetchImpl: async (url, options) => {
      seen = { url, body: JSON.parse(options.body) };
      return new Response(stream);
    },
  });
  const deltas = [];
  const result = await provider.text({
    input: [{ role: 'user', content: 'Open Earth' }],
    memories: [],
    safetyId: 'test-hash',
    onDelta: (text) => deltas.push(text),
  });
  assert.deepEqual(deltas, ['Opening']);
  assert.equal(result.output[0].call_id, 'c1');
  assert.equal(seen.url, 'https://api.openai.com/v1/responses');
  assert.equal(seen.body.model, 'gpt-6.1-sol');
  assert.deepEqual(seen.body.reasoning, { effort: 'low' });
  assert.equal(seen.body.store, false);
  assert.deepEqual(seen.body.include, ['reasoning.encrypted_content']);
  assert.equal(seen.body.max_output_tokens, 1200);
  assert.equal(seen.body.parallel_tool_calls, false);
  assert.equal(
    seen.body.tools.every((tool) => tool.strict === true),
    true,
  );
  assert.doesNotMatch(
    JSON.stringify(seen.body.tools),
    /"format"|"const"|"uniqueItems"/,
  );
});

test('incomplete and malformed provider streams fail explicitly', async () => {
  const provider = createOpenAIProvider({
    key: 'test-server-key',
    tools: [],
    fetchImpl: async () =>
      new Response('data: {"type":"response.incomplete"}\n\n'),
  });
  await assert.rejects(
    provider.text({ input: [], memories: [], onDelta() {} }),
    { code: 'TURN_INCOMPLETE' },
  );
});

test('an upstream creation failure cannot claim that no call was created', async () => {
  const provider = createOpenAIProvider({
    key: 'test-server-key',
    tools: [],
    fetchImpl: async () => new Response('', { status: 500 }),
  });
  await assert.rejects(
    provider.createRealtime({ sdp: 'v=0\noffer', memories: [] }),
    (error) => error.code === 'CREATION_UNCONFIRMED' && !error.definitiveNoCall,
  );
});

test('rejecting a provider event cancels the unread upstream response body', async () => {
  let cancelled = false;
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(
        new TextEncoder().encode('data: {"type":"response.incomplete"}\n\n'),
      );
    },
    cancel() {
      cancelled = true;
    },
  });
  const provider = createOpenAIProvider({
    key: 'test-server-key',
    tools: [],
    fetchImpl: async () => new Response(stream),
  });
  await assert.rejects(
    provider.text({ input: [], memories: [], onDelta() {} }),
    { code: 'TURN_INCOMPLETE' },
  );
  assert.equal(cancelled, true);
});
