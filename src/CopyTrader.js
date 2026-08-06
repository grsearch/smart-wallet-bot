'use strict';

const fs = require('fs');
const path = require('path');

class AuditLog {
  constructor(filePath) {
    this.filePath = filePath;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
  }

  write(type, payload) {
    const row = JSON.stringify({ ts: Date.now(), type, ...payload });
    fs.appendFile(this.filePath, `${row}\n`, (error) => {
      if (error) console.error(`[audit] ${error.message}`);
    });
  }
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

class CopyTrader {
  constructor({ config, executor, store }) {
    this.config = config;
    this.executor = executor;
    this.store = store;
    this.audit = new AuditLog(config.files.audit);
    this.mintQueues = new Map();
  }

  handle(trade) {
    const previous = this.mintQueues.get(trade.mint) || Promise.resolve();
    const next = previous
      .catch(() => {})
      .then(() => this._handle(trade))
      .finally(() => {
        if (this.mintQueues.get(trade.mint) === next) this.mintQueues.delete(trade.mint);
      });
    this.mintQueues.set(trade.mint, next);
    return next;
  }

  async _handle(trade) {
    const ageMs = Date.now() - trade.detectedAt;
    if (ageMs > this.config.follow.maxSignalAgeMs) {
      return this._skip(trade, 'stale_signal', { ageMs });
    }
    if (this.store.hasProcessed(trade.signature)) return false;
    if (trade.quoteMint && trade.quoteMint !== this.config.programs.wsol) {
      return this._skip(trade, 'unsupported_non_sol_quote', { quoteMint: trade.quoteMint });
    }

    // Persist acceptance before any transaction is submitted. A reconnect or
    // process restart can then never submit the same source signature twice.
    this.store.markSignal(trade, 'accepted', { ageMs });
    this.audit.write('source_trade', trade);

    try {
      if (trade.side === 'BUY') return await this._buy(trade);
      if (trade.side === 'SELL') return await this._sell(trade);
      return this._skipMarked(trade, 'unsupported_side');
    } catch (error) {
      const message = errorMessage(error);
      this.store.updateSignal(trade.signature, 'failed', { error: message });
      this.audit.write('copy_failed', { sourceSignature: trade.signature, error: message });
      console.error(`[copy] ${trade.side} ${trade.mint.slice(0, 8)} failed: ${message}`);
      return false;
    }
  }

  _buySize(trade) {
    const follow = this.config.follow;
    if (follow.buyMode === 'PROPORTIONAL') {
      const detectedSpend = trade.approximateSmartBuySol;
      if (!Number.isFinite(detectedSpend) || detectedSpend <= 0) return null;
      return Math.max(follow.minBuySol, Math.min(follow.maxBuySol, detectedSpend * follow.buyScale));
    }
    return Math.max(follow.minBuySol, Math.min(follow.maxBuySol, follow.buySol));
  }

  async _buy(trade) {
    const existing = this.store.getPosition(trade.sourceWallet, trade.mint);
    if (existing && !this.config.follow.allowScaleIn) {
      return this._skipMarked(trade, 'scale_in_disabled');
    }
    if (existing && existing.buyCount >= this.config.follow.maxBuysPerWalletMint) {
      return this._skipMarked(trade, 'max_buys_for_wallet_mint');
    }
    if (!existing && this.store.countPositions() >= this.config.follow.maxOpenPositions) {
      return this._skipMarked(trade, 'max_open_positions');
    }
    if (
      Number.isFinite(trade.approximateSmartBuySol) &&
      trade.approximateSmartBuySol < this.config.follow.minSmartBuySol
    ) {
      return this._skipMarked(trade, 'smart_buy_below_minimum');
    }

    const buySol = this._buySize(trade);
    if (!Number.isFinite(buySol) || buySol <= 0) {
      return this._skipMarked(trade, 'buy_size_unavailable');
    }
    if (this.store.totalInvestedSol() + buySol > this.config.follow.maxTotalSol + 1e-9) {
      return this._skipMarked(trade, 'max_total_sol');
    }

    console.log(
      `[copy] BUY ${trade.mint.slice(0, 8)} source=${trade.sourceWallet.slice(0, 8)} ` +
        `size=${buySol.toFixed(4)} SOL venue=${trade.venue} age=${Date.now() - trade.detectedAt}ms`,
    );
    const result = await this.executor.buy({ ...trade, buySol });
    if (!result.success) throw new Error(result.error || 'buy submission failed');
    const position = this.store.recordBuy(trade, result, buySol);
    this.store.updateSignal(trade.signature, 'submitted', {
      copySignature: result.signature,
      channel: result.channel,
    });
    this.audit.write('copy_buy', { sourceTrade: trade, result, position });
    return true;
  }

  async _sell(trade) {
    const position = this.store.getPosition(trade.sourceWallet, trade.mint);
    if (!position) return this._skipMarked(trade, 'no_copied_position');

    const positionRaw = BigInt(position.tokenAmountRaw || '0');
    if (positionRaw <= 0n) return this._skipMarked(trade, 'empty_copied_position');
    const sellBps = this.config.follow.sellMode === 'FULL'
      ? 10_000
      : Math.max(1, Math.min(10_000, trade.sellBps || 10_000));
    let sellRaw = (positionRaw * BigInt(sellBps)) / 10_000n;
    if (sellBps >= 9_950) sellRaw = positionRaw;
    if (sellRaw <= 0n) sellRaw = 1n;

    console.log(
      `[copy] SELL ${trade.mint.slice(0, 8)} source=${trade.sourceWallet.slice(0, 8)} ` +
        `ratio=${(sellBps / 100).toFixed(2)}% venue=${trade.venue} age=${Date.now() - trade.detectedAt}ms`,
    );
    const result = await this.executor.sell({
      ...trade,
      tokenAmountRaw: sellRaw.toString(),
      position,
    });
    if (!result.success) throw new Error(result.error || 'sell submission failed');
    const remaining = this.store.recordSell(trade, sellRaw.toString(), result);
    this.store.updateSignal(trade.signature, 'submitted', {
      copySignature: result.signature,
      channel: result.channel,
    });
    this.audit.write('copy_sell', { sourceTrade: trade, result, remaining });
    return true;
  }

  _skip(trade, reason, details = {}) {
    if (!this.store.hasProcessed(trade.signature)) {
      this.store.markSignal(trade, 'skipped', { reason, ...details });
    }
    this.audit.write('copy_skipped', { sourceTrade: trade, reason, ...details });
    console.log(`[copy] skip ${trade.side} ${trade.mint.slice(0, 8)}: ${reason}`);
    return false;
  }

  _skipMarked(trade, reason, details = {}) {
    this.store.updateSignal(trade.signature, 'skipped', { reason, ...details });
    this.audit.write('copy_skipped', { sourceTrade: trade, reason, ...details });
    console.log(`[copy] skip ${trade.side} ${trade.mint.slice(0, 8)}: ${reason}`);
    return false;
  }
}

module.exports = { AuditLog, CopyTrader };
