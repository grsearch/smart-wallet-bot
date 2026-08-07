'use strict';

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');

const DASHBOARD_ROOT = path.resolve(__dirname, '..', 'dashboard');
const MAX_AUDIT_BYTES = 1024 * 1024;
const MAX_REQUEST_BYTES = 4096;
const SESSION_COOKIE = 'dashboard_session';
const SESSION_MAX_AGE_SECONDS = 24 * 60 * 60;
const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;

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

function beijingDayKey(timestamp) {
  return new Date(Number(timestamp) + BEIJING_OFFSET_MS).toISOString().slice(0, 10);
}

function beijingDayStart(timestamp) {
  const shifted = new Date(Number(timestamp) + BEIJING_OFFSET_MS);
  return Date.UTC(
    shifted.getUTCFullYear(),
    shifted.getUTCMonth(),
    shifted.getUTCDate(),
  ) - BEIJING_OFFSET_MS;
}

function emptyTradeCounters() {
  return {
    transactions: 0,
    buys: 0,
    sells: 0,
    realizedPnlSol: 0,
    wins: 0,
    evaluatedSells: 0,
  };
}

function emptyWalletAggregate(address) {
  return {
    address,
    total: emptyTradeCounters(),
    today: emptyTradeCounters(),
  };
}

function auditRealizedPnlSol(row) {
  if (row.type !== 'copy_sell' || !Number.isFinite(row.soldCostSol)) return null;
  const result = row.result || {};
  const proceedsRaw = result.actualSolProceedsLamports
    ?? result.expectedSolLamports
    ?? result.expectedMinQuoteRaw;
  if (proceedsRaw == null) return null;
  const proceedsSol = lamportsToSol(proceedsRaw);
  return Number.isFinite(proceedsSol) ? proceedsSol - row.soldCostSol : null;
}

function applyWalletAuditRow(statsByWallet, row, currentDayKey) {
  if (row.type !== 'copy_buy' && row.type !== 'copy_sell') return;
  const trade = row.sourceTrade || row;
  const address = trade.sourceWallet;
  if (!address) return;
  const aggregate = statsByWallet.get(address) || emptyWalletAggregate(address);
  statsByWallet.set(address, aggregate);
  const timestamp = Number(row.ts || trade.detectedAt || 0);
  const counters = [aggregate.total];
  if (timestamp > 0 && beijingDayKey(timestamp) === currentDayKey) {
    counters.push(aggregate.today);
  }
  const pnl = auditRealizedPnlSol(row);
  for (const counter of counters) {
    counter.transactions += 1;
    if (row.type === 'copy_buy') {
      counter.buys += 1;
      continue;
    }
    counter.sells += 1;
    if (pnl == null) continue;
    counter.realizedPnlSol += pnl;
    counter.evaluatedSells += 1;
    if (pnl > 0) counter.wins += 1;
  }
}

function winRate(counter) {
  return counter.evaluatedSells > 0
    ? (counter.wins / counter.evaluatedSells) * 100
    : null;
}

function normalizePnl(value) {
  return Math.abs(value) < 1e-12 ? 0 : value;
}

function walletStatisticsPayload(statsByWallet, trackedWallets, now) {
  const currentDayKey = beijingDayKey(now);
  return {
    timeZone: 'Asia/Shanghai',
    period: 'BEIJING_DAY',
    periodStartAt: beijingDayStart(now),
    periodEndAt: now,
    wallets: trackedWallets.map((address) => {
      const aggregate = statsByWallet.get(address) || emptyWalletAggregate(address);
      return {
        address,
        totalTransactions: aggregate.total.transactions,
        totalBuys: aggregate.total.buys,
        totalSells: aggregate.total.sells,
        totalRealizedPnlSol: normalizePnl(aggregate.total.realizedPnlSol),
        totalWinRate: winRate(aggregate.total),
        todayTransactions: aggregate.today.transactions,
        todayBuys: aggregate.today.buys,
        todaySells: aggregate.today.sells,
        todayRealizedPnlSol: normalizePnl(aggregate.today.realizedPnlSol),
        todayWinRate: winRate(aggregate.today),
      };
    }),
    dayKey: currentDayKey,
  };
}

function aggregateWalletStatistics(rows, trackedWallets, now = Date.now()) {
  const currentDayKey = beijingDayKey(now);
  const statsByWallet = new Map();
  for (const row of rows) applyWalletAuditRow(statsByWallet, row, currentDayKey);
  return walletStatisticsPayload(statsByWallet, trackedWallets, now);
}

