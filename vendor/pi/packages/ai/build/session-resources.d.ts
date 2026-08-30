export type SessionResourceCleanup = (sessionId?: string) => void;
export declare function registerSessionResourceCleanup(cleanup: SessionResourceCleanup): () => void;
export declare function cleanupSessionResources(sessionId?: string): void;
