import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, randomBytes } from 'node:crypto';
import { webcrypto } from 'node:crypto';

import {
  countGithubLogLines,
  formatGithubLogLines,
} from '../src/browser/log-format.js';
import {
  decryptMessageBody,
  signJwt,
} from '../src/browser/crypto.js';
import { Buffer } from '../src/shims/buffer.js';

describe('browser log formatting', () => {
  it('formats GitHub log lines with timestamps', () => {
    const out = formatGithubLogLines('hello\nworld\n');
    assert.match(out, /hello/);
    assert.match(out, /world/);
    assert.equal(countGithubLogLines('a\nb\n'), 2);
    assert.equal(countGithubLogLines(''), 0);
  });
});

describe('browser crypto', () => {
  it('decrypts AES-CBC message bodies encrypted with Node crypto', async () => {
    const sessionKey = randomBytes(32);
    const iv = randomBytes(16);
    const plaintext = '{"message":"broker ping"}';
    const cipher = createCipheriv('aes-256-cbc', sessionKey, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const body = Buffer.concat([iv, encrypted]).toString('base64');

    const decoded = await decryptMessageBody(body, sessionKey);
    assert.equal(decoded, plaintext);
  });

  it('signs JWT segments with Web Crypto RSA keys', async () => {
    const subtle = webcrypto.subtle;
    const keyPair = await subtle.generateKey(
      {
        name: 'RSASSA-PKCS1-v1_5',
        modulusLength: 2048,
        publicExponent: new Uint8Array([0x01, 0x00, 0x01]),
        hash: 'SHA-256',
      },
      true,
      ['sign', 'verify'],
    );

    const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ sub: 'runner' })).toString('base64url');
    const jwt = await signJwt(header, payload, keyPair.privateKey);
    assert.match(jwt, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);

    const [, , signatureB64] = jwt.split('.');
    const signature = Buffer.from(signatureB64.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    const data = new TextEncoder().encode(`${header}.${payload}`);
    const valid = await subtle.verify(
      { name: 'RSASSA-PKCS1-v1_5' },
      keyPair.publicKey,
      signature,
      data,
    );
    assert.equal(valid, true);
  });
});
