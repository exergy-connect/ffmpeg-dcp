#!/usr/bin/env node
/**
 * @file  accountBalance.js - check a DCP bank account balance.
 *
 * Usage:
 *   node accountBalance.js [accountSpec]
 *
 * accountSpec (optional) is a private key, a wallet label, a path to a
 * keystore file, or the raw JSON contents of a keystore (single-quote inline
 * JSON on the command line - it contains characters the shell will otherwise
 * mangle; a file path avoids that entirely). If omitted, checks your
 * 'default' wallet (~/.dcp/default.keystore).
 *
 * DCP requires some identity to be set before talking to the bank, but the
 * identity doesn't have to differ from the account being queried - so the
 * same key resolved for the balance check below is reused as the identity.
 *
 * The teller request itself lives in ../dcp-bank-account.js and is the
 * `bank` concept in dcp-transcoding.xp (viewAccount → payload.balance).
 */
'use strict';

const { viewAccountBalance } = require('../dcp-bank-account');

async function resolveAccountKey(accountSpec)
{
  const wallet = require('dcp/wallet');

  if (!accountSpec)
    return await (await wallet.get('default')).getPrivateKey();
  if (wallet.isPrivateKey(accountSpec))
    return new wallet.PrivateKey(accountSpec);

  let keystoreJSON;
  try { keystoreJSON = JSON.parse(accountSpec); } catch (error) {} // eslint-disable-line -- not inline JSON; try as a label or file path next

  if (keystoreJSON)
    return await (await new wallet.BankAccountKeystore(keystoreJSON)).getPrivateKey();

  try { return await (await wallet.get(accountSpec)).getPrivateKey(); }
  catch (error) /* not a wallet label either; try it as a keystore file path */
  {
    keystoreJSON = JSON.parse(require('fs').readFileSync(accountSpec, 'utf-8'));
    return await (await new wallet.BankAccountKeystore(keystoreJSON)).getPrivateKey();
  }
}

async function checkBalance(accountSpec)
{
  const identity = require('dcp/identity');
  const { Connection } = require('dcp/protocol');
  const fromKey = await resolveAccountKey(accountSpec);
  const { address, balance } = await viewAccountBalance({
    Connection,
    dcpConfig,
    fromKey,
    identity,
  });
  console.log(`Balance of ${address} is ${balance}⊇`);
  return balance;
}

module.exports = { checkBalance, resolveAccountKey };

if (require.main === module) {
  require('dcp-client').init()
    .then(() => checkBalance(process.argv[2]))
    .catch((error) => {
      console.error(error.message + (error.code ? ` (${error.code})` : ''));
      process.exitCode = 1;
    });
}
