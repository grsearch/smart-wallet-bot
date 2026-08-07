'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PositionStore } = require('../src/PositionStore');

test('persists signature dedup and proportional position accounting', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'copy-bot-test-'));
  const file = path.join(dir, 'state.json');
  const store = new PositionStore(file);
  const trade = {
    signature: 'source-1',
    sourceWallet: 'wallet',
    mint: 'mint',
    side: 'BUY',
    venue: 'PUMP_CURVE',
    decimals: 6,
    tokenDeltaRaw: '1000',
    detectedAt: Date.now(),
  };

  store.markSignal(trade);
  store.recordBuy(trade, { tokenAmountRaw: '1000', signature: 'copy-buy' }, 0.1);
  assert.equal(store.getPosition('wallet', 'mint').tokenAmountRaw, '1000');
  store.recordSell(
    { ...trade, side: 'SELL' },
    '250',
    { signature: 'copy-sell', expectedSolLamports: '30000000' },
  );
  assert.equal(store.getPosition('wallet', 'mint').tokenAmountRaw, '750');
  assert(Math.abs(store.getPosition('wallet', 'mint').investedSol - 0.075) < 1e-12);
  const dashboardState = store.getDashboardState();
  assert.equal(dashboardState.stats.copyBuys, 1);
  assert.equal(dashboardState.stats.copySells, 1);
  assert(Math.abs(dashboardState.stats.realizedCostSol - 0.025) < 1e-12);
  assert(Math.abs(dashboardState.stats.estimatedRealizedProceedsSol - 0.03) < 1e-12);

  const reloaded = new PositionStore(file);
  assert.equal(reloaded.hasProcessed('source-1'), true);
  assert.equal(reloaded.getPosition('wallet', 'mint').tokenAmountRaw, '750');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('can mark a signature in memory without blocking the trade path on disk', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'copy-bot-fast-mark-test-'));
  const store = new PositionStore(path.join(dir, 'state.json'));
  let saves = 0;
  store._save = () => { saves += 1; };
  const trade = {
    signature: 'fast-source-buy',
    sourceWallet: 'wallet',
    mint: 'mint',
    side: 'BUY',
    detectedAt: Date.now(),
  };

  store.markSignal(trade, 'accepted', {}, false);
  assert.equal(store.hasProcessed(trade.signature), true);
  assert.equal(saves, 0);
  store.updateSignal(trade.signature, 'failed', { error: 'test' });
  assert.equal(saves, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('full exit keeps a closed-position tombstone and a new buy clears it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'copy-bot-closed-test-'));
  const file = path.join(dir, 'state.json');
  const store = new PositionStore(file);
  const buy = {
    signature: 'source-buy',
    sourceWallet: 'wallet',
    mint: 'mint',
    side: 'BUY',
    venue: 'PUMP_CURVE',
    tokenDeltaRaw: '1000',
    detectedAt: Date.now(),
  };
  store.markSignal(buy, 'confirmed');
  store.recordBuy(buy, { tokenAmountRaw: '1000', signature: 'copy-buy' }, 0.1);
  store.recordSell(
    { ...buy, side: 'SELL', signature: 'source-sell', trigger: 'SMART_WALLET' },
    '1000',
    { signature: 'copy-sell', actualSolProceedsLamports: '120000000' },
  );

  assert.equal(store.getPosition('wallet', 'mint'), null);
  assert.equal(store.getClosedPosition('wallet', 'mint').copySignature, 'copy-sell');
  assert.equal(store.getClosedPosition('wallet', 'mint').exitTrigger, 'SMART_WALLET');
  assert.equal(store.getDashboardState().stats.estimatedRealizedProceedsSol, 0.12);
  assert.equal(store.getLatestSignal('wallet', 'mint', 'BUY').status, 'confirmed');

  store.recordBuy(
    { ...buy, signature: 'source-buy-2' },
    { tokenAmountRaw: '500', signature: 'copy-buy-2' },
    0.05,
  );
  assert.equal(store.getClosedPosition('wallet', 'mint'), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('zombie reconciliation removes the position and preserves an on-chain-empty tombstone', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'copy-bot-zombie-test-'));
  const store = new PositionStore(path.join(dir, 'state.json'));
  const trade = {
    signature: 'source-buy',
    sourceWallet: 'wallet',
    mint: 'mint',
    side: 'BUY',
    venue: 'PUMP_CURVE',
    tokenDeltaRaw: '1000',
    detectedAt: Date.now(),
  };
  store.recordBuy(trade, { tokenAmountRaw: '1000', signature: 'copy-buy' }, 0.05);
  const removed = store.removeZombiePosition('wallet', 'mint', {
    reason: 'ata_missing',
    ataAddress: 'ata-address',
  });

  assert.equal(removed.tokenAmountRaw, '1000');
  assert.equal(store.getPosition('wallet', 'mint'), null);
  assert.equal(store.getClosedPosition('wallet', 'mint').exitTrigger, 'ON_CHAIN_EMPTY');
  assert.equal(store.getClosedPosition('wallet', 'mint').reconciledReason, 'ata_missing');
  assert.equal(store.getDashboardState().stats.reconciledPositions, 1);
  assert.equal(store.getDashboardState().stats.reconciledCostSol, 0.05);
  fs.rmSync(dir, { recursive: true, force: true });
});
