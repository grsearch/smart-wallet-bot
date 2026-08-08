'use strict';

const EventEmitter = require('events');
const yellowstone = require('@triton-one/yellowstone-grpc');

const Client = yellowstone.default;
const {
  CommitmentLevel,
  SubscribeRequest,
  SubscribeRequestFilterTransactions,
} = yellowstone;

class SignatureDedup {
  constructor({ ttlMs = 10 * 60_000, maxSize = 10_000 } = {}) {
    this.ttlMs = ttlMs;
    this.maxSize = maxSize;
    this.items = new Map();
  }

  accept(signature) {
    if (!signature) return true;
    const now = Date.now();
    const existing = this.items.get(signature);
    if (existing && existing > now) return false;
    this.items.set(signature, now + this.ttlMs);
    if (this.items.size > this.maxSize) this.prune(now);
    return true;
  }

  prune(now = Date.now()) {
    for (const [key, expiresAt] of this.items) {
      if (expiresAt <= now || this.items.size > this.maxSize * 0.9) this.items.delete(key);
      if (this.items.size <= this.maxSize * 0.9 && expiresAt > now) break;
    }
  }
}

function shortEndpoint(endpoint, index) {
  try {
    const host = endpoint.replace(/^https?:\/\//, '').split(/[/:]/)[0];
    return `${host.split('.')[0] || 'region'}-${index + 1}`;
  } catch (_) {
    return `region-${index + 1}`;
  }
}

function signatureFromUpdate(update) {
  const value = update?.transaction?.signature || update?.signature;
  if (!value) return null;
  if (typeof value === 'string') return value;
  const bs58Module = require('bs58');
  const bs58 = bs58Module.default || bs58Module;
  return bs58.encode(Uint8Array.from(value));
}

function normalizeWallets(wallets) {
  return [...new Set((wallets || [])
    .map((wallet) => String(wallet || '').trim())
    .filter(Boolean))];
}

class RegionConnection {
  constructor({ endpoint, token, wallets, label, settings, onUpdate, onStatus }) {
    this.endpoint = endpoint;
    this.token = token;
    this.wallets = normalizeWallets(wallets);
    this.label = label;
    this.settings = settings;
    this.onUpdate = onUpdate;
    this.onStatus = onStatus;
    this.client = null;
    this.stream = null;
    this.running = false;
    this.reconnectAttempt = 0;
    this.reconnectTimer = null;
    this.pingTimer = null;
    this.pingId = 0;
  }

  async start() {
    this.running = true;
    await this._connect();
  }

  async stop() {
    this.running = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.reconnectTimer = null;
    this.pingTimer = null;
    this._close();
  }

  async updateWallets(wallets, { startIfStopped = false } = {}) {
    this.wallets = normalizeWallets(wallets);

    if (this.wallets.length === 0) {
      if (this.running) await this.stop();
      return 'stopped';
    }
    if (!this.running) {
      if (startIfStopped) {
        await this.start();
        return 'started';
      }
      return 'pending';
    }
    if (!this.stream) return 'pending_reconnect';

    try {
      await this._writeSubscription();
      return 'updated';
    } catch (error) {
      this._handleDisconnect(error);
      throw error;
    }
  }

  _close() {
    const stream = this.stream;
    const client = this.client;
    this.stream = null;
    this.client = null;
    if (stream) {
      try { stream.removeAllListeners(); } catch (_) {}
      try { stream.destroy(); } catch (_) {}
    }
    if (client) {
      try { if (typeof client.close === 'function') client.close(); } catch (_) {}
    }
  }

  async _connect() {
    if (!this.running) return;
    try {
      this._close();
      this.client = new Client(this.endpoint, this.token, {
        'grpc.max_receive_message_length': 64 * 1024 * 1024,
        'grpc.keepalive_time_ms': 30_000,
        'grpc.keepalive_timeout_ms': 5_000,
        'grpc.keepalive_permit_without_calls': 1,
      });
      if (typeof this.client.connect === 'function') await this.client.connect();
      this.stream = await this.client.subscribe();
      this.stream.on('data', (message) => this._handleMessage(message));
      this.stream.on('error', (error) => this._handleDisconnect(error));
      this.stream.on('end', () => this._handleDisconnect(new Error('stream ended')));
      this.stream.on('close', () => this._handleDisconnect(new Error('stream closed')));
      await this._writeSubscription();
      this.reconnectAttempt = 0;
      this._startPing();
      this.onStatus('connected', this.label);
    } catch (error) {
      this.onStatus('error', this.label, error);
      this._scheduleReconnect();
    }
  }

  async _writeSubscription() {
    const filterPlain = {
      vote: false,
      failed: false,
      accountInclude: this.wallets,
      accountExclude: [],
      accountRequired: [],
    };
    const filter = SubscribeRequestFilterTransactions
      ? SubscribeRequestFilterTransactions.create(filterPlain)
      : filterPlain;
    const plain = {
      accounts: {},
      slots: {},
      transactions: { smartWalletTrades: filter },
      transactionsStatus: {},
      blocks: {},
      blocksMeta: {},
      entry: {},
      accountsDataSlice: [],
      commitment: CommitmentLevel.PROCESSED,
    };
    const request = SubscribeRequest ? SubscribeRequest.create(plain) : plain;
    await this._write(request);
  }

  _write(request) {
    return new Promise((resolve, reject) => {
      if (!this.stream) return reject(new Error('stream is not connected'));
      this.stream.write(request, (error) => (error ? reject(error) : resolve()));
    });
  }

  _handleMessage(message) {
    if (message.ping) {
      this._sendPing().catch((error) => this._handleDisconnect(error));
      return;
    }
    if (message.pong || !message.transaction) return;
    this.onUpdate(message.transaction, {
      region: this.label,
      receivedAt: Date.now(),
    });
  }

  _startPing() {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = setInterval(() => {
      this._sendPing().catch((error) => this._handleDisconnect(error));
    }, this.settings.pingIntervalMs);
    if (typeof this.pingTimer.unref === 'function') this.pingTimer.unref();
  }

  async _sendPing() {
    if (!this.stream) return;
    this.pingId = (this.pingId + 1) % 2_147_483_647 || 1;
    const plain = {
      ping: { id: this.pingId },
      accounts: {},
      accountsDataSlice: [],
      transactions: {},
      transactionsStatus: {},
      slots: {},
      blocks: {},
      blocksMeta: {},
      entry: {},
    };
    await this._write(SubscribeRequest ? SubscribeRequest.create(plain) : plain);
  }

  _handleDisconnect(error) {
    if (!this.running) return;
    this.onStatus('disconnected', this.label, error);
    this._scheduleReconnect();
  }

  _scheduleReconnect() {
    if (!this.running || this.reconnectTimer) return;
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    this._close();
    const delay = Math.min(
      this.settings.reconnectMaxMs,
      this.settings.reconnectMinMs * (2 ** this.reconnectAttempt),
    );
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this._connect();
    }, delay);
  }
}

