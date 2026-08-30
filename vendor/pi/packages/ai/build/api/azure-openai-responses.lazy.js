import { lazyApi } from "./lazy.js";
export const azureOpenAIResponsesApi = () => lazyApi(() => import("./azure-openai-responses.js"));
