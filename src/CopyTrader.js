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

function executionError(result, fallback) {
  const error = new Error(result?.error || fallback);
  error.execution = result || null;
  return error;
}

function lamportsToSol(value) {
  return Number(BigInt(value || '0')) / 1_000_000_000;
}

function positiveLamportsToSol(value) {
  try {
    const lamports = BigInt(value || '0');
    return lamports > 0n ? Number(lamports) / 1_000_000_000 : null;
  } catch (_) {
    return null;
  }
}

class CopyTrader {
  constructor({ config, executor, store }) {
    this.config = config;
    this.executor = executor;
    this.store = store;
    this.audit = new AuditLog(config.files.audit);
    this.mintQueues = new Map();
    this.trailingTimer = null;
    this.trailingCheckRunning = false;
    this.trailingQuoteErrorAt = new Map();
    this.reconcileTimer = null;
    this.reconcileRunning = false;
    this.reconcileErrorAt = new Map();
    this.zombieObservations = new Map();
  }

  _enqueueMint(mint, task) {
    const previous = this.mintQueues.get(mint) || Promise.resolve();
    const next = previous
      .catch(() => {})
      .then(task)
      .finally(() => {
        if (this.mintQueues.get(mint) === next) this.mintQueues.delete(mint);
      });
    this.mintQueues.set(mint, next);
    return next;
  }

  handle(trade) {
    const receivedAt = Date.now();
    return this._enqueueMint(trade.mint, () => this._handle(trade, receivedAt));
  }

  closePosition(sourceWallet, mint) {
    const requestedAt = Date.now();
    return this._enqueueMint(mint, async () => {
      const position = this.store.getPosition(sourceWallet, mint);
      if (!position) {
        return {
          success: false,
          status: 'not_found',
          error: 'position_not_found',
        };
      }

      const signature = `MANUAL_CLOSE:${sourceWallet}:${mint}:${requestedAt}`;
      const signal = {
        signature,
        sourceWallet,
        mint,
        side: 'SELL',
        venue: position.venue,
        poolAddress: position.poolAddress || null,
        tokenProgram: position.tokenProgram || null,
        quoteMint: this.config.programs.wsol,
        decimals: position.decimals,
        tokenDeltaRaw: `-${position.tokenAmountRaw}`,
        sellBps: 10_000,
        detectedAt: requestedAt,
        trigger: 'MANUAL_DASHBOARD',
      };
      const success = await this._handle(signal, requestedAt);
      const processed = this.store.getProcessedSignal(signature);
      return {
        success,
        status: processed?.status || (success ? 'confirmed' : 'failed'),
        sourceSignature: signature,
        copySignature: processed?.copySignature || null,
        error: processed?.error || processed?.reason || null,
        chainError: processed?.chainError || null,
      };
    });
  }

  start() {
    this._startPositionReconciliation();
    const settings = this.config.trailingTakeProfit;
    if (!settings?.enabled || this.trailingTimer) return;
    if (this.config.dryRun) {
      console.log('[trailing-tp] disabled in DRY_RUN because live sell quotes are unavailable');
      return;
    }
    this.trailingTimer = setInterval(() => {
      this._runTrailingChecks().catch((error) => {
        console.error(`[trailing-tp] monitor failed: ${errorMessage(error)}`);
      });
    }, settings.pollMs);
    if (typeof this.trailingTimer.unref === 'function') this.trailingTimer.unref();
    console.log(
      `[trailing-tp] enabled activation=+${settings.activationPercent}% ` +
        `drawdown=${settings.drawdownPercent}% poll=${settings.pollMs}ms`,
    );
    this._runTrailingChecks().catch((error) => {
      console.error(`[trailing-tp] initial check failed: ${errorMessage(error)}`);
    });
  }

  stop() {
    if (this.trailingTimer) clearInterval(this.trailingTimer);
    this.trailingTimer = null;
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
    this.reconcileTimer = null;
  }

  _startPositionReconciliation() {
    const settings = this.config.positionReconciliation || {};
    if (this.config.dryRun || settings.enabled === false || this.reconcileTimer) return;
    const pollMs = settings.pollMs ?? 30_000;
    this.reconcileTimer = setInterval(() => {
      this._runPositionReconciliation().catch((error) => {
        console.error(`[reconcile] monitor failed: ${errorMessage(error)}`);
      });
    }, pollMs);
    if (typeof this.reconcileTimer.unref === 'function') this.reconcileTimer.unref();
    console.log(
      `[reconcile] enabled poll=${pollMs}ms confirmations=${settings.missingConfirmations ?? 2}`,
    );
    this._runPositionReconciliation().catch((error) => {
      console.error(`[reconcile] initial check failed: ${errorMessage(error)}`);
    });
  }

