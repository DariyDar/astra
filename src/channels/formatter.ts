/**
 * Message formatters: convert Claude's standard Markdown output
 * to platform-specific markup.
 *
 * Claude emits: **bold**, *italic*, `code`, ```blocks```, - lists, ## headers, [text](url)
 * Slack wants:  *bold*, _italic_, `code`, ```blocks```, • lists, *Header*, <url|text>
 * Telegram wants: <b>bold</b>, <i>italic</i>, <code>code</code>, <pre>blocks</pre>, • lists, <a href>links</a>
 */

/**
 * Convert standard Markdown to Slack mrkdwn.
 *
 * Rules:
 * - **bold** → *bold*   (Slack bold is single asterisk)
 * - *italic* or _italic_ → _italic_  (Slack italic is underscore)
 * - ## Heading or ### Heading → *Heading* (bold, no native headers in Slack)
 * - # Heading (h1) → *HEADING* (uppercase + bold for prominence)
 * - [text](url) → <url|text>
 * - ```lang\ncode\n``` → ```code``` (kept as-is, Slack renders triple backtick blocks)
 * - `code` → `code` (kept as-is)
 * - - item / * item → • item
 * - 1. item → 1. item (Slack has no native ordered lists, but numbers render fine)
 * - > quote → > quote (Slack renders block quotes)
 */
export function markdownToMrkdwn(text: string): string {
  let result = text

  // 1. Code blocks (fenced) — must be processed before other inline patterns
  //    ```lang\ncode\n``` → ```\ncode\n```  (strip language specifier)
  result = result.replace(/```[a-zA-Z]*\n([\s\S]*?)```/g, '```\n$1```')

  // 2. H1 headings → *HEADING* (uppercase)
  result = result.replace(/^# (.+)$/gm, (_, heading: string) => `*${heading.toUpperCase()}*`)

  // 3. H2/H3 headings → *Heading* (bold)
  result = result.replace(/^#{2,3} (.+)$/gm, '*$1*')

  // 4. Deeper headings (h4-h6) → just bold
  result = result.replace(/^#{4,6} (.+)$/gm, '*$1*')

  // 5. Bold: **text** → *text*  (must come before italic to avoid double-processing)
  result = result.replace(/\*\*(.+?)\*\*/gs, '*$1*')

  // 6. Italic: *text* (single asterisk, non-greedy, not already bold) → _text_
  //    Use negative lookbehind/ahead to avoid touching already-converted bold
  result = result.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/gs, '_$1_')

  // 7. Links: [text](url) → <url|text>
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<$2|$1>')

  // 8. Unordered list bullets: "- item" or "* item" at line start → "• item"
  result = result.replace(/^[ \t]*[-*] /gm, '• ')

  // 9. Escape bare < > & that aren't part of our mrkdwn links (e.g. <url|text>)
  //    Slack treats bare < > & as HTML entities — escape them
  result = result.replace(/&(?!amp;|lt;|gt;)/g, '&amp;')
  // Don't escape < > that are part of mrkdwn links we just created
  // (They are already in <url|text> form which Slack expects)

  return result
}

/**
 * Convert standard Markdown to Telegram HTML.
 *
 * Telegram HTML mode supports: <b>, <i>, <u>, <s>, <code>, <pre>, <a href>, <blockquote>
 * It does NOT support: headers, lists (no <ul>/<li>)
 * Special chars in text must be escaped: & → &amp;  < → &lt;  > → &gt;
 *
 * Rules:
 * - **bold** → <b>bold</b>
 * - *italic* or _italic_ → <i>italic</i>
 * - `code` → <code>code</code>
 * - ```code block``` → <pre><code>code block</code></pre>
 * - [text](url) → <a href="url">text</a>
 * - ## Heading → <b>Heading</b>
 * - - item → • item  (Telegram has no native lists)
 * - > quote → <blockquote>quote</blockquote>
 */
export function markdownToHtml(text: string): string {
  let result = text

  // 1. Code blocks (fenced) — extract before other processing to avoid escaping their content
  const codeBlocks: string[] = []
  result = result.replace(/```[a-zA-Z]*\n?([\s\S]*?)```/g, (_, code: string) => {
    const escaped = escapeHtml(code.trimEnd())
    codeBlocks.push(`<pre><code>${escaped}</code></pre>`)
    return `\x00CODE_BLOCK_${codeBlocks.length - 1}\x00`
  })

  // 2. Inline code — extract before escaping
  const inlineCodes: string[] = []
  result = result.replace(/`([^`]+)`/g, (_, code: string) => {
    const escaped = escapeHtml(code)
    inlineCodes.push(`<code>${escaped}</code>`)
    return `\x00INLINE_CODE_${inlineCodes.length - 1}\x00`
  })

  // 3. Escape HTML special chars in remaining text
  result = escapeHtml(result)

  // 4. H1 headings → <b>HEADING</b>
  result = result.replace(/^# (.+)$/gm, (_, heading: string) => `<b>${heading.toUpperCase()}</b>`)

  // 5. H2/H3+ headings → <b>Heading</b>
  result = result.replace(/^#{2,} (.+)$/gm, '<b>$1</b>')

  // 6. Bold: **text** → <b>text</b>
  result = result.replace(/\*\*(.+?)\*\*/gs, '<b>$1</b>')

  // 7. Italic: *text* or _text_ → <i>text</i>
  //    Use careful regex to avoid touching already-converted <b> tags
  result = result.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/gs, '<i>$1</i>')
  result = result.replace(/(?<!_)_(?!_)(.+?)(?<!_)_(?!_)/gs, '<i>$1</i>')

  // 8. Links: [text](url) → <a href="url">text</a>
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')

  // 9. Block quotes: > text → <blockquote>text</blockquote>
  result = result.replace(/^&gt; (.+)$/gm, '<blockquote>$1</blockquote>')

  // 10. Unordered list bullets: "- item" or "* item" → "• item"
  result = result.replace(/^[ \t]*[-*] /gm, '• ')

  // 11. Restore code blocks
  codeBlocks.forEach((block, i) => {
    result = result.replace(`\x00CODE_BLOCK_${i}\x00`, block)
  })
  inlineCodes.forEach((code, i) => {
    result = result.replace(`\x00INLINE_CODE_${i}\x00`, code)
  })

  return result
}

/**
 * Escape HTML special characters (for use in HTML mode text nodes).
 * Only escapes & < > — Telegram HTML mode only requires these three.
 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}
