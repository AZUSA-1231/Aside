import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import test from "node:test";
import { Type, createModels } from "@earendil-works/pi-ai";
import { Agent } from "@earendil-works/pi-agent-core/aside";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { createConversationRuntime } from "../src/runtime.mjs";
import { createWorkspaceReadTools } from "../src/workspace-tools.mjs";
import {
  WorkspaceError,
  resolveTaskWorkspace,
  selectDescriptorHandoff,
} from "../src/workspace.mjs";

function makeAgent(faux) {
  const models = createModels();
  models.setProvider(faux.provider);
  return new Agent({
    initialState: {
      systemPrompt: "Use the registered tools when needed.",
      model: faux.getModel(),
      thinkingLevel: "off",
      tools: [],
    },
    streamFn: models.streamSimple.bind(models),
    convertToLlm: (messages) => messages,
  });
}

function turnContext(descriptors) {
  return {
    flow: { id: "flow-handoff", kind: "conversation" },
    blocks: [],
    attachments: [
      {
        id: "attachment-handoff",
        host: "explorer",
        source: "Explorer",
        capturedAt: Date.now(),
        expiresAt: EXPIRY,
        sensitivity: "local_metadata",
        summary: "Explorer selection",
        // A real capture always carries at least one block; the descriptor is
        // the part that establishes the workspace.
        blocks: [{ type: "text", text: "Explorer selection" }],
        descriptors,
      },
    ],
  };
}

const EXPIRY = Date.now() + 60_000;

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "aside-handoff-"));
  const nested = join(root, "reports");
  await mkdir(nested, { recursive: true });
  await writeFile(join(nested, "report.md"), "# report\n", "utf8");
  await writeFile(join(nested, "other.md"), "# other\n", "utf8");
  await writeFile(join(root, "loose.txt"), "loose\n", "utf8");
  return {
    root: resolve(root),
    nested: resolve(nested),
    report: resolve(join(nested, "report.md")),
    other: resolve(join(nested, "other.md")),
    loose: resolve(join(root, "loose.txt")),
  };
}

/** One attachment, descriptors in the order a host reported them. */
function capture(descriptors, expiresAt = EXPIRY) {
  return { attachments: [{ expiresAt, descriptors }] };
}

const directory = (path) => ({ role: "directory", path, kind: "directory" });
const rootDescriptor = (path) => ({ role: "workspace_root", path, kind: "directory" });
const selected = (path) => ({ role: "selected_item", path, kind: "file" });
const document = (path) => ({ role: "document", path, kind: "file" });

test("C6-06: binds a captured directory and its selected file together", async () => {
  const { nested, report } = await fixture();
  try {
    // Explorer reports its directory before the selected item, which is the
    // ordering that previously made the directory itself the target.
    const resolution = await resolveTaskWorkspace({
      context: capture([directory(nested), selected(report)]),
      now: Date.now(),
    });

    assert.equal(resolution.state.status, "resolved");
    assert.equal(resolution.state.source, "descriptor_handoff");
    assert.equal(resolution.state.canonical_path, nested);
    assert.equal(resolution.state.target.role, "selected_item");
    assert.equal(resolution.state.target.canonical_path, report);
    assert.equal(resolution.state.target.relative_path, "report.md");
    assert.equal(resolution.state.target.kind, "file");
    assert.ok(resolution.state.target.identity);
    assert.ok(resolution.environment);
  } finally {
    await rm(nested, { recursive: true, force: true });
  }
});

test("binds identically whichever order the host reports the descriptors", async () => {
  const { nested, report } = await fixture();
  try {
    const first = await resolveTaskWorkspace({
      context: capture([directory(nested), selected(report)]),
      now: Date.now(),
    });
    const reversed = await resolveTaskWorkspace({
      context: capture([selected(report), directory(nested)]),
      now: Date.now(),
    });
    assert.deepEqual(
      { ...reversed.state, continuation_id: undefined },
      { ...first.state, continuation_id: undefined },
    );
  } finally {
    await rm(nested, { recursive: true, force: true });
  }
});

