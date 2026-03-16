/**
 * Shared types for the self-improvement agent.
 */

/** A single interaction record joined from audit_trail + messages. */
export interface InteractionRecord {
  correlationId: string
  userId: string
  channelId: string
  userText: string
  assistantText: string
  status: 'success' | 'error' | 'timeout'
  errorMessage?: string
  skill?: string
  responseTimeMs: number
  inputTokens?: number
  outputTokens?: number
  costUsd?: number
  createdAt: Date
}

/** Types of problems detected in interactions. */
export type ProblemType =
  | 'error'
  | 'timeout'
  | 'negative_feedback'
  | 'short_response'
  | 'slow_response'
  | 'max_turns_exceeded'

/** An interaction flagged as problematic. */
export interface ProblematicCase {
  interaction: InteractionRecord
  problems: ProblemType[]
  /** The user's follow-up message that indicates negative feedback (if applicable). */
  feedbackText?: string
}

/** Fix categories — only registry_fix is auto-applied. */
export type FixCategory = 'registry_fix' | 'prompt_fix' | 'code_fix' | 'infra_fix'

/** A safe fix that can be auto-applied (registry_fix only). */
export interface SafeFix {
  filePath: string
  description: string
  oldContent: string
  newContent: string
}

/** Result of Claude's analysis of a problematic case. */
export interface AnalysisResult {
  correlationId: string
  problems: ProblemType[]
  category: FixCategory
  summary: string
  fix?: SafeFix
}

/** Full self-improvement report for the day. */
export interface SelfImproveReport {
  date: string
  totalInteractions: number
  errorCount: number
  timeoutCount: number
  avgResponseTimeMs: number
  maxResponseTimeMs: number
  totalCostUsd: number
  problematicCases: ProblematicCase[]
  analysisResults: AnalysisResult[]
  appliedFixes: AnalysisResult[]
  failedFixes: Array<{ result: AnalysisResult; error: string }>
  proposedFixes: AnalysisResult[]
}
