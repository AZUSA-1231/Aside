import { lazyApi } from "./lazy.js";
export const piMessagesApi = () => lazyApi(() => import("./pi-messages.js"));
