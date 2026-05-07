/**
 * Notion blocks → wiki-safe HTML.
 *
 * Replaces the inline-styled converter from scripts/notion-to-drive.ts.
 * Output uses ONLY tags from the wiki-portal allow-list — no style/class.
 * Designed for wiki transfer; not a faithful Notion-rendering exercise.
 *
 * Image URLs are returned as-is (Notion S3); call rewriteImagesInHtml from
 * media-downloader.ts afterwards to replace them with stable Drive URLs.
 */

import { NotionClient, escapeHtml, richTextToHtml, type NotionBlock, type RichText } from './notion-client.js'

export interface NotionPageHtml {
  html: string
  /** Map<image source URL, originating Notion block ID> for media refresh. */
  imageBlocks: Map<string, string>
}

export async function pageToHtml(
  client: NotionClient,
  pageId: string,
  pageTitle: string,
): Promise<NotionPageHtml> {
  const blocks = await client.getAllChildren(pageId)
  const parts: string[] = []
  const imageBlocks = new Map<string, string>()
  parts.push(`<h1>${escapeHtml(pageTitle)}</h1>`)
  for (const block of blocks) {
    try {
      parts.push(await blockToHtml(client, block, 0, imageBlocks))
    } catch (e) {
      parts.push(`<!-- block ${block.id} failed: ${escapeHtml((e as Error).message.slice(0, 100))} -->`)
    }
  }
  return {
    html: wrapLists(parts.filter(Boolean).join('\n')),
    imageBlocks,
  }
}

/**
 * Refresh a Notion media URL by re-fetching its block. S3 URLs expire ~1h.
 * Returns null if block has no image URL anymore.
 */
export async function refreshNotionMediaUrl(
  client: NotionClient,
  blockId: string,
): Promise<string | null> {
  try {
    const block = await client.get(`/blocks/${blockId}`) as NotionBlock & {
      image?: { type?: string; file?: { url: string }; external?: { url: string } }
      file?: { type?: string; file?: { url: string }; external?: { url: string } }
    }
    const image = block.image
    if (image) {
      const url = image.type === 'file' ? image.file?.url : image.external?.url
      return url ?? null
    }
    return null
  } catch {
    return null
  }
}

