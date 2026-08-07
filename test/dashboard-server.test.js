'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  aggregateWalletStatistics,
  beijingDayKey,
  DashboardServer,
  normalizeActivity,
} = require('../src/DashboardServer');
const { PositionStore } = require('../src/PositionStore');

function decodeNumericEntities(value) {
  return value.replace(/&#x([0-9a-f]+);/gi, (_, hex) => (
    String.fromCodePoint(Number.parseInt(hex, 16))
  ));
}

test('dashboard labels automatic zombie cleanup as a cleaned activity', () => {
  const activity = normalizeActivity({
    ts: Date.now(),
    type: 'zombie_position_removed',
    reason: 'ata_missing',
    sourceTrade: {
      signature: 'reconcile-signature',
      sourceWallet: 'source-wallet',
      mint: 'mint-address',
      side: 'SELL',
      venue: 'PUMP_CURVE',
    },
  });
  assert.equal(activity.kind, 'CLEANED');
  assert.equal(activity.reason, 'ata_missing');
});

test('smart wallet statistics use Beijing day boundaries and realized sell win rate', () => {
  const now = Date.UTC(2026, 7, 7, 4, 0, 0);
  const walletA = 'wallet-a';
  const walletB = 'wallet-b';
  const rows = [
    {
      ts: Date.UTC(2026, 7, 6, 15, 30, 0),
      type: 'copy_buy',
      sourceTrade: { sourceWallet: walletA, side: 'BUY' },
    },
    {
      ts: Date.UTC(2026, 7, 6, 15, 45, 0),
      type: 'copy_sell',
      sourceTrade: { sourceWallet: walletA, side: 'SELL' },
      soldCostSol: 0.05,
      result: { actualSolProceedsLamports: '70000000' },
    },
    {
      ts: Date.UTC(2026, 7, 6, 17, 0, 0),
      type: 'copy_buy',
      sourceTrade: { sourceWallet: walletA, side: 'BUY' },
    },
    {
      ts: Date.UTC(2026, 7, 6, 18, 0, 0),
      type: 'copy_sell',
      sourceTrade: { sourceWallet: walletA, side: 'SELL' },
      soldCostSol: 0.05,
      result: { actualSolProceedsLamports: '40000000' },
    },
    {
      ts: Date.UTC(2026, 7, 7, 1, 0, 0),
      type: 'copy_buy',
      sourceTrade: { sourceWallet: walletB, side: 'BUY' },
    },
  ];

  const statistics = aggregateWalletStatistics(rows, [walletA, walletB, 'wallet-c'], now);
  assert.equal(beijingDayKey(now), '2026-08-07');
  assert.equal(statistics.timeZone, 'Asia/Shanghai');
  assert.equal(statistics.periodStartAt, Date.UTC(2026, 7, 6, 16, 0, 0));
  const first = statistics.wallets[0];
  assert.equal(first.totalTransactions, 4);
  assert.equal(first.totalBuys, 2);
  assert.equal(first.totalSells, 2);
  assert(Math.abs(first.totalRealizedPnlSol - 0.01) < 1e-12);
  assert.equal(first.totalWinRate, 50);
  assert.equal(first.todayTransactions, 2);
  assert.equal(first.todayBuys, 1);
  assert.equal(first.todaySells, 1);
  assert(Math.abs(first.todayRealizedPnlSol + 0.01) < 1e-12);
  assert.equal(first.todayWinRate, 0);
  assert.equal(statistics.wallets[1].todayTransactions, 1);
  assert.equal(statistics.wallets[1].todayWinRate, null);
  assert.equal(statistics.wallets[2].totalTransactions, 0);
});

