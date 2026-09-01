# Chromium CDP Capability Study

Status: research complete; no production Chromium transport implemented  
Date: 2026-08-31  
Scope: Chromium-family browser capture for Chrome, Edge, and compatible browsers

This study answers what a Chromium DevTools Protocol (CDP) connection can
observe, what shape it returns, and which parts are useful to Aside. It is a
transport study, not a decision to send all observable browser data into the
context envelope.

Decision update: the Cycle 4 browser default is now a native Windows UIA
capture. CDP remains an explicitly opted-in transport for controlled browser
launches or future enhancement work; it is not required for the default
capture. Optional per-window visual augmentation is defined in the companion
[UIA and screen capture study](./chromium-uia-screen-capture.md).

## 1. Test Method

The reproducible probe is [chromium-cdp-probe.mjs](../../../tools/chromium-cdp-probe.mjs).
It starts a local fixture server, creates a temporary CDP page target, attaches
through the browser WebSocket with a flattened target session, runs bounded
queries, and closes the target. It prints sanitized JSON only:

- URL values, form values, cookie values, storage values, complete DOM, MHTML,
  and screenshot pixels are omitted from the report;
- the fixture contains synthetic values only and is never a user's page;
- the probe is not registered in the production `HostExtractorRegistry`.

The environment had Microsoft Edge `152.0.4191.53` installed and no Chrome
executable was found. The Edge run reported CDP protocol `1.3`. A dedicated
temporary profile and `--headless=new` were used. This restricted environment
also required test-only software-rendering and sandbox flags; those flags are
not a production launch recommendation.

Run the probe against an explicitly opted-in browser endpoint:

```text
edge --headless=new --remote-debugging-address=127.0.0.1 --remote-debugging-port=9222 --user-data-dir=<dedicated-profile> about:blank
npm run chromium:probe -- --endpoint http://127.0.0.1:9222
```

Never point the probe or a future connector at a normal user profile without a
clear consent and security design. A reachable CDP endpoint is a powerful
browser control surface.

## 2. Observed Capability Matrix

| Concern | CDP surface | Observed return shape | Value to Aside | Initial policy |
| --- | --- | --- | --- | --- |
| Browser identity | `/json/version`, `Browser.getVersion` | Browser product, protocol version, user agent, V8/WebKit versions | Distinguishes Edge/Chrome branding and validates transport | Keep product/version in native adapter diagnostics; do not send engine internals to Pi by default |
| Target discovery | `/json/list`, `Target.getTargets` | Target id, type, title, URL, attached state, opener/context metadata | Finds page targets and rejects extension/service-worker targets | Inspect only during one capture; require `type = page`; never persist the full target list |
| Active page identity | Target info plus `Runtime.evaluate` | Title and URL; URL can contain query values and fragments | Useful low-cost source label and page reference | Keep title and a sanitized URL; drop raw query/hash by default |
| Explicit selection | `Runtime.evaluate` with `window.getSelection()` | Plain string | Highest-signal user-directed context | Include when non-empty, bounded, and marked untrusted reference text |
| Visible page text | `Runtime.evaluate` with bounded `document.body.innerText` | Plain string, potentially thousands of characters | Useful for page Q&A and summarization | Separate explicit capability; bound, show as an attachment, and apply a short expiry |
| Frame structure | `Page.getFrameTree` | Tree of frame ids, parent ids, names, URLs, security origins | Helps explain embedded page boundaries | Keep top document by default; do not recursively capture frames without an explicit adapter rule |
| DOM structure | `DOM.getDocument` and related DOM commands | Remote node tree and node ids; outer HTML can be requested | Can power detailed extraction | Do not use raw DOM or outer HTML as the default context source |
| Accessibility tree | `Accessibility.getFullAXTree` | Semantic nodes, roles, names, and properties | Can be useful for a purpose-built reader adapter | Excluded from generic browser capture; it is a broad content traversal surface |
| Page snapshot | `Page.captureSnapshot` | MHTML string | Reconstructs a page and its resources | Excluded; too broad, opaque, and difficult to redact |
| Screenshot | `Page.captureScreenshot` | Base64 PNG bytes | Can represent pixels | Excluded; screenshot/OCR is outside Cycle 4 browser capture |
| Navigation history | `Page.getNavigationHistory` | Ordered entries with title and full URLs | Shows history is technically available | Excluded from a one-shot current-page attachment |
| Form metadata | `Runtime.evaluate` over form controls | Tag, type, name, autocomplete, disabled/read-only state | Sometimes explains the current UI | Metadata is not a reason to inspect values; exclude password, hidden, and all form values |
| Cookies and storage | `Network.getAllCookies`, `document.cookie`, Web Storage APIs | Cookie records, cookie attributes, storage keys, and readable values | No product value for contextual help | Hard deny. Never request or forward credentials, cookies, tokens, or storage values |
| Browser extension API | Page evaluation versus extension context | `chrome.tabs` was not visible to normal page JavaScript | Explains why an extension can enhance active-tab/content coverage | Keep extensions optional; use the native UIA bridge as the default and an approved extension only for declared enhancements |
| Browser control | `Target.createTarget`, close/attach, page evaluation, input/navigation domains | Target creation and arbitrary script/control commands | Useful for a controlled transport test | Keep control commands outside capture; no navigation, input, injection, or arbitrary code execution |