  async _runTrailingChecks() {
    if (this.trailingCheckRunning) return false;
    this.trailingCheckRunning = true;
    try {
      const checks = this.store.listPositions().map((position) => (
        this._enqueueMint(position.mint, () => this._checkTrailingPosition(position))
      ));
      const results = await Promise.allSettled(checks);
      for (const result of results) {
        if (result.status !== 'rejected') continue;
        const message = errorMessage(result.reason);
        this.audit.write('trailing_take_profit_monitor_failed', { error: message });
        console.error(`[trailing-tp] position check failed: ${message}`);
      }
      return true;
    } finally {
      this.trailingCheckRunning = false;
    }
  }

  async _runPositionReconciliation() {
    if (this.reconcileRunning || typeof this.executor.inspectPosition !== 'function') return false;
    this.reconcileRunning = true;
    try {
      const checks = this.store.listPositions().map((position) => (
        this._enqueueMint(position.mint, () => this._reconcilePosition(position))
      ));
      const results = await Promise.allSettled(checks);
      for (const result of results) {
        if (result.status !== 'rejected') continue;
        const message = errorMessage(result.reason);
        this.audit.write('position_reconcile_monitor_failed', { error: message });
        console.error(`[reconcile] position check failed: ${message}`);
      }
      return true;
    } finally {
      this.reconcileRunning = false;
    }
  }

  async _reconcilePosition(snapshot, context = {}) {
    const position = this.store.getPosition(snapshot.sourceWallet, snapshot.mint);
    if (!position || typeof this.executor.inspectPosition !== 'function') return 'gone';
    const key = `${position.sourceWallet}:${position.mint}`;
    const inspection = await this.executor.inspectPosition(position);
    if (!inspection.success) {
      const now = Date.now();
      const lastLoggedAt = this.reconcileErrorAt.get(key) || 0;
      if (now - lastLoggedAt >= 30_000) {
        this.reconcileErrorAt.set(key, now);
        this.audit.write('position_reconcile_failed', {
          position,
          error: inspection.error || 'position inspection failed',
          ...context,
        });
        console.warn(
          `[reconcile] inspect failed ${position.mint.slice(0, 8)}: ` +
            `${inspection.error || 'unknown error'}`,
        );
      }
      return 'failed';
    }

    this.reconcileErrorAt.delete(key);
    if (inspection.status === 'active') {
      this.zombieObservations.delete(key);
      return 'active';
    }
    if (!['missing', 'empty'].includes(inspection.status)) return 'failed';

    const previous = this.zombieObservations.get(key);
    const now = Date.now();
    const minimumDelayMs = this.config.positionReconciliation?.confirmationDelayMs ?? 1_000;
    const sameStatus = previous?.status === inspection.status;
    const canIncrement = sameStatus && now - previous.lastSeenAt >= minimumDelayMs;
    const observation = {
      status: inspection.status,
      count: sameStatus ? previous.count + (canIncrement ? 1 : 0) : 1,
      firstSeenAt: sameStatus ? previous.firstSeenAt : now,
      lastSeenAt: !sameStatus || canIncrement ? now : previous.lastSeenAt,
    };
    this.zombieObservations.set(key, observation);
    const required = this.config.positionReconciliation?.missingConfirmations ?? 2;
    if (observation.count < required) {
      if (!previous || observation.count !== previous.count) {
        this.audit.write('zombie_position_suspected', { position, inspection, observation });
        console.warn(
          `[reconcile] suspected zombie ${position.mint.slice(0, 8)} ` +
            `${inspection.status} (${observation.count}/${required})`,
        );
      }
      return 'suspected';
    }

    const reason = inspection.status === 'missing' ? 'ata_missing' : 'ata_balance_zero';
    const removed = this.store.removeZombiePosition(position.sourceWallet, position.mint, {
      reason,
      ataAddress: inspection.ataAddress,
      actualTokenAmountRaw: inspection.actualTokenAmountRaw,
    });
    this.zombieObservations.delete(key);
    this.trailingQuoteErrorAt.delete(key);
    if (!removed) return 'gone';
    const sourceTrade = {
      signature: `RECONCILE:${position.sourceWallet}:${position.mint}:${Date.now()}`,
      sourceWallet: position.sourceWallet,
      mint: position.mint,
      side: 'SELL',
      venue: position.venue,
      detectedAt: Date.now(),
      trigger: 'ON_CHAIN_EMPTY',
    };
    this.audit.write('zombie_position_removed', {
      sourceTrade,
      position: removed,
      inspection,
      reason,
      quoteError: context.quoteError || null,
    });
    console.warn(
      `[reconcile] removed zombie ${position.mint.slice(0, 8)} ` +
        `reason=${reason} ata=${inspection.ataAddress || 'unknown'}`,
    );
    return 'removed';
  }

