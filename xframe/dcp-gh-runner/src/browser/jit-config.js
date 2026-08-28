import { decodeBase64Json } from './http.js';
import { pickField } from '../util.js';

function decodeBigInt(fieldName, value) {
  if (!value) throw new Error(`RSA params missing ${fieldName}`);
  const bytes = Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
  let result = 0n;
  for (const byte of bytes) result = (result << 8n) + BigInt(byte);
  return result;
}

function bigIntToBase64Url(value) {
  let hex = value.toString(16);
  if (hex.length % 2 === 1) hex = `0${hex}`;
  const bytes = Uint8Array.from(hex.match(/.{2}/g).map((h) => parseInt(h, 16)));
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function modInverse(value, modulus) {
  let oldValue = value;
  let oldModulus = modulus;
  let oldCoefficient = 1n;
  let coefficient = 0n;
  while (oldModulus !== 0n) {
    const quotient = oldValue / oldModulus;
    [oldValue, oldModulus] = [oldModulus, oldValue - quotient * oldModulus];
    [oldCoefficient, coefficient] = [coefficient, oldCoefficient - quotient * coefficient];
  }
  if (oldValue > 1n) throw new Error('RSA params are not invertible');
  if (oldCoefficient < 0n) oldCoefficient += modulus;
  return oldCoefficient;
}

function getRsaParam(params, name) {
  if (params[name] != null && params[name] !== '') return String(params[name]);
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(params)) {
    if (key.toLowerCase() === target && value != null && value !== '') return String(value);
  }
  return '';
}

function buildJwk(rsaParams) {
  const modulus = decodeBigInt('Modulus', getRsaParam(rsaParams, 'Modulus'));
  const exponent = decodeBigInt('Exponent', getRsaParam(rsaParams, 'Exponent'));
  const privateExponent = decodeBigInt('D', getRsaParam(rsaParams, 'D'));
  const primeP = decodeBigInt('P', getRsaParam(rsaParams, 'P'));
  const primeQ = decodeBigInt('Q', getRsaParam(rsaParams, 'Q'));
  const dpValue = getRsaParam(rsaParams, 'DP');
  const dqValue = getRsaParam(rsaParams, 'DQ');
  const inverseQValue = getRsaParam(rsaParams, 'InverseQ');
  const dp = dpValue ? decodeBigInt('DP', dpValue) : privateExponent % (primeP - 1n);
  const dq = dqValue ? decodeBigInt('DQ', dqValue) : privateExponent % (primeQ - 1n);
  const qi = inverseQValue
    ? decodeBigInt('InverseQ', inverseQValue)
    : modInverse(primeQ, primeP);

  return {
    kty: 'RSA',
    n: bigIntToBase64Url(modulus),
    e: bigIntToBase64Url(exponent),
    d: bigIntToBase64Url(privateExponent),
    p: bigIntToBase64Url(primeP),
    q: bigIntToBase64Url(primeQ),
    dp: bigIntToBase64Url(dp),
    dq: bigIntToBase64Url(dq),
    qi: bigIntToBase64Url(qi),
    alg: 'RS256',
    ext: true,
  };
}

async function importRsaKeys(jwk) {
  const signKey = await crypto.subtle.importKey(
    'jwk',
    jwk,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const decryptKey = await crypto.subtle.importKey(
    'jwk',
    jwk,
    { name: 'RSA-OAEP', hash: 'SHA-1' },
    false,
    ['decrypt'],
  );
  return { signKey, decryptKey };
}

export function decodeJitConfig(encodedJitConfig) {
  const outer = decodeBase64Json(encodedJitConfig);
  for (const key of ['.runner', '.credentials', '.credentials_rsaparams']) {
    if (typeof outer[key] !== 'string') throw new Error(`JIT config missing ${key}`);
  }
  return {
    runner: decodeBase64Json(outer['.runner']),
    credentials: decodeBase64Json(outer['.credentials']),
    rsaParams: decodeBase64Json(outer['.credentials_rsaparams']),
  };
}

export async function parseRunnerIdentity(files) {
  const runner = files.runner;
  const credentials = files.credentials;
  const data = credentials.data ?? credentials.Data ?? credentials;

  const clientId = String(
    pickField(data, ['clientId', 'ClientId'])
      || pickField(credentials, ['clientId', 'ClientId']),
  );
  const authorizationUrl = String(
    pickField(data, ['authorizationUrl', 'AuthorizationUrl'])
      || pickField(credentials, ['authorizationUrl', 'AuthorizationUrl']),
  );
  if (!clientId || !authorizationUrl) {
    throw new Error('Runner credentials missing clientId or authorizationUrl');
  }

  const brokerUrl = String(
    pickField(runner, ['serverUrlV2', 'ServerUrlV2', 'serverUrl', 'ServerUrl']),
  );
  if (!brokerUrl) throw new Error('Runner config missing serverUrl/serverUrlV2');

  const agentId = Number(pickField(runner, ['agentId', 'AgentId']) || 0);
  const agentName = String(pickField(runner, ['agentName', 'AgentName']));
  if (!agentId || !agentName) throw new Error('Runner config missing agentId or agentName');

  const jwk = buildJwk(files.rsaParams);

  return {
    agentId,
    agentName,
    brokerUrl: brokerUrl.replace(/\/$/, ''),
    poolId: Number(runner.poolId ?? 1),
    clientId,
    authorizationUrl,
    privateKey: await importRsaKeys(jwk),
  };
}
