import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
  getAsideSettingsPath,
  SETTINGS_MAX_BYTES,
  SettingsError,
  validateSettingsDocument,
} from "./settings-schema.mjs";

export const MISSING_SETTINGS_REVISION = "missing";

function settingsRevision(text) {
  return createHash("sha256").update(text).digest("hex");
}

async function readSettingsText(path) {
  const handle = await open(path, "r");
  try {
    const entry = await handle.stat();
    if (!entry.isFile()) throw new SettingsError("settings_unsafe_file", "Aside settings must be a regular file.");
    if (entry.size > SETTINGS_MAX_BYTES) throw new SettingsError("settings_too_large", "Aside settings exceed the supported size.");
    const buffer = Buffer.alloc(SETTINGS_MAX_BYTES + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, null);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > SETTINGS_MAX_BYTES) throw new SettingsError("settings_too_large", "Aside settings exceed the supported size.");
    return buffer.subarray(0, offset).toString("utf8");
  } finally {
    await handle.close();
  }
}

export async function readUserSettings({ environment = process.env, readTextFile = readSettingsText } = {}) {
  const path = getAsideSettingsPath(environment);
  let text;
  try {
    text = await readTextFile(path, "utf8");
  } catch (error) {
    if (error instanceof SettingsError) throw error;
    if (error?.code === "ENOENT") {
      return Object.freeze({ path, revision: MISSING_SETTINGS_REVISION, document: Object.freeze({ schema_version: 1 }) });
    }
    throw new SettingsError("settings_read_failed", "Aside could not read its settings file.");
  }
  if (typeof text !== "string" || Buffer.byteLength(text) > SETTINGS_MAX_BYTES) {
    throw new SettingsError("settings_too_large", "Aside settings exceed the supported size.");
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new SettingsError("settings_invalid_json", "Aside settings are not valid JSON. The existing file has been preserved.");
  }
  return Object.freeze({ path, revision: settingsRevision(text), document: validateSettingsDocument(parsed) });
}

async function removeFile(path) {
  try {
    await unlink(path);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

async function requireRegularFile(path) {
  try {
    const entry = await lstat(path);
    if (!entry.isFile() || entry.isSymbolicLink()) {
      throw new SettingsError("settings_unsafe_file", "Aside settings must be a regular file, not a link or directory.");
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

async function acquireSettingsLock(path) {
  const lockPath = `${path}.lock`;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let handle;
    try {
      handle = await open(lockPath, "wx", 0o600);
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      try {
        const owner = JSON.parse(await readFile(lockPath, "utf8"));
        if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0) break;
        try {
          process.kill(owner.pid, 0);
          break;
        } catch (probeError) {
          if (probeError?.code !== "ESRCH") break;
        }
        await removeFile(lockPath);
        continue;
      } catch {
        break;
      }
    }
    try {
      await handle.writeFile(JSON.stringify({ pid: process.pid }));
      await handle.close();
      return () => removeFile(lockPath);
    } catch (error) {
      await handle.close().catch(() => undefined);
      await removeFile(lockPath);
      throw error;
    }
  }
  throw new SettingsError("settings_busy", "Another settings update is in progress, or a settings lock needs recovery. Retry after it finishes.");
}

export async function saveUserSettings({
  document,
  expectedRevision,
  environment = process.env,
  replaceFile = rename,
} = {}) {
  const normalized = validateSettingsDocument(document);
  if (expectedRevision !== MISSING_SETTINGS_REVISION && !/^[a-f0-9]{64}$/u.test(expectedRevision ?? "")) {
    throw new SettingsError("settings_revision_required", "Read Aside settings before saving changes.");
  }
  const path = getAsideSettingsPath(environment);
  const text = `${JSON.stringify(normalized, null, 2)}\n`;
  if (Buffer.byteLength(text) > SETTINGS_MAX_BYTES) {
    throw new SettingsError("settings_too_large", "Aside settings exceed the supported size.");
  }
  let releaseLock;
  let temporaryPath;
  try {
    await mkdir(dirname(path), { recursive: true });
    releaseLock = await acquireSettingsLock(path);
    await requireRegularFile(path);
    const current = await readUserSettings({ environment });
    if (current.revision !== expectedRevision) {
      throw new SettingsError("settings_conflict", "Aside settings changed outside this editor. Reload before saving.");
    }
    temporaryPath = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
    const handle = await open(temporaryPath, "wx", 0o600);
    try {
      await handle.writeFile(text, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await requireRegularFile(path);
    const beforeReplace = await readUserSettings({ environment });
    if (beforeReplace.revision !== expectedRevision) {
      throw new SettingsError("settings_conflict", "Aside settings changed outside this editor. Reload before saving.");
    }
    await replaceFile(temporaryPath, path);
    temporaryPath = undefined;
    return Object.freeze({ path, revision: settingsRevision(text), document: normalized });
  } catch (error) {
    if (error instanceof SettingsError) throw error;
    throw new SettingsError("settings_write_failed", "Aside could not save settings. The previous settings file has been preserved.");
  } finally {
    if (temporaryPath) await removeFile(temporaryPath).catch(() => undefined);
    if (releaseLock) await releaseLock().catch(() => undefined);
  }
}
