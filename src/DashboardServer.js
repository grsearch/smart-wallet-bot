'use strict';

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');

const DASHBOARD_ROOT = path.resolve(__dirname, '..', 'dashboard');
const MAX_AUDIT_BYTES = 1024 * 1024;

const STATIC_ROUTES = new Map([
  ['/', { file: 'index.html', type: 'text/html; charset=utf-8' }],
  ['/styles.css', { file: 'styles.css', type: 'text/css; charset=utf-8' }],
  ['/app.js', { file: 'app.js', type: 'text/javascript; charset=utf-8' }],
]);

function streamLabel(endpoint, index) {
  try {
    const host = endpoint.replace(/^https?:\/\//, '').split(/[/:]/)[0];
    return `${host.split('.')[0] || 'region'}-${index + 1}`;
  } catch (_) {
    return `region-${index + 1}`;
  }
}

function senderLabel(endpoint) {
  try {
    const host = endpoint.replace(/^https?:\/\//, '').split(/[/:]/)[0];
    return `SENDER:${(host.split('.')[0] || 'region').toUpperCase()}`;
  } catch (_) {
    return 'SENDER:REGION';
  }
}

function readRecentJsonLines(filePath, limit, maxBytes = MAX_AUDIT_BYTES) {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size === 0) return [];
    const start = Math.max(0, stat.size - maxBytes);
    const length = stat.size - start;
    const buffer = Buffer.allocUnsafe(length);
    const fd = fs.openSync(filePath, 'r');
    try {
      fs.readSync(fd, buffer, 0, length, start);
    } finally {
      fs.closeSync(fd);
    }
    let text = buffer.toString('utf8');
    if (start > 0) {
      const firstNewline = text.indexOf('\n');
      text = firstNewline >= 0 ? text.slice(firstNewline + 1) : '';
    }
    return text
      .split(/\r?\n/)
      .filter(Boolean)
      .slice(-Math.max(limit * 3, limit))
      .map((line) => {
        try { return JSON.parse(line); } catch (_) { return null; }
      })
      .filter(Boolean);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

function lamportsToSol(value) {
  try { return Number(BigInt(value || '0')) / 1_000_000_000; } catch (_) { return null; }
}

function normalizeActivity(row) {
  const trade = row.sourceTrade || row;
  const result = row.result || {};
  const typeMap = {
    copy_buy: 'BUY',
    copy_sell: 'SELL',
    copy_failed: 'FAILED',
    copy_skipped: 'SKIPPED',
    zombie_position_removed: 'CLEANED',
  };
  const kind = typeMap[row.type];
  if (!kind) return null;
  return {
    timestamp: row.ts || trade.detectedAt || Date.now(),
    kind,
    side: trade.side || null,
    mint: trade.mint || null,
    sourceWallet: trade.sourceWallet || null,
    sourceSignature: trade.signature || row.sourceSignature || null,
    copySignature: result.signature || row.copySignature || null,
    venue: result.venue || trade.venue || null,
    channel: result.channel || null,
    latencyMs: Number.isFinite(result.latencyMs)
      ? result.latencyMs
      : (Number.isFinite(result.submittedLatencyMs) ? result.submittedLatencyMs : null),
    buySol: Number.isFinite(row.buySol) ? row.buySol : null,
    soldCostSol: Number.isFinite(row.soldCostSol) ? row.soldCostSol : null,
    estimatedProceedsSol: lamportsToSol(
      result.actualSolProceedsLamports || result.expectedSolLamports || result.expectedMinQuoteRaw,
    ),
    reason: row.reason || trade.trigger || null,
    error: row.error || result.error || null,
  };
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

class DashboardServer {
  constructor({ config, store }) {
    this.config = config;
    this.store = store;
    this.server = null;
    this.startedAt = Date.now();
    this.serviceStatus = 'starting';
    this.lastSignalAt = null;
    this.lastError = null;
    this.streams = new Map();
    this.submissionChannels = new Map();
    config.stream.endpoints.forEach((endpoint, index) => {
      const label = streamLabel(endpoint, index);
      this.streams.set(label, {
        label,
        endpointHost: endpoint.replace(/^https?:\/\//, '').split('/')[0],
        status: 'waiting',
        updatedAt: Date.now(),
        connectedAt: null,
        lastMessageAt: null,
        messages: 0,
        error: null,
      });
    });
    this.submissionChannels.set('STAKED_RPC', {
      channel: 'STAKED_RPC',
      attempts: 0,
      successes: 0,
      failures: 0,
      lastStatus: 'waiting',
    });
    for (const endpoint of config.rpc?.senderEndpoints || []) {
      const channel = senderLabel(endpoint);
      this.submissionChannels.set(channel, {
        channel,
        attempts: 0,
        successes: 0,
        failures: 0,
        lastStatus: 'waiting',
        healthStatus: 'waiting',
      });
    }
  }

  async start() {
    if (!this.config.dashboard.enabled || this.server) return null;
    this.server = http.createServer((request, response) => this._handle(request, response));
    await new Promise((resolve, reject) => {
      const onError = (error) => reject(error);
      this.server.once('error', onError);
      this.server.listen(this.config.dashboard.port, this.config.dashboard.host, () => {
        this.server.off('error', onError);
        resolve();
      });
    });
    this.server.on('error', (error) => {
      this.lastError = error.message;
      console.error(`[dashboard] ${error.message}`);
    });
    this.serviceStatus = 'running';
    const address = this.server.address();
    const port = typeof address === 'object' && address ? address.port : this.config.dashboard.port;
    console.log(`[dashboard] http://${this.config.dashboard.host}:${port}`);
    return { host: this.config.dashboard.host, port };
  }

  async stop() {
    this.serviceStatus = 'stopped';
    if (!this.server) return;
    const server = this.server;
    this.server = null;
    await new Promise((resolve) => server.close(() => resolve()));
  }

  address() {
    return this.server?.address() || null;
  }

  setServiceStatus(status) {
    this.serviceStatus = status;
  }

  updateStreamStatus({ status, label, error }) {
    const current = this.streams.get(label) || {
      label,
      endpointHost: label,
      messages: 0,
      lastMessageAt: null,
    };
    this.streams.set(label, {
      ...current,
      status,
      updatedAt: Date.now(),
      connectedAt: status === 'connected' ? Date.now() : current.connectedAt || null,
      error: error ? String(error.message || error).slice(0, 300) : null,
    });
    if (error) this.lastError = String(error.message || error).slice(0, 300);
  }

  recordStreamMessage(context = {}) {
    const label = context.region;
    if (!label) return;
    const current = this.streams.get(label) || { label, endpointHost: label, messages: 0 };
    this.streams.set(label, {
      ...current,
      status: current.status || 'connected',
      messages: (current.messages || 0) + 1,
      lastMessageAt: context.receivedAt || Date.now(),
      updatedAt: Date.now(),
    });
  }

  recordTrade(trade) {
    this.lastSignalAt = trade.detectedAt || Date.now();
  }

  recordSubmissionChannel(event) {
    const current = this.submissionChannels.get(event.channel) || {
      channel: event.channel,
      attempts: 0,
      successes: 0,
      failures: 0,
    };
    const success = event.status === 'success';
    this.submissionChannels.set(event.channel, {
      ...current,
      attempts: current.attempts + 1,
      successes: current.successes + (success ? 1 : 0),
      failures: current.failures + (success ? 0 : 1),
      lastStatus: event.status,
      lastLatencyMs: event.latencyMs ?? null,
      lastSubmitAt: event.at || Date.now(),
      lastError: success ? null : String(event.error || 'submission failed').slice(0, 300),
    });
  }

  recordSenderHealth(event) {
    const current = this.submissionChannels.get(event.channel) || {
      channel: event.channel,
      attempts: 0,
      successes: 0,
      failures: 0,
      lastStatus: 'waiting',
    };
    this.submissionChannels.set(event.channel, {
      ...current,
      healthStatus: event.status,
      healthLatencyMs: event.latencyMs ?? null,
      healthUpdatedAt: event.at || Date.now(),
      healthError: event.status === 'connected'
        ? null
        : String(event.error || 'health check failed').slice(0, 300),
    });
  }

  recordError(error) {
    this.lastError = String(error?.message || error).slice(0, 300);
  }

  _isAuthorized(request) {
    const token = this.config.dashboard.token;
    if (!token) return true;
    const expected = `Basic ${Buffer.from(`dashboard:${token}`).toString('base64')}`;
    return safeEqual(request.headers.authorization || '', expected);
  }

  _securityHeaders(response) {
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('X-Frame-Options', 'DENY');
  }

  _sendJson(response, statusCode, body) {
    response.statusCode = statusCode;
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.setHeader('Cache-Control', 'no-store');
    response.end(`${JSON.stringify(body)}\n`);
  }

  _snapshot() {
    const state = this.store.getDashboardState();
    const signals = state.processedSignals;
    const activity = readRecentJsonLines(
      this.config.files.audit,
      this.config.dashboard.recentTrades,
    )
      .map(normalizeActivity)
      .filter(Boolean)
      .slice(-this.config.dashboard.recentTrades)
      .reverse();
    const estimatedRealizedPnlSol =
      state.stats.estimatedRealizedProceedsSol - state.stats.realizedCostSol;
    return {
      generatedAt: Date.now(),
      runtime: {
        status: this.serviceStatus,
        mode: this.config.dryRun ? 'DRY_RUN' : 'LIVE',
        startedAt: this.startedAt,
        uptimeMs: Date.now() - this.startedAt,
        lastSignalAt: this.lastSignalAt,
        lastError: this.lastError,
      },
      configuration: {
        trackedWallets: [...this.config.smartWallets],
        buyMode: this.config.follow.buyMode,
        buySol: this.config.follow.buySol,
        sellMode: this.config.follow.sellMode,
        maxTotalSol: this.config.follow.maxTotalSol,
        trailingTakeProfit: { ...this.config.trailingTakeProfit },
        positionReconciliation: { ...this.config.positionReconciliation },
      },
      streams: [...this.streams.values()],
      submissionChannels: [...this.submissionChannels.values()],
      stats: {
        openPositions: state.positions.length,
        totalInvestedSol: this.store.totalInvestedSol(),
        copyBuys: state.stats.copyBuys,
        copySells: state.stats.copySells,
        estimatedRealizedPnlSol,
        submittedSignals: signals.filter((signal) => (
          signal.status === 'submitted' || signal.status === 'confirmed'
        )).length,
        skippedSignals: signals.filter((signal) => signal.status === 'skipped').length,
        failedSignals: signals.filter((signal) => signal.status === 'failed').length,
        trackedSignals24h: signals.length,
        reconciledPositions: state.stats.reconciledPositions || 0,
        reconciledCostSol: state.stats.reconciledCostSol || 0,
      },
      positions: state.positions.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)),
      activity,
    };
  }

  _handle(request, response) {
    this._securityHeaders(response);
    if (!this._isAuthorized(request)) {
      response.setHeader('WWW-Authenticate', 'Basic realm="SOL Copy Bot Dashboard", charset="UTF-8"');
      return this._sendJson(response, 401, { error: 'authentication_required' });
    }
    if (!['GET', 'HEAD'].includes(request.method)) {
      response.setHeader('Allow', 'GET, HEAD');
      return this._sendJson(response, 405, { error: 'method_not_allowed' });
    }
    let pathname;
    try {
      pathname = new URL(request.url, 'http://dashboard.local').pathname;
    } catch (_) {
      return this._sendJson(response, 400, { error: 'invalid_url' });
    }
    if (pathname === '/api/health') {
      return this._sendJson(response, 200, {
        status: this.serviceStatus,
        mode: this.config.dryRun ? 'DRY_RUN' : 'LIVE',
        uptimeMs: Date.now() - this.startedAt,
      });
    }
    if (pathname === '/api/dashboard') {
      try {
        return this._sendJson(response, 200, this._snapshot());
      } catch (error) {
        this.lastError = error.message;
        return this._sendJson(response, 500, { error: 'dashboard_snapshot_failed' });
      }
    }
    const asset = STATIC_ROUTES.get(pathname);
    if (!asset) return this._sendJson(response, 404, { error: 'not_found' });
    try {
      const content = fs.readFileSync(path.join(DASHBOARD_ROOT, asset.file));
      response.statusCode = 200;
      response.setHeader('Content-Type', asset.type);
      // Dashboard releases can change HTML and JS together. Caching either side
      // risks mismatched DOM IDs and a UI that appears to require manual reload.
      response.setHeader('Cache-Control', 'no-store, max-age=0');
      if (request.method === 'HEAD') return response.end();
      return response.end(content);
    } catch (error) {
      this.lastError = error.message;
      return this._sendJson(response, 500, { error: 'dashboard_asset_failed' });
    }
  }
}

module.exports = {
  DashboardServer,
  normalizeActivity,
  readRecentJsonLines,
  streamLabel,
};
