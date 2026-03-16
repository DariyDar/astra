/**
 * /improve skill — interactive self-improvement from user feedback.
 *
 * Usage: /improve <фидбек> — analyzes the last interaction, proposes fixes.
 * The bot applies safe YAML registry fixes automatically (with confirmation),
 * and reports unsafe fixes that need manual review.
 *
 * Feedback is stored in known-patterns.yaml for future reference.
 */

import type { Skill, SkillContext, SkillResult } from './types.js'
import { readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { load as yamlParse, dump as yamlDump } from 'js-yaml'
import { logger } from '../logging/logger.js'

const REGISTRY_DIR = resolve(import.meta.dirname, '..', 'kb', 'registry')
const PATTERNS_FILE = join(REGISTRY_DIR, 'known-patterns.yaml')

/** Max size of old/new content for auto-apply. */
const MAX_DIFF_CHARS = 500

interface KnownPattern {
  question_pattern: string
  problem: string
  fix_applied: string
  date: string
}

const improveSkill: Skill = {
  name: 'improve',
  description: 'Analyze last interaction, apply fixes based on user feedback',

  triggers: [
    '/improve', 'improve', 'исправь', 'исправить',
    'запомни ошибку', 'научись', 'улучши',
  ],

  async preProcess(ctx: SkillContext): Promise<SkillResult> {
    // Extract feedback text (everything after /improve or trigger word)
    let feedback = ctx.message.text
    for (const prefix of ['/improve', 'improve', 'исправь', 'запомни ошибку', 'научись', 'улучши']) {
      if (feedback.toLowerCase().startsWith(prefix)) {
        feedback = feedback.slice(prefix.length).trim()
        break
      }
    }

    // Load known patterns for context
    const patterns = loadKnownPatterns()
    const patternsContext = patterns.length > 0
      ? `\n\nИзвестные паттерны ошибок (уже исправленные):\n${patterns.slice(-10).map((p) =>
          `- "${p.question_pattern}" → ${p.problem} → ${p.fix_applied}`).join('\n')}`
      : ''

    const prompt = feedback
      ? `Пользователь даёт фидбек на мой предыдущий ответ: "${feedback}"\n\nПроанализируй последнее взаимодействие из Recent conversation выше и предложи исправления.`
      : 'Пользователь вызвал /improve. Проанализируй моё последнее взаимодействие из Recent conversation выше и спроси, что было не так.'

    return {
      prompt,
      systemPromptExtra: buildImproveSystemPrompt(patternsContext),
    }
  },

  async postProcess(response: string, ctx: SkillContext): Promise<string> {
    // Check if Claude's response contains a fix block to auto-apply
    const fixMatch = response.match(/```yaml:fix\n([\s\S]*?)```/)
    if (!fixMatch) return response

    try {
      const fixData = yamlParse(fixMatch[1]) as {
        file: string
        old: string
        new: string
        description: string
        pattern?: { question: string; problem: string }
      }

      if (!fixData?.file || !fixData?.old || !fixData?.new) {
        return response
      }

      // Validate and apply
      const result = applySafeFix(fixData)

      // Save pattern if provided
      if (fixData.pattern) {
        savePattern({
          question_pattern: fixData.pattern.question,
          problem: fixData.pattern.problem,
          fix_applied: fixData.description,
          date: new Date().toISOString().slice(0, 10),
        })
      }

      // Replace fix block with result
      const fixBlock = fixMatch[0]
      const replacement = result.success
        ? `\n✅ Исправление применено: ${fixData.description}\nФайл: ${fixData.file}`
        : `\n❌ Не удалось применить: ${result.error}\nФайл: ${fixData.file}`

      return response.replace(fixBlock, replacement)
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      logger.warn({ error: msg }, 'Improve: failed to process fix block')
      return response
    }
  },
}

function buildImproveSystemPrompt(patternsContext: string): string {
  return `## Self-Improvement Mode

Ты в режиме самоулучшения. Пользователь даёт фидбек на твой предыдущий ответ.

### Твоя задача:
1. Посмотри на Recent conversation выше — найди последний вопрос пользователя и твой ответ
2. Проанализируй фидбек пользователя — что именно было не так
3. Определи root cause проблемы
4. Предложи исправление

### Типы исправлений:

**Автоматическое (YAML registry)** — если проблема в отсутствующем алиасе, неправильных данных в реестре, недостающей связи.
Сгенерируй блок в формате:
\`\`\`yaml:fix
file: src/kb/registry/path/to/file.yaml
old: |
  existing content to replace
new: |
  new content
description: Краткое описание что исправлено
pattern:
  question: паттерн вопроса который вызвал проблему
  problem: краткое описание проблемы
\`\`\`

Правила для auto-fix:
- ТОЛЬКО файлы в src/kb/registry/**/*.yaml
- old/new не больше ${MAX_DIFF_CHARS} символов каждый
- old должен точно совпадать с текстом в файле (1 совпадение)
- new должен быть валидным YAML

**Ручное** — если нужно менять код, промпты, или структуру. Просто опиши что нужно изменить.

### Формат ответа:
1. **Проблема**: что пошло не так
2. **Root cause**: почему это произошло
3. **Исправление**: блок yaml:fix (если автоматическое) или описание (если ручное)
4. **Проверка**: как проверить что исправление работает

Если фидбека нет (пустое сообщение после /improve), спроси пользователя:
"Что было не так с моим последним ответом? Опиши проблему, и я постараюсь исправить."
${patternsContext}`
}

function applySafeFix(fix: { file: string; old: string; new: string; description: string }): {
  success: boolean
  error?: string
} {
  try {
    const absolutePath = resolve(REGISTRY_DIR, '..', '..', '..', fix.file)
    const allowedPrefix = REGISTRY_DIR

    // Path validation
    if (!absolutePath.startsWith(allowedPrefix) || !fix.file.endsWith('.yaml')) {
      return { success: false, error: `Путь не разрешён: ${fix.file}` }
    }

    if (!existsSync(absolutePath)) {
      return { success: false, error: `Файл не найден: ${fix.file}` }
    }

    // Size guard
    if (fix.old.length > MAX_DIFF_CHARS || fix.new.length > MAX_DIFF_CHARS) {
      return { success: false, error: `Изменение слишком большое (>${MAX_DIFF_CHARS} символов)` }
    }

    const content = readFileSync(absolutePath, 'utf-8')

    // Normalize line endings for matching
    const normalizedContent = content.replace(/\r\n/g, '\n')
    const normalizedOld = fix.old.replace(/\r\n/g, '\n').trim()

    // Check uniqueness
    const occurrences = normalizedContent.split(normalizedOld).length - 1
    if (occurrences === 0) {
      return { success: false, error: 'Текст для замены не найден в файле' }
    }
    if (occurrences > 1) {
      return { success: false, error: `Найдено ${occurrences} совпадений — неоднозначная замена` }
    }

    const newContent = normalizedContent.replace(normalizedOld, fix.new.replace(/\r\n/g, '\n').trim())

    // Validate YAML
    try {
      yamlParse(newContent)
    } catch {
      return { success: false, error: 'Результат не является валидным YAML' }
    }

    // Atomic write
    const tmpPath = absolutePath + '.tmp'
    writeFileSync(tmpPath, newContent, 'utf-8')
    renameSync(tmpPath, absolutePath)

    logger.info({ file: fix.file, description: fix.description }, 'Improve: fix applied')
    return { success: true }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    return { success: false, error: msg }
  }
}

function loadKnownPatterns(): KnownPattern[] {
  try {
    if (!existsSync(PATTERNS_FILE)) return []
    const content = readFileSync(PATTERNS_FILE, 'utf-8')
    const data = yamlParse(content) as { patterns?: KnownPattern[] }
    return data?.patterns ?? []
  } catch {
    return []
  }
}

function savePattern(pattern: KnownPattern): void {
  try {
    const patterns = loadKnownPatterns()
    patterns.push(pattern)

    // Keep last 100 patterns
    const trimmed = patterns.slice(-100)
    const content = yamlDump({ patterns: trimmed }, { lineWidth: 120 })

    const tmpPath = PATTERNS_FILE + '.tmp'
    writeFileSync(tmpPath, content, 'utf-8')
    renameSync(tmpPath, PATTERNS_FILE)

    logger.info({ pattern: pattern.question_pattern }, 'Improve: pattern saved')
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    logger.warn({ error: msg }, 'Improve: failed to save pattern')
  }
}

export default improveSkill
