/**
 * Encrypted payload produced by AES-256-GCM encryption.
 * All fields are base64-encoded strings.
 */
export interface EncryptedPayload {
  /** Base64-encoded ciphertext */
  ciphertext: string
  /** Base64-encoded initialization vector (96-bit / 12 bytes) */
  iv: string
  /** Base64-encoded authentication tag (128-bit / 16 bytes) */
  tag: string
}
