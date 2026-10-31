import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import test from "node:test";
import { createPdfAdapter, MAX_PDF_PAGES } from "../src/pdf-adapter.mjs";
import { buildLargePdf } from "./pdf-fixtures.mjs";

/**
 * G01 — evidence about parse responsiveness, not just declared limits.
 *
 * The audit's finding was that the C6-19 limit story had no measurement behind
 * it: `Promise.race` against a timer proves the *caller* stopped waiting, which
 * is a different claim from "the parse can be interrupted". If parsing is
 * synchronous, the timer cannot fire and neither can the abort — the promise
 * settles eventually either way, so the distinction is invisible from inside
 * the read.
 *
 * These tests measure from outside. A heartbeat is scheduled while the parse
 * runs, and the largest gap between ticks is the longest the event loop was
 * blocked.
 *
 * **What these tests assert is the measured fact, not a target.** The parse
 * does block the loop; that is now recorded as a property of the current
 * implementation rather than assumed away. See C6-I036 for what follows from
 * it. A future change that moves parsing off the main thread should flip these
 * assertions, and the test failing is the signal to do so deliberately.
 */

const HEARTBEAT_MS = 10;

function startHeartbeat(intervalMs = HEARTBEAT_MS) {
  let last = performance.now();
  let worst = 0;
  let ticks = 0;
  let timer;
  const tick = () => {
    const now = performance.now();
    worst = Math.max(worst, now - last);
    last = now;
    ticks += 1;
    timer = setTimeout(tick, intervalMs);
  };
  timer = setTimeout(tick, intervalMs);
  return {
    stop() {
      clearTimeout(timer);
      return { worstGapMs: Math.max(worst, performance.now() - last), ticks };
    },
  };
}

async function measure(pdf, selection) {
  const heartbeat = startHeartbeat();
  const started = performance.now();
  try {
    const document = await createPdfAdapter().read({ bytes: new Uint8Array(pdf), path: "probe.pdf", selection });
    return { document, elapsedMs: performance.now() - started, ...heartbeat.stop() };
  } finally {
    heartbeat.stop();
  }
}

test("G01: parsing a 300-page PDF lets the event loop run", async (context) => {
  const pdf = buildLargePdf(300);
  const { document, elapsedMs, ticks, worstGapMs } = await measure(pdf);
  context.diagnostic(JSON.stringify({ fixturePages: 300, fixtureBytes: pdf.length, elapsedMs, heartbeatTicks: ticks, worstGapMs }));

  assert.equal(document.metadata.pages, 300);
  assert.ok(document.blocks.length > 0, "the fixture produced no content, so nothing was measured");

  // Before the fix this was 0: the loop was occupied from before the parse
  // until after it, and nothing else could run. Now the page loop yields, so
  // the heartbeat gets turns and a cancellation has somewhere to land.
  //
  // The number is not asserted, only that it is non-zero. Pinning it would make
  // the test a benchmark, and this machine is not a stable one.
  assert.ok(
    ticks > 0,
    `the heartbeat never ran during a ${elapsedMs.toFixed(0)}ms parse, which means the `
    + "loop is blocked for its whole duration again",
  );
});

test("G01: an abort during the page loop is delivered, and the read refuses", async (context) => {
  // The defect this covers, and what the fix does and does not reach.
  //
  // Before the fix the abort was not merely late, it was dropped: `setTimeout`
  // could not run until the loop was free, which was after the read had already
  // succeeded. A user who cancelled a PDF read got the document.
  //
  // The page loop now yields periodically, so a cancellation issued during it
  // is delivered and the read refuses. What this does **not** fix is the
  // document-loading phase before the first page: measured at ~174ms on a
  // 300-page fixture, and no yield can happen inside it. An abort issued in
  // that window still waits. That bound is recorded in C6-I036 rather than
  // presented as solved.
  const pdf = buildLargePdf(300);
  const controller = new AbortController();

  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  let pagesRequested = 0;
  let firstPageAt;
  let abortDeliveredAt;
  const started = performance.now();
  const adapter = createPdfAdapter({
    load: async (data) => {
      const task = pdfjs.getDocument({ data, isEvalSupported: false, useSystemFonts: false, disableFontFace: true, useWorkerFetch: false, verbosity: 0 });
      return {
        promise: task.promise.then((document) => ({
          numPages: document.numPages,
          getPage(pageNumber) {
            pagesRequested += 1;
            if (pagesRequested === 1) {
              firstPageAt = performance.now() - started;
              setImmediate(() => {
                abortDeliveredAt = performance.now() - started;
                controller.abort();
              });
            }
            return document.getPage(pageNumber);
          },
          getMetadata: () => document.getMetadata(),
          destroy: () => document.destroy(),
        })),
        destroy: () => task.destroy(),
      };
    },
  });
  const pending = adapter.read({
    bytes: new Uint8Array(pdf),
    path: "probe.pdf",
    signal: controller.signal,
  });
  await assert.rejects(pending, (error) => {
    assert.equal(error.code, "aborted");
    return true;
  });
  assert.ok(pagesRequested > 0 && pagesRequested < 300);
  context.diagnostic(JSON.stringify({ fixturePages: 300, firstPageAtMs: firstPageAt, abortDeliveredAtMs: abortDeliveredAt, cancelledAtMs: performance.now() - started, pagesRequested }));
});

test("G01: an abort before the read starts still refuses immediately", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () => createPdfAdapter().read({
      bytes: new Uint8Array(buildLargePdf(5)),
      path: "probe.pdf",
      signal: controller.signal,
    }),
    (error) => {
      assert.equal(error.code, "aborted");
      return true;
    },
  );
});

test("G01: a bounded page range returns only its selected pages", async () => {
  const pdf = buildLargePdf(300);

  const all = await measure(pdf);
  const few = await measure(pdf, { pages: "1-3" });

  assert.equal(few.document.metadata.pages_read, 3);
  assert.ok(few.document.blocks.length < all.document.blocks.length);
});

test("G01: the page ceiling refuses extraction after loading page metadata", async () => {
  let pagesRequested = 0;
  let destroyed = false;
  const adapter = createPdfAdapter({
    load: async () => ({
      promise: Promise.resolve({
        numPages: MAX_PDF_PAGES + 1,
        async getPage() { pagesRequested += 1; },
        async destroy() { destroyed = true; },
      }), destroy() {},
    }),
  });
  await assert.rejects(() => adapter.read({ bytes: new Uint8Array(), path: "oversized.pdf" }), (error) => error.code === "document_too_complex");
  assert.equal(pagesRequested, 0);
  assert.equal(destroyed, true);
});
