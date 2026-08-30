import { lazyApi } from "./lazy.js";
export const anthropicMessagesApi = () => lazyApi(() => import("./anthropic-messages.js"));