async function blockToHtml(
  client: NotionClient,
  block: NotionBlock,
  depth: number,
  imageBlocks: Map<string, string>,
): Promise<string> {
  const type = block.type
  const data = block[type] as Record<string, unknown> | undefined
  if (!data) return ''

  const richText = (data.rich_text ?? []) as RichText[]
  const text = richTextToHtml(richText)

  let childrenHtml = ''
  if (block.has_children && depth < 8) {
    const children = await client.getAllChildren(block.id)
    const parts: string[] = []
    for (const child of children) {
      parts.push(await blockToHtml(client, child, depth + 1, imageBlocks))
    }
    childrenHtml = parts.join('\n')
  }

  switch (type) {
    case 'paragraph':
      return text ? `<p>${text}</p>${wrapChildren(childrenHtml)}` : wrapChildren(childrenHtml)

    case 'heading_1':
      return `<h2>${text}</h2>${wrapChildren(childrenHtml)}` // page title is h1, demote
    case 'heading_2':
      return `<h3>${text}</h3>${wrapChildren(childrenHtml)}`
    case 'heading_3':
      return `<h4>${text}</h4>${wrapChildren(childrenHtml)}`

    case 'bulleted_list_item':
      return `<li class="bullet">${text}${childrenHtml ? wrapNestedList(childrenHtml, false) : ''}</li>`
    case 'numbered_list_item':
      return `<li class="number">${text}${childrenHtml ? wrapNestedList(childrenHtml, true) : ''}</li>`

    case 'to_do': {
      const checked = (data.checked as boolean) ? '☑' : '☐'
      return `<li class="bullet">${checked} ${text}</li>`
    }

    case 'toggle':
      return `<p><strong>${text}</strong></p>${wrapChildren(childrenHtml)}`

    case 'quote':
      return `<blockquote>${text}${wrapChildren(childrenHtml)}</blockquote>`

    case 'callout': {
      const icon = data.icon as { type: string; emoji?: string } | null
      const emoji = icon?.emoji ? `${icon.emoji} ` : ''
      return `<blockquote>${emoji}${text}${wrapChildren(childrenHtml)}</blockquote>`
    }

    case 'code': {
      const lang = (data.language as string) || ''
      const langClass = lang ? ` class="language-${escapeHtml(lang)}"` : ''
      const codeText = richText.map(r => escapeHtml(r.plain_text)).join('')
      return `<pre><code${langClass}>${codeText}</code></pre>`
    }

    case 'divider':
      return '<hr>'

    case 'image': {
      const imageData = data as { type: string; file?: { url: string }; external?: { url: string }; caption?: RichText[] }
      const url = imageData.type === 'file' ? imageData.file?.url : imageData.external?.url
      const caption = imageData.caption ? richTextToHtml(imageData.caption) : ''
      if (!url) return '<!-- image: no url -->'
      imageBlocks.set(url, block.id)
      const alt = caption.replace(/<[^>]+>/g, '') || 'image'
      const img = `<img src="${escapeHtml(url)}" alt="${escapeHtml(alt)}">`
      return caption ? `<p>${img}<br><em>${caption}</em></p>` : `<p>${img}</p>`
    }

    case 'video': {
      const v = data as { type: string; file?: { url: string }; external?: { url: string } }
      const url = v.type === 'file' ? v.file?.url : v.external?.url
      if (!url) return ''
      return `<p><a href="${escapeHtml(url)}">[Видео]</a></p>`
    }

    case 'file': {
      const f = data as { type: string; file?: { url: string }; external?: { url: string }; name?: string }
      const url = f.type === 'file' ? f.file?.url : f.external?.url
      const name = (f.name as string) || 'Файл'
      if (!url) return ''
      return `<p><a href="${escapeHtml(url)}">${escapeHtml(name)}</a></p>`
    }

    case 'bookmark': {
      const u = (data.url as string) || ''
      const caption = (data.caption as RichText[]) || []
      const label = caption.length ? richTextToHtml(caption) : escapeHtml(u)
      return `<p><a href="${escapeHtml(u)}">${label}</a></p>`
    }

    case 'embed': {
      const u = (data.url as string) || ''
      return `<p><a href="${escapeHtml(u)}">${escapeHtml(u)}</a></p>`
    }

    case 'link_preview': {
      const u = (data.url as string) || ''
      return `<p><a href="${escapeHtml(u)}">${escapeHtml(u)}</a></p>`
    }

    case 'table': {
      const rows = block.has_children ? await client.getAllChildren(block.id) : []
      const hasHeader = (data.has_column_header as boolean) === true
      const headerRows: string[] = []
      const bodyRows: string[] = []
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i]
        const cells = ((row.table_row as Record<string, unknown>)?.cells ?? []) as RichText[][]
        const tag = i === 0 && hasHeader ? 'th' : 'td'
        const tr = '<tr>' + cells.map(c => `<${tag}>${richTextToHtml(c)}</${tag}>`).join('') + '</tr>'
        if (tag === 'th') headerRows.push(tr)
        else bodyRows.push(tr)
      }
      const head = headerRows.length ? `<thead>${headerRows.join('')}</thead>` : ''
      const body = bodyRows.length ? `<tbody>${bodyRows.join('')}</tbody>` : ''
      return `<table>${head}${body}</table>`
    }

    case 'table_row':
      return ''

    case 'column_list':
    case 'column':
      return childrenHtml

    case 'child_page':
      return `<p><strong>📄 ${escapeHtml((data.title as string) || 'Подстраница')}</strong></p>${wrapChildren(childrenHtml)}`

    case 'child_database':
      return `<p><em>[База данных: ${escapeHtml((data.title as string) || 'Untitled')}]</em></p>`

    case 'synced_block':
      return childrenHtml

    case 'equation':
      return `<p><code>${escapeHtml((data.expression as string) || '')}</code></p>`

    default:
      return text ? `<p>${text}</p>` : ''
  }
}

function wrapChildren(html: string): string {
  return html ? `\n${html}` : ''
}

function wrapNestedList(html: string, ordered: boolean): string {
  const tag = ordered ? 'ol' : 'ul'
  return `<${tag}>${html}</${tag}>`
}

/**
 * Wrap consecutive <li class="bullet"> in <ul>, consecutive <li class="number"> in <ol>.
 * Removes the class= markers afterwards (wiki sanitizer drops them anyway).
 */
function wrapLists(html: string): string {
  // Convert sequences of <li class="bullet"> ... </li>
  let out = html.replace(/(?:<li class="bullet">[\s\S]*?<\/li>\s*)+/g, (group) => {
    const items = group.replace(/class="bullet"/g, '')
    return `<ul>${items}</ul>`
  })
  out = out.replace(/(?:<li class="number">[\s\S]*?<\/li>\s*)+/g, (group) => {
    const items = group.replace(/class="number"/g, '')
    return `<ol>${items}</ol>`
  })
  return out
}