test("C6-07: a directory descriptor alone becomes the workspace root", async () => {
  const { nested, root } = await fixture();
  try {
    for (const descriptor of [directory(nested), rootDescriptor(root)]) {
      const resolution = await resolveTaskWorkspace({
        context: capture([descriptor]),
        now: Date.now(),
      });
      assert.equal(resolution.state.status, "resolved");
      assert.equal(resolution.state.canonical_path, descriptor.path);
      assert.equal(resolution.state.target.relative_path, ".");
      assert.equal(resolution.state.target.kind, "directory");
      assert.equal(resolution.state.source, "workspace_descriptor");
    }
    const inside = await resolveTaskWorkspace({
      context: capture([rootDescriptor(root)]),
      now: Date.now(),
    });
    assert.equal(inside.state.canonical_path, root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a bare file descriptor keeps its containing directory as the root", async () => {
  const { nested, report } = await fixture();
  try {
    for (const descriptor of [document(report), selected(report)]) {
      const resolution = await resolveTaskWorkspace({
        context: capture([descriptor]),
        now: Date.now(),
      });
      assert.equal(resolution.state.source, "file_descriptor");
      assert.equal(resolution.state.canonical_path, nested);
      assert.equal(resolution.state.target.relative_path, "report.md");
      assert.equal(resolution.state.target.role, descriptor.role);
    }
  } finally {
    await rm(nested, { recursive: true, force: true });
  }
});

test("C6-08: refuses to guess between competing roots or targets", async () => {
  const { root, nested, report, other } = await fixture();
  try {
    for (const [descriptors, code] of [
      [[directory(nested), rootDescriptor(root)], "ambiguous_descriptor"],
      [[directory(nested), directory(root)], "ambiguous_descriptor"],
      [[selected(report), selected(other)], "ambiguous_descriptor"],
      [[document(report), selected(other)], "ambiguous_descriptor"],
    ]) {
      await assert.rejects(
        () =>
          resolveTaskWorkspace({ context: capture(descriptors), now: Date.now() }),
        (error) => error instanceof WorkspaceError && error.code === code,
        code,
      );
    }
    // The same resource reported twice is not ambiguous.
    const duplicate = await resolveTaskWorkspace({
      context: capture([selected(report), document(report)]),
      now: Date.now(),
    });
    assert.equal(duplicate.state.target.canonical_path, report);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("C6-08: rejects stale, missing, and mismatched captures without guessing", async () => {
  const { nested, report } = await fixture();
  try {
    const cases = [
      [capture([selected(report)], Date.now() - 1), "descriptor_expired"],
      [capture([selected(join(nested, "gone.md"))]), "not_found"],
      // A declared kind that disagrees with the resource is rejected, not
      // silently reinterpreted.
      [capture([{ role: "directory", path: report, kind: "directory" }]), "wrong_type"],
      [capture([{ role: "selected_item", path: nested, kind: "file" }]), "wrong_type"],
      // An ancestor that is a file can never yield the directory it names.
      [capture([directory(join(report, "child"))]), "not_found"],
    ];
    for (const [context, code] of cases) {
      await assert.rejects(
        () => resolveTaskWorkspace({ context, now: Date.now() }),
        (error) => error instanceof WorkspaceError && error.code === code,
        code,
      );
    }
  } finally {
    await rm(nested, { recursive: true, force: true });
  }
});

test("rejects a target captured outside its own root", async () => {
  const { root, loose, nested } = await fixture();
  try {
    // The captured root is the nested directory; the target is its sibling.
    assert.equal(basename(loose), "loose.txt");
    await assert.rejects(
      () =>
        resolveTaskWorkspace({
          context: capture([directory(nested), selected(loose)]),
          now: Date.now(),
        }),
      (error) => error instanceof WorkspaceError && error.code === "scope_escape",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an explicit selection outranks a capture and reports the override", async () => {
  const { root, nested, report } = await fixture();
  try {
    const resolution = await resolveTaskWorkspace({
      workspaceHint: root,
      context: capture([directory(nested), selected(report)]),
      now: Date.now(),
    });
    assert.equal(resolution.state.source, "explicit");
    assert.equal(resolution.state.canonical_path, root);
    assert.equal(resolution.state.target.relative_path, ".");
    assert.deepEqual(resolution.overridden, {
      source: "explicit",
      captured_path: nested,
    });

    // With no capture there is nothing to override.
    const plain = await resolveTaskWorkspace({
      workspaceHint: root,
      now: Date.now(),
    });
    assert.equal(plain.overridden, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("C6-08: an explicit file path still resolves to its containing directory", async () => {
  const { nested, report } = await fixture();
  try {
    const resolution = await resolveTaskWorkspace({
      workspaceHint: { path: report, source: "explicit" },
      now: Date.now(),
    });
    assert.equal(resolution.state.canonical_path, nested);
    assert.equal(resolution.state.target.relative_path, "report.md");
    assert.ok(resolution.environment);
  } finally {
    await rm(nested, { recursive: true, force: true });
  }
});

test("reuses a prior workspace only within the same conversation", async () => {
  const { nested, report } = await fixture();
  try {
    const first = await resolveTaskWorkspace({
      context: capture([selected(report)]),
      continuationId: "conversation-a",
      now: Date.now(),
    });
    assert.equal(first.state.continuation_id, "conversation-a");

    // The same conversation continues: the workspace is inherited.
    const continued = await resolveTaskWorkspace({
      previousWorkspace: first.state,
      continuationId: "conversation-a",
      now: Date.now(),
    });
    assert.equal(continued.state.status, "resolved");
    assert.equal(continued.state.canonical_path, nested);
    assert.equal(continued.state.source, "file_descriptor");

    // A different conversation must not inherit it.
    for (const continuationId of ["conversation-b", undefined]) {
      const fresh = await resolveTaskWorkspace({
        previousWorkspace: first.state,
        continuationId,
        now: Date.now(),
      });
      assert.equal(fresh.state.status, "unresolved");
      assert.equal(fresh.state.code, "workspace_required");
      assert.equal(fresh.environment, undefined);
    }
  } finally {
    await rm(nested, { recursive: true, force: true });
  }
});

test("a prior workspace is dropped when its target disappears", async () => {
  const { nested, report } = await fixture();
  try {
    const first = await resolveTaskWorkspace({
      context: capture([selected(report)]),
      continuationId: "conversation-a",
      now: Date.now(),
    });
    await unlink(report);
    await assert.rejects(
      () =>
        resolveTaskWorkspace({
          previousWorkspace: first.state,
          continuationId: "conversation-a",
          now: Date.now(),
        }),
      (error) => error instanceof WorkspaceError && error.code === "not_found",
    );
  } finally {
    await rm(nested, { recursive: true, force: true });
  }
});

test("C6-08: an ambiguous capture is recoverable, not a failed run", async () => {
  const { root, nested } = await fixture();
  try {
    const faux = fauxProvider({ tokensPerSecond: 1_000 });
    faux.setResponses([fauxAssistantMessage("I could not tell which folder you meant.")]);
    const events = [];
    const runtime = await createConversationRuntime({
      agent: makeAgent(faux),
      tools: createWorkspaceReadTools(),
      emit: (event) => events.push(event),
    });

    await runtime.prompt(
      "ambiguous-capture",
      "summarize this",
      turnContext([directory(nested), directory(root)]),
    );

    const unresolved = events.find((event) => event.type === "workspace_unresolved");
    assert.equal(unresolved.code, "ambiguous_descriptor");
    assert.equal(events.find((event) => event.type === "run_started").tools.length, 0);
    assert.equal(
      events.filter((event) => ["completed", "failed", "cancelled"].includes(event.type)).length,
      1,
    );
    assert.equal(
      events.at(-1).type,
      "completed",
      "the model still answers without scoped tools",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reports when an explicit selection outranks a capture", async () => {
  const { root, nested, report } = await fixture();
  try {
    const faux = fauxProvider({ tokensPerSecond: 1_000 });
    faux.setResponses([fauxAssistantMessage("ok")]);
    const events = [];
    const runtime = await createConversationRuntime({
      agent: makeAgent(faux),
      tools: createWorkspaceReadTools(),
      workspaceHint: root,
      emit: (event) => events.push(event),
    });

    await runtime.prompt(
      "explicit-wins",
      "read the report",
      turnContext([directory(nested), selected(report)]),
    );

    const overridden = events.find((event) => event.type === "workspace_overridden");
    assert.equal(overridden.replaced_by, "explicit");
    assert.equal(overridden.captured_path, nested);
    const resolved = events.find((event) => event.type === "workspace_resolved");
    assert.equal(resolved.workspace.canonical_path, root);
    assert.equal(resolved.workspace.source, "explicit");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("carries a capture's workspace across prompts in one conversation only", async () => {
  const { nested, report } = await fixture();
  try {
    const faux = fauxProvider({ tokensPerSecond: 1_000 });
    faux.setResponses([
      fauxAssistantMessage("read it"),
      fauxAssistantMessage("edited it"),
      fauxAssistantMessage("no folder selected"),
    ]);
    const events = [];
    const agent = makeAgent(faux);
    agent.sessionId = "conversation-a";
    const runtime = await createConversationRuntime({
      agent,
      tools: createWorkspaceReadTools(),
      emit: (event) => events.push(event),
    });

    await runtime.prompt("turn-1", "read it", turnContext([selected(report)]));
    const first = events.find((event) => event.type === "workspace_resolved");
    assert.equal(first.workspace.canonical_path, nested);

    // Same conversation, no new capture: the workspace continues.
    await runtime.prompt("turn-2", "now edit it");
    const second = events
      .filter((event) => event.type === "workspace_resolved")
      .at(1);
    assert.equal(second.workspace.canonical_path, nested);

    // A different conversation must not inherit it.
    agent.sessionId = "conversation-b";
    await runtime.prompt("turn-3", "and now?");
    const last = events.filter((event) => event.type === "workspace_unresolved").at(-1);
    assert.equal(last.code, "workspace_required");
    assert.equal(last.task_id, "turn-3");
  } finally {
    await rm(nested, { recursive: true, force: true });
  }
});

test("selects root and target independently from the descriptor roles", async () => {
  const { root, nested, report, loose } = await fixture();
  try {
    assert.equal(selectDescriptorHandoff(undefined), undefined);
    assert.equal(selectDescriptorHandoff({ attachments: [] }), undefined);

    const both = selectDescriptorHandoff(capture([directory(nested), selected(report)]));
    assert.equal(both.root.role, "directory");
    assert.equal(both.target.role, "selected_item");

    const rootOnly = selectDescriptorHandoff(capture([rootDescriptor(root)]));
    assert.equal(rootOnly.root.role, "workspace_root");
    assert.equal(rootOnly.target, undefined);

    const targetOnly = selectDescriptorHandoff(capture([document(loose)]));
    assert.equal(targetOnly.root, undefined);
    assert.equal(targetOnly.target.role, "document");

    // Descriptors in other roles contribute nothing rather than being guessed.
    assert.equal(
      selectDescriptorHandoff(capture([{ role: "unknown", path: loose, kind: "file" }])),
      undefined,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