class SmartWalletStream extends EventEmitter {
  constructor({ endpoints, token, wallets, settings }) {
    super();
    this.dedup = new SignatureDedup();
    this.wallets = normalizeWallets(wallets);
    this.running = false;
    this.regions = endpoints.map((endpoint, index) => new RegionConnection({
      endpoint,
      token,
      wallets: this.wallets,
      label: shortEndpoint(endpoint, index),
      settings,
      onUpdate: (update, context) => this._handleUpdate(update, context),
      onStatus: (status, label, error) => this.emit('status', { status, label, error }),
    }));
  }

  async start() {
    this.running = true;
    if (this.wallets.length === 0) return;
    await Promise.all(this.regions.map((region) => region.start()));
  }

  async stop() {
    this.running = false;
    await Promise.all(this.regions.map((region) => region.stop()));
  }

  async updateWallets(wallets) {
    this.wallets = normalizeWallets(wallets);
    const regionStates = await Promise.all(this.regions.map((region) => (
      region.updateWallets(this.wallets, { startIfStopped: this.running })
    )));
    return {
      activeWallets: [...this.wallets],
      regionStates,
    };
  }

  _handleUpdate(update, context) {
    const signature = signatureFromUpdate(update);
    if (!this.dedup.accept(signature)) return;
    this.emit('transaction', update, context);
  }
}

module.exports = {
  RegionConnection,
  SignatureDedup,
  SmartWalletStream,
  normalizeWallets,
  signatureFromUpdate,
};
