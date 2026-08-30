import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createModels } from "@earendil-works/pi-ai";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { createConfiguredAgent } from "../src/runtime.mjs";
import {
  getAsideConfigCandidates,
  loadAsideConfig,
  normalizeAsideApiUrl,
  parseAsideEnv,
} from "../src/config.mjs";

async function createTempDirectory(t) {
  const directory = await mkdtemp(join(tmpdir(), "aside-config-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test("parses .env.local and gives existing environment values precedence", async (t) => {
  const root = await createTempDirectory(t);
  const child = join(root, "agent-runtime");
  await mkdir(child);
  await writeFile(
    join(root, ".env.local"),
    [
      "ASIDE_PROVIDER=openai",
      'ASIDE_MODEL="gpt-4o-mini"',
      "OPENAI_API_KEY='file-secret'",
      "ASIDE_API_URL=https://proxy.example/v1/",
    ].join("\n"),
  );

  const configuration = await loadAsideConfig({
    cwd: child,
    environment: {
      ASIDE_MODEL: "gpt-4.1",
      OPENAI_API_KEY: "environment-secret",
    },
  });

  assert.equal(configuration.source, join(root, ".env.local"));
  assert.equal(configuration.values.ASIDE_PROVIDER, "openai");
  assert.equal(configuration.values.ASIDE_MODEL, "gpt-4.1");
  assert.equal(configuration.values.OPENAI_API_KEY, "environment-secret");
  assert.equal(configuration.values.ASIDE_API_URL, "https://proxy.example/v1/");
});

test("uses the packaged config fallback when no project file exists", async (t) => {
  const root = await createTempDirectory(t);
  const localAppData = join(root, "local-app-data");
  await mkdir(join(localAppData, "Aside"), { recursive: true });
  await writeFile(
    join(localAppData, "Aside", "config.env"),
    "ASIDE_PROVIDER=openai\nASIDE_MODEL=gpt-4.1\n",
  );

  const configuration = await loadAsideConfig({
    cwd: join(root, "unrelated"),
    environment: { LOCALAPPDATA: localAppData },
  });

  assert.equal(configuration.source, join(localAppData, "Aside", "config.env"));
  assert.equal(configuration.values.ASIDE_MODEL, "gpt-4.1");
});

test("injects file credentials into Pi auth without mutating process.env", async (t) => {
  const root = await createTempDirectory(t);
  const originalKey = process.env.OPENAI_API_KEY;
  await writeFile(join(root, ".env.local"), "OPENAI_API_KEY=file-secret\n");
  const configuration = await loadAsideConfig({ cwd: root, environment: {} });
  const models = createModels({
    authContext: {
      env: async (name) => configuration.values[name],
      fileExists: async () => false,
    },
  });
  const provider = openaiProvider();
  models.setProvider(provider);
  const model = models.getModel("openai", "gpt-4.1");
  assert.ok(model);

  const auth = await models.getAuth(model);
  assert.equal(auth?.auth.apiKey, "file-secret");
  assert.equal(process.env.OPENAI_API_KEY, originalKey);
});

test("applies an Aside API URL to the selected Pi model", async (t) => {
  const root = await createTempDirectory(t);
  await writeFile(
    join(root, ".env.local"),
    "ASIDE_PROVIDER=openai\nASIDE_MODEL=gpt-4.1\nASIDE_API_URL=http://localhost:11434/v1/\n",
  );

  const configured = await createConfiguredAgent({
    configCwd: root,
    environment: {},
  });

  assert.equal(configured.provider, "openai");
  assert.equal(configured.model, "gpt-4.1");
  assert.equal(configured.agent.state.model.baseUrl, "http://localhost:11434/v1");
});

test("validates API URLs without exposing their value", () => {
  assert.equal(
    normalizeAsideApiUrl(" https://proxy.example/v1/ "),
    "https://proxy.example/v1",
  );
  assert.throws(
    () => normalizeAsideApiUrl("ftp://proxy.example/v1"),
    /HTTP or HTTPS provider URL/,
  );
  assert.throws(
    () => normalizeAsideApiUrl("https://user:secret@proxy.example/v1"),
    /without credentials/,
  );
});

test("rejects non-string config parser input", () => {
  assert.throws(() => parseAsideEnv(null), /configuration file .* is invalid/);
  assert.ok(getAsideConfigCandidates({ cwd: process.cwd(), environment: {} }).length > 0);
});
