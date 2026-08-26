'use strict';

/**
 * DCP bank teller viewAccount — shared by test/accountBalance.js (Node) and
 * dcp-transcoding.js (browser). Protocol is the `bank` concept in
 * dcp-transcoding.xp.
 */

function defaultBankQuery() {
  return {
    service: 'bankTeller',
    operation: 'viewAccount',
    address_field: 'address',
    authorize_with: 'account_key',
    balance_field: 'payload.balance',
  };
}

function accountAddress(key) {
  return key?.address ?? key?.account;
}

function parseCreditBalance(raw) {
  if (raw == null) return NaN;
  if (typeof raw === 'number') return raw;
  if (typeof raw === 'string') return Number(raw);
  if (typeof raw.toNumber === 'function') return raw.toNumber();
  return Number(String(raw));
}

function readViewAccountBalance(res) {
  if (!res?.success) {
    const detail = res?.payload?.message || res?.payload?.code
      || JSON.stringify(res?.payload || res);
    throw new Error(detail || 'Bank balance request failed');
  }
  const payload = res.payload;
  const raw = payload?.balance
    ?? payload?.accounts?.[0]?.balance
    ?? (Array.isArray(payload) ? payload[0]?.balance : undefined);
  return parseCreditBalance(raw);
}

async function applyIdentity(identity, fromKey) {
  if (!identity?.set) return;
  try {
    await identity.set(fromKey);
  } catch (error) {
    const msg = error?.message || String(error);
    if (error?.code !== 'EHAVEIDENTITY' && !/already been set|EHAVEIDENTITY/i.test(msg)) {
      throw error;
    }
  }
}

/**
 * Query the bank teller for one account's credit balance.
 *
 * @param {object} deps
 * @param {typeof Object} deps.Connection  dcp/protocol Connection
 * @param {object} deps.dcpConfig
 * @param {object} deps.fromKey  PrivateKey or Keystore for the account
 * @param {object} [deps.identity]  if set, identity.set(fromKey) first
 * @param {object} [deps.bank]  bank concept from dcp-transcoding.xp
 * @returns {Promise<{ address: *, balance: number }>}
 */
async function viewAccountBalance(deps) {
  const bank = { ...defaultBankQuery(), ...(deps.bank || {}) };
  const { Connection, dcpConfig, fromKey } = deps;
  await applyIdentity(deps.identity, fromKey);

  const address = accountAddress(fromKey);
  const service = dcpConfig.bank.services[bank.service || 'bankTeller'];
  const bankTeller = new Connection(service);
  try {
    const operation = bank.operation || 'viewAccount';
    const body = operation === 'viewAccounts'
      ? { addresses: [address] }
      : { [bank.address_field || 'address']: address };
    const req = new bankTeller.Request(operation, body);
    await req.authorize(fromKey);
    const res = await req.send();
    return { address, balance: readViewAccountBalance(res) };
  } finally {
    bankTeller.close();
  }
}

const api = {
  defaultBankQuery,
  accountAddress,
  parseCreditBalance,
  readViewAccountBalance,
  viewAccountBalance,
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = api;
}
if (typeof window !== 'undefined') {
  window.dcpBankAccount = api;
}
