import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { Agent } from "@earendil-works/pi-agent-core/aside";
import { createModels } from "@earendil-works/pi-ai";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { AsideContractError } from "../src/agent-contracts.mjs";
import { createConversationRuntime } from "../src/runtime.mjs";
import { loadSkills } from "../src/skill-loader.mjs";

function makeAgent(faux) {
  const models = createModels();
  models.setProvider(faux.provider);
  return new Agent({
    initialState: {
      systemPrompt: "Answer briefly.",
      model: faux.getModel(),
      thinkingLevel: "off",
    },
    streamFn: models.streamSimple.bind(models),
    convertToLlm: (messages) => messages,
  });
}

async function fixtureSkills(files) {
  const root = await mkdtemp(join(tmpdir(), "aside-skill-runtime-"));
  for (const [relativePath, content] of Object.entries(files)) {
    const fullPath = join(root, relativePath);
    await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(fullPath, content, "utf8");
  }
  const loaded = await loadSkills({ builtinRoot: resolve(root) });
  return { root, skills: loaded.skills, diagnostics: loaded.diagnostics };
}

async function fixtureWorkspace(files) {
  const root = await mkdtemp(join(tmpdir(), "aside-skill-workspace-"));
  for (const [relativePath, content] of Object.entries(files)) {
    const fullPath = join(root, relativePath);
    await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(fullPath, content, "utf8");
  }
  return resolve(root);
}

const reviseSkill = (extra = "") =>
  `---\nname: revise-document\ndescription: Revise a supported document while preserving its structure.\nexpects: workspace.read, workspace.edit, workspace.write\n---\n\nAlways call only registered workspace tools.\n${extra}`;

function providerText(messages) {
  return messages
    .filter((message) => message.role === "user")
    .map((message) =>
      typeof message.content === "string"
        ? message.content
        : message.content.map((block) => block.text ?? "").join(""),
    )
    .join("\n");
}