class WalletAuditAccumulator {
  constructor(filePath) {
    this.filePath = filePath;
    this._reset();
  }

  _reset() {
    this.offset = 0;
    this.pending = '';
    this.fileIdentity = null;
    this.dayKey = null;
    this.statsByWallet = new Map();
  }

  _resetToday(dayKey) {
    this.dayKey = dayKey;
    for (const aggregate of this.statsByWallet.values()) {
      aggregate.today = emptyTradeCounters();
    }
  }

  _update(now) {
    const currentDayKey = beijingDayKey(now);
    if (this.dayKey !== currentDayKey) this._resetToday(currentDayKey);
    let stat;
    try {
      stat = fs.statSync(this.filePath);
    } catch (error) {
      if (error.code === 'ENOENT') {
        this._reset();
        this._resetToday(currentDayKey);
        return;
      }
      throw error;
    }
    if (!stat.isFile()) return;
    const identity = `${stat.dev}:${stat.ino}`;
    if ((this.fileIdentity && this.fileIdentity !== identity) || stat.size < this.offset) {
      this._reset();
      this._resetToday(currentDayKey);
    }
    this.fileIdentity = identity;
    if (stat.size === this.offset) return;

    const length = stat.size - this.offset;
    const buffer = Buffer.allocUnsafe(length);
    const fd = fs.openSync(this.filePath, 'r');
    try {
      fs.readSync(fd, buffer, 0, length, this.offset);
    } finally {
      fs.closeSync(fd);
    }
    this.offset = stat.size;
    const lines = `${this.pending}${buffer.toString('utf8')}`.split(/\r?\n/);
    this.pending = lines.pop() || '';
    for (const line of lines) {
      if (!line) continue;
      try {
        applyWalletAuditRow(this.statsByWallet, JSON.parse(line), currentDayKey);
      } catch (_) {}
    }
  }

