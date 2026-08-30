import { lazyApi } from "./lazy.js";
export const openAIResponsesApi = () => lazyApi(() => import("./openai-responses.js"));
