# v1.4.8.1 Gemini API compatibility

Verified against Google's official documentation on 2026-10-11:

- [Release notes](https://ai.google.dev/gemini-api/docs/changelog): October 8 redirects `gemini-3.7-flash` to `gemini-3.8-flash`, and `gemini-3.5-flash` to `gemini-3.6-flash`. Sampling deprecation appears in the July 21 release notes.
- [Latest model](https://ai.google.dev/gemini-api/docs/latest-model): use thinking levels; omit deprecated sampling controls. Gemini 3.8 Flash supports low/medium/high, not minimal.
- [GenerateContent thinking](https://ai.google.dev/gemini-api/docs/generate-content/thinking): legacy thinking budgets may still be accepted for backward compatibility; this application sends only capability-approved thinking levels.
- [3.7 model](https://ai.google.dev/gemini-api/docs/models/gemini-3.7-flash) and [3.5 guide](https://ai.google.dev/gemini-api/docs/whats-new-gemini-3.5): confirm the official redirects.
- [Interactions overview](https://ai.google.dev/gemini-api/docs/interactions-overview) and [migration guide](https://ai.google.dev/gemini-api/docs/migrate-to-interactions): Interactions is GA and recommended, GenerateContent remains supported, and custom Safety Settings are not yet available in Interactions.

## Contract

`shared/models.js` owns the two fixed redirects. Active catalog options omit these legacy aliases, including cached and refreshed Models API results. Historical metadata remains loadable and displays the target. Alias capabilities are inherited from the target's curated metadata.

Stored Chat/variant IDs, Default Model preferences, Backup V1 and MAICFG1 are preserved. Only validated provider request assembly canonicalizes the model ID. The default product model is unchanged. Both stream and memory extraction use GenerateContent; no probe generation or additional provider call is introduced.

Thinking and deprecated sampling controls already had correct capability-aware validation. Regression tests inspect final Google SDK URL and JSON configuration, and reject caller-supplied budgets and sampling penetration. Stored sampling preferences remain portable but inactive for the current catalog. Custom Safety Settings remain intact.

## Future Interactions migration blockers

A separate migration must address streaming event protocol, abort/stop propagation, custom safety parity, structured JSON extraction and error classification. It must retain branch-aware context and explicitly choose storage semantics (`store=false` for stateless use; otherwise map `previous_interaction_id` to the selected branch). Token cost, implicit/explicit caching, and interaction retention defaults also need evaluation. This patch does not implement that migration.