  snapshot(trackedWallets, now = Date.now()) {
    this._update(now);
    return walletStatisticsPayload(this.statsByWallet, trackedWallets, now);
  }
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
  constructor({ config, store, trader = null }) {
    this.config = config;
    this.store = store;
    this.trader = trader;
    this.server = null;
    this.startedAt = Date.now();
    this.serviceStatus = 'starting';
    this.lastSignalAt = null;
    this.lastError = null;
    this.walletAudit = new WalletAuditAccumulator(config.files.audit);
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
    this.server = http.createServer((request, response) => {
      Promise.resolve(this._handle(request, response)).catch((error) => {
        this.lastError = error.message;
        console.error(`[dashboard] request failed: ${error.message}`);
        if (!response.headersSent) {
          this._securityHeaders(response);
          this._sendJson(response, 500, { error: 'dashboard_request_failed' });
        } else if (!response.writableEnded) {
          response.end();
        }
      });
    });
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

  _sessionValue() {
    const token = this.config.dashboard.token;
    if (!token) return '';
    return crypto.createHmac('sha256', token)
      .update('smart-wallet-dashboard-session-v1')
      .digest('base64url');
  }

  _cookieValue(request, name) {
    const cookies = String(request.headers.cookie || '').split(';');
    for (const cookie of cookies) {
      const separator = cookie.indexOf('=');
      if (separator < 0 || cookie.slice(0, separator).trim() !== name) continue;
      return cookie.slice(separator + 1).trim();
    }
    return '';
  }

  _authorization(request) {
    const token = this.config.dashboard.token;
    if (!token) return { authorized: true, viaBasic: false };
    const expected = `Basic ${Buffer.from(`dashboard:${token}`).toString('base64')}`;
    if (safeEqual(request.headers.authorization || '', expected)) {
      return { authorized: true, viaBasic: true };
    }
    const session = this._cookieValue(request, SESSION_COOKIE);
    return { authorized: safeEqual(session, this._sessionValue()), viaBasic: false };
  }

  _setSessionCookie(request, response) {
    if (!this.config.dashboard.token) return;
    const forwardedProto = String(request.headers['x-forwarded-proto'] || '')
      .split(',')[0]
      .trim()
      .toLowerCase();
    const secure = Boolean(request.socket.encrypted) || forwardedProto === 'https';
    response.setHeader('Set-Cookie', [
      `${SESSION_COOKIE}=${this._sessionValue()}`,
      'Path=/',
      'HttpOnly',
      'SameSite=Strict',
      `Max-Age=${SESSION_MAX_AGE_SECONDS}`,
      secure ? 'Secure' : null,
    ].filter(Boolean).join('; '));
  }

  _isSameOrigin(request) {
    const fetchSite = String(request.headers['sec-fetch-site'] || '').toLowerCase();
    if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') return false;
    const origin = request.headers.origin;
    if (!origin) return false;
    try {
      const forwardedHost = String(request.headers['x-forwarded-host'] || '')
        .split(',')[0]
        .trim();
      const requestHost = forwardedHost || request.headers.host;
      return Boolean(requestHost) && new URL(origin).host === requestHost;
    } catch (_) {
      return false;
    }
  }

  _readJsonBody(request) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let bytes = 0;
      let tooLarge = false;
      request.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > MAX_REQUEST_BYTES) {
          tooLarge = true;
          chunks.length = 0;
          return;
        }
        if (!tooLarge) chunks.push(chunk);
      });
      request.on('end', () => {
        if (tooLarge) {
          const error = new Error('request_too_large');
          error.statusCode = 413;
          reject(error);
          return;
        }
        try {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve(text ? JSON.parse(text) : {});
        } catch (_) {
          const error = new Error('invalid_json');
          error.statusCode = 400;
          reject(error);
        }
      });
      request.on('error', reject);
    });
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
    const now = Date.now();
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
    const smartWalletStats = this.walletAudit.snapshot(this.config.smartWallets, now);
    const estimatedRealizedPnlTodaySol = normalizePnl(smartWalletStats.wallets.reduce(
      (total, wallet) => total + wallet.todayRealizedPnlSol,
      0,
    ));
    return {
      generatedAt: now,
      runtime: {
        status: this.serviceStatus,
        mode: this.config.dryRun ? 'DRY_RUN' : 'LIVE',
        startedAt: this.startedAt,
        uptimeMs: now - this.startedAt,
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
        estimatedRealizedPnlTodaySol,
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
      smartWalletStats,
      activity,
    };
  }

  async _handle(request, response) {
    this._securityHeaders(response);
    let pathname;
    try {
      pathname = new URL(request.url, 'http://dashboard.local').pathname;
    } catch (_) {
      return this._sendJson(response, 400, { error: 'invalid_url' });
    }

    const authorization = this._authorization(request);
    if (!authorization.authorized) {
      response.setHeader('WWW-Authenticate', 'Basic realm="SOL Copy Bot Dashboard", charset="UTF-8"');
      return this._sendJson(response, 401, { error: 'authentication_required' });
    }
    if (authorization.viaBasic) this._setSessionCookie(request, response);

    if (pathname === '/api/positions/close') {
      if (request.method !== 'POST') {
        response.setHeader('Allow', 'POST');
        return this._sendJson(response, 405, { error: 'method_not_allowed' });
      }
      if (!this._isSameOrigin(request)) {
        return this._sendJson(response, 403, { error: 'same_origin_required' });
      }
      if (!String(request.headers['content-type'] || '').toLowerCase().startsWith('application/json')) {
        return this._sendJson(response, 415, { error: 'json_content_type_required' });
      }
      if (!this.trader || typeof this.trader.closePosition !== 'function') {
        return this._sendJson(response, 503, { error: 'manual_close_unavailable' });
      }

      let body;
      try {
        body = await this._readJsonBody(request);
      } catch (error) {
        return this._sendJson(response, error.statusCode || 400, { error: error.message });
      }
      const sourceWallet = typeof body.sourceWallet === 'string' ? body.sourceWallet.trim() : '';
      const mint = typeof body.mint === 'string' ? body.mint.trim() : '';
      if (!sourceWallet || !mint) {
        return this._sendJson(response, 400, { error: 'source_wallet_and_mint_required' });
      }
      if (!this.store.getPosition(sourceWallet, mint)) {
        return this._sendJson(response, 404, { error: 'position_not_found' });
      }

      const result = await this.trader.closePosition(sourceWallet, mint);
      if (!result.success) {
        const statusCode = result.status === 'not_found' ? 404 : 409;
        return this._sendJson(response, statusCode, {
          error: result.error || 'manual_close_failed',
          status: result.status || 'failed',
          copySignature: result.copySignature || null,
          chainError: result.chainError || null,
        });
      }
      return this._sendJson(response, 200, {
        success: true,
        status: result.status,
        copySignature: result.copySignature || null,
      });
    }

    if (!['GET', 'HEAD'].includes(request.method)) {
      response.setHeader('Allow', 'GET, HEAD');
      return this._sendJson(response, 405, { error: 'method_not_allowed' });
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
  aggregateWalletStatistics,
  beijingDayKey,
  DashboardServer,
  normalizeActivity,
  readRecentJsonLines,
  streamLabel,
};
