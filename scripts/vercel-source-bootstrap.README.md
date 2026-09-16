# Pinned source deployment

This script lets a small Vercel file payload build the complete public
`dream-unity/November-1st` checkout. It downloads only the fixed repository at
an exact commit, verifies the SHA-256 of the compressed GitHub archive, validates
the archive, and materialises the source before dependency installation.

Create `deploy-source.json` **outside the committed repository**, for the
deployment payload only:

```json
{
  "repository": "dream-unity/November-1st",
  "commit": "<40 lowercase hexadecimal characters>",
  "archiveSha256": "<64 lowercase hexadecimal characters>"
}
```

Compute the digest from the bytes served by
`https://codeload.github.com/dream-unity/November-1st/tar.gz/<commit>`.
An HTTP error page or a separately generated `git archive` is not the same
archive. Download, check the response, and hash the actual codeload bytes.

Include these files, copied byte-for-byte from that commit, in `files[]`:

- `package.json`
- `package-lock.json`
- `vercel.json`
- `api/[...path].js`
- `scripts/vercel-source-bootstrap.mjs`
- The deployment-only `deploy-source.json`

The API entrypoint and Vercel configuration must be present in the initial
payload for discovery. Hydration compares those initial files with the archive
and fails on a mismatch. It never executes scripts taken from the archive.
The subsequent, explicit `npm ci` and build run the application's normal code.

Commit this package lifecycle script before computing the source pin:

```json
{
  "scripts": {
    "preinstall": "node scripts/vercel-source-bootstrap.mjs"
  }
}
```

Adding this scripts-only entry does not change the lockfile's dependency graph.
Do not add it only to an uploaded wrapper manifest: the initial manifest must
match the committed source. Preserve any other existing lifecycle work when
integrating it. The explicit frontend install command is:

```text
node scripts/vercel-source-bootstrap.mjs && npm ci
```

Vercel's native API functions may use a separate npm installation rather than
the frontend's custom install command. The `preinstall` lifecycle gives those
installations the same hydration step. Builds in a complete Git checkout do
not need `deploy-source.json`; the script checks expected source files and
returns without downloading. Repeated runs with a deployment manifest verify
all recorded source hashes and avoid downloading when they match. Concurrent
local invocations serialise with a directory lock. An interrupted build that
leaves the lock should be retried in a clean deployment directory.

Configure the Vercel function to trace the hydrated `host/`, `server/`, and
required `src/` modules and include runtime-read reference files. Ordinary
static imports are traceable after installation; dynamic file paths need
explicit `functions["api/[...path].js"].includeFiles` patterns. For example,
use the reviewed host's actual data paths rather than shipping credentials or
assuming that a successful frontend build verifies the backend. Inspect a
deployed API response and build logs to verify function inclusion.

Keep `deploy-source.json`, `.vercel-source-manifest.json`, and
`.vercel-source-bootstrap.lock/` out of commits and public build output. The
runtime source includes the full frontend and provider code; the bootstrap is
only a transport mechanism, not a replacement implementation or Git deploy
integration. Later deployments must update both the commit and its checksum.
