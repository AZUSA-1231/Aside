export type RuntimeRequest =
  | { type: "prompt"; request_id: string; text: string }
  | { type: "cancel"; request_id: string };

export type RuntimeEvent =
  | { type: "ready"; provider: string; model: string }
  | { type: "run_started"; request_id: string }
  | { type: "text_delta"; request_id: string; delta: string }
  | { type: "completed"; request_id: string }
  | { type: "cancelled"; request_id: string }
  | {
      type: "failed";
      request_id: string;
      message: string;
      retryable: boolean;
    }
  | { type: "runtime_unavailable"; message: string };