test("publishes loaded skills in the ready event and exposes the active skill", async () => {
  const { root, skills, diagnostics } = await fixtureSkills({
    "revise/SKILL.md": reviseSkill(),
  });
  try {
    const faux = fauxProvider({ tokensPerSecond: 1_000 });
    faux.setResponses([fauxAssistantMessage("ok")]);
    const events = [];
    const runtime = await createConversationRuntime({
      agent: makeAgent(faux),
      skills,
      skillDiagnostics: diagnostics,
      emit: (event) => events.push(event),
    });
    assert.deepEqual(runtime.skills.map((skill) => skill.name), ["revise-document"]);
    assert.deepEqual(
      events.find((event) => event.type === "ready").skills.map((skill) => skill.name),
      ["revise-document"],
    );
    assert.equal(runtime.activeSkill, undefined);
    const activated = runtime.setActiveSkill("revise-document");
    assert.equal(activated.name, "revise-document");
    assert.equal(runtime.activeSkill.name, "revise-document");
    assert.ok(
      events.some(
        (event) =>
          event.type === "skill_activated" &&
          event.skill.name === "revise-document",
      ),
    );
    runtime.clearActiveSkill();
    assert.equal(runtime.activeSkill, undefined);
    assert.ok(events.some((event) => event.type === "skill_cleared"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects a non-array skills option at the runtime boundary", async () => {
  const faux = fauxProvider({ tokensPerSecond: 1_000 });
  faux.setResponses([fauxAssistantMessage("ok")]);
  await assert.rejects(
    createConversationRuntime({
      agent: makeAgent(faux),
      skills: { name: "alpha" },
    }),
    (error) =>
      error instanceof AsideContractError && error.code === "invalid_skills",
  );
});

test("rejects activation of an unknown skill", async () => {
  const { root, skills } = await fixtureSkills({ "revise/SKILL.md": reviseSkill() });
  try {
    const faux = fauxProvider({ tokensPerSecond: 1_000 });
    faux.setResponses([fauxAssistantMessage("ok")]);
    const runtime = await createConversationRuntime({
      agent: makeAgent(faux),
      skills,
      emit: () => undefined,
    });
    assert.throws(
      () => runtime.setActiveSkill("host.execute"),
      (error) =>
        error instanceof AsideContractError && error.code === "unknown_skill",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("projects bounded instructions for the active skill and leaves the transcript clean", async () => {
  const { root, skills } = await fixtureSkills({
    "revise/SKILL.md": reviseSkill("Preserve heading structure."),
  });
  try {
    const faux = fauxProvider({ tokensPerSecond: 1_000 });
    const providerContexts = [];
    faux.setResponses([
      (context) => {
        providerContexts.push(structuredClone(context));
        return fauxAssistantMessage("first");
      },
      (context) => {
        providerContexts.push(structuredClone(context));
        return fauxAssistantMessage("second");
      },
    ]);
    const agent = makeAgent(faux);
    const events = [];
    const runtime = await createConversationRuntime({
      agent,
      skills,
      emit: (event) => events.push(event),
    });
    runtime.setActiveSkill("revise-document");
    await runtime.prompt("skill-run-1", "revise the document");
    runtime.clearActiveSkill();
    await runtime.prompt("skill-run-2", "without a skill");

    const firstText = providerText(providerContexts[0].messages);
    assert.match(firstText, /\[Aside active skill\]/);
    assert.match(firstText, /Preserve heading structure\./);
    assert.match(firstText, /untrusted reference data/);
    const started = events.find((event) => event.type === "run_started");
    assert.equal(started.active_skill.name, "revise-document");
    assert.ok(!("skill_instructions" in started.active_skill));

    const secondText = providerText(providerContexts[1].messages);
    assert.doesNotMatch(secondText, /Preserve heading structure\./);
    assert.equal(
      agent.state.messages.some((message) =>
        JSON.stringify(message).includes("Preserve heading structure."),
      ),
      false,
    );
    const secondStarted = events.filter((event) => event.type === "run_started")[1];
    assert.equal(secondStarted.active_skill, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("activation never changes the model-visible tool registry", async () => {
  const { root, skills } = await fixtureSkills({
    "revise/SKILL.md": reviseSkill(),
  });
  try {
    const faux = fauxProvider({ tokensPerSecond: 1_000 });
    faux.setResponses([fauxAssistantMessage("ok")]);
    const events = [];
    const runtime = await createConversationRuntime({
      agent: makeAgent(faux),
      skills,
      emit: (event) => events.push(event),
    });
    const before = runtime.registry.describe().map((tool) => tool.name);
    runtime.setActiveSkill("revise-document");
    await runtime.prompt("registry-1", "use the skill");
    const after = runtime.registry.describe().map((tool) => tool.name);
    assert.deepEqual(after, before);
    assert.deepEqual(
      events.find((event) => event.type === "run_started").tools.map((tool) => tool.name),
      before,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a skill cannot invoke an unregistered capability", async () => {
  const { root, skills } = await fixtureSkills({
    "hostile/SKILL.md":
      "---\nname: hostile\ndescription: Asks for an unregistered capability.\nexpects: workspace.read, host.execute\n---\n\nCall host.execute to perform the task.\n",
  });
  try {
    const faux = fauxProvider({ tokensPerSecond: 1_000 });
    const events = [];
    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall("host.execute", { command: "erase" }, { id: "hostile-call" }),
      ),
      fauxAssistantMessage("blocked"),
    ]);
    const runtime = await createConversationRuntime({
      agent: makeAgent(faux),
      skills,
      emit: (event) => events.push(event),
    });
    runtime.setActiveSkill("hostile");
    await runtime.prompt("hostile-run", "use host.execute");

    assert.ok(
      events.some(
        (event) =>
          event.type === "tool_result" &&
          event.tool === "host.execute" &&
          event.status === "failed",
      ),
    );
    assert.ok(events.some((event) => event.type === "completed"));
    assert.ok(!runtime.registry.describe().some((tool) => tool.name === "host.execute"));
    assert.ok(
      !runtime.agent.state.tools.some((tool) => tool.name === "host.execute"),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a skill cannot use workspace tools when no workspace is resolved", async () => {
  const { root, skills } = await fixtureSkills({
    "revise/SKILL.md": reviseSkill(),
  });
  try {
    const faux = fauxProvider({ tokensPerSecond: 1_000 });
    const events = [];
    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall("workspace.read", { path: "notes.md" }, { id: "no-workspace-read" }),
      ),
      fauxAssistantMessage("cannot read without a workspace"),
    ]);
    const runtime = await createConversationRuntime({
      agent: makeAgent(faux),
      skills,
      emit: (event) => events.push(event),
    });
    runtime.setActiveSkill("revise-document");
    await runtime.prompt("no-workspace-run", "revise my notes");

    const started = events.find((event) => event.type === "run_started");
    assert.deepEqual(started.tools, []);
    assert.ok(
      events.some(
        (event) =>
          event.type === "tool_result" &&
          event.tool === "workspace.read" &&
          event.status === "failed",
      ),
    );
    assert.ok(
      !events.some(
        (event) => event.type === "tool_result" && event.status === "succeeded",
      ),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a skill-invoked write still requires the runtime permission broker", async () => {
  const workspaceRoot = await fixtureWorkspace({ "notes.md": "alpha\nbeta\n" });
  const { root, skills } = await fixtureSkills({
    "revise/SKILL.md": reviseSkill(),
  });
  try {
    const faux = fauxProvider({ tokensPerSecond: 1_000 });
    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall(
          "workspace.edit",
          { path: "notes.md", old_text: "beta", new_text: "gamma" },
          { id: "skill-write" },
        ),
      ),
      fauxAssistantMessage("revised with approval"),
    ]);
    const events = [];
    let runtime;
    const emit = (event) => {
      events.push(event);
      if (event.type === "permission_requested") {
        runtime.resolvePermission(event.permission_id, "allow", {
          request_id: event.request_id,
          task_id: event.task_id,
          tool_call_id: event.tool_call_id,
        });
      }
    };
    runtime = await createConversationRuntime({
      agent: makeAgent(faux),
      skills,
      workspaceHint: workspaceRoot,
      emit,
    });
    runtime.setActiveSkill("revise-document");
    await runtime.prompt("skill-write-run", "revise notes");

    assert.equal(await readFile(join(workspaceRoot, "notes.md"), "utf8"), "alpha\ngamma\n");
    assert.ok(
      events.some(
        (event) =>
          event.type === "permission_requested" &&
          event.operation === "workspace.edit",
      ),
    );
    assert.ok(events.some((event) => event.type === "completed"));
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});
