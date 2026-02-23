import crypto from 'node:crypto'
import type { EncryptedPayload } from './types.js'

const ALGORITHM = 'aes-256-gcm'
/** NIST recommended IV length for GCM: 96 bits */
const IV_LENGTH = 12
/** GCM authentication tag length: 128 bits */
const TAG_LENGTH = 16

/**
 * Encrypt plaintext using AES-256-GCM.
 * Generates a fresh random IV for every call (critical: never reuse IVs with GCM).
 */
export function encrypt(plaintext: string, key: Buffer): EncryptedPayload {
  const iv = crypto.randomBytes(IV_LENGTH)
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv, {
    authTagLength: TAG_LENGTH,
  })

  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ])

  const tag = cipher.getAuthTag()

  return {
    ciphertext: encrypted.toString('base64'),
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
  }
}

/**
 * Decrypt an AES-256-GCM encrypted payload back to plaintext.
 * Sets the auth tag BEFORE calling final() (critical for GCM integrity verification).
 */
export function decrypt(payload: EncryptedPayload, key: Buffer): string {
  const iv = Buffer.from(payload.iv, 'base64')
  const tag = Buffer.from(payload.tag, 'base64')
  const ciphertext = Buffer.from(payload.ciphertext, 'base64')

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, {
    authTagLength: TAG_LENGTH,
  })

  // CRITICAL: setAuthTag must be called BEFORE final() for GCM integrity
  decipher.setAuthTag(tag)

  const decrypted = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ])

  return decrypted.toString('utf8')
}

/**
 * Convert a 64-character hex string to a 32-byte Buffer suitable as AES-256 key.
 */
export function deriveKeyFromHex(hexKey: string): Buffer {
  if (hexKey.length !== 64) {
    throw new Error(
      `Encryption key must be 64 hex characters (32 bytes), got ${hexKey.length}`,
    )
  }
  return Buffer.from(hexKey, 'hex')
}
