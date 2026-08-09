'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');

test('documented defaults use configured fees and the staged 20/40/10/60 exit strategy', () => {
  const envExample = fs.readFileSync(path.join(root, '.env.example'), 'utf8');
  const configSource = fs.readFileSync(path.join(root, 'src', 'config.js'), 'utf8');

  assert.match(envExample, /^BUY_PRIORITY_FEE_LAMPORTS=500000$/m);
  assert.match(envExample, /^SELL_PRIORITY_FEE_LAMPORTS=200000$/m);
  assert.match(envExample, /^QUICK_TAKE_PROFIT_PERCENT=20$/m);
  assert.match(envExample, /^QUICK_TAKE_PROFIT_WINDOW_MS=3000$/m);
  assert.match(envExample, /^TRAILING_TAKE_PROFIT_ACTIVATION_PERCENT=40$/m);
  assert.match(envExample, /^TRAILING_TAKE_PROFIT_DRAWDOWN_PERCENT=10$/m);
  assert.match(envExample, /^MAX_HOLD_TIME_MS=60000$/m);
  assert.match(envExample, /^TRAILING_TAKE_PROFIT_POLL_MS=500$/m);
  assert.match(envExample, /^CURVE_BUY_RETRY_6002=true$/m);
  assert.match(envExample, /^CURVE_BUY_RETRY_MAX_SIGNAL_AGE_MS=5000$/m);
  assert.match(envExample, /^SENDER_WARM_INTERVAL_MS=5000$/m);
  assert.match(envExample, /^POSITION_RECONCILE_ENABLED=true$/m);
  assert.match(envExample, /^POSITION_RECONCILE_MISSING_CONFIRMATIONS=2$/m);
  assert.match(envExample, /^POSITION_RECONCILE_CONFIRMATION_DELAY_MS=1000$/m);
  assert.match(configSource, /buyPriorityFeeLamports: integerEnv\('BUY_PRIORITY_FEE_LAMPORTS', 500_000\)/);
  assert.match(configSource, /sellPriorityFeeLamports: integerEnv\('SELL_PRIORITY_FEE_LAMPORTS', 200_000\)/);
  assert.match(configSource, /quickProfitPercent: numberEnv\('QUICK_TAKE_PROFIT_PERCENT', 20\)/);
  assert.match(configSource, /quickProfitWindowMs: integerEnv\('QUICK_TAKE_PROFIT_WINDOW_MS', 3_000\)/);
  assert.match(configSource, /activationPercent: numberEnv\('TRAILING_TAKE_PROFIT_ACTIVATION_PERCENT', 40\)/);
  assert.match(configSource, /drawdownPercent: numberEnv\('TRAILING_TAKE_PROFIT_DRAWDOWN_PERCENT', 10\)/);
  assert.match(configSource, /maxHoldMs: integerEnv\('MAX_HOLD_TIME_MS', 60_000\)/);
  assert.match(configSource, /curveBuyRetry6002: flagEnv\('CURVE_BUY_RETRY_6002', true\)/);
  assert.match(configSource, /enabled: flagEnv\('POSITION_RECONCILE_ENABLED', true\)/);
});
