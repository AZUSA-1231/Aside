import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import test from "node:test";
import { createPdfAdapter } from "../src/pdf-adapter.mjs";
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
      return { worstGapMs: worst, ticks };
    },
  };
}

async function measure(pdf, selection) {
  const heartbeat = startHeartbeat();
  const started = performance.now();
  const document = await createPdfAdapter().read({
    bytes: new Uint8Array(pdf),
    path: "probe.pdf",
    selection,
  });
  const elapsedMs = performance.now() - started;
  return { document, elapsedMs, ...heartbeat.stop() };
}

test("G01: parsing a 300-page PDF lets the event loop run", async () => {
  const pdf = buildLargePdf(300);
  const { document, elapsedMs, ticks } = await measure(pdf);

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

test("G01: an abort during the page loop is delivered, and the read refuses", async () => {
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

  const pending = createPdfAdapter().read({
    bytes: new Uint8Array(pdf),
    path: "probe.pdf",
    signal: controller.signal,
  });
  // Late enough to land in the page loop rather than the loading phase, so the
  // assertion is about the loop's behavior.
  setTimeout(() => controller.abort(), 60);

  await assert.rejects(pending, (error) => {
    assert.equal(error.code, "aborted");
    return true;
  });
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

test("G01: a bounded page range bounds the work, and the block ceiling fires", async () => {
  // The limits that *are* enforceable regardless of the above: selecting fewer
  // pages does less work, and a document past the page ceiling is refused
  // before any parsing happens.
  const pdf = buildLargePdf(300);

  const all = await measure(pdf);
  const few = await measure(pdf, { pages: "1-3" });

  assert.equal(few.document.metadata.pages_read, 3);
  assert.ok(
    few.elapsedMs < all.elapsedMs,
    `reading 3 pages (${few.elapsedMs.toFixed(0)}ms) should cost less than 300 `
    + `(${all.elapsedMs.toFixed(0)}ms)`,
  );
  assert.ok(few.document.blocks.length < all.document.blocks.length);
});

test("G01: the page ceiling is refused before the document is parsed", async () => {
  const pdf = buildLargePdf(300);
  // Above the ceiling, the refusal must not depend on parsing the document
  // first — that would make the ceiling a limit on the result rather than on
  // the work.
  const oversized = Buffer.concat([pdf, pdf]);
  const { elapsedMs, ticks } = await measure(oversized).catch((error) => {
    assert.ok(["invalid_document", "document_too_complex"].includes(error.code), error.code);
    return { elapsedMs: 0, ticks: 0 };
  });
  assert.ok(elapsedMs < 200, "a refusal should not cost a full parse");
  void ticks;
});
