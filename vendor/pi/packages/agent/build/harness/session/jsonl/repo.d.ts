import { Session } from "../session.ts";
import { type ForkOptions, type SessionRepo } from "../types.ts";
import { JsonlSessionStorage } from "./storage.ts";
import type { JsonlSessionCreateOptions, JsonlSessionListOptions, JsonlSessionMetadata, JsonlSessionRepoOptions } from "./types.ts";
export declare function listJsonlSessionMetadata(options: JsonlSessionRepoOptions, query?: JsonlSessionListOptions): Promise<JsonlSessionMetadata[]>;
export declare function loadJsonlSessionStorage(options: JsonlSessionRepoOptions, metadata: JsonlSessionMetadata): Promise<JsonlSessionStorage>;
export declare class JsonlSessionRepo implements SessionRepo<JsonlSessionMetadata, JsonlSessionCreateOptions, JsonlSessionListOptions> {
    private readonly fs;
    private readonly sessionsRootInput;
    private readonly activeCreateDestinations;
    private rootPromise;
    constructor(options: JsonlSessionRepoOptions);
    create(options: JsonlSessionCreateOptions): Promise<Session<JsonlSessionMetadata>>;
    open(metadata: JsonlSessionMetadata): Promise<Session<JsonlSessionMetadata>>;
    list(options?: JsonlSessionListOptions): Promise<JsonlSessionMetadata[]>;
    delete(metadata: JsonlSessionMetadata): Promise<void>;
    fork(source: JsonlSessionMetadata, options: ForkOptions & JsonlSessionCreateOptions): Promise<Session<JsonlSessionMetadata>>;
    private loadStorage;
    private resolveCreateDestination;
    /**
     * Prevent same-process create/fork races for one logical destination. The durable filename includes a
     * timestamp, so the async filesystem existence check alone can let two concurrent calls both decide the
     * same {cwd, id} is free and publish duplicate sessions.
     */
    private claimCreateDestination;
    private prepareCreate;
    private listDirect;
    private sessionIdExists;
    private sessionDirectory;
    private root;
}
