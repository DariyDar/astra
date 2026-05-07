/**
 * Polish wiki article HTML using Claude Haiku.
 *
 * Strict prompt: keep ALL content, only fix structure (heading hierarchy,
 * list/table formatting, paragraph splits). No rewriting, no removing,
 * no adding facts. Output must be valid wiki-allow-list HTML.
 */

import { callClaude } from '../../src/llm/client.js'
import { sanitizeWikiHtml } from './markdown-to-html.js'

const SYSTEM_PROMPT = `Ты редактор корпоративной wiki. На вход — HTML статьи, экспортированной из Notion или ClickUp. Твоя задача — улучшить ФОРМАТИРОВАНИЕ, не меняя содержание.

ЖЁСТКИЕ ПРАВИЛА:
1. НИЧЕГО не удаляй из текста. Каждое предложение, каждое число, каждая ссылка должны остаться. Если в исходнике есть «Levels: 1, 2, 3, 4, 5» — все цифры должны быть в выходе.
2. НИЧЕГО не выдумывай. Не добавляй пояснений, контекста, выводов, которых нет в исходнике.
3. НЕ переводи текст. Русский остаётся русским, английский — английским.
4. НЕ меняй смысл предложений. Можешь только перенести предложение в правильный раздел или разбить параграф на абзацы.

ЧТО МОЖНО МЕНЯТЬ:
- Иерархия заголовков (h1 → h2 → h3 без пропусков уровней). h1 в статье должен быть один (название).
- Большие куски текста с маркерами «- » или «1)» превратить в <ul>/<ol> с <li>.
- Таблицы из текста с | -разделителями превратить в <table><thead><tbody>.
- Длинный <p> разбить на абзацы по смыслу.
- Удалить служебные пометки типа «TODO:», «WIP», «черновик» ТОЛЬКО если они явно мета-комментарии не относящиеся к содержанию.
- Опечатки в тегах (<strng> → <strong>) исправить.

РАЗРЕШЁННЫЕ ТЕГИ (только эти): h1, h2, h3, h4, h5, h6, p, a, img, ul, ol, li, table, thead, tbody, tr, th, td, strong, b, em, i, u, s, del, br, hr, blockquote, code, pre, sup, sub, span, div.
РАЗРЕШЁННЫЕ АТРИБУТЫ: href, src, alt, colspan, rowspan, target, rel.
ЗАПРЕЩЕНО: style="...", class="...", любые скрипты, любые data-атрибуты.

Верни ТОЛЬКО HTML — без markdown-обрамления \`\`\`, без пояснений до или после.`

export interface PolishResult {
  html: string
  inputChars: number
  outputChars: number
  costUsd?: number
}

export async function polishHtml(html: string): Promise<PolishResult> {
  const inputChars = html.length

  // Hard limit on input — Haiku context. Drop polish for very large docs.
  const MAX_INPUT = 80_000
  if (inputChars > MAX_INPUT) {
    return { html, inputChars, outputChars: inputChars }
  }
  if (inputChars < 100) {
    return { html, inputChars, outputChars: inputChars }
  }

  try {
    const resp = await callClaude(html, {
      system: SYSTEM_PROMPT,
      model: 'haiku',
      timeoutMs: 180_000,
    })
    let polished = resp.text.trim()

    // Strip markdown fences if model added them
    polished = polished.replace(/^```(?:html)?\s*/i, '').replace(/\s*```$/i, '').trim()

    // Sanity check: refuse if output is wildly shorter (model truncated/refused)
    if (polished.length < inputChars * 0.5) {
      console.log(`    polish: output too short (${polished.length} vs input ${inputChars}), keeping original`)
      return { html, inputChars, outputChars: inputChars, costUsd: resp.usage?.costUsd }
    }

    // Always sanitize — defence against model hallucinating banned tags
    const safe = sanitizeWikiHtml(polished)

    return {
      html: safe,
      inputChars,
      outputChars: safe.length,
      costUsd: resp.usage?.costUsd,
    }
  } catch (e) {
    console.log(`    polish failed: ${(e as Error).message.slice(0, 100)}`)
    return { html, inputChars, outputChars: inputChars }
  }
}
