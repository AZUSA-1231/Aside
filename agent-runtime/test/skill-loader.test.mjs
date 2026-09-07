import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  MAX_SKILL_DESCRIPTION_BYTES,
  MAX_SKILL_FILE_BYTES,
  MAX_SKILL_INSTRUCTIONS_BYTES,
  buildSkillManifest,
  createMinimalIgnoreMatcher,
  loadSkillFromText,
  loadSkills,
  loadSkillsFromDirectory,
  parseSkillFrontmatter,
  skillEventList,
} from "../src/skill-loader.mjs";

async function fixture(files) {
  const root = await mkdtemp(join(tmpdir(), "aside-skill-loader-"));
  for (const [relativePath, value] of Object.entries(files)) {
    const fullPath = join(root, relativePath);
    await mkdir(dirname(fullPath), { recursive: true });
    if (typeof value === "string") {
      await writeFile(fullPath, value, "utf8");
    } else {
      await writeFile(fullPath, Buffer.from(value));
    }
  }
  return root;
}

const validSkill = (body = "Follow these bounded instructions.") =>
  `---\nname: alpha\ndescription: A valid bounded skill.\ndisable-model-invocation: false\n---\n\n${body}`;

test("loads a valid builtin layout with bounded metadata and expectations", async () => {
  const root = await fixture({
    "skills/alpha/SKILL.md": validSkill(),
    "skills/beta/SKILL.md":
      "---\nname: beta\ndescription: Second bounded skill.\nexpects: workspace.read, workspace.write\ndisable-model-invocation: true\n---\n\nBeta instructions.",
  });
  try {
    const result = await loadSkills({ builtinRoot: join(root, "skills") });
    assert.equal(result.diagnostics.length, 0);
    assert.deepEqual(
      result.skills.map((skill) => skill.name),
      ["alpha", "beta"],
    );
    const alpha = result.get("alpha");
    assert.equal(alpha.source, "builtin");
    assert.equal(alpha.description, "A valid bounded skill.");
    assert.equal(alpha.disableModelInvocation, false);
    assert.deepEqual(alpha.expects, []);
    assert.match(alpha.instructions, /Follow these bounded instructions/);
    const beta = result.get("beta");
    assert.equal(beta.disableModelInvocation, true);
    assert.deepEqual(beta.expects, ["workspace.read", "workspace.write"]);
    assert.equal(skillEventList(result.skills)[1].model_invocation, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("diagnoses and skips malformed frontmatter", async () => {
  const root = await fixture({
    "skills/gamma/SKILL.md":
      "---\nname: gamma\nthis line has no colon\n---\n\nInstructions.",
  });
  try {
    const result = await loadSkills({ builtinRoot: join(root, "skills") });
    assert.deepEqual(result.skills, []);
    assert.ok(
      result.diagnostics.some(
        (diagnostic) => diagnostic.code === "parse_failed",
      ),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("diagnoses and skips invalid names and missing descriptions", async () => {
  const root = await fixture({
    "skills/Bad-Name/SKILL.md":
      "---\nname: Bad-Name\ndescription: Has an uppercase name.\n---\n\nInstructions.",
    "skills/node/SKILL.md":
      "---\nname: node\n---\n\nNo description.",
    "skills/good/SKILL.md": validSkill(),
  });
  try {
    const result = await loadSkills({ builtinRoot: join(root, "skills") });
    assert.deepEqual(
      result.skills.map((skill) => skill.name),
      ["alpha"],
    );
    assert.ok(
      result.diagnostics.every(
        (diagnostic) => diagnostic.code === "invalid_metadata",
      ),
    );
    assert.equal(
      result.diagnostics.filter((diagnostic) =>
        /lowercase letters/.test(diagnostic.message),
      ).length,
      1,
    );
    assert.equal(
      result.diagnostics.filter((diagnostic) =>
        /description is required/.test(diagnostic.message),
      ).length,
      1,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("diagnoses oversized files and instructions without loading them", async () => {
  const root = await fixture({
    "skills/big-file/SKILL.md": validSkill(`x`.repeat(MAX_SKILL_FILE_BYTES)),
    "skills/big-body/SKILL.md": validSkill(
      `y`.repeat(MAX_SKILL_INSTRUCTIONS_BYTES + 1),
    ),
  });
  try {
    const result = await loadSkills({ builtinRoot: join(root, "skills") });
    assert.deepEqual(result.skills, []);
    assert.equal(
      result.diagnostics.filter(
        (diagnostic) => diagnostic.code === "skill_too_large",
      ).length,
      2,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("diagnoses non-UTF-8 skill files as unsupported encoding", async () => {
  const root = await fixture({
    "skills/binary/SKILL.md": new Uint8Array([0xff, 0xfe, 0x80]),
  });
  try {
    const result = await loadSkills({ builtinRoot: join(root, "skills") });
    assert.deepEqual(result.skills, []);
    assert.ok(
      result.diagnostics.some(
        (diagnostic) => diagnostic.code === "unsupported_encoding",
      ),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("keeps the higher-priority skill on a duplicate name", async () => {
  const root = await fixture({
    "builtin/alpha/SKILL.md": validSkill(),
    "user/alpha/SKILL.md":
      "---\nname: alpha\ndescription: User duplicate.\n---\n\nUser instructions.",
  });
  try {
    const result = await loadSkills({
      builtinRoot: join(root, "builtin"),
      resourcePolicy: { user: { root: join(root, "user"), enabled: true } },
    });
    assert.deepEqual(result.skills.map((skill) => skill.source), ["builtin"]);
    assert.ok(
      result.diagnostics.some(
        (diagnostic) =>
          diagnostic.code === "duplicate_skill" &&
          diagnostic.path.includes("user") &&
          diagnostic.path.endsWith("SKILL.md"),
      ),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("enables user and project sources only through an explicit resource policy", async () => {
  const root = await fixture({
    "user/user-skill/SKILL.md":
      "---\nname: user-skill\ndescription: User skill.\n---\n\nInstructions.",
    "project/project-skill/SKILL.md":
      "---\nname: project-skill\ndescription: Project skill.\n---\n\nInstructions.",
  });
  try {
    const disabled = await loadSkills({
      builtinRoot: join(root, "missing"),
      resourcePolicy: {
        user: { root: join(root, "user"), enabled: false },
        project: { root: join(root, "project"), enabled: false },
      },
    });
    assert.deepEqual(disabled.skills, []);

    const enabled = await loadSkills({
      builtinRoot: join(root, "missing"),
      resourcePolicy: {
        user: { root: join(root, "user"), enabled: true },
        project: { root: join(root, "project"), enabled: true },
      },
    });
    assert.deepEqual(
      enabled.skills.map((skill) => [skill.name, skill.source]),
      [
        ["user-skill", "user"],
        ["project-skill", "project"],
      ],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("skips a missing source directory without a failure", async () => {
  const result = await loadSkills({ builtinRoot: join(tmpdir(), "aside-missing-root-" + Date.now()) });
  assert.deepEqual(result.skills, []);
  assert.deepEqual(result.diagnostics, []);
});

test("honors root-level ignore files when discovering skills", async () => {
  const root = await fixture({
    "skills/.gitignore": "secret/\nignored-file.md\n",
    "skills/secret/SKILL.md": validSkill(),
    "skills/ignored-file.md":
      "---\nname: ignored-file\ndescription: Ignored root file.\n---\n\nInstructions.",
    "skills/visible/SKILL.md": validSkill(),
  });
  try {
    const result = await loadSkills({ builtinRoot: join(root, "skills") });
    assert.deepEqual(
      result.skills.map((skill) => skill.name),
      ["alpha"],
    );
    assert.equal(result.diagnostics.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reports invalid expected tool names but still loads the skill as reference data", () => {
  const result = loadSkillFromText({
    content:
      "---\nname: risky\ndescription: References unregistered tools.\nexpects: workspace.read, host.execute!!\n---\n\nInstructions.",
    filePath: "/root/skills/risky/SKILL.md",
    source: "project",
    parentName: "risky",
  });
  assert.ok(result.skill);
  assert.deepEqual(result.skill.expects, ["workspace.read"]);
  assert.ok(
    result.diagnostics.some(
      (diagnostic) =>
        diagnostic.code === "invalid_metadata" &&
        /host\.execute!!/.test(diagnostic.message),
    ),
  );
});

test("builds a bounded manifest that lists only model-invocable skills", () => {
  const skills = [
    { name: "alpha", description: "A", source: "builtin", disableModelInvocation: false, expects: [] },
    { name: "beta", description: "B", source: "builtin", disableModelInvocation: true, expects: [] },
  ];
  const manifest = buildSkillManifest(skills);
  assert.match(manifest, /<name>alpha<\/name>/);
  assert.doesNotMatch(manifest, /<name>beta<\/name>/);
  assert.match(manifest, /untrusted reference data/);
  assert.equal(buildSkillManifest([]), "");
  assert.ok(new TextEncoder().encode(manifest).byteLength < 8 * 1024);
});

test("bounds the number of skills loaded from one source", async () => {
  const named = (name, body = "Instructions.") =>
    `---\nname: ${name}\ndescription: ${name} skill.\n---\n\n${body}`;
  const files = {};
  for (let index = 0; index < 5; index += 1) {
    files[`skills/skill-${index}/SKILL.md`] = named(`skill-${index}`);
  }
  const root = await fixture(files);
  try {
    const result = await loadSkillsFromDirectory({
      root: join(root, "skills"),
      source: "builtin",
      maxSkills: 2,
    });
    assert.equal(result.skills.length, 2);
    assert.deepEqual(
      result.skills.map((skill) => skill.name),
      ["skill-0", "skill-1"],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("parses frontmatter with quotes, booleans, and missing delimiters", () => {
  assert.deepEqual(parseSkillFrontmatter("plain body"), {
    frontmatter: {},
    body: "plain body",
  });
  const parsed = parseSkillFrontmatter(
    '---\nname: "quoted"\ndescription: \'single\'\ndisable-model-invocation: true\n---\n\nBody text.',
  );
  assert.deepEqual(parsed.frontmatter, {
    name: "quoted",
    description: "single",
    "disable-model-invocation": "true",
  });
  assert.equal(parsed.body, "Body text.");
  const noClose = parseSkillFrontmatter("---\nname: alpha\nno closing delimiter");
  assert.equal(noClose.body, "---\nname: alpha\nno closing delimiter");
});

test("minimal ignore matcher supports negation and globs", () => {
  const matcher = createMinimalIgnoreMatcher([
    "secret/",
    "!secret/keep.md",
    "**/*.tmp",
  ]);
  assert.equal(matcher.ignores("secret"), true);
  assert.equal(matcher.ignores("keep.md"), false);
  assert.equal(matcher.ignores("nested/deep/file.tmp"), true);
  assert.equal(matcher.ignores("secret/keep.md"), false);
});

test("rejects a missing description at the contract level", () => {
  const result = loadSkillFromText({
    content: "---\nname: node\n---\n\nNo description here.",
    filePath: "/root/skills/node/SKILL.md",
    source: "user",
    parentName: "node",
  });
  assert.equal(result.skill, undefined);
  assert.ok(
    result.diagnostics.some((diagnostic) =>
      /description is required/.test(diagnostic.message),
    ),
  );
  assert.equal(MAX_SKILL_DESCRIPTION_BYTES, 1_024);
});
