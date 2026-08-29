import readline from "node:readline";
import { createConversationRuntime, sanitizeError } from "./runtime.mjs";

function send(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

let runtime;
let setupError;
try {
  runtime = await createConversationRuntime({ emit: send });
} catch (error) {
  setupError = sanitizeError(error);
  send({ type: "runtime_unavailable", message: setupError });
}

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of input) {
  if (!line.trim()) continue;
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    continue;
  }

  if (
    request?.type === "prompt" &&
    typeof request.request_id === "string" &&
    typeof request.text === "string"
  ) {
    if (runtime) {
      void runtime.prompt(request.request_id, request.text);
    } else {
      send({
        type: "failed",
        request_id: request.request_id,
        message: setupError ?? "The Aside runtime is unavailable.",
        retryable: true,
      });
    }
  } else if (
    request?.type === "cancel" &&
    typeof request.request_id === "string" &&
    runtime
  ) {
    runtime.cancel(request.request_id);
  }
}
