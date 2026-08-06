'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');

test('documented defaults use 0.0005/0.0002 SOL priority fees and 80/15 trailing take profit', () => {
  const envExample = fs.readFileSync(path.join(root, '.env.example'), 'utf8');
  const configSource = fs.readFileSync(path.join(root, 'src', 'config.js'), 'utf8');

  assert.match(envExample, /^BUY_PRIORITY_FEE_LAMPORTS=500000$/m);
  assert.match(envExample, /^SELL_PRIORITY_FEE_LAMPORTS=200000$/m);
  assert.match(envExample, /^TRAILING_TAKE_PROFIT_ACTIVATION_PERCENT=80$/m);
  assert.match(envExample, /^TRAILING_TAKE_PROFIT_DRAWDOWN_PERCENT=15$/m);
  assert.match(envExample, /^CURVE_BUY_RETRY_6002=true$/m);
  assert.match(envExample, /^CURVE_BUY_RETRY_MAX_SIGNAL_AGE_MS=5000$/m);
  assert.match(envExample, /^SENDER_WARM_INTERVAL_MS=5000$/m);
  assert.match(envExample, /^POSITION_RECONCILE_ENABLED=true$/m);
  assert.match(envExample, /^POSITION_RECONCILE_MISSING_CONFIRMATIONS=2$/m);
  assert.match(envExample, /^POSITION_RECONCILE_CONFIRMATION_DELAY_MS=1000$/m);
  assert.match(configSource, /buyPriorityFeeLamports: integerEnv\('BUY_PRIORITY_FEE_LAMPORTS', 500_000\)/);
  assert.match(configSource, /sellPriorityFeeLamports: integerEnv\('SELL_PRIORITY_FEE_LAMPORTS', 200_000\)/);
  assert.match(configSource, /activationPercent: numberEnv\('TRAILING_TAKE_PROFIT_ACTIVATION_PERCENT', 80\)/);
  assert.match(configSource, /drawdownPercent: numberEnv\('TRAILING_TAKE_PROFIT_DRAWDOWN_PERCENT', 15\)/);
  assert.match(configSource, /curveBuyRetry6002: flagEnv\('CURVE_BUY_RETRY_6002', true\)/);
  assert.match(configSource, /enabled: flagEnv\('POSITION_RECONCILE_ENABLED', true\)/);
});
