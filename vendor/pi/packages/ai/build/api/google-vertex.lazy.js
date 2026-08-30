import { lazyApi } from "./lazy.js";
export const googleVertexApi = () => lazyApi(() => import("./google-vertex.js"));
