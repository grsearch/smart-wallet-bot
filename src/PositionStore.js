'use strict';

const fs = require('fs');
const path = require('path');

const STATE_VERSION = 1;
const PROCESSED_RETENTION_MS = 24 * 60 * 60_000;
const PROCESSED_MAX = 20_000;

function emptyStats() {
  return {
    copyBuys: 0,
    copySells: 0,
    totalBoughtSol: 0,
    realizedCostSol: 0,
    estimatedRealizedProceedsSol: 0,
  };
}

function emptyState() {
  return {
    version: STATE_VERSION,
    updatedAt: Date.now(),
    positions: {},
    processedSignals: {},
    stats: emptyStats(),
  };
}

function positionKey(sourceWallet, mint) {
  return `${sourceWallet}:${mint}`;
}

class PositionStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.state = this._load();
    this._pruneProcessed();
  }

  _load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      if (parsed.version !== STATE_VERSION || typeof parsed.positions !== 'object') {
        throw new Error(`unsupported state version: ${parsed.version}`);
      }
      parsed.processedSignals ||= {};
      parsed.stats = { ...emptyStats(), ...(parsed.stats || {}) };
      return parsed;
    } catch (error) {
      if (error.code !== 'ENOENT') {
        const backup = `${this.filePath}.invalid-${Date.now()}`;
        fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
        try { fs.copyFileSync(this.filePath, backup); } catch (_) {}
        console.warn(`[state] invalid state was ignored and backed up: ${error.message}`);
      }
      return emptyState();
    }
  }

  _save() {
    this.state.updatedAt = Date.now();
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.${process.pid}.tmp`;
    fs.writeFileSync(tempPath, `${JSON.stringify(this.state, null, 2)}\n`, 'utf8');
    fs.renameSync(tempPath, this.filePath);
  }

  _pruneProcessed(now = Date.now()) {
    const entries = Object.entries(this.state.processedSignals)
      .sort((a, b) => (b[1].detectedAt || 0) - (a[1].detectedAt || 0));
    const kept = entries.filter(([, value], index) => (
      index < PROCESSED_MAX && now - (value.detectedAt || 0) <= PROCESSED_RETENTION_MS
    ));
    this.state.processedSignals = Object.fromEntries(kept);
  }

  hasProcessed(signature) {
    return Boolean(this.state.processedSignals[signature]);
  }

  markSignal(trade, status = 'accepted', details = {}) {
    this.state.processedSignals[trade.signature] = {
      sourceWallet: trade.sourceWallet,
      mint: trade.mint,
      side: trade.side,
      detectedAt: trade.detectedAt || Date.now(),
      status,
      ...details,
    };
    if (Object.keys(this.state.processedSignals).length > PROCESSED_MAX) this._pruneProcessed();
    this._save();
  }

  updateSignal(signature, status, details = {}) {
    const current = this.state.processedSignals[signature];
    if (!current) return;
    this.state.processedSignals[signature] = {
      ...current,
      status,
      completedAt: Date.now(),
      ...details,
    };
    this._save();
  }

  getPosition(sourceWallet, mint) {
    return this.state.positions[positionKey(sourceWallet, mint)] || null;
  }

  listPositions() {
    return Object.values(this.state.positions);
  }

  countPositions() {
    return Object.keys(this.state.positions).length;
  }

  totalInvestedSol() {
    return this.listPositions().reduce((sum, position) => sum + (position.investedSol || 0), 0);
  }

  getDashboardState() {
    return {
      updatedAt: this.state.updatedAt,
      positions: this.listPositions().map((position) => ({ ...position })),
      processedSignals: Object.values(this.state.processedSignals)
        .sort((a, b) => (b.detectedAt || 0) - (a.detectedAt || 0)),
      stats: { ...this.state.stats },
    };
  }

  recordBuy(trade, result, buySol) {
    const key = positionKey(trade.sourceWallet, trade.mint);
    const current = this.state.positions[key];
    const addedRaw = BigInt(result.tokenAmountRaw || trade.tokenDeltaRaw || '0');
    const currentRaw = BigInt(current?.tokenAmountRaw || '0');
    const now = Date.now();
    this.state.positions[key] = {
      sourceWallet: trade.sourceWallet,
      mint: trade.mint,
      venue: result.venue || trade.venue,
      poolAddress: result.poolAddress || current?.poolAddress || null,
      decimals: result.decimals ?? trade.decimals,
      tokenAmountRaw: (currentRaw + addedRaw).toString(),
      investedSol: (current?.investedSol || 0) + buySol,
      buyCount: (current?.buyCount || 0) + 1,
      openedAt: current?.openedAt || now,
      updatedAt: now,
      lastBuySignature: result.signature || null,
      sourceSignature: trade.signature,
    };
    this.state.stats.copyBuys += 1;
    this.state.stats.totalBoughtSol += buySol;
    this._save();
    return this.state.positions[key];
  }

  recordSell(trade, soldRaw, result) {
    const key = positionKey(trade.sourceWallet, trade.mint);
    const current = this.state.positions[key];
    if (!current) return null;
    const beforeRaw = BigInt(current.tokenAmountRaw || '0');
    const actualSold = BigInt(soldRaw);
    const remainingRaw = beforeRaw > actualSold ? beforeRaw - actualSold : 0n;
    const clampedSoldRaw = actualSold > beforeRaw ? beforeRaw : actualSold;
    const soldRatio = Number(clampedSoldRaw * 1_000_000n / beforeRaw) / 1_000_000;
    const soldCostSol = current.investedSol * soldRatio;
    let expectedSolLamports = 0n;
    try {
      expectedSolLamports = BigInt(result.expectedSolLamports || result.expectedMinQuoteRaw || '0');
    } catch (_) {}
    this.state.stats.copySells += 1;
    this.state.stats.realizedCostSol += soldCostSol;
    this.state.stats.estimatedRealizedProceedsSol += Number(expectedSolLamports) / 1_000_000_000;
    if (remainingRaw === 0n) {
      delete this.state.positions[key];
      this._save();
      return null;
    }
    const remainingRatio = Number(remainingRaw * 1_000_000n / beforeRaw) / 1_000_000;
    this.state.positions[key] = {
      ...current,
      venue: result.venue || trade.venue || current.venue,
      poolAddress: result.poolAddress || current.poolAddress || null,
      tokenAmountRaw: remainingRaw.toString(),
      investedSol: current.investedSol * remainingRatio,
      updatedAt: Date.now(),
      lastSellSignature: result.signature || null,
      sourceSignature: trade.signature,
    };
    this._save();
    return this.state.positions[key];
  }
}

module.exports = { PositionStore, positionKey };
