export type SettingsProvider = "openai" | "anthropic" | "deepseek" | "google";
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface SettingsDocument {
  schema_version: 1;
  provider?: SettingsProvider;
  model?: string | null;
  api_url?: string | null;
  thinking_level?: ThinkingLevel;
  workspace_root?: string | null;
  mcp_config_path?: string | null;
}

export interface SettingsSnapshot {
  schema_version: 1;
  path: string;
  revision: string;
  effective_revision: string;
  document: SettingsDocument;
  effective: {
    provider: string;
    model: string | null;
    api_url: string | null;
    thinking_level: string;
    workspace_root: string | null;
    mcp_config_path: string;
  };
  sources: Record<Exclude<keyof SettingsDocument, "schema_version">, {
    kind: "environment" | "settings" | "legacy" | "default";
    path?: string;
  }>;
  credentials: Record<SettingsProvider, {
    configured: boolean;
    source: "none" | "environment" | "legacy" | "credential_store";
    stored?: boolean;
    storage_error?: boolean;
  }>;
  legacy_source: string | null;
  default_workspace_root?: string | null;
  diagnostics: Array<{ code: string; field: string; message: string }>;
  runtime_fields: string[];
  application: {
    state: "not_started" | "starting" | "loaded" | "pending" | "applying" | "unavailable";
    loaded_revision: string | null;
    mode: "runtime_start" | "idle_rebuild";
    last_apply_error?: string | null;
  };
}

export interface ProviderCatalog {
  provider: SettingsProvider;
  default_model: string | null;
  models: Array<{
    id: string;
    name: string;
    api: string;
    base_url: string;
    reasoning: boolean;
    input: string[];
    context_window: number;
    max_tokens: number;
    thinking_levels: ThinkingLevel[];
  }>;
}

export interface ConnectionTestResult {
  ok: boolean;
  code: string;
  message: string;
  effective_revision: string;
  provider?: string;
  model?: string;
}
