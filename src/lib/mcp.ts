/**
 * Shapes for editing MCP server definitions.
 *
 * `McpServerEntry` is the file's own shape, not the runtime's normalized
 * config: the editor writes back what the user entered, and the runtime adds
 * derived fields (`fingerprint`) only while loading.
 */

export type McpServerEntry = {
  id: string;
  display_name?: string;
  transport?: "stdio";
  command: string;
  args?: string[];
  env?: Record<string, { from_config: string }>;
  tool_classifications?: Record<string, {
    effect?: string;
    scope?: string;
    egress?: string;
    replay?: string;
    schema_digest?: string;
    server_fingerprint?: string;
  }>;
  cwd?: string;
  enabled?: boolean;
  trust_acknowledged?: boolean;
};

export interface McpToolClassification {
  tool: string;
  effect?: string;
  scope?: string;
  egress?: string;
  replay?: string;
  schema_digest?: string;
  server_fingerprint?: string;
  /** The server's identity changed since this classification was approved. */
  stale: boolean;
}

export interface McpServerView {
  raw: McpServerEntry;
  id: string;
  display_name: string;
  enabled: boolean;
  trust_acknowledged: boolean;
  fingerprint: string;
  command: string;
  args: string[];
  cwd: string | null;
  /** Name → configuration reference. Never a value. */
  environment: Array<{ name: string; from_config: string }>;
  classifications: McpToolClassification[];
}

export interface McpSettingsSnapshot {
  path: string;
  revision: string;
  exists: boolean;
  servers: McpServerView[];
  diagnostics: Array<{ index: number; id?: string; code: string; message: string }>;
  effective_revision: string;
}

export type McpTestResult =
  | {
    outcome: "ok";
    server_id: string;
    display_name: string;
    elapsed_ms: number;
    tools: Array<{ name: string }>;
    diagnostics: Array<{ code: string; message: string }>;
  }
  | {
    outcome: "tools_rejected" | "unreachable";
    server_id: string;
    display_name: string;
    elapsed_ms: number;
    message: string;
    code?: string;
    tools: [];
    diagnostics: Array<{ code: string; message: string }>;
  }
  | {
    outcome: "missing_environment";
    server_id: string;
    display_name: string;
    /** Names only — the values are secrets and never leave the runtime. */
    missing: Array<{ name: string; from_config: string }>;
    message: string;
    tools: [];
    diagnostics: [];
  }
  | {
    outcome: "invalid";
    code: string;
    message: string;
    tools: [];
    diagnostics: [];
  };