test('dashboard serves authenticated runtime, positions, activity and static UI', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dashboard-test-'));
  const stateFile = path.join(dir, 'state.json');
  const auditFile = path.join(dir, 'trades.jsonl');
  const store = new PositionStore(stateFile);
  const trade = {
    signature: 'source-buy',
    sourceWallet: 'source-wallet',
    mint: 'mint-address',
    side: 'BUY',
    venue: 'PUMP_CURVE',
    decimals: 6,
    tokenDeltaRaw: '1000',
    slot: 123,
    detectedAt: Date.now(),
  };
  store.markSignal(trade);
  store.recordBuy(trade, { tokenAmountRaw: '1000', signature: 'copy-buy' }, 0.05);
  store.updateSignal(trade.signature, 'confirmed', { copySignature: 'copy-buy' });
  fs.writeFileSync(auditFile, `${JSON.stringify({
    ts: Date.now(),
    type: 'copy_buy',
    sourceTrade: trade,
    result: {
      signature: 'copy-buy',
      channel: 'test',
      latencyMs: 12,
      detectedToSubmittedMs: 48,
      sourceSlot: 123,
      confirmedSlot: 124,
      slotLag: 1,
    },
    buySol: 0.05,
  })}\n`);

  const config = {
    dryRun: false,
    smartWallets: ['source-wallet'],
    stream: { endpoints: ['https://laserstream-mainnet-lax.helius-rpc.com'] },
    rpc: { senderEndpoints: ['http://slc-sender.helius-rpc.com/fast'] },
    follow: { buyMode: 'FIXED', buySol: 0.05, sellMode: 'FULL', maxTotalSol: 2 },
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
    },
    files: { audit: auditFile },
    dashboard: { enabled: true, host: '127.0.0.1', port: 0, token: 'test-secret', recentTrades: 25 },
  };
  const closeCalls = [];
  const trader = {
    closePosition: async (sourceWallet, mint) => {
      closeCalls.push({ sourceWallet, mint });
      return {
        success: true,
        status: 'confirmed',
        copySignature: 'manual-close-signature',
      };
    },
  };
  const dashboard = new DashboardServer({ config, store, trader });
  dashboard.updateStreamStatus({ status: 'connected', label: 'laserstream-mainnet-lax-1' });
  dashboard.recordStreamMessage({ region: 'laserstream-mainnet-lax-1', receivedAt: Date.now() });
  dashboard.recordTrade(trade);
  dashboard.recordSenderHealth({
    channel: 'SENDER:SLC-SENDER',
    status: 'connected',
    latencyMs: 8,
  });
  dashboard.recordSubmissionChannel({
    channel: 'STAKED_RPC',
    status: 'success',
    latencyMs: 12,
  });
  await dashboard.start();
  t.after(async () => {
    await dashboard.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const port = dashboard.address().port;
  const unauthorized = await fetch(`http://127.0.0.1:${port}/api/dashboard`);
  assert.equal(unauthorized.status, 401);
  const headers = {
    Authorization: `Basic ${Buffer.from('dashboard:test-secret').toString('base64')}`,
  };
  const page = await fetch(`http://127.0.0.1:${port}/`, { headers });
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type'), /charset=utf-8/i);
  assert.match(page.headers.get('cache-control'), /no-store/i);
  const setCookie = page.headers.get('set-cookie');
  assert.match(setCookie, /dashboard_session=/);
  assert.match(setCookie, /HttpOnly/i);
  assert.match(setCookie, /SameSite=Strict/i);
  assert.equal(setCookie.includes('test-secret'), false);
  const sessionHeaders = { Cookie: setCookie.split(';')[0] };

  const response = await fetch(`http://127.0.0.1:${port}/api/dashboard`, {
    headers: sessionHeaders,
  });
  assert.equal(response.status, 200);
  const snapshot = await response.json();
  assert.equal(snapshot.runtime.mode, 'LIVE');
  assert.equal(snapshot.stats.openPositions, 1);
  assert.equal(snapshot.positions[0].mint, 'mint-address');
  assert.equal(snapshot.streams[0].status, 'connected');
  assert.equal(snapshot.activity[0].kind, 'BUY');
  assert.equal(snapshot.activity[0].detectedToSubmittedMs, 48);
  assert.equal(snapshot.activity[0].sourceSlot, 123);
  assert.equal(snapshot.activity[0].confirmedSlot, 124);
  assert.equal(snapshot.activity[0].slotLag, 1);
  assert.equal(snapshot.stats.submittedSignals, 1);
  assert.equal(snapshot.configuration.trailingTakeProfit.activationPercent, 80);
  assert.equal(snapshot.smartWalletStats.timeZone, 'Asia/Shanghai');
  assert.equal(snapshot.smartWalletStats.wallets[0].totalTransactions, 1);
  assert.equal(snapshot.smartWalletStats.wallets[0].todayTransactions, 1);
  assert.equal(snapshot.smartWalletStats.wallets[0].totalWinRate, null);
  assert.equal(snapshot.stats.estimatedRealizedPnlTodaySol, 0);
  assert(snapshot.submissionChannels.some((channel) => (
    channel.channel === 'STAKED_RPC' && channel.successes === 1
  )));
  assert(snapshot.submissionChannels.some((channel) => (
    channel.channel === 'SENDER:SLC-SENDER' && channel.healthStatus === 'connected'
  )));
  assert.equal(JSON.stringify(snapshot).includes('test-secret'), false);

  fs.appendFileSync(auditFile, `${JSON.stringify({
    ts: Date.now(),
    type: 'copy_sell',
    sourceTrade: { ...trade, signature: 'source-sell', side: 'SELL' },
    soldCostSol: 0.05,
    result: { signature: 'copy-sell', actualSolProceedsLamports: '60000000' },
  })}\n`);
  const updatedResponse = await fetch(`http://127.0.0.1:${port}/api/dashboard`, {
    headers: sessionHeaders,
  });
  const updatedSnapshot = await updatedResponse.json();
  const updatedWallet = updatedSnapshot.smartWalletStats.wallets[0];
  assert.equal(updatedWallet.totalTransactions, 2);
  assert.equal(updatedWallet.todayTransactions, 2);
  assert(Math.abs(updatedWallet.totalRealizedPnlSol - 0.01) < 1e-12);
  assert.equal(updatedWallet.totalWinRate, 100);
  assert(Math.abs(updatedSnapshot.stats.estimatedRealizedPnlTodaySol - 0.01) < 1e-12);

  const pageText = await page.text();
  assert.match(pageText, /Smart Wallet Command Center/);
  assert.equal(/[^\x00-\x7f]/.test(pageText), false);
  assert.match(decodeNumericEntities(pageText), /当前持仓/);
  assert.match(decodeNumericEntities(pageText), /聪明钱包统计/);
  const app = await fetch(`http://127.0.0.1:${port}/app.js`, { headers: sessionHeaders });
  assert.equal(app.status, 200);
  assert.match(app.headers.get('cache-control'), /no-store/i);
  const appText = await app.text();
  assert.equal(/[^\x00-\x7f]/.test(appText), false);
  assert.equal(appText.includes(String.raw`\\u`), false);
  assert.match(appText, /https:\/\/gmgn\.ai\/sol\/token\//);
  assert.match(appText, /https:\/\/gmgn\.ai\/sol\/address\//);
  assert.match(appText, /REFRESH_INTERVAL_MS = 1000/);
  assert.match(appText, /setTimeout/);
  assert.match(appText, /\/api\/positions\/close/);
  assert.match(appText, /credentials: 'same-origin'/);
  assert.match(appText, /\\u624b\\u52a8\\u5e73\\u4ed3/);
  assert.match(appText, /walletStatsBody/);
  assert.match(appText, /formatWinRate/);
  assert.match(appText, /totalRealizedPnl/);
  assert.match(appText, /todayRealizedPnl/);
  assert.match(appText, /executionSpeedLabel/);
  assert.match(appText, /SLOT/);

  const crossOriginClose = await fetch(`http://127.0.0.1:${port}/api/positions/close`, {
    method: 'POST',
    headers: {
      ...sessionHeaders,
      Origin: 'https://attacker.example',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ sourceWallet: 'source-wallet', mint: 'mint-address' }),
  });
  assert.equal(crossOriginClose.status, 403);

  const unauthenticatedClose = await fetch(`http://127.0.0.1:${port}/api/positions/close`, {
    method: 'POST',
    headers: {
      Origin: `http://127.0.0.1:${port}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ sourceWallet: 'source-wallet', mint: 'mint-address' }),
  });
  assert.equal(unauthenticatedClose.status, 401);

  const manualClose = await fetch(`http://127.0.0.1:${port}/api/positions/close`, {
    method: 'POST',
    headers: {
      ...sessionHeaders,
      Origin: `http://127.0.0.1:${port}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ sourceWallet: 'source-wallet', mint: 'mint-address' }),
  });
  assert.equal(manualClose.status, 200);
  assert.deepEqual(await manualClose.json(), {
    success: true,
    status: 'confirmed',
    copySignature: 'manual-close-signature',
  });
  assert.deepEqual(closeCalls, [{ sourceWallet: 'source-wallet', mint: 'mint-address' }]);
});
