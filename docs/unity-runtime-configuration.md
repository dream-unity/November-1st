# Dream Unity runtime configuration

The private Unity conversation service requires `UNITY_AI_ENABLED=1`,
`UNITY_OPENAI_API_KEY`, `UNITY_SIGNING_KEY`,
`UNITY_CONTEXT_ENCRYPTION_KEY`, `UNITY_INVITE_HASHES_JSON`, and a complete
Redis REST credential pair. Store these values only in server environment
configuration. They must never use a browser-visible prefix or appear in logs.

Redis credentials are selected in this order:

| Priority | URL variable             | Token variable             |
| -------- | ------------------------ | -------------------------- |
| 1        | `UNITY_REDIS_REST_URL`   | `UNITY_REDIS_REST_TOKEN`   |
| 2        | `UPSTASH_REDIS_REST_URL` | `UPSTASH_REDIS_REST_TOKEN` |
| 3        | `KV_REST_API_URL`        | `KV_REST_API_TOKEN`        |

The first pair with either variable defined is selected as a whole. An empty,
incomplete, invalid, or placeholder value in that pair makes admission unavailable,
even if a lower-priority pair is complete. Remove both higher-priority variables
when deliberately switching to another source. A URL and token from different
families are never combined.

The URL must be an HTTPS root URL without user information, a query, or a fragment.
Use the writable REST token: admission requires atomic Redis scripts and writes.
Read-only tokens and arbitrary custom prefixes are not aliases. If an integration
uses custom names, configure the explicit Unity pair with the corresponding values.

Upstash documents the `UPSTASH_REDIS_REST_*` pair for direct configuration and
the `KV_REST_API_*` pair for its Vercel integration in its
[Next.js guide](https://upstash.com/docs/redis/tutorials/nextjs_with_redis).

`GET /api/unity/status` reports configuration presence only. A ready status does
not prove that Redis is reachable, a provider key is accepted, or paid quota is
available. Verify invitation exchange, a real conversation, and confirmed session
closure after deploying. Keep invitation checks, shared admission, capability
signing, and context encryption enabled during verification.
