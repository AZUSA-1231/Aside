import { lazyApi } from "./lazy.js";
export const openAICodexResponsesApi = () => lazyApi(() => import("./openai-codex-responses.js"));
