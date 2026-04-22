/**
 * Knowledge Base lookup tool — reads vault data without LLM.
 * Returns project cards, people info, channels, statuses.
 */

import { getAllProjects, loadProjectCard, getKnowledgeMap } from '../kb/vault-reader.js'
import { getCached, setCache, TTL } from './cache.js'

export interface KBLookupOpts {
  project?: string
  person?: string
  section?: 'team' | 'channels' | 'docs' | 'status' | 'all'
}

export interface KBResult {
  found: boolean
  data: string
}

export async function lookupKB(opts: KBLookupOpts): Promise<KBResult> {
  const cached = getCached<KBResult>('kb-lookup', opts)
  if (cached) return cached

  const lines: string[] = []

  if (opts.project) {
    const projects = getAllProjects()
    const match = projects.find(p =>
      p.name.toLowerCase().includes(opts.project!.toLowerCase()) ||
      (p.aliases || []).some((a: string) => a.toLowerCase().includes(opts.project!.toLowerCase())),
    )

    if (match) {
      const card = loadProjectCard(match.name)
      if (card) {
        lines.push(`**Проект:** ${match.name}`)
        lines.push(`**Статус:** ${match.status}`)
        lines.push(`**Компания:** ${match.company}`)

        if (!opts.section || opts.section === 'team' || opts.section === 'all') {
          if (card.team_internal?.length) {
            lines.push('\n**Команда:**')
            for (const person of card.team_internal) {
              lines.push(`- ${person}`)
            }
          }
        }

        if (!opts.section || opts.section === 'channels' || opts.section === 'all') {
          if (card.slack_channels && Object.keys(card.slack_channels).length > 0) {
            lines.push('\n**Slack каналы:**')
            for (const [ch, desc] of Object.entries(card.slack_channels)) {
              lines.push(`- ${ch}: ${desc}`)
            }
          }
        }

        if (!opts.section || opts.section === 'docs' || opts.section === 'all') {
          if (card.drive_docs?.length) {
            lines.push('\n**Документы:**')
            for (const doc of card.drive_docs) {
              lines.push(`- ${doc}`)
            }
          }
          if (card.resources?.length) {
            lines.push('\n**Ресурсы:**')
            for (const res of card.resources) {
              lines.push(`- ${res}`)
            }
          }
        }

        if (!opts.section || opts.section === 'status' || opts.section === 'all') {
          if (card.current_status) {
            lines.push('\n**Текущий статус:**')
            if (card.current_status.current_focus) lines.push(`Фокус: ${card.current_status.current_focus}`)
            if (card.current_status.milestones?.length) {
              lines.push('Майлстоуны:')
              for (const m of card.current_status.milestones.slice(0, 5)) {
                lines.push(`- ${m}`)
              }
            }
          }
        }
      }
    }
  }

  if (lines.length === 0) {
    // Fallback — return knowledge map summary
    const map = getKnowledgeMap()
    if (map) {
      lines.push(map.slice(0, 3000)) // cap at 3K chars
    }
  }

  const result: KBResult = {
    found: lines.length > 0,
    data: lines.join('\n') || 'Ничего не найдено в базе знаний',
  }

  setCache('kb-lookup', opts, result, TTL.kb)
  return result
}

/** Format KB result as text for LLM */
export function formatKBResult(result: KBResult): string {
  return `--- База знаний ---\n${result.data}`
}
