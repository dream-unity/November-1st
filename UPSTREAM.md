# Upstream provenance

November-1st contains the complete God's Eye View source from
https://github.com/bilawalsidhu/gods-eye-view at commit
`0d41b6be5490db1f10a171f238be75db4d4ec3b4` (version 0.1.1).

The original layers, aircraft models, cockpit, contacts, camera systems,
annotations, director, voice modules and source/provider architecture remain.
No remote copy of the previous small Vercel application's app.js is loaded.

Dream Unity additions are the production host (`host/`), serverless entry
(`api/`), browser navigation/status (`src/dream-unity/`), production build
configuration, deployment metadata, container and verification workflows.

Source code retains its original MIT notice in LICENSE. Third-party datasets,
models and media retain their own licences and attribution. See DATA_SOURCES.md
and public/models/README.md. Their licences are not replaced by MIT.

Software inclusion is distinct from configured provider access. AIS, FIRMS,
TomTom, photorealistic imagery and AI features retain their upstream account/key
requirements. Vercel hosting uses request/response provider routes; AIS ingestion
requires the persistent host or an explicitly configured persistent AIS service.

For updates, review an immutable upstream commit, retain this record and run
the upstream tests plus production-host tests. Do not replace the full app with
the former six-layer implementation or load executable source from moving URLs.
