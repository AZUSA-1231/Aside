import { lazyApi } from "./lazy.js";
export const openAICompletionsApi = () => lazyApi(() => import("./openai-completions.js"));
