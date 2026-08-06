'use strict';

const path = require('path');
const dotenv = require('dotenv');
const { PublicKey } = require('@solana/web3.js');

const APP_ROOT = path.resolve(__dirname, '..');
dotenv.config({ path: path.join(APP_ROOT, '.env'), override: false });

function textEnv(name, fallback = '') {
  const value = process.env[name];
  return value == null || value.trim() === '' ? fallback : value.trim();
}

function numberEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

function integerEnv(name, fallback) {
  return Math.trunc(numberEnv(name, fallback));
}

function flagEnv(name, fallback = false) {
  const value = process.env[name];
  if (value == null || value.trim() === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

function listEnv(name, fallback = []) {
  const value = textEnv(name);
  return value ? value.split(',').map((item) => item.trim()).filter(Boolean) : [...fallback];
}

function appPath(value) {
  return path.isAbsolute(value) ? value : path.resolve(APP_ROOT, value);
}

function isLoopbackHost(host) {
  return ['127.0.0.1', 'localhost', '::1'].includes(String(host).toLowerCase());
}

const DEFAULT_SMART_WALLET = '7yd579zXmWPoxEE22BUYTzAo8nyMmQtPyEWS3g1BFhH4';

const config = {
  appRoot: APP_ROOT,
  dryRun: flagEnv('DRY_RUN', true),
  smartWallets: listEnv('SMART_WALLETS', [DEFAULT_SMART_WALLET]),
  stream: {
    endpoints: listEnv('HELIUS_LASERSTREAM_ENDPOINTS'),
    token: textEnv('HELIUS_LASERSTREAM_TOKEN'),
    reconnectMinMs: 500,
    reconnectMaxMs: 10_000,
    pingIntervalMs: 30_000,
  },
  rpc: {
    url: textEnv('HELIUS_RPC_URL'),
    stakedUrl: textEnv('HELIUS_STAKED_RPC_URL'),
    senderEndpoints: listEnv('HELIUS_SENDER_ENDPOINTS'),
    senderWarmIntervalMs: integerEnv('SENDER_WARM_INTERVAL_MS', 5_000),
  },
  wallet: {
    privateKeyBs58: textEnv('WALLET_PRIVATE_KEY_BS58'),
  },
  follow: {
    buyMode: textEnv('FOLLOW_BUY_MODE', 'FIXED').toUpperCase(),
    buySol: numberEnv('FOLLOW_BUY_SOL', 0.05),
    buyScale: numberEnv('FOLLOW_BUY_SCALE', 0.1),
    minBuySol: numberEnv('FOLLOW_MIN_BUY_SOL', 0.02),
    maxBuySol: numberEnv('FOLLOW_MAX_BUY_SOL', 0.3),
    minSmartBuySol: numberEnv('FOLLOW_MIN_SMART_BUY_SOL', 0),
    sellMode: textEnv('FOLLOW_SELL_MODE', 'FULL').toUpperCase(),
    maxSignalAgeMs: integerEnv('FOLLOW_MAX_SIGNAL_AGE_MS', 5_000),
    maxOpenPositions: integerEnv('FOLLOW_MAX_OPEN_POSITIONS', 20),
    maxTotalSol: numberEnv('FOLLOW_MAX_TOTAL_SOL', 2),
    allowScaleIn: flagEnv('FOLLOW_ALLOW_SCALE_IN', true),
    maxBuysPerWalletMint: integerEnv('FOLLOW_MAX_BUYS_PER_WALLET_MINT', 5),
  },
  execution: {
    buySlippageBps: integerEnv('BUY_SLIPPAGE_BPS', 3_000),
    sellSlippageBps: integerEnv('SELL_SLIPPAGE_BPS', 3_000),
    computeUnitLimit: integerEnv('COMPUTE_UNIT_LIMIT', 250_000),
    buyPriorityFeeLamports: integerEnv('BUY_PRIORITY_FEE_LAMPORTS', 500_000),
    sellPriorityFeeLamports: integerEnv('SELL_PRIORITY_FEE_LAMPORTS', 200_000),
    jitoTipLamports: integerEnv('JITO_TIP_LAMPORTS', 1_000_000),
    blockhashMaxAgeMs: 25_000,
    confirmationTimeoutMs: integerEnv('TX_CONFIRMATION_TIMEOUT_MS', 20_000),
    confirmationPollMs: integerEnv('TX_CONFIRMATION_POLL_MS', 500),
    curveBuyRetry6002: flagEnv('CURVE_BUY_RETRY_6002', true),
    curveBuyRetryMaxSignalAgeMs: integerEnv('CURVE_BUY_RETRY_MAX_SIGNAL_AGE_MS', 5_000),
  },
  trailingTakeProfit: {
    enabled: flagEnv('TRAILING_TAKE_PROFIT_ENABLED', true),
    activationPercent: numberEnv('TRAILING_TAKE_PROFIT_ACTIVATION_PERCENT', 80),
    drawdownPercent: numberEnv('TRAILING_TAKE_PROFIT_DRAWDOWN_PERCENT', 15),
    pollMs: integerEnv('TRAILING_TAKE_PROFIT_POLL_MS', 1_000),
    retryMs: integerEnv('TRAILING_TAKE_PROFIT_RETRY_MS', 5_000),
  },
  files: {
    state: appPath(textEnv('STATE_FILE', './data/state.json')),
    audit: appPath(textEnv('AUDIT_FILE', './data/trades.jsonl')),
  },
  dashboard: {
    enabled: flagEnv('DASHBOARD_ENABLED', true),
    host: textEnv('DASHBOARD_HOST', '127.0.0.1'),
    port: integerEnv('DASHBOARD_PORT', 8_787),
    token: textEnv('DASHBOARD_TOKEN'),
    recentTrades: integerEnv('DASHBOARD_RECENT_TRADES', 100),
  },
  programs: {
    pump: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
    pumpAmm: 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA',
    token: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
    token2022: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
    wsol: 'So11111111111111111111111111111111111111112',
    usdc: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  },
};

function validateConfig() {
  const errors = [];
  const assertPublicKey = (value, label) => {
    try {
      new PublicKey(value);
    } catch (_) {
      errors.push(`${label} is not a valid Solana public key: ${value}`);
    }
  };

  if (config.smartWallets.length === 0) errors.push('SMART_WALLETS is empty');
  config.smartWallets.forEach((wallet, index) => assertPublicKey(wallet, `SMART_WALLETS[${index}]`));
  if (new Set(config.smartWallets).size !== config.smartWallets.length) {
    errors.push('SMART_WALLETS contains duplicate addresses');
  }
  if (config.stream.endpoints.length === 0) errors.push('HELIUS_LASERSTREAM_ENDPOINTS is empty');
  if (!config.stream.token) errors.push('HELIUS_LASERSTREAM_TOKEN is empty');
  if (!config.rpc.url) errors.push('HELIUS_RPC_URL is empty');
  if (!config.dryRun && !config.wallet.privateKeyBs58) {
    errors.push('WALLET_PRIVATE_KEY_BS58 is required when DRY_RUN=false');
  }
  if (!['FIXED', 'PROPORTIONAL'].includes(config.follow.buyMode)) {
    errors.push('FOLLOW_BUY_MODE must be FIXED or PROPORTIONAL');
  }
  if (!['FULL', 'PROPORTIONAL'].includes(config.follow.sellMode)) {
    errors.push('FOLLOW_SELL_MODE must be FULL or PROPORTIONAL');
  }
  for (const [name, value] of [
    ['FOLLOW_BUY_SOL', config.follow.buySol],
    ['FOLLOW_MIN_BUY_SOL', config.follow.minBuySol],
    ['FOLLOW_MAX_BUY_SOL', config.follow.maxBuySol],
    ['FOLLOW_MAX_TOTAL_SOL', config.follow.maxTotalSol],
  ]) {
    if (!Number.isFinite(value) || value <= 0) errors.push(`${name} must be > 0`);
  }
  if (config.follow.minBuySol > config.follow.maxBuySol) {
    errors.push('FOLLOW_MIN_BUY_SOL must be <= FOLLOW_MAX_BUY_SOL');
  }
  for (const [name, value] of [
    ['BUY_SLIPPAGE_BPS', config.execution.buySlippageBps],
    ['SELL_SLIPPAGE_BPS', config.execution.sellSlippageBps],
  ]) {
    if (!Number.isInteger(value) || value < 0 || value > 10_000) {
      errors.push(`${name} must be an integer between 0 and 10000`);
    }
  }
  if (config.execution.computeUnitLimit < 100_000) {
    errors.push('COMPUTE_UNIT_LIMIT must be at least 100000');
  }
  if (!Number.isInteger(config.execution.confirmationTimeoutMs) || config.execution.confirmationTimeoutMs < 1_000) {
    errors.push('TX_CONFIRMATION_TIMEOUT_MS must be an integer of at least 1000');
  }
  if (!Number.isInteger(config.execution.confirmationPollMs) || config.execution.confirmationPollMs < 100) {
    errors.push('TX_CONFIRMATION_POLL_MS must be an integer of at least 100');
  }
  if (
    !Number.isInteger(config.execution.curveBuyRetryMaxSignalAgeMs) ||
    config.execution.curveBuyRetryMaxSignalAgeMs < 0
  ) {
    errors.push('CURVE_BUY_RETRY_MAX_SIGNAL_AGE_MS must be a non-negative integer');
  }
  if (!Number.isInteger(config.rpc.senderWarmIntervalMs) || config.rpc.senderWarmIntervalMs < 1_000) {
    errors.push('SENDER_WARM_INTERVAL_MS must be an integer of at least 1000');
  }
  if (
    !Number.isFinite(config.trailingTakeProfit.activationPercent) ||
    config.trailingTakeProfit.activationPercent <= 0
  ) {
    errors.push('TRAILING_TAKE_PROFIT_ACTIVATION_PERCENT must be > 0');
  }
  if (
    !Number.isFinite(config.trailingTakeProfit.drawdownPercent) ||
    config.trailingTakeProfit.drawdownPercent <= 0 ||
    config.trailingTakeProfit.drawdownPercent >= 100
  ) {
    errors.push('TRAILING_TAKE_PROFIT_DRAWDOWN_PERCENT must be > 0 and < 100');
  }
  if (!Number.isInteger(config.trailingTakeProfit.pollMs) || config.trailingTakeProfit.pollMs < 250) {
    errors.push('TRAILING_TAKE_PROFIT_POLL_MS must be an integer of at least 250');
  }
  if (!Number.isInteger(config.trailingTakeProfit.retryMs) || config.trailingTakeProfit.retryMs < 1_000) {
    errors.push('TRAILING_TAKE_PROFIT_RETRY_MS must be an integer of at least 1000');
  }
  if (config.dashboard.enabled) {
    if (!Number.isInteger(config.dashboard.port) || config.dashboard.port < 1 || config.dashboard.port > 65_535) {
      errors.push('DASHBOARD_PORT must be an integer between 1 and 65535');
    }
    if (
      !Number.isInteger(config.dashboard.recentTrades) ||
      config.dashboard.recentTrades < 1 ||
      config.dashboard.recentTrades > 500
    ) {
      errors.push('DASHBOARD_RECENT_TRADES must be an integer between 1 and 500');
    }
    if (!isLoopbackHost(config.dashboard.host) && !config.dashboard.token) {
      errors.push('DASHBOARD_TOKEN is required when DASHBOARD_HOST is not loopback');
    }
  }
  return errors;
}

module.exports = { APP_ROOT, DEFAULT_SMART_WALLET, config, validateConfig };
