# P3 - Generic Bounded UIA Fallback

Status: completed 2026-09-04

Source requirements: Cycle 4 PRD, closeout plan, especially FR-4.3, FR-4.5,
FR-4.7, FR-4.12, and C4-07.

## Outcome

Add a production Generic UIA strategy for applications without a specialized
host adapter. It performs one bounded semantic snapshot when UIA is usable and
reports an honest unavailable state otherwise.

## Design

The shared UIA module remains a transport. It owns COM initialization,
connection timeout, tree walking, view selection, depth/node limits, provider
diagnostics, and native element lifetime. The Generic UIA strategy owns the
product-facing attachment and normalization policy.

The product-facing generic block keeps only bounded semantic fields:

~~~
{
  "fields": ["role", "name", "bounds"],
  "nodes": [["button", "Play", {"x": 10, "y": 20, "width": 80, "height": 30}]]
}
~~~

Names are normalized accessible labels, not a transcription guarantee. The
strategy must not read TextPattern document ranges, arbitrary edit values,
clipboard contents, screenshots, OCR output, credentials, or browser-specific
metadata. It must not merge a generic attachment with another strategy result.

## Tasks

1. Extract the reusable bounded semantic snapshot operation from the current
   Browser implementation without moving host policy into uia.rs.
2. Implement the Generic UIA strategy behind the P2 fallback decision.
3. Preserve max depth 16 and max nodes 800 as the initial bounded defaults.
4. Return partial quality and truncation flags when provider or budget limits
   affect the result; return unavailable when no usable UIA surface exists.
5. Keep the Side rail responsive while the one-shot worker completes.

## Tests

- an unsupported UIA-exposing target receives exactly one generic attempt;
- a target with no UIA returns unavailable without title guessing;
- depth and node limits are independently represented;
- offscreen, invalid-bounds, empty-container, and repeated-node behavior is
  deterministic;
- the serialized block contains only role, name, and bounds fields;
- a Browser match never receives an additional generic capture;
- target replacement during capture yields no attachment.

## Exit Criteria

Messaging, media, and game-like faux targets can receive a bounded generic
attachment; unsupported or unavailable surfaces remain usable as ordinary
conversation surfaces; Browser composition remains Browser-owned.

## Deferred

Full page text, selected text, visual capture, OCR, DOM/CDP extraction,
browser actions, and rich document/editor content.
