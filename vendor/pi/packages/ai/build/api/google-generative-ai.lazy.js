import { lazyApi } from "./lazy.js";
export const googleGenerativeAIApi = () => lazyApi(() => import("./google-generative-ai.js"));
