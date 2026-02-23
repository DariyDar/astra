/**
 * Context for tracking LLM requests through the system.
 */
export interface LlmRequestContext {
  correlationId: string
  action: string
  userId?: string
}
