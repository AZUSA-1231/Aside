import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink, unlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import test from "node:test";
import { Type } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { Agent } from "@earendil-works/pi-agent-core/aside";
import { createModels } from "@earendil-works/pi-ai";
import {
  WorkspaceError,
  resolveTaskWorkspace,
} from "../src/workspace.mjs";
import { createConversationRuntime } from "../src/runtime.mjs";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "aside-workspace-"));
  const file = join(root, "notes.txt");
  await writeFile(file, "original", "utf8");
  return { root: resolve(root), file: resolve(file) };
}

function descriptorContext(file, expiresAt = Date.now() + 60_000) {
  return {
    attachments: [
      {
        expiresAt,
        descriptors: [{ role: "document", path: file, kind: "file" }],
      },
    ],
  };
}

test("resolves a file descriptor to its containing workspace", async () => {
  const { root, file } = await fixture();
  try {
    const resolution = await resolveTaskWorkspace({
      context: descriptorContext(file),
      now: Date.now(),
    });

    assert.equal(resolution.state.status, "resolved");
    assert.equal(resolution.state.source, "file_descriptor");
    assert.equal(resolution.state.canonical_path, root);
    assert.equal(resolution.state.target.relative_path, basename(file));
    assert.equal(resolution.state.target.kind, "file");
    assert.equal(resolution.state.target.identity.size, 8);

    const addressed = await resolution.environment.resolvePath("notes.txt", {
      expectedKind: "file",
    });
    assert.equal(addressed.canonical_path, file);
    assert.equal((await resolution.environment.readText("notes.txt", { maxBytes: 64 })).text, "original");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("does not expose an environment when no workspace candidate exists", async () => {
  const resolution = await resolveTaskWorkspace({ context: undefined });
  assert.equal(resolution.state.status, "unresolved");
  assert.equal(resolution.state.code, "workspace_required");
  assert.equal(resolution.environment, undefined);
});

test("does not expose workspace tools before workspace activation", async () => {
  const faux = fauxProvider({ tokensPerSecond: 1_000 });
  let calls = 0;
  faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall("workspace.read", { path: "notes.txt" }, { id: "blocked-read" }),
    ),
    fauxAssistantMessage("I need a workspace before reading that file."),
  ]);
  const models = createModels();
  models.setProvider(faux.provider);
  const agent = new Agent({
    initialState: {
      systemPrompt: "Use workspace tools only when available.",
      model: faux.getModel(),
      thinkingLevel: "off",
      tools: [
        {
          name: "workspace.read",
          description: "Read a workspace file.",
          label: "Read",
          parameters: Type.Object({ path: Type.String() }),
          async execute() {
            calls += 1;
            return { content: [{ type: "text", text: "must not run" }] };
          },
          descriptor: { effect: "read", scope: "workspace", replay: "safe" },
        },
      ],
    },
    streamFn: models.streamSimple.bind(models),
    convertToLlm: (messages) => messages,
  });
  const events = [];
  const runtime = await createConversationRuntime({ agent, emit: (event) => events.push(event) });
  await runtime.prompt("no-workspace", "read notes");

  assert.equal(calls, 0);
  assert.deepEqual(events.find((event) => event.type === "run_started").tools, []);
  assert.equal(events.find((event) => event.type === "workspace_unresolved").code, "workspace_required");
});

test("rejects lexical escapes and symlink targets outside the workspace", async (t) => {
  const { root } = await fixture();
  const outside = await mkdtemp(join(tmpdir(), "aside-outside-"));
  const link = join(root, "outside-link");
  try {
    const resolution = await resolveTaskWorkspace({ workspaceHint: root });
    assert.throws(
      () => resolution.environment.assertWithinWorkspace("../outside.txt"),
      (error) => error instanceof WorkspaceError && error.code === "scope_escape",
    );

    try {
      await symlink(outside, link, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      t.skip(`symlink fixture unavailable: ${error.code ?? "unknown"}`);
      return;
    }
    await writeFile(join(outside, "secret.txt"), "outside", "utf8");
    await assert.rejects(
      resolution.environment.resolvePath("outside-link/secret.txt", { expectedKind: "file" }),
      (error) => error instanceof WorkspaceError && error.code === "scope_escape",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("revalidates a prepared target and detects replacement", async () => {
  const { root, file } = await fixture();
  try {
    const resolution = await resolveTaskWorkspace({ workspaceHint: root });
    const prepared = await resolution.environment.resolvePath("notes.txt", {
      expectedKind: "file",
    });
    // Distinct sizes and explicit mtimes so the replacement cannot collide
    // with the original identity (same-ms rewrites and inode reuse otherwise
    // make sameWorkspaceIdentity match and skip stale_target).
    await unlink(file);
    await writeFile(file, "replaced-with-different-length-content", "utf8");
    await utimes(file, new Date(0), new Date(0));
    await assert.rejects(
      resolution.environment.revalidate(prepared, { expectedKind: "file" }),
      (error) => error instanceof WorkspaceError && error.code === "stale_target",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("keeps task workspace resolution separate from process cwd", async () => {
  const { root } = await fixture();
  const before = process.cwd();
  try {
    const resolution = await resolveTaskWorkspace({ workspaceHint: root });
    assert.equal(resolution.environment.cwd, root);
    assert.equal(process.cwd(), before);
    const previous = resolution.state;
    const reused = await resolveTaskWorkspace({ previousWorkspace: previous });
    assert.equal(reused.state.canonical_path, root);
    assert.equal(process.cwd(), before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// A02 — a commit that must not replace has to be one operation
//
// Found by the independent audit. `writeAtomic` checked the destination and
// then renamed onto it. On Windows `rename` replaces, so a file created between
// the check and the commit was silently overwritten — the user loses a file,
// which is the exact outcome C6-I009 and C6-24 promise cannot happen.
//
// The existing race test creates the file while the permission decision is
// pending, which the pre-commit check catches. It does not reach the window the
// audit found: between the last check and the commit. No number of checks
// closes that window, because it is wherever the last check happens to be.
// ---------------------------------------------------------------------------

test("A02: a file created after the final check is not replaced by the commit", async () => {
  const { root } = await fixture();
  try {
    const resolution = await resolveTaskWorkspace({ workspaceHint: root });
    const target = join(root, "output.bin");

    await assert.rejects(
      () => resolution.environment.writeBytesAtomic("output.bin", new Uint8Array([1, 2, 3]), {
        maxBytes: 1_024,
        expectMissing: true,
        // The gap itself: another writer commits between the check and ours.
        beforeRename: async () => {
          await writeFile(target, "CONCURRENT_OUTPUT", "utf8");
        },
      }),
      (error) => {
        assert.ok(error instanceof WorkspaceError, `expected WorkspaceError, got ${error?.name}`);
        assert.equal(error.code, "stale_target");
        return true;
      },
    );

    assert.equal(
      await readFile(target, "utf8"),
      "CONCURRENT_OUTPUT",
      "the concurrent writer's file was overwritten",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("A02: an ordinary new-file commit still works", async () => {
  // The primitive must not be so careful that it refuses every write.
  const { root } = await fixture();
  try {
    const resolution = await resolveTaskWorkspace({ workspaceHint: root });
    await resolution.environment.writeBytesAtomic("fresh.bin", new Uint8Array([9, 9, 9]), {
      maxBytes: 1_024,
      expectMissing: true,
    });
    assert.equal((await readFile(join(root, "fresh.bin"))).byteLength, 3);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
