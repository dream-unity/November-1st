import { enforceOptInRateLimit, openAiRateLimiter } from './rate-limit.js';
import {
  resolveVoiceModel,
  isKnownVoiceTier,
} from '../../../src/voice/voiceCost.js';
import {
  OPENAI_REALTIME_MODEL_MINI_DEFAULT,
  OPENAI_REALTIME_MODEL_DEFAULT,
  OPENAI_REALTIME_VOICE_DEFAULT,
  OPENAI_REALTIME_REASONING_DEFAULT,
  OPENAI_REALTIME_CONTEXT_TOKENS_DEFAULT,
  OPENAI_REALTIME_CONTEXT_RETENTION_DEFAULT,
} from './constants.js';
import { realtimeInstructions } from './instructions.js';
import { GEV_REALTIME_TOOLS } from './tools.js';
import {
  voiceAvailability,
  voiceProviderFailure,
  sendVoiceJson,
} from './status.js';
import { readResponseTextCapped } from '../common/http.js';

function createRealtimeTokenHandler({
  annotationGuidance,
  endpoint = 'https://api.openai.com/v1/realtime/client_secrets',
  fetchImpl = (...args) => fetch(...args),
  resolveApiKey = () => process.env.OPENAI_API_KEY,
  models = {},
} = {}) {
  return async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (req.method !== 'GET' && req.method !== 'POST') {
      res.statusCode = 405;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'Method not allowed' }));
      return;
    }

    const apiKey = String(resolveApiKey() ?? '').trim();
    const availability = voiceAvailability({ apiKey });
    if (!availability.available) {
      return sendVoiceJson(res, 503, {
        ...availability,
        error: availability.message,
      });
    }

    // Missing configuration must not consume a quota reserved for real calls.
    if (!enforceOptInRateLimit(openAiRateLimiter(), req, res)) return;

    // Voice model tier, requested by the client as ?tier=standard|mini.
    // resolveVoiceModel is total: an unknown, empty, or hostile value
    // resolves to `standard` instead of reaching OpenAI as a model id, so a
    // bad querystring degrades to a normal session rather than a dead mic.
    // The env overrides stay authoritative per tier (see .env.example) —
    // a wrong upstream model id is then a config fix, not a code change.
    const requestedTier = (() => {
      try {
        return new URL(req.url || '', 'http://localhost').searchParams.get(
          'tier',
        );
      } catch {
        return null;
      }
    })();
    const tier = resolveVoiceModel(requestedTier).tier;
    const model =
      tier === 'mini'
        ? models.mini ||
          process.env.OPENAI_REALTIME_MODEL_MINI ||
          OPENAI_REALTIME_MODEL_MINI_DEFAULT
        : models.standard ||
          process.env.OPENAI_REALTIME_MODEL ||
          OPENAI_REALTIME_MODEL_DEFAULT;
    const voice =
      process.env.OPENAI_REALTIME_VOICE || OPENAI_REALTIME_VOICE_DEFAULT;
    const effort =
      process.env.OPENAI_REALTIME_REASONING_EFFORT ||
      OPENAI_REALTIME_REASONING_DEFAULT;
    const contextTokenLimit = Math.round(
      Math.max(
        1000,
        Math.min(
          12000,
          Number(process.env.OPENAI_REALTIME_CONTEXT_TOKENS) ||
            OPENAI_REALTIME_CONTEXT_TOKENS_DEFAULT,
        ),
      ),
    );
    const contextRetentionRatio = Math.max(
      0.1,
      Math.min(
        1,
        Number(process.env.OPENAI_REALTIME_CONTEXT_RETENTION) ||
          OPENAI_REALTIME_CONTEXT_RETENTION_DEFAULT,
      ),
    );
    const sessionConfig = {
      session: {
        type: 'realtime',
        model,
        reasoning: { effort },
        truncation: {
          type: 'retention_ratio',
          retention_ratio: contextRetentionRatio,
          token_limits: {
            post_instructions: contextTokenLimit,
          },
        },
        audio: {
          input: {
            noise_reduction: { type: 'near_field' },
            turn_detection: {
              type: 'semantic_vad',
              eagerness: 'low',
              create_response: true,
              interrupt_response: false,
            },
          },
          output: { voice },
        },
        instructions: realtimeInstructions(annotationGuidance),
        tools: GEV_REALTIME_TOOLS,
        tool_choice: 'auto',
      },
    };

    try {
      const signal = AbortSignal.timeout(30_000);
      const response = await fetchImpl(endpoint, {
        method: 'POST',
        redirect: 'error',
        signal,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'OpenAI-Safety-Identifier': 'gev-local-dev',
        },
        body: JSON.stringify(sessionConfig),
      });
      const body = await readResponseTextCapped(response, 256 * 1024, signal);
      let data;
      try {
        data = JSON.parse(body);
      } catch {
        data = null;
      }
      if (!response.ok) {
        const failure = voiceProviderFailure(response.status, data);
        const status = response.status === 429 ? 429 : 502;
        if (status === 429) res.setHeader('Retry-After', '30');
        return sendVoiceJson(res, status, failure);
      }
      const token = data?.value ?? data?.client_secret?.value;
      if (typeof token !== 'string' || !/^[!-~]{1,4096}$/.test(token)) {
        return sendVoiceJson(res, 502, {
          code: 'VOICE_INVALID_RESPONSE',
          retryable: true,
          error:
            'The voice provider returned an invalid session response. Try again shortly.',
        });
      }
      res.statusCode = response.status;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      // Which tier/model this secret was actually minted for. The upstream
      // body is passed through untouched (the client parses it verbatim), so
      // these headers are the authoritative echo — including the case where a
      // bogus ?tier= was silently downgraded to standard.
      res.setHeader('X-GEV-Voice-Tier', tier);
      res.setHeader('X-GEV-Voice-Model', model);
      if (requestedTier && !isKnownVoiceTier(requestedTier)) {
        res.setHeader('X-GEV-Voice-Tier-Fallback', '1');
      }
      res.end(body);
    } catch (error) {
      if (error?.code === 'RESPONSE_TOO_LARGE')
        return sendVoiceJson(res, 502, {
          code: 'VOICE_INVALID_RESPONSE',
          retryable: true,
          error:
            'The voice provider returned an oversized session response. Try again shortly.',
        });
      const timedOut =
        error?.name === 'TimeoutError' || error?.name === 'AbortError';
      return sendVoiceJson(res, timedOut ? 504 : 502, {
        code: timedOut
          ? 'VOICE_PROVIDER_TIMEOUT'
          : 'VOICE_PROVIDER_UNREACHABLE',
        retryable: true,
        error: timedOut
          ? 'The voice provider took too long to respond. Try again shortly.'
          : 'The server could not reach the voice provider. Try again shortly.',
      });
    }
  };
}

export { createRealtimeTokenHandler };
