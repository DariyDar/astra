import { readdirSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { logger } from '../logging/logger.js'
import type { Skill } from './types.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

export class SkillRegistry {
  private readonly skills: Skill[] = []

  /** Register a skill manually */
  register(skill: Skill): void {
    if (this.skills.some(s => s.name === skill.name)) {
      logger.warn({ skill: skill.name }, 'Duplicate skill name, skipping')
      return
    }
    this.skills.push(skill)
    logger.debug({ skill: skill.name, triggers: skill.triggers }, 'Skill registered')
  }

  /**
   * Auto-discover and register all skill modules in the skills directory.
   * Each module must default-export a Skill object.
   * Skips types.ts, registry.ts, engine.ts (infrastructure files).
   */
  async loadSkills(): Promise<void> {
    const skillsDir = __dirname
    const SKIP_FILES = new Set(['types.ts', 'types.js', 'registry.ts', 'registry.js', 'engine.ts', 'engine.js'])

    let files: string[]
    try {
      files = readdirSync(skillsDir).filter(
        f => (f.endsWith('.ts') || f.endsWith('.js')) && !f.endsWith('.d.ts') && !SKIP_FILES.has(f),
      )
    } catch {
      logger.warn('Failed to read skills directory')
      return
    }

    for (const file of files) {
      try {
        const modulePath = resolve(skillsDir, file)
        const mod = await import(modulePath) as { default?: Skill }
        if (mod.default && mod.default.name && mod.default.triggers) {
          this.register(mod.default)
        } else {
          logger.debug({ file }, 'Skipped file: no valid default Skill export')
        }
      } catch (error) {
        logger.warn({ file, error }, 'Failed to load skill module')
      }
    }

    logger.info({ count: this.skills.length, skills: this.skills.map(s => s.name) }, 'Skills loaded')
  }

  /**
   * Find the best matching skill for a message text.
   * Uses weighted scoring: multi-word triggers score higher than single-word.
   * Requires a minimum score of 2 to avoid false positives on common words.
   */
  match(text: string): Skill | null {
    const lower = text.toLowerCase()
    let bestSkill: Skill | null = null
    let bestScore = 0

    for (const skill of this.skills) {
      let score = 0
      for (const trigger of skill.triggers) {
        if (lower.includes(trigger)) {
          // Multi-word triggers are more specific → weight by word count
          score += trigger.split(/\s+/).length
        }
      }
      if (score > bestScore && score >= 2) {
        bestScore = score
        bestSkill = skill
      }
    }

    return bestSkill
  }

  /** Get the number of registered skills */
  get count(): number {
    return this.skills.length
  }
}
