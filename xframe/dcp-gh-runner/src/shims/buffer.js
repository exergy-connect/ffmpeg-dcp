/** Minimal Buffer shim for bundling github protocol code in the browser. */
function base64ToBytes(b64) {
  const normalized = String(b64).replace(/-/g, '+').replace(/_/g, '/');
  const pad = normalized.length % 4 === 0 ? '' : '='.repeat(4 - (normalized.length % 4));
  const bin = atob(normalized + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

export class Buffer extends Uint8Array {
  static from(value, encoding) {
    if (value instanceof Uint8Array) return new Buffer(value);
    if (typeof value === 'string') {
      if (encoding === 'base64') return new Buffer(base64ToBytes(value));
      if (encoding === 'hex') {
        const out = new Uint8Array(value.length / 2);
        for (let i = 0; i < out.length; i += 1) {
          out[i] = parseInt(value.slice(i * 2, i * 2 + 2), 16);
        }
        return new Buffer(out);
      }
      return new Buffer(new TextEncoder().encode(value));
    }
    if (Array.isArray(value)) return new Buffer(Uint8Array.from(value));
    throw new Error('Buffer.from unsupported input');
  }

  static isBuffer(value) {
    return value instanceof Buffer || value instanceof Uint8Array;
  }

  equals(other) {
    if (!other || this.length !== other.length) return false;
    for (let i = 0; i < this.length; i += 1) {
      if (this[i] !== other[i]) return false;
    }
    return true;
  }

  static byteLength(value, encoding) {
    return Buffer.from(value, encoding).length;
  }

  static concat(list) {
    const total = list.reduce((sum, item) => sum + item.length, 0);
    const out = new Buffer(total);
    let offset = 0;
    for (const item of list) {
      out.set(item, offset);
      offset += item.length;
    }
    return out;
  }

  toString(encoding) {
    if (encoding === 'base64') return bytesToBase64(this);
    if (encoding === 'base64url') {
      return bytesToBase64(this).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    }
    if (encoding === 'hex') {
      return [...this].map((b) => b.toString(16).padStart(2, '0')).join('');
    }
    return new TextDecoder().decode(this);
  }
}

export default Buffer;