The measured fixture values were:

- one Edge browser endpoint with protocol `1.3`;
- seven existing targets before the temporary page and eight afterward;
- no explicit active-target field in either target listing;
- a 47-character selection string;
- 2,147 characters of visible body text, which the probe truncated to a bounded
  sample;
- two frames;
- five form controls, including password and hidden fields whose values were
  readable by page JavaScript;
- two cookie records returned by the CDP cookie query, with values omitted;
- a 4,310-byte MHTML snapshot and a 60,955-byte PNG, with content omitted.

The target list also contained Edge built-in extension background pages and a
service worker. Target type filtering is therefore mandatory.

## 3. Important Constraints

### CDP does not identify the active Tab

`/json/list` and `Target.getTargets` expose target identity, title, URL, and
attachment state. They do not expose a reliable `activeTab` or last-focused-tab
field. `attached` means that a debugger is attached, not that the user is
looking at that page. Target order is not a product contract.

Native foreground-window identity can identify the browser window, but it
cannot select the active tab inside that window. A browser companion must
provide that missing fact, or a CDP-only adapter cannot reliably satisfy
"capture the page the user is currently using" in a multi-tab window.

### CDP is not normally available in a user's browser

The experiment explicitly launched Edge with a remote debugging endpoint. The
existing normal Edge process did not expose a usable endpoint in this test.
Shipping a connector that scans arbitrary localhost ports would be both
unreliable and unsafe. Chrome and Edge share the protocol shape, but their
installation, policy, profile, and extension permission behavior still need
separate validation.

### A CDP connection is much more powerful than a capture API

The same browser WebSocket that returns a title can create targets, evaluate
arbitrary page JavaScript, navigate, send input, and query sensitive browser
data. Loopback binding alone does not make an endpoint a narrow capability.
The connector must be explicitly opted into, bound to the invocation target,
restricted to page targets, and prevented from forwarding control privileges
into the provider context.

## 4. Candidate Aside Capture Shape

This is a recommendation for the next design review, not a new runtime type.
It fits the existing `AsideHostAttachment` envelope and keeps native target
capabilities out of React and Pi:

```text
attachment.host = browser
attachment.source = "Chrome page" or "Edge page"
attachment.sensitivity = local_metadata or local_content
attachment.blocks =
  [
    json {
      label: "page_identity",
      data: {
        browser: "chrome" | "edge" | "chromium",
        title: string,
        url: { protocol, origin, pathname }
      }
    },
    text { label: "selection", text: string },       // only when present
    text { label: "visible_page_text", text: string }, // explicit capability
    image { label: "browser_window", image: bounded }  // visual setting only
  ]
```

The opaque native target binding and CDP session id remain inside the native
adapter. They are used for validation and discarded after the one-shot call;
they are not attachment fields and never enter the provider projection.

The suggested first policy is:

1. Every capture click resolves the current approved browser target again and
   creates one new attachment. There is no target cache, polling loop, or
   browser-state manager.
2. Identity plus a non-empty explicit selection are the smallest useful
   capture. They can be fast and low-volume while still answering "what page
   am I on?" and "what did I select?".
3. Whole visible page text is a separate bounded capability until its consent,
   redaction, and prompt-budget behavior are reviewed. It must never silently
   include form values, cookies, storage, or raw DOM.
4. The exact URL is not sent by default. Keep origin and path; query values and
   fragments require a later explicit decision because they commonly contain
   search terms, identifiers, or tokens.
5. All blocks remain untrusted reference data, are visible and removable in
   the attachment list, use a short expiry, and follow the existing aggregate
   context limit. A new oversized capture is rejected without replacing older
   attachments.

This leaves room for a fast one-click page capture after the native UIA bridge
is proven, without making the initial browser transport a general page scraper.
The visual block is added only when the local browser visual-capture setting is
enabled; it is not a replacement for UIA metadata or selection.

## 5. Transport Direction

The evidence now points to three deliberately separate transport modes:

| Mode | Role | Required capability |
| --- | --- | --- |
| Native Windows UIA bridge | Default zero-extension Chrome/Edge path | Invocation HWND, selected-tab/control semantics, bounded TextPattern reads, and optional document bounds |
| Approved browser companion | Optional enhancement for pages UIA cannot represent | `tabs.query` for active tab identity and a click-triggered content script/message for selection or bounded text |
| Explicit CDP connector | Development, controlled environments, or a separately approved browser setup | User-provided endpoint, target binding, page-type filtering, session timeout, and strict command allowlist |

Chrome and Edge can share most UIA pattern extraction and the later CDP message
transport. Browser detection, endpoint discovery, extension packaging,
permission UX, and active-tab binding must remain injectable adapter concerns
rather than being inferred from a title or a guessed target order.

No Chromium plan is created yet. The next plan should validate the UIA selected-
tab/page tree, define the visual setting's per-window capture path, and put the
smallest capability behind the existing `HostExtractor` trait. Extensions and
CDP remain optional transports with separate permission and isolation tests.