  async _checkTrailingPosition(snapshot) {
    const settings = this.config.trailingTakeProfit;
    if (!settings?.enabled) return false;
    const position = this.store.getPosition(snapshot.sourceWallet, snapshot.mint);
    if (!position) return false;

    const quote = await this.executor.quoteSell(position);
    if (!quote.success) {
      const reconciliation = await this._reconcilePosition(position, {
        quoteError: quote.error || 'sell quote failed',
      });
      if (reconciliation === 'suspected' || reconciliation === 'removed') {
        return reconciliation === 'removed';
      }
      const key = `${position.sourceWallet}:${position.mint}`;
      const now = Date.now();
      const lastLoggedAt = this.trailingQuoteErrorAt.get(key) || 0;
      if (now - lastLoggedAt >= Math.max(30_000, settings.retryMs)) {
        this.trailingQuoteErrorAt.set(key, now);
        this.audit.write('trailing_take_profit_quote_failed', {
          position,
          error: quote.error || 'sell quote failed',
        });
        console.warn(
          `[trailing-tp] quote failed ${position.mint.slice(0, 8)}: ${quote.error || 'unknown error'}`,
        );
      }
      return false;
    }

    const valueSol = lamportsToSol(quote.expectedSolLamports);
    const costSol = Number(position.investedSol || 0);
    if (!Number.isFinite(valueSol) || valueSol <= 0 || !Number.isFinite(costSol) || costSol <= 0) {
      return false;
    }
    const now = Date.now();
    const activationValueSol = costSol * (1 + settings.activationPercent / 100);
    let trailing = position.trailingTakeProfit || null;
    if (!trailing?.active) {
      if (valueSol < activationValueSol) return false;
      trailing = {
        active: true,
        activatedAt: now,
        activationValueSol,
        peakValueSol: valueSol,
        lastTriggerAt: null,
      };
      this.store.updateTrailingTakeProfit(position.sourceWallet, position.mint, trailing);
      this.audit.write('trailing_take_profit_activated', {
        position: { ...position, trailingTakeProfit: trailing },
        quotedValueSol: valueSol,
        activationPercent: settings.activationPercent,
        drawdownPercent: settings.drawdownPercent,
      });
      console.log(
        `[trailing-tp] activated ${position.mint.slice(0, 8)} ` +
          `value=${valueSol.toFixed(6)} SOL cost=${costSol.toFixed(6)} SOL`,
      );
      return true;
    }

    let peakValueSol = Math.max(Number(trailing.peakValueSol || 0), valueSol);
    if (peakValueSol > Number(trailing.peakValueSol || 0)) {
      const updated = this.store.updateTrailingTakeProfit(position.sourceWallet, position.mint, {
        peakValueSol,
      });
      trailing = updated?.trailingTakeProfit || { ...trailing, peakValueSol };
    }
    const triggerValueSol = peakValueSol * (1 - settings.drawdownPercent / 100);
    if (valueSol > triggerValueSol) return false;
    if (now - Number(trailing.lastTriggerAt || 0) < settings.retryMs) return false;

    this.store.updateTrailingTakeProfit(position.sourceWallet, position.mint, {
      peakValueSol,
      lastTriggerAt: now,
      lastTriggerValueSol: valueSol,
    });
    const signal = {
      signature: `TRAILING_TP:${position.sourceWallet}:${position.mint}:${now}`,
      sourceWallet: position.sourceWallet,
      mint: position.mint,
      side: 'SELL',
      venue: position.venue,
      poolAddress: position.poolAddress || quote.poolAddress || null,
      tokenProgram: position.tokenProgram || quote.tokenProgram || null,
      quoteMint: this.config.programs.wsol,
      decimals: position.decimals,
      tokenDeltaRaw: `-${position.tokenAmountRaw}`,
      sellBps: 10_000,
      detectedAt: now,
      trigger: 'TRAILING_TAKE_PROFIT',
      trailingTakeProfit: {
        costSol,
        quotedValueSol: valueSol,
        peakValueSol,
        triggerValueSol,
        activationPercent: settings.activationPercent,
        drawdownPercent: settings.drawdownPercent,
      },
    };
    this.audit.write('trailing_take_profit_triggered', { sourceTrade: signal });
    console.log(
      `[trailing-tp] SELL ${position.mint.slice(0, 8)} value=${valueSol.toFixed(6)} SOL ` +
        `peak=${peakValueSol.toFixed(6)} SOL trigger=${triggerValueSol.toFixed(6)} SOL`,
    );
    return this._handle(signal, now);
  }

