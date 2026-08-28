import { Buffer } from '../shims/buffer.js';

/**
 * @param {Uint8Array} encryptedKey
 * @param {CryptoKey} privateKey
 */
export async function decryptSessionKey(encryptedKey, privateKey) {
  const decryptKey = privateKey?.decryptKey ?? privateKey;
  const plain = await crypto.subtle.decrypt(
    { name: 'RSA-OAEP', hash: 'SHA-1' },
    decryptKey,
    encryptedKey,
  );
  return new Uint8Array(plain);
}

/**
 * @param {string} encryptedBody
 * @param {Uint8Array|null} sessionKey
 */
export async function decryptMessageBody(encryptedBody, sessionKey) {
  const raw = Buffer.from(encryptedBody, 'base64');
  const blockSize = 16;
  if (raw.length < blockSize * 2) throw new Error('Encrypted message body is too short');
  const iv = raw.subarray(0, blockSize);
  const ciphertext = raw.subarray(blockSize);
  if (ciphertext.length % blockSize !== 0) {
    throw new Error('Encrypted message body length is not block-aligned');
  }
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    sessionKey,
    { name: 'AES-CBC' },
    false,
    ['decrypt'],
  );
  const decrypted = new Uint8Array(await crypto.subtle.decrypt(
    { name: 'AES-CBC', iv },
    cryptoKey,
    ciphertext,
  ));
  return new TextDecoder().decode(decrypted);
}

/**
 * @param {string} body
 * @param {Uint8Array|null} sessionKey
 */
export async function decodeMessageBody(body, sessionKey) {
  if (sessionKey) return decryptMessageBody(body, sessionKey);
  try {
    const parsed = JSON.parse(body);
    if (typeof parsed === 'string') return parsed;
    return JSON.stringify(parsed);
  } catch {
    return body;
  }
}

function bytesToBase64Url(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * @param {string} headerB64
 * @param {string} payloadB64
 * @param {CryptoKey} privateKey
 */
export async function signJwt(headerB64, payloadB64, privateKey) {
  const data = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
  const signature = new Uint8Array(await crypto.subtle.sign(
    { name: 'RSASSA-PKCS1-v1_5' },
    privateKey,
    data,
  ));
  return `${headerB64}.${payloadB64}.${bytesToBase64Url(signature)}`;
}

export { bytesToBase64Url };
