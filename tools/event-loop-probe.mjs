#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Measures event-loop responsiveness while a document parse runs.
 *
 * This exists because G01 asks for evidence that the parse limits are
 * *enforceable*, not merely declared. A `Promise.race` against a timer proves
 * only that the caller stopped waiting; if the parse is synchronous, the timer
 * cannot fire and the loop cannot run anything else — including the abort that
 * is supposed to stop it. The promise settles eventually either way, so the
 * distinction is invisible from inside the read.
 *
 * So this measures from outside: a heartbeat timer is scheduled while the parse
 * runs, and the largest gap between ticks is the longest the loop was blocked.
 * If the parse were cooperatively yielding, the gap would stay near the tick
 * interval regardless of document size.
 *
 * Usage:
 *   node tools/event-loop-probe.mjs <file.pdf> [page-range]
 */

const HEARTBEAT_MS = 10;

/**
 * The largest gap between heartbeats, in milliseconds.
 *
 * A `setTimeout` chain rather than `setInterval`: an interval that misses ticks
 * reports the *scheduled* time, which is exactly the number that does not move
 * when the loop is blocked.
 */
function startHeartbeat(intervalMs = HEARTBEAT_MS) {
  let last = performance.now();
  let worst = 0;
  let ticks = 0;
  let timer;

  const tick = () => {
    const now = performance.now();
    const gap = now - last;
    if (gap > worst) worst = gap;
    last = now;
    ticks += 1;
    timer = setTimeout(tick, intervalMs);
  };
  timer = setTimeout(tick, intervalMs);

  return {
    stop() {
      clearTimeout(timer);
      return { worst_gap_ms: Number(worst.toFixed(1)), ticks };
    },
  };
}

async function main() {
  const [target, pages] = process.argv.slice(2);
  if (!target) {
    process.stderr.write("usage: node tools/event-loop-probe.mjs <file.pdf> [page-range]\n");
    process.exitCode = 2;
    return;
  }

  // A `file://` URL, not a path: on Windows a bare `D:\...` is read as a URL
  // scheme and the loader refuses it.
  const adapterUrl = new URL("../agent-runtime/src/pdf-adapter.mjs", import.meta.url);
  const { createPdfAdapter } = await import(adapterUrl.href);

  const bytes = new Uint8Array(await readFile(target));
  const adapter = createPdfAdapter();
  const heartbeat = startHeartbeat();
  const started = performance.now();
  const before = process.memoryUsage().heapUsed;

  let outcome;
  try {
    const document = await adapter.read({
      bytes,
      path: target,
      selection: pages === undefined ? undefined : { pages },
    });
    outcome = {
      status: "succeeded",
      blocks: document.blocks?.length ?? 0,
      pages: document.metadata?.pages ?? null,
      partial: document.partial === true,
      warnings: (document.warnings ?? []).map((warning) => warning.code),
    };
  } catch (error) {
    outcome = { status: "refused", code: error?.code ?? "unknown" };
  }

  const elapsed = performance.now() - started;
  const { worst_gap_ms, ticks } = heartbeat.stop();
  const heapDeltaMb = (process.memoryUsage().heapUsed - before) / 1024 / 1024;

  process.stdout.write(
    `${JSON.stringify(
      {
        file: target,
        bytes: bytes.byteLength,
        pages: pages ?? null,
        outcome,
        elapsed_ms: Number(elapsed.toFixed(1)),
        heartbeat: { interval_ms: HEARTBEAT_MS, ticks, worst_gap_ms },
        heap_delta_mb: Number(heapDeltaMb.toFixed(1)),
      },
      null,
      2,
    )}\n`,
  );
}

await main();
