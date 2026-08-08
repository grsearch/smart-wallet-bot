'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  RegionConnection,
  SmartWalletStream,
  normalizeWallets,
} = require('../src/SmartWalletStream');
const { activeTrackedWallets } = require('../src/index');

function regionFor(wallets = ['wallet-a']) {
  return new RegionConnection({
    endpoint: 'https://example.invalid',
    token: 'test-token',
    wallets,
    label: 'test-region',
    settings: {
      pingIntervalMs: 30_000,
      reconnectMinMs: 100,
      reconnectMaxMs: 1_000,
    },
    onUpdate: () => {},
    onStatus: () => {},
  });
}

test('wallet lists are normalized and disabled wallets stay out after restart', () => {
  assert.deepEqual(normalizeWallets([' wallet-a ', 'wallet-a', '', null]), ['wallet-a']);
  const store = {
    isWalletFollowEnabled: (wallet) => wallet !== 'wallet-b',
  };
  assert.deepEqual(
    activeTrackedWallets(['wallet-a', 'wallet-b', 'wallet-a'], store),
    ['wallet-a'],
  );
});

test('a connected region rewrites its accountInclude filter immediately', async () => {
  const region = regionFor();
  const writes = [];
  region.running = true;
  region.stream = {
    write: (request, callback) => {
      writes.push(request);
      callback(null);
    },
  };

  const result = await region.updateWallets(['wallet-b', 'wallet-b']);

  assert.equal(result, 'updated');
  assert.deepEqual(region.wallets, ['wallet-b']);
  assert.equal(writes.length, 1);
  assert.deepEqual(
    [...writes[0].transactions.smartWalletTrades.accountInclude],
    ['wallet-b'],
  );
});

test('disabling every wallet closes streams instead of subscribing to all transactions', async () => {
  const region = regionFor();
  let destroyed = false;
  let clientClosed = false;
  let writes = 0;
  region.running = true;
  region.stream = {
    removeAllListeners: () => {},
    destroy: () => { destroyed = true; },
    write: (_request, callback) => {
      writes += 1;
      callback(null);
    },
  };
  region.client = {
    close: () => { clientClosed = true; },
  };

  const result = await region.updateWallets([]);

  assert.equal(result, 'stopped');
  assert.equal(region.running, false);
  assert.equal(region.stream, null);
  assert.equal(region.client, null);
  assert.equal(destroyed, true);
  assert.equal(clientClosed, true);
  assert.equal(writes, 0);
});

test('restoring a wallet restarts regions that were stopped when all wallets were disabled', async () => {
  const stream = new SmartWalletStream({
    endpoints: ['https://example.invalid'],
    token: 'test-token',
    wallets: [],
    settings: {},
  });
  const calls = [];
  stream.running = true;
  stream.regions = [{
    updateWallets: async (wallets, options) => {
      calls.push({ wallets: [...wallets], options });
      return 'started';
    },
  }];

  const result = await stream.updateWallets(['wallet-a']);

  assert.deepEqual(result.activeWallets, ['wallet-a']);
  assert.deepEqual(result.regionStates, ['started']);
  assert.deepEqual(calls, [{
    wallets: ['wallet-a'],
    options: { startIfStopped: true },
  }]);
});
