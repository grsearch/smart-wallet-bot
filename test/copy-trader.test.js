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
    dryRun: false,
    programs: { wsol: 'wsol' },
    files: { audit: path.join(dir, 'audit.jsonl') },
    trailingTakeProfit: {
      enabled: true,
      activationPercent: 80,
      drawdownPercent: 15,
      pollMs: 1000,
      retryMs: 5000,
    },
    positionReconciliation: {
      enabled: true,
      pollMs: 30000,
      missingConfirmations: 2,
      confirmationDelayMs: 1,
    },
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
      actualBuyCostLamports: '100500000',
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
  assert.equal(store.getPosition(base.sourceWallet, base.mint).investedSol, 0.1005);
  const sellTrade = { ...base, signature: 'source-sell', side: 'SELL', sellBps: 2500 };
  assert.equal(await trader.handle(sellTrade), true);
  assert.equal(sellRaw, '1000');
  assert.equal(store.getPosition(base.sourceWallet, base.mint), null);
  assert.equal(await trader.handle({ ...sellTrade, signature: 'source-sell-later' }), false);
  assert.equal(sellCalls, 1);
  const laterSell = store.getDashboardState().processedSignals
    .find((signal) => signal.detectedAt === sellTrade.detectedAt && signal.status === 'skipped');
  assert.equal(laterSell.reason, 'already_closed');

  await new Promise((resolve) => setTimeout(resolve, 20));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('manual dashboard close sells the complete position and waits for confirmation', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'copy-trader-manual-close-test-'));
  const config = configFor(dir);
  let submittedTrade = null;
  const executor = {
    sell: async (trade) => {
      submittedTrade = trade;
      return {
        success: true,
        signature: 'manual-copy-sell',
        channel: 'STAKED_RPC',
        venue: 'PUMP_CURVE',
      };
    },
  };
  const store = new PositionStore(path.join(dir, 'state.json'));
  store.recordBuy(
    {
      signature: 'source-buy',
      sourceWallet: 'source-wallet',
      mint: 'mint-address',
      side: 'BUY',
      venue: 'PUMP_CURVE',
      tokenProgram: 'token-program',
      decimals: 6,
      tokenDeltaRaw: '1234',
      detectedAt: Date.now(),
    },
    {
      signature: 'copy-buy',
      venue: 'PUMP_CURVE',
      tokenProgram: 'token-program',
      tokenAmountRaw: '1234',
      decimals: 6,
    },
    0.05,
  );
  const trader = new CopyTrader({ config, executor, store });

  const result = await trader.closePosition('source-wallet', 'mint-address');

  assert.equal(result.success, true);
  assert.equal(result.status, 'confirmed');
  assert.equal(result.copySignature, 'manual-copy-sell');
  assert.equal(submittedTrade.trigger, 'MANUAL_DASHBOARD');
  assert.equal(submittedTrade.tokenAmountRaw, '1234');
  assert.equal(submittedTrade.sellBps, 10_000);
  assert.equal(store.getPosition('source-wallet', 'mint-address'), null);
  assert.equal(
    store.getClosedPosition('source-wallet', 'mint-address').exitTrigger,
    'MANUAL_DASHBOARD',
  );

  const missing = await trader.closePosition('source-wallet', 'mint-address');
  assert.equal(missing.success, false);
  assert.equal(missing.status, 'not_found');

  await new Promise((resolve) => setTimeout(resolve, 20));
  const rows = fs.readFileSync(config.files.audit, 'utf8')
    .trim()
    .split(/\r?\n/)
    .map((line) => JSON.parse(line));
  assert(rows.some((row) => (
    row.type === 'strategy_trade' && row.trigger === 'MANUAL_DASHBOARD'
  )));
  assert(rows.some((row) => (
    row.type === 'copy_sell' && row.sourceTrade.trigger === 'MANUAL_DASHBOARD'
  )));
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

  assert.equal(await trader.handle({
    ...trade,
    signature: 'source-sell-after-failed-buy',
    side: 'SELL',
  }), false);
  const sellSignal = store.getDashboardState().processedSignals
    .find((item) => item.side === 'SELL');
  assert.equal(sellSignal.reason, 'buy_failed_no_position');

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

