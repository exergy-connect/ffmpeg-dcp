import {
  constants,
  createDecipheriv,
  privateDecrypt,
} from "node:crypto";

/**
 * @param {Buffer} encryptedKey
 * @param {import("node:crypto").KeyObject} privateKey
 */
export function decryptSessionKey(encryptedKey, privateKey) {
  return privateDecrypt(
    {
      key: privateKey,
      padding: constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: "sha1",
    },
    encryptedKey
  );
}

/**
 * @param {Buffer} data
 * @param {number} blockSize
 */
function pkcs7Unpad(data, blockSize) {
  if (data.length === 0) {
    throw new Error("Invalid PKCS#7 padding");
  }
  const padLen = data[data.length - 1];
  if (padLen === 0 || padLen > blockSize || padLen > data.length) {
    throw new Error("Invalid PKCS#7 padding");
  }
  for (let index = data.length - padLen; index < data.length; index += 1) {
    if (data[index] !== padLen) {
      throw new Error("Invalid PKCS#7 padding");
    }
  }
  return data.subarray(0, data.length - padLen);
}

/**
 * @param {string} encryptedBody
 * @param {Buffer} sessionKey
 */
export function decryptMessageBody(encryptedBody, sessionKey) {
  const raw = Buffer.from(encryptedBody, "base64");
  const blockSize = 16;
  if (raw.length < blockSize * 2) {
    throw new Error("Encrypted message body is too short");
  }

  const iv = raw.subarray(0, blockSize);
  const ciphertext = raw.subarray(blockSize);
  if (ciphertext.length % blockSize !== 0) {
    throw new Error("Encrypted message body length is not block-aligned");
  }

  const decipher = createDecipheriv("aes-256-cbc", sessionKey, iv);
  const decrypted = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);
  return pkcs7Unpad(decrypted, blockSize).toString("utf8");
}

/**
 * @param {string} body
 * @param {Buffer|null} sessionKey
 */
export function decodeMessageBody(body, sessionKey) {
  if (sessionKey) {
    return decryptMessageBody(body, sessionKey);
  }

  try {
    const parsed = JSON.parse(body);
    if (typeof parsed === "string") {
      return parsed;
    }
    return JSON.stringify(parsed);
  } catch {
    return body;
  }
}
