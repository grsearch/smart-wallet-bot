'use strict';

const { config, validateConfig } = require('./config');
const { SmartWalletParser } = require('./SmartWalletParser');
const { SmartWalletStream } = require('./SmartWalletStream');
const { PositionStore } = require('./PositionStore');
const { TradeExecutor } = require('./TradeExecutor');
const { CopyTrader } = require('./CopyTrader');

async function main() {
  const errors = validateConfig();
  if (errors.length > 0) {
    console.error('Configuration errors:');
    for (const error of errors) console.error(`  - ${error}`);
    process.exitCode = 1;
    return;
  }

  const store = new PositionStore(config.files.state);
  const executor = new TradeExecutor(config);
  const parser = new SmartWalletParser({
    trackedWallets: config.smartWallets,
    programs: config.programs,
  });
  const trader = new CopyTrader({ config, executor, store });
  const stream = new SmartWalletStream({
    endpoints: config.stream.endpoints,
    token: config.stream.token,
    wallets: config.smartWallets,
    settings: config.stream,
  });

  console.log('============================================================');
  console.log('Pump Smart Wallet Copy Bot');
  console.log(`Mode: ${config.dryRun ? 'DRY_RUN (no real transactions)' : 'LIVE'}`);
  console.log(`Tracked wallets: ${config.smartWallets.length}`);
  config.smartWallets.forEach((wallet) => console.log(`  - ${wallet}`));
  console.log(`Existing copied positions: ${store.countPositions()}`);
  console.log(`Buy mode: ${config.follow.buyMode}; sell mode: ${config.follow.sellMode}`);
  console.log('============================================================');

  await executor.start();

  stream.on('status', ({ status, label, error }) => {
    const suffix = error ? `: ${error.message}` : '';
    console.log(`[stream:${label}] ${status}${suffix}`);
  });
  stream.on('transaction', (update, context) => {
    let trades;
    try {
      trades = parser.parse(update, context);
    } catch (error) {
      console.error(`[parser] ${error.message}`);
      return;
    }
    for (const trade of trades) {
      trader.handle(trade).catch((error) => console.error(`[copy] unhandled: ${error.message}`));
    }
  });

  await stream.start();

  let stopping = false;
  const shutdown = async (signal) => {
    if (stopping) return;
    stopping = true;
    console.log(`[main] ${signal}; stopping...`);
    await stream.stop();
    executor.stop();
  };
  process.on('SIGINT', () => shutdown('SIGINT').finally(() => process.exit(0)));
  process.on('SIGTERM', () => shutdown('SIGTERM').finally(() => process.exit(0)));
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`[main] fatal: ${error.stack || error.message}`);
    process.exit(1);
  });
}

module.exports = { main };
