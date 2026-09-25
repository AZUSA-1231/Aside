# P5 - First-Party Web Search

**Status: RETIRED 2026-09-18** — see
[C6-I026](../ISSUES.md#c6-i026---web-search-leaves-cycle-6-entirely).

This plan delivers nothing and must not be implemented. It is kept as a record
of a capability Cycle 6 considered and declined. Its exit criteria, C6-26
through C6-30, are **retired**, not deferred with an owner. Their intent
survives only as
[PRD section 10.2](../PRD.md#102-requirements-for-any-future-search-capability)
— requirements for a future search capability, not work owed by anyone.

**The whole plan is withdrawn.** Every task below — the provider gate, the
public tool contract, the credential pipeline, the enablement UX, the faux
provider — was written for a first-party capability that will not be built.
Nothing here migrates to another plan, and P6 does not inherit it.

What Cycle 6 concluded, and why, is recorded in
[C6-I026](../ISSUES.md#c6-i026---web-search-leaves-cycle-6-entirely): a
first-party build requires Aside to adopt one provider's contract, terms, and
credential, while every keyless option available through the MCP route is a
scraper, which relocates the dependency instead of removing it.

Depends on: — (withdrawn)
Unblocks: —
Source requirements: PRD sections 3.2, 5, 10, 12 through 16, and C6-26 through
C6-30

## Outcome

Provide a built-in, provider-neutral `web.search` tool that sends only a
bounded query and declared filters, returns source-bearing bounded results,
and handles configuration/network/provider failures truthfully. Web Search is
an explicit external capability, not a general browser or URL-fetch surface.

## Provider Gate

Before implementation, compare candidate search providers/APIs for:

- official API and SDK/HTTP stability;
- terms, result-display/citation requirements, caching restrictions, and
  provider attribution;
- pricing/quota assumptions without embedding them in the public tool schema;
- geographic availability, safe-search and locale/freshness/domain filters;
- result fields, canonical URLs, dates, snippets, and ranking semantics;
- credential handling, telemetry, timeouts, cancellation, and retry guidance;
- deterministic faux-backend support and Windows packaging.

The public contract must not leak one provider's response type. Provider
selection and credentials are configuration, and an unavailable provider must
remove or disable the tool honestly.

## Public Tool Contract

`web.search` accepts a bounded query plus optional supported filters such as:

```text
max_results
freshness/date range
locale/language
allowed or excluded domains
safe-search mode
```

Only filters supported by the selected backend and normalized by Aside are
exposed. Results contain bounded title, URL, snippet, source/domain,
date/uncertainty, rank, attribution, and warnings. Results never contain raw
headers, provider request IDs that leak credentials, or unbounded payloads.

## Tasks

1. Complete the provider/terms/privacy review and choose the initial backend
   plus an internal provider interface suitable for deterministic fakes.
2. Define `web.search` schema and normalized result/error taxonomy independent
   of the backend. Bound query/filter bytes, domains, result count, snippet
   bytes, total output, active duration, and provider retries.
3. Register the tool only when the capability is enabled and usable. Mark its
   policy as remote query egress with built-in source and safe/non-replayable
   behavior chosen from actual request semantics.
4. Implement credential resolution outside prompts, tool arguments, React,
   transcript, and normal logs. Redact provider error bodies before
   normalization.
5. Send only query and declared filters. Prove that workspace paths/content,
   captured context, transcript history, and unrelated model state are not
   attached to the provider request.
6. Normalize URLs defensively, preserve required attribution, make date
   uncertainty explicit, and label every result as untrusted external content.
   Do not fetch result pages to enrich snippets.
7. Define UX/policy for initial external capability enablement and task-visible
   query activity. It must be legible without interrupting every harmless
   query if an explicit user setting safely establishes enablement; no
   background search is permitted.
8. Handle missing configuration, invalid credentials, provider refusal,
   rate/quota limit, timeout, network/TLS/DNS failure, malformed response,
   partial response, cancellation, and unsupported filter as distinct bounded
   outcomes where the backend permits.
9. Define conservative retry behavior. Never retry after cancellation, never
   turn a provider error into fabricated results, and respect provider retry
   signals within task limits.
10. Add a faux provider recording exact outbound requests. Cover successful
    normalization, hostile snippets, URL oddities, missing dates, truncation,
    attribution, all failure classes, cancellation, retry bounds, secret
    redaction, registry availability, and session persistence.
11. Add faux-agent flows that search, cite source identities, recover when
    search is unavailable, and refuse arbitrary browse/fetch requests.

## Deliverables

- Provider-neutral `web.search` contract and adapter interface.
- One configured first-party search backend.
- Explicit query-egress policy and capability enablement behavior.
- Bounded source-bearing results and typed failure taxonomy.
- Faux provider, privacy, persistence, cancellation, and agent-flow coverage.

## Exit Criteria

- C6-26 proves the exact outbound payload contains only query/declared filters
  and results preserve inspectable sources and required attribution.
- C6-27 proves hostile result text remains untrusted and cannot change policy
  or authority.
- C6-28 distinguishes unavailable, auth, rate-limit, and network failure with
  no fabricated success.
- C6-29 proves credentials/raw responses are absent from stored sessions,
  provider messages, React events, and ordinary logs.
- C6-30 proves no arbitrary URL fetch, page read, browser action, login,
  download, or hidden enrichment capability exists.
- The provider/terms record documents display, caching, attribution, and quota
  obligations relevant to the shipped behavior.

## Checks

Run focused faux-provider and privacy tests with network disabled, then the
full quality gate. Perform an optional manually authorized real-provider smoke
test for query, attribution, rate-limit handling, and cancellation; record no
credential or full raw payload in evidence.

## Verification

Record after implementation:

- provider decision, terms constraints, and selected interface;
- normalized schema/results/errors and limits;
- faux-provider exact-request evidence;
- focused/full test results;
- redacted manual smoke evidence or a clear note that it was not run.
