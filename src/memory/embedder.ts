import type { FeatureExtractionPipeline } from '@huggingface/transformers'
import { logger } from '../logging/logger.js'

const MODEL_NAME = 'Xenova/paraphrase-multilingual-MiniLM-L12-v2'
const EMBEDDING_DIMENSION = 384

let embedder: FeatureExtractionPipeline | null = null

/**
 * Initialize the local ONNX embedding pipeline.
 * Downloads the model on first run (~90MB), cached locally after that.
 * Should be called during application startup to trigger model download.
 */
export async function initEmbedder(): Promise<void> {
  if (embedder) {
    return
  }

  logger.info({ model: MODEL_NAME }, 'Initializing embedding pipeline')

  // Dynamic import avoids TS2590 "union type too complex" on pipeline() overloads
  const { pipeline } = await import('@huggingface/transformers')
  embedder = (await (pipeline as Function)(
    'feature-extraction',
    MODEL_NAME,
    { dtype: 'fp32' },
  )) as FeatureExtractionPipeline

  logger.info(
    { model: MODEL_NAME, dimension: EMBEDDING_DIMENSION },
    'Embedding pipeline initialized',
  )
}

/**
 * Embed text into a dense vector using the local ONNX model.
 * Returns a normalized 384-dimensional vector suitable for cosine similarity.
 *
 * @throws Error if initEmbedder() has not been called
 */
export async function embed(text: string): Promise<number[]> {
  if (!embedder) {
    throw new Error(
      'Embedder not initialized. Call initEmbedder() during startup.',
    )
  }

  const output = await embedder(text, { pooling: 'mean', normalize: true })
  return Array.from(output.data as Float32Array)
}

/**
 * Get the embedding vector dimension for the configured model.
 */
export function getEmbeddingDimension(): number {
  return EMBEDDING_DIMENSION
}