test('trailing take profit activates at +80% and fully exits after a 15% drawdown', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'copy-trader-trailing-test-'));
  const config = configFor(dir);
  const quotedLamports = ['1790000000', '1800000000', '2000000000', '1700000000'];
  let quoteIndex = 0;
  let sellTrade = null;
  const executor = {
    quoteSell: async () => ({
      success: true,
      venue: 'PUMP_CURVE',
      expectedSolLamports: quotedLamports[quoteIndex++],
      tokenProgram: 'token-program',
    }),
    sell: async (trade) => {
      sellTrade = trade;
      return {
        success: true,
        signature: 'trailing-copy-sell',
        channel: 'test',
        venue: 'PUMP_CURVE',
        expectedSolLamports: '1700000000',
      };
    },
  };
  const store = new PositionStore(path.join(dir, 'state.json'));
  const buyTrade = {
    signature: 'source-buy',
    sourceWallet: 'source-wallet',
    mint: 'mint-address',
    side: 'BUY',
    venue: 'PUMP_CURVE',
    tokenProgram: 'token-program',
    decimals: 6,
    tokenDeltaRaw: '1000',
    detectedAt: Date.now(),
  };
  store.recordBuy(
    buyTrade,
    {
      signature: 'copy-buy',
      venue: 'PUMP_CURVE',
      tokenProgram: 'token-program',
      tokenAmountRaw: '1000',
      decimals: 6,
    },
    1,
  );
  const trader = new CopyTrader({ config, executor, store });

  await trader._runTrailingChecks();
  assert.equal(store.getPosition('source-wallet', 'mint-address').trailingTakeProfit, null);

  await trader._runTrailingChecks();
  let position = store.getPosition('source-wallet', 'mint-address');
  assert.equal(position.trailingTakeProfit.active, true);
  assert.equal(position.trailingTakeProfit.peakValueSol, 1.8);

  await trader._runTrailingChecks();
  position = store.getPosition('source-wallet', 'mint-address');
  assert.equal(position.trailingTakeProfit.peakValueSol, 2);

  await trader._runTrailingChecks();
  assert.equal(store.getPosition('source-wallet', 'mint-address'), null);
  assert.equal(sellTrade.trigger, 'TRAILING_TAKE_PROFIT');
  assert.equal(sellTrade.tokenAmountRaw, '1000');
  assert.equal(sellTrade.position.tokenProgram, 'token-program');

  await new Promise((resolve) => setTimeout(resolve, 20));
  const types = fs.readFileSync(config.files.audit, 'utf8')
    .trim()
    .split(/\r?\n/)
    .map((line) => JSON.parse(line).type);
  assert(types.includes('trailing_take_profit_activated'));
  assert(types.includes('trailing_take_profit_triggered'));
  assert(types.includes('strategy_trade'));
  assert(types.includes('copy_sell'));

  fs.rmSync(dir, { recursive: true, force: true });
});

test('position reconciliation removes a zombie only after two missing ATA observations', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'copy-trader-zombie-test-'));
  const config = configFor(dir);
  config.positionReconciliation.confirmationDelayMs = 50;
  let inspections = 0;
  const executor = {
    inspectPosition: async () => {
      inspections += 1;
      return {
        success: true,
        status: 'missing',
        ataAddress: 'closed-ata',
        actualTokenAmountRaw: '0',
      };
    },
  };
  const store = new PositionStore(path.join(dir, 'state.json'));
  store.recordBuy(
    {
      signature: 'source-buy',
      sourceWallet: 'source-wallet',
      mint: 'mint-address',
      side: 'BUY',
      venue: 'PUMP_CURVE',
      tokenDeltaRaw: '1000',
      detectedAt: Date.now(),
    },
    { signature: 'copy-buy', tokenAmountRaw: '1000', venue: 'PUMP_CURVE' },
    0.05,
  );
  const trader = new CopyTrader({ config, executor, store });

  await trader._runPositionReconciliation();
  assert(store.getPosition('source-wallet', 'mint-address'));
  await trader._runPositionReconciliation();
  assert(store.getPosition('source-wallet', 'mint-address'));
  await new Promise((resolve) => setTimeout(resolve, 60));
  await trader._runPositionReconciliation();
  assert.equal(store.getPosition('source-wallet', 'mint-address'), null);
  assert.equal(inspections, 3);
  assert.equal(
    store.getClosedPosition('source-wallet', 'mint-address').exitTrigger,
    'ON_CHAIN_EMPTY',
  );

  await new Promise((resolve) => setTimeout(resolve, 20));
  const rows = fs.readFileSync(config.files.audit, 'utf8')
    .trim()
    .split(/\r?\n/)
    .map((line) => JSON.parse(line));
  assert(rows.some((row) => row.type === 'zombie_position_suspected'));
  assert(rows.some((row) => row.type === 'zombie_position_removed'));
  fs.rmSync(dir, { recursive: true, force: true });
});
