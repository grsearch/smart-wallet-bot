'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DashboardServer } = require('../src/DashboardServer');
const { PositionStore } = require('../src/PositionStore');

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
    detectedAt: Date.now(),
  };
  store.markSignal(trade);
  store.recordBuy(trade, { tokenAmountRaw: '1000', signature: 'copy-buy' }, 0.05);
  store.updateSignal(trade.signature, 'submitted', { copySignature: 'copy-buy' });
  fs.writeFileSync(auditFile, `${JSON.stringify({
    ts: Date.now(),
    type: 'copy_buy',
    sourceTrade: trade,
    result: { signature: 'copy-buy', channel: 'test', latencyMs: 12 },
    buySol: 0.05,
  })}\n`);

  const config = {
    dryRun: false,
    smartWallets: ['source-wallet'],
    stream: { endpoints: ['https://laserstream-mainnet-lax.helius-rpc.com'] },
    follow: { buyMode: 'FIXED', buySol: 0.05, sellMode: 'FULL', maxTotalSol: 2 },
    files: { audit: auditFile },
    dashboard: { enabled: true, host: '127.0.0.1', port: 0, token: 'test-secret', recentTrades: 25 },
  };
  const dashboard = new DashboardServer({ config, store });
  dashboard.updateStreamStatus({ status: 'connected', label: 'laserstream-mainnet-lax-1' });
  dashboard.recordStreamMessage({ region: 'laserstream-mainnet-lax-1', receivedAt: Date.now() });
  dashboard.recordTrade(trade);
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
  const response = await fetch(`http://127.0.0.1:${port}/api/dashboard`, { headers });
  assert.equal(response.status, 200);
  const snapshot = await response.json();
  assert.equal(snapshot.runtime.mode, 'LIVE');
  assert.equal(snapshot.stats.openPositions, 1);
  assert.equal(snapshot.positions[0].mint, 'mint-address');
  assert.equal(snapshot.streams[0].status, 'connected');
  assert.equal(snapshot.activity[0].kind, 'BUY');
  assert.equal(JSON.stringify(snapshot).includes('test-secret'), false);

  const page = await fetch(`http://127.0.0.1:${port}/`, { headers });
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Smart Wallet Command Center/);
});
