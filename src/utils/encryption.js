import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';
import { getConfig } from '../config/env.js';

function getEncryptionKey() {
  const { appEncryptionKey } = getConfig();
  if (!appEncryptionKey) {
    throw new Error('APP_ENCRYPTION_KEY is required to encrypt stored credentials.');
  }
  return createHash('sha256').update(appEncryptionKey).digest();
}

export function encryptSecret(value) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', getEncryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString('base64url')}.${authTag.toString('base64url')}.${encrypted.toString('base64url')}`;
}

export function decryptSecret(payload) {
  const parts = payload.split('.');
  if (parts.length !== 3) {
    throw new Error('Encrypted secret payload is malformed.');
  }

  const [ivPart, authTagPart, encryptedPart] = parts;
  const decipher = createDecipheriv('aes-256-gcm', getEncryptionKey(), Buffer.from(ivPart, 'base64url'));
  decipher.setAuthTag(Buffer.from(authTagPart, 'base64url'));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(encryptedPart, 'base64url')),
    decipher.final(),
  ]);
  return decrypted.toString('utf8');
}
