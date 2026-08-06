'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { CopyTrader } = require('../src/CopyTrader');
const { PositionStore } = require('../src/PositionStore');

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
