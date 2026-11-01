import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { handleSettingsRequest } from "./settings-service.mjs";
import { SETTINGS_MAX_BYTES, SettingsError } from "./settings-schema.mjs";

export async function runSettingsControl({ input = process.stdin, output = process.stdout, environment = process.env, cwd = process.cwd() } = {}) {
  try {
    const chunks = [];
    let bytes = 0;
    for await (const chunk of input) {
      bytes += Buffer.byteLength(chunk);
      if (bytes > SETTINGS_MAX_BYTES) throw new SettingsError("settings_request_too_large", "The settings request is too large.");
      chunks.push(Buffer.from(chunk));
    }
    let request;
    try {
      request = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      throw new SettingsError("settings_invalid_request", "The settings request is not valid JSON.");
    }
    const { credential_values, ...operation } = request;
    const settings = await handleSettingsRequest(operation, { environment, cwd, credentialValues: credential_values });
    output.write(`${JSON.stringify({ ok: true, settings })}\n`);
  } catch (error) {
    output.write(`${JSON.stringify({ ok: false, error: error instanceof SettingsError
      ? { code: error.code, message: error.message }
      : { code: "settings_unavailable", message: "Aside could not access its settings. Existing files have been preserved." } })}\n`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runSettingsControl();
}
