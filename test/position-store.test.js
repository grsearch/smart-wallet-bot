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
