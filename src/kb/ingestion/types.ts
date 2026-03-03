import type { KBChunkInput } from '../types.js'

/** A raw item fetched from a source, before chunking. */
export interface RawItem {
  id: string
  text: string
  metadata: Record<string, unknown>
  date?: Date
}

/** Interface that all source adapters must implement. */
export interface SourceAdapter {
  /** Unique name for this adapter instance, e.g. 'slack:ac', 'gmail:dariy'. */
  name: string

  /** Source type for kb_chunks.source column. */
  source: KBChunkInput['source']

  /**
   * Fetch items newer than the given watermark.
   * Returns items in chronological order (oldest first).
   * The watermark is source-specific (timestamp string, page token, etc.).
   * If watermark is empty string, fetch initial batch (e.g., last 3 months).
   */
  fetchSince(watermark: string): Promise<{ items: RawItem[]; nextWatermark: string }>

  /** Convert a raw item into one or more chunk inputs. */
  toChunks(item: RawItem): KBChunkInput[]
}
