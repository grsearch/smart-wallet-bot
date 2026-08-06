'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { CopyTrader } = require('../src/CopyTrader');
const { PositionStore } = require('../src/PositionStore');

function configFor(dir, followOverrides = {}) {
  return {
    programs: { wsol: 'wsol' },
    files: { audit: path.join(dir, 'audit.jsonl') },
    follow: {
      buyMode: 'FIXED',
      buySol: 0.1,
      buyScale: 0.1,
      minBuySol: 0.02,
      maxBuySol: 0.3,
      minSmartBuySol: 0,
      sellMode: 'FULL',
      maxSignalAgeMs: 5000,
      maxOpenPositions: 20,
      maxTotalSol: 2,
      allowScaleIn: true,
      maxBuysPerWalletMint: 5,
      ...followOverrides,
    },
  };
}

test('copy trader clears its copied position on the first source sell in FULL mode', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'copy-trader-test-'));
  const config = {
    programs: { wsol: 'wsol' },
    files: { audit: path.join(dir, 'audit.jsonl') },
    follow: {
      buyMode: 'FIXED',
      buySol: 0.1,
      buyScale: 0.1,
      minBuySol: 0.02,
      maxBuySol: 0.3,
      minSmartBuySol: 0,
      sellMode: 'FULL',
      maxSignalAgeMs: 5000,
      maxOpenPositions: 20,
      maxTotalSol: 2,
      allowScaleIn: true,
      maxBuysPerWalletMint: 5,
    },
  };
  let sellRaw = null;
  let sellCalls = 0;
  const executor = {
    buy: async () => ({
      success: true,
      signature: 'copy-buy',
      channel: 'test',
      venue: 'PUMP_CURVE',
      tokenAmountRaw: '1000',
      decimals: 6,
    }),
    sell: async (trade) => {
      sellCalls += 1;
      sellRaw = trade.tokenAmountRaw;
      return { success: true, signature: 'copy-sell', channel: 'test', venue: 'PUMP_CURVE' };
    },
  };
  const store = new PositionStore(path.join(dir, 'state.json'));
  const trader = new CopyTrader({ config, executor, store });
  const base = {
    sourceWallet: 'source-wallet',
    mint: 'mint-address',
    venue: 'PUMP_CURVE',
    quoteMint: 'wsol',
    tokenDeltaRaw: '1000',
    decimals: 6,
    detectedAt: Date.now(),
  };

  assert.equal(await trader.handle({ ...base, signature: 'source-buy', side: 'BUY' }), true);
  assert.equal(store.getPosition(base.sourceWallet, base.mint).tokenAmountRaw, '1000');
  const sellTrade = { ...base, signature: 'source-sell', side: 'SELL', sellBps: 2500 };
  assert.equal(await trader.handle(sellTrade), true);
  assert.equal(sellRaw, '1000');
  assert.equal(store.getPosition(base.sourceWallet, base.mint), null);
  assert.equal(await trader.handle(sellTrade), false);
  assert.equal(sellCalls, 1);

  await new Promise((resolve) => setTimeout(resolve, 20));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('an on-chain buy failure is audited and never creates a copied position', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'copy-trader-failure-test-'));
  const config = configFor(dir);
  const chainError = { InstructionError: [3, { Custom: 6002 }] };
  const executor = {
    buy: async () => ({
      success: false,
      error: 'transaction copy-buy-failed on-chain failure',
      signature: 'copy-buy-failed',
      channel: 'SENDER:SLC',
      confirmationStatus: 'failed',
      confirmationLatencyMs: 811,
      chainError,
    }),
  };
  const store = new PositionStore(path.join(dir, 'state.json'));
  const trader = new CopyTrader({ config, executor, store });
  const trade = {
    sourceWallet: 'source-wallet',
    mint: 'mint-address',
    venue: 'PUMP_CURVE',
    quoteMint: 'wsol',
    tokenDeltaRaw: '1000',
    decimals: 6,
    detectedAt: Date.now(),
    signature: 'source-buy-failed',
    side: 'BUY',
  };

  assert.equal(await trader.handle(trade), false);
  assert.equal(store.getPosition(trade.sourceWallet, trade.mint), null);
  const signal = store.getDashboardState().processedSignals
    .find((item) => item.sourceWallet === trade.sourceWallet && item.mint === trade.mint);
  assert.equal(signal.status, 'failed');
  assert.equal(signal.copySignature, 'copy-buy-failed');
  assert.equal(signal.confirmationStatus, 'failed');
  assert.deepEqual(signal.chainError, chainError);

  await new Promise((resolve) => setTimeout(resolve, 20));
  const auditRows = fs.readFileSync(config.files.audit, 'utf8')
    .trim()
    .split(/\r?\n/)
    .map((line) => JSON.parse(line));
  const failure = auditRows.find((row) => row.type === 'copy_failed');
  assert.equal(failure.sourceTrade.signature, trade.signature);
  assert.equal(failure.result.signature, 'copy-buy-failed');
  assert.equal(failure.confirmationStatus, 'failed');
  assert.deepEqual(failure.chainError, chainError);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('a timely sell stays valid while queued behind buy confirmation', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'copy-trader-queue-test-'));
  const config = configFor(dir, { maxSignalAgeMs: 5 });
  let releaseBuy;
  const buyConfirmation = new Promise((resolve) => { releaseBuy = resolve; });
  let sellCalls = 0;
  const executor = {
    buy: async () => {
      await buyConfirmation;
      return {
        success: true,
        signature: 'copy-buy',
        channel: 'test',
        venue: 'PUMP_CURVE',
        tokenAmountRaw: '1000',
        decimals: 6,
      };
    },
    sell: async () => {
      sellCalls += 1;
      return { success: true, signature: 'copy-sell', channel: 'test', venue: 'PUMP_CURVE' };
    },
  };
  const store = new PositionStore(path.join(dir, 'state.json'));
  const trader = new CopyTrader({ config, executor, store });
  const detectedAt = Date.now();
  const base = {
    sourceWallet: 'source-wallet',
    mint: 'mint-address',
    venue: 'PUMP_CURVE',
    quoteMint: 'wsol',
    tokenDeltaRaw: '1000',
    decimals: 6,
    detectedAt,
  };
  const buy = trader.handle({ ...base, signature: 'source-buy', side: 'BUY' });
  const sell = trader.handle({ ...base, signature: 'source-sell', side: 'SELL' });
  await new Promise((resolve) => setTimeout(resolve, 15));
  releaseBuy();

  assert.equal(await buy, true);
  assert.equal(await sell, true);
  assert.equal(sellCalls, 1);
  assert.equal(store.getPosition(base.sourceWallet, base.mint), null);

  await new Promise((resolve) => setTimeout(resolve, 20));
  fs.rmSync(dir, { recursive: true, force: true });
});
