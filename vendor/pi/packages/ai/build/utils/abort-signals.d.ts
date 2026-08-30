export interface CombinedAbortSignal {
    signal?: AbortSignal;
    cleanup: () => void;
}
export declare function combineAbortSignals(signals: readonly (AbortSignal | undefined)[]): CombinedAbortSignal;