  async _handle(trade, receivedAt = Date.now()) {
    // Measure staleness when the signal entered our queue. A timely SELL that
    // waits behind its BUY confirmation must not become stale just from waiting.
    const ageMs = receivedAt - trade.detectedAt;
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
    this.audit.write(trade.trigger ? 'strategy_trade' : 'source_trade', trade);

    try {
      if (trade.side === 'BUY') return await this._buy(trade);
      if (trade.side === 'SELL') return await this._sell(trade);
      return this._skipMarked(trade, 'unsupported_side');
    } catch (error) {
      const message = errorMessage(error);
      const result = error.execution || null;
      const failure = {
        error: message,
        copySignature: result?.signature || null,
        channel: result?.channel || null,
        confirmationStatus: result?.confirmationStatus || null,
        confirmationLatencyMs: result?.confirmationLatencyMs ?? null,
        chainError: result?.chainError || null,
        confirmationPollError: result?.confirmationPollError || null,
      };
      this.store.updateSignal(trade.signature, 'failed', failure);
      this.audit.write('copy_failed', {
        sourceTrade: trade,
        sourceSignature: trade.signature,
        result,
        ...failure,
      });
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
    if (existing) {
      return this._skipMarked(trade, 'first_buy_already_copied', {
        copiedBuySignature: existing.sourceSignature || null,
        positionOpenedAt: existing.openedAt || null,
      });
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
    if (!result.success) throw executionError(result, 'buy submission failed');
    const actualBuySol = positiveLamportsToSol(
      result.actualBuyCostLamports || result.payerBalanceDeltaLamports,
    );
    const recordedBuySol = actualBuySol || buySol;
    const position = this.store.recordBuy(trade, result, recordedBuySol);
    this.store.updateSignal(trade.signature, 'confirmed', {
      copySignature: result.signature,
      channel: result.channel,
    });
    this.audit.write('copy_buy', {
      sourceTrade: trade,
      result,
      position,
      buySol: recordedBuySol,
      requestedBuySol: buySol,
    });
    return true;
  }

  async _sell(trade) {
    const position = this.store.getPosition(trade.sourceWallet, trade.mint);
    if (!position) {
      const closed = this.store.getClosedPosition(trade.sourceWallet, trade.mint);
      if (closed) {
        return this._skipMarked(trade, 'already_closed', {
          closedAt: closed.closedAt,
          exitTrigger: closed.exitTrigger,
          closeSignature: closed.copySignature,
        });
      }
      const latestBuy = this.store.getLatestSignal(trade.sourceWallet, trade.mint, 'BUY');
      if (latestBuy?.status === 'failed') {
        return this._skipMarked(trade, 'buy_failed_no_position', {
          buyError: latestBuy.error || null,
          buyChainError: latestBuy.chainError || null,
        });
      }
      if (latestBuy?.status === 'skipped') {
        return this._skipMarked(trade, 'buy_skipped_no_position', {
          buySkipReason: latestBuy.reason || null,
        });
      }
      return this._skipMarked(trade, 'no_copy_history');
    }

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
        `ratio=${(sellBps / 100).toFixed(2)}% venue=${trade.venue} ` +
        `trigger=${trade.trigger || 'SMART_WALLET'} age=${Date.now() - trade.detectedAt}ms`,
    );
    const result = await this.executor.sell({
      ...trade,
      tokenAmountRaw: sellRaw.toString(),
      position,
    });
    if (!result.success) throw executionError(result, 'sell submission failed');
    const beforeRaw = BigInt(position.tokenAmountRaw || '0');
    const soldRatio = Number(sellRaw * 1_000_000n / beforeRaw) / 1_000_000;
    const soldCostSol = position.investedSol * soldRatio;
    const remaining = this.store.recordSell(trade, sellRaw.toString(), result);
    this.store.updateSignal(trade.signature, 'confirmed', {
      copySignature: result.signature,
      channel: result.channel,
    });
    this.audit.write('copy_sell', { sourceTrade: trade, result, remaining, soldCostSol });
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
