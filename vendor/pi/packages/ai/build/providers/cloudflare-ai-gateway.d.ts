import { type Provider } from "../models.ts";
type CloudflareAIGatewayApi = "anthropic-messages" | "openai-completions" | "openai-responses";
export declare function cloudflareAIGatewayProvider(): Provider<CloudflareAIGatewayApi>;
export {};
