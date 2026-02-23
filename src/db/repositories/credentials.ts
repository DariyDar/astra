import { eq } from 'drizzle-orm'
import { db } from '../index.js'
import { credentials } from '../schema.js'
import { encrypt, decrypt } from '../../crypto/encrypt.js'
import type { EncryptedPayload } from '../../crypto/types.js'

/**
 * Repository for encrypted credential storage and retrieval.
 * Only API tokens and OAuth refresh tokens should be stored here.
 */
export class CredentialRepository {
  private readonly encryptionKey: Buffer

  constructor(encryptionKey: Buffer) {
    this.encryptionKey = encryptionKey
  }

  /**
   * Store a credential encrypted with AES-256-GCM.
   * Upserts: if a credential with the same name exists, it is updated.
   */
  async store(name: string, value: string): Promise<void> {
    const payload: EncryptedPayload = encrypt(value, this.encryptionKey)

    await db
      .insert(credentials)
      .values({
        name,
        ciphertext: payload.ciphertext,
        iv: payload.iv,
        tag: payload.tag,
      })
      .onConflictDoUpdate({
        target: credentials.name,
        set: {
          ciphertext: payload.ciphertext,
          iv: payload.iv,
          tag: payload.tag,
          updatedAt: new Date(),
        },
      })
  }

  /**
   * Retrieve and decrypt a credential by name.
   * Returns null if the credential does not exist.
   */
  async retrieve(name: string): Promise<string | null> {
    const rows = await db
      .select()
      .from(credentials)
      .where(eq(credentials.name, name))
      .limit(1)

    if (rows.length === 0) {
      return null
    }

    const row = rows[0]
    const payload: EncryptedPayload = {
      ciphertext: row.ciphertext,
      iv: row.iv,
      tag: row.tag,
    }

    return decrypt(payload, this.encryptionKey)
  }

  /**
   * Delete a credential by name.
   */
  async delete(name: string): Promise<void> {
    await db.delete(credentials).where(eq(credentials.name, name))
  }

  /**
   * List all stored credential names (NOT their values).
   */
  async list(): Promise<string[]> {
    const rows = await db
      .select({ name: credentials.name })
      .from(credentials)

    return rows.map((row) => row.name)
  }
}
