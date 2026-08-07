'use strict';

const axios = require('axios');
const BN = require('bn.js');
const bs58Module = require('bs58');
const bs58 = bs58Module.default || bs58Module;
const { EventEmitter } = require('events');
const http = require('http');
const https = require('https');
const {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
} = require('@solana/web3.js');
const {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  AccountLayout,
  MintLayout,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} = require('@solana/spl-token');

const HELIUS_TIP_ACCOUNTS = [
  '4ACfpUFoaSD9bfPdeu6DBt89gB6ENTeHBXCAi87NhDEE',
  'D2L6yPZ2FmmmTKPgzaMKdhu6EWZcTpLy1Vhx8uvZe7NZ',
  '9bnz4RShgq1hAnLnZbP8kbgBg1kEmcJBYQq3gQbmnSta',
  '5VY91ws6B2hMmBFRsXkoAAdsPHBJwRfBht4DXox3xkwn',
  '2nyhqdwKcJZR2vcqCyrYsaPVdAnFoJjiksCXJ7hfEYgD',
  '2q5pghRs6arqVjRvT5gfgWfWcHWmw1ZuCzphgd5KfWGJ',
  'wyvPkWjVZz1M8fHQnMMCDTQDbkManefNNhweYk5WkcF',
  '3KCKozbAaF75qEU33jtzozcJ29yJuaLJTy2jFdzUY8bT',
  '4vieeGHPYPG2MmyPRcYjdiDmmhN3ww7hsFNap8pVN3Ey',
  '4TQLFNWK8AovT1gFvda5jfw2oJeRMKEmw7aH6MGBJ3or',
];

function toLamports(sol) {
  return new BN(Math.max(1, Math.floor(sol * 1e9)).toString());
}

function firstSuccessful(tasks) {
  return new Promise((resolve, reject) => {
    if (tasks.length === 0) return reject(new Error('no transaction submission channel configured'));
    let failed = 0;
    const errors = [];
    for (const task of tasks) {
      Promise.resolve(task)
        .then(resolve)
        .catch((error) => {
          errors.push(error.message || String(error));
          failed += 1;
          if (failed === tasks.length) reject(new Error(errors.join(' | ')));
        });
    }
  });
}

function executionFailureResult(error) {
  return {
    success: false,
    error: error.message || String(error),
    ...(error.execution || {}),
  };
}

function customProgramError(value) {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = customProgramError(item);
      if (found != null) return found;
    }
    return null;
  }
  if (!value || typeof value !== 'object') return null;
  if (Number.isInteger(value.Custom)) return value.Custom;
  for (const child of Object.values(value)) {
    const found = customProgramError(child);
    if (found != null) return found;
  }
  return null;
}

function positiveLamports(value) {
  try {
    const amount = BigInt(value || '0');
    return amount > 0n ? amount : 0n;
  } catch (_) {
    return 0n;
  }
}

class TradeExecutor extends EventEmitter {
  constructor(config) {
    super();
    this.config = config;
    this.dryRun = config.dryRun;
    this.rpc = new Connection(config.rpc.url || 'http://127.0.0.1:8899', 'confirmed');
    // LaserStream emits at processed commitment. Quotes use the same view so a
    // fast-moving curve is not priced from an older confirmed snapshot.
    this.quoteRpc = new Connection(config.rpc.url || 'http://127.0.0.1:8899', 'processed');
    this.stakedRpc = config.rpc.stakedUrl
      ? new Connection(config.rpc.stakedUrl, 'confirmed')
      : this.rpc;
    this.keypair = null;
    this.curveSdk = null;
    this.curveOffline = null;
    this.curveMath = null;
    this.ammOffline = null;
    this.ammOnline = null;
    this.ammMath = null;
    this.canonicalPumpPoolPda = null;
    this.ammGlobalConfigPda = null;
    this.ammFeeConfigPda = null;
    this.ammStatic = null;
    this.ammStaticAt = 0;
    this.curveStatic = null;
    this.curveStaticAt = 0;
    this.blockhash = null;
    this.blockhashAt = 0;
    this.blockhashTimer = null;
    this.senderWarmTimer = null;
    this.senderHttpAgent = new http.Agent({ keepAlive: true, maxSockets: 32 });
    this.senderHttpsAgent = new https.Agent({ keepAlive: true, maxSockets: 32 });
  }

  async start() {
    if (this.dryRun) return;
    const secret = bs58.decode(this.config.wallet.privateKeyBs58);
    this.keypair = Keypair.fromSecretKey(secret);
    if (this.config.smartWallets.includes(this.keypair.publicKey.toBase58())) {
      throw new Error('the execution wallet cannot also be present in SMART_WALLETS');
    }

    const pump = require('@pump-fun/pump-sdk');
    const pumpSwap = require('@pump-fun/pump-swap-sdk');
    this.curveSdk = new pump.OnlinePumpSdk(this.quoteRpc);
    this.curveOffline = pump.PUMP_SDK;
    this.curveMath = {
      buy: pump.getBuyTokenAmountFromSolAmount,
      sell: pump.getSellSolAmountFromTokenAmount,
    };
    this.ammOffline = new pumpSwap.PumpAmmSdk();
    this.ammOnline = new pumpSwap.OnlinePumpAmmSdk(this.quoteRpc);
    this.ammMath = {
      buy: pumpSwap.buyQuoteInput,
      sell: pumpSwap.sellBaseInput,
    };
    this.canonicalPumpPoolPda = pumpSwap.canonicalPumpPoolPda;
    this.ammGlobalConfigPda = pumpSwap.GLOBAL_CONFIG_PDA;
    this.ammFeeConfigPda = pumpSwap.PUMP_AMM_FEE_CONFIG_PDA;

    await Promise.all([
      this._refreshBlockhash(),
      this._curveStaticState(),
      this._ammStaticState(),
    ]);
    this.blockhashTimer = setInterval(() => {
      this._refreshBlockhash().catch((error) => console.warn(`[executor] blockhash: ${error.message}`));
    }, 5_000);
    if (typeof this.blockhashTimer.unref === 'function') this.blockhashTimer.unref();
    if (this.config.rpc.senderEndpoints.length > 0) {
      this._warmSenderConnections();
      this.senderWarmTimer = setInterval(
        () => this._warmSenderConnections(),
        this.config.rpc.senderWarmIntervalMs ?? 5_000,
      );
      if (typeof this.senderWarmTimer.unref === 'function') this.senderWarmTimer.unref();
    }
    console.log(`[executor] live wallet ${this.keypair.publicKey.toBase58()}`);
  }

  stop() {
    if (this.blockhashTimer) clearInterval(this.blockhashTimer);
    this.blockhashTimer = null;
    if (this.senderWarmTimer) clearInterval(this.senderWarmTimer);
    this.senderWarmTimer = null;
    this.senderHttpAgent.destroy();
    this.senderHttpsAgent.destroy();
  }

  async buy(trade) {
    if (this.dryRun) {
      const requestedLamports = toLamports(trade.buySol).toString();
      return {
        success: true,
        signature: `DRYRUN_BUY_${Date.now()}`,
        channel: 'DRY_RUN',
        venue: trade.venue,
        decimals: trade.decimals,
        tokenAmountRaw: trade.tokenDeltaRaw,
        poolAddress: null,
        tokenProgram: trade.tokenProgram || null,
        actualBuyCostLamports: requestedLamports,
        retryCount: 0,
      };
    }
    const attempts = [];
    try {
      let result;
      if (trade.venue === 'PUMP_CURVE') result = await this._buyCurve(trade);
      else if (trade.venue === 'PUMP_SWAP') result = await this._buyAmm(trade);
      else throw new Error(`unsupported venue: ${trade.venue}`);
      return this._finalizeBuyResult(result, attempts);
    } catch (error) {
      attempts.push(this._executionAttempt(error, 1));
      if (!this._shouldRetryCurveBuy6002(trade, error)) {
        return { ...executionFailureResult(error), retryCount: 0, attempts };
      }

      console.warn(
        `[executor] BUY ${trade.mint.slice(0, 8)} retrying once after confirmed Custom:6002`,
      );
      try {
        // Force a new blockhash and rebuild from newly fetched curve state. If
        // the token graduated in the meantime, _buyCurve switches to PumpSwap.
        await this._refreshBlockhash();
        const result = await this._buyCurve(trade);
        return this._finalizeBuyResult(result, attempts);
      } catch (retryError) {
        attempts.push(this._executionAttempt(retryError, 2));
        return { ...executionFailureResult(retryError), retryCount: 1, attempts };
      }
    }
  }

  _shouldRetryCurveBuy6002(trade, error) {
    if (trade.venue !== 'PUMP_CURVE') return false;
    if (this.config.execution.curveBuyRetry6002 === false) return false;
    if (error?.execution?.confirmationStatus !== 'failed') return false;
    if (customProgramError(error.execution.chainError) !== 6002) return false;
    const detectedAt = Number(trade.detectedAt || Date.now());
    const maxAgeMs = this.config.execution.curveBuyRetryMaxSignalAgeMs ??
      this.config.follow?.maxSignalAgeMs ?? 5_000;
    return Date.now() - detectedAt <= maxAgeMs;
  }

  _executionAttempt(error, attempt) {
    return {
      attempt,
      success: false,
      signature: error?.execution?.signature || null,
      channel: error?.execution?.channel || null,
      confirmationStatus: error?.execution?.confirmationStatus || null,
      chainError: error?.execution?.chainError || null,
      payerBalanceDeltaLamports: error?.execution?.payerBalanceDeltaLamports || null,
      error: error?.message || String(error),
    };
  }

  _finalizeBuyResult(result, failedAttempts) {
    const failedCost = failedAttempts.reduce(
      (sum, attempt) => sum + positiveLamports(attempt.payerBalanceDeltaLamports),
      0n,
    );
    const landedCost = positiveLamports(result.payerBalanceDeltaLamports);
    const actualBuyCostLamports = failedCost + landedCost;
    return {
      ...result,
      actualBuyCostLamports: actualBuyCostLamports > 0n
        ? actualBuyCostLamports.toString()
        : null,
      retryCount: failedAttempts.length,
      attempts: failedAttempts.length > 0
        ? [...failedAttempts, {
          attempt: failedAttempts.length + 1,
          success: true,
          signature: result.signature,
          channel: result.channel,
          confirmationStatus: result.confirmationStatus,
          payerBalanceDeltaLamports: result.payerBalanceDeltaLamports || null,
        }]
        : [],
    };
  }

  async sell(trade) {
    if (this.dryRun) {
      return {
        success: true,
        signature: `DRYRUN_SELL_${Date.now()}`,
        channel: 'DRY_RUN',
        venue: trade.venue,
        poolAddress: trade.position?.poolAddress || null,
      };
    }
    try {
      if (trade.venue === 'PUMP_CURVE') return await this._sellCurve(trade);
      if (trade.venue === 'PUMP_SWAP') return await this._sellAmm(trade);
      throw new Error(`unsupported venue: ${trade.venue}`);
    } catch (error) {
      return executionFailureResult(error);
    }
  }

  async inspectPosition(position) {
    if (this.dryRun) {
      return { success: false, error: 'position inspection is unavailable in DRY_RUN' };
    }
    try {
      const mint = new PublicKey(position.mint);
      // Never trust a persisted token-program value for deletion decisions.
      // Resolve the mint owner again so an old/bad state entry cannot make us
      // derive the wrong ATA and remove a real position.
      const tokenProgram = await this._fetchMintTokenProgram(mint);
      const ata = getAssociatedTokenAddressSync(
        mint,
        this.keypair.publicKey,
        false,
        tokenProgram,
        ASSOCIATED_TOKEN_PROGRAM_ID,
      );
      const account = await this.quoteRpc.getAccountInfo(ata, 'processed');
      if (!account) {
        return {
          success: true,
          status: 'missing',
          mint: mint.toBase58(),
          ataAddress: ata.toBase58(),
          tokenProgram: tokenProgram.toBase58(),
          actualTokenAmountRaw: '0',
        };
      }
      if (!account.owner.equals(tokenProgram)) {
        throw new Error(`ATA owner program mismatch: ${account.owner.toBase58()}`);
      }
      const data = Buffer.from(account.data || []);
      if (data.length < 72) throw new Error(`invalid token account data length: ${data.length}`);
      const amount = data.readBigUInt64LE(64);
      return {
        success: true,
        status: amount === 0n ? 'empty' : 'active',
        mint: mint.toBase58(),
        ataAddress: ata.toBase58(),
        tokenProgram: tokenProgram.toBase58(),
        actualTokenAmountRaw: amount.toString(),
      };
    } catch (error) {
      return executionFailureResult(error);
    }
  }

  async quoteSell(position) {
    if (this.dryRun) return { success: false, error: 'sell quotes are unavailable in DRY_RUN' };
    try {
      if (position.venue === 'PUMP_CURVE') {
        const quote = await this._curveSellQuote(position);
        if (quote.migrated) return this._quoteAmmSell({ ...position, venue: 'PUMP_SWAP' });
        return {
          success: true,
          venue: 'PUMP_CURVE',
          expectedSolLamports: quote.expectedSol.toString(),
          tokenProgram: quote.tokenProgram.toBase58(),
          poolAddress: null,
        };
      }
      if (position.venue === 'PUMP_SWAP') return await this._quoteAmmSell(position);
      throw new Error(`unsupported venue: ${position.venue}`);
    } catch (error) {
      return executionFailureResult(error);
    }
  }

  async _curveStaticState() {
    if (this.curveStatic && Date.now() - this.curveStaticAt < 60_000) return this.curveStatic;
    const [global, feeConfig] = await Promise.all([
      this.curveSdk.fetchGlobal(),
      this.curveSdk.fetchFeeConfig(),
    ]);
    this.curveStatic = { global, feeConfig };
    this.curveStaticAt = Date.now();
    return this.curveStatic;
  }

  async _buyCurve(trade) {
    const mint = new PublicKey(trade.mint);
    const user = this.keypair.publicKey;
    const tokenProgram = new PublicKey(trade.tokenProgram || this.config.programs.token);
    const [buyState, staticState] = await Promise.all([
      this.curveSdk.fetchBuyState(mint, user, tokenProgram),
      this._curveStaticState(),
    ]);
    if (buyState.bondingCurve.complete) return this._buyAmm({ ...trade, venue: 'PUMP_SWAP' });
    const solAmount = toLamports(trade.buySol);
    const expectedTokens = this.curveMath.buy({
      global: staticState.global,
      feeConfig: staticState.feeConfig,
      mintSupply: buyState.bondingCurve.tokenTotalSupply,
      bondingCurve: buyState.bondingCurve,
      amount: solAmount,
      quoteMint: new PublicKey(this.config.programs.wsol),
    });
    if (!expectedTokens || expectedTokens.lte(new BN(0))) throw new Error('bonding curve quote returned zero tokens');
    const instructions = await this.curveOffline.buyInstructions({
      ...buyState,
      global: staticState.global,
      mint,
      user,
      amount: expectedTokens,
      solAmount,
      // Pump SDK expects a whole percentage (30 means 30%), not a fraction.
      slippage: this.config.execution.buySlippageBps / 100,
      tokenProgram,
    });
    const submission = await this._buildAndSubmit(instructions, 'BUY', trade);
    return {
      success: true,
      ...submission,
      venue: 'PUMP_CURVE',
      decimals: trade.decimals,
      tokenAmountRaw: expectedTokens.toString(),
      poolAddress: null,
      tokenProgram: tokenProgram.toBase58(),
    };
  }

  async _resolveTokenProgram(mint, provided) {
    if (provided) return new PublicKey(provided);
    return this._fetchMintTokenProgram(mint);
  }

  async _fetchMintTokenProgram(mint) {
    const account = await this.quoteRpc.getAccountInfo(mint, 'processed');
    if (!account) throw new Error(`mint account not found: ${mint.toBase58()}`);
    const owner = account.owner.toBase58();
    if (![this.config.programs.token, this.config.programs.token2022].includes(owner)) {
      throw new Error(`unsupported mint token program: ${owner}`);
    }
    return account.owner;
  }

  async _curveSellQuote(trade) {
    const mint = new PublicKey(trade.mint);
    const user = this.keypair.publicKey;
    const tokenProgram = await this._resolveTokenProgram(mint, trade.tokenProgram);
    const [sellState, staticState] = await Promise.all([
      this.curveSdk.fetchSellState(mint, user, tokenProgram),
      this._curveStaticState(),
    ]);
    if (sellState.bondingCurve.complete) return { migrated: true };
    const amount = new BN(trade.tokenAmountRaw);
    const expectedSol = this.curveMath.sell({
      global: staticState.global,
      feeConfig: staticState.feeConfig,
      mintSupply: sellState.bondingCurve.tokenTotalSupply,
      bondingCurve: sellState.bondingCurve,
      amount,
    });
    if (!expectedSol || expectedSol.lte(new BN(0))) {
      throw new Error('bonding curve sell quote returned zero SOL');
    }
    return { mint, user, tokenProgram, sellState, staticState, amount, expectedSol };
  }

  async _sellCurve(trade) {
    const quote = await this._curveSellQuote(trade);
    if (quote.migrated) return this._sellAmm({ ...trade, venue: 'PUMP_SWAP' });
    const { mint, user, tokenProgram, sellState, staticState, amount, expectedSol } = quote;
    const instructions = await this.curveOffline.sellInstructions({
      ...sellState,
      global: staticState.global,
      mint,
      user,
      amount,
      solAmount: expectedSol,
      slippage: this.config.execution.sellSlippageBps / 100,
      tokenProgram,
      mayhemMode: Boolean(sellState.bondingCurve.isMayhemMode),
      cashback: Boolean(sellState.bondingCurve.isCashbackCoin),
    });
    const submission = await this._buildAndSubmit(instructions, 'SELL', trade);
    return {
      success: true,
      ...submission,
      venue: 'PUMP_CURVE',
      poolAddress: null,
      expectedSolLamports: expectedSol.toString(),
    };
  }

  _ammQuoteArgs(state) {
    return {
      baseReserve: state.poolBaseAmount,
      quoteReserve: state.poolQuoteAmount,
      virtualQuoteReserves: state.pool.virtualQuoteReserves,
      globalConfig: state.globalConfig,
      baseMintAccount: state.baseMintAccount,
      baseMint: state.baseMint,
      coinCreator: state.pool.coinCreator,
      creator: state.pool.creator,
      feeConfig: state.feeConfig,
    };
  }

  _poolForMint(mint, trade) {
    if (trade.poolAddress) return new PublicKey(trade.poolAddress);
    if (trade.position?.poolAddress) return new PublicKey(trade.position.poolAddress);
    return this.canonicalPumpPoolPda(mint);
  }

  async _ammStaticState() {
    if (this.ammStatic && Date.now() - this.ammStaticAt < 60_000) return this.ammStatic;
    const [globalConfigAccountInfo, feeConfigAccountInfo] =
      await this.quoteRpc.getMultipleAccountsInfo([
        this.ammGlobalConfigPda,
        this.ammFeeConfigPda,
      ], 'processed');
    if (!globalConfigAccountInfo) throw new Error('PumpSwap global config account not found');
    this.ammStatic = {
      globalConfig: this.ammOffline.decodeGlobalConfig(globalConfigAccountInfo),
      feeConfig: feeConfigAccountInfo
        ? this.ammOffline.decodeFeeConfig(feeConfigAccountInfo)
        : null,
    };
    this.ammStaticAt = Date.now();
    return this.ammStatic;
  }

  async _fastAmmBuyState(poolKey, user) {
    // The upstream Online SDK performs three sequential RPC rounds, including
    // a final read of the user's ATAs. BUY instructions can safely use
    // idempotent ATA creation, so the hot path only needs pool metadata followed
    // by the mint/reserve accounts. Static configuration is pre-warmed.
    const [staticState, poolAccountInfo] = await Promise.all([
      this._ammStaticState(),
      this.quoteRpc.getAccountInfo(poolKey, 'processed'),
    ]);
    if (!poolAccountInfo) throw new Error('PumpSwap pool account not found');
    const pool = this.ammOffline.decodePool(poolAccountInfo);
    const [
      baseMintAccountInfo,
      quoteMintAccountInfo,
      poolBaseAccountInfo,
      poolQuoteAccountInfo,
    ] = await this.quoteRpc.getMultipleAccountsInfo([
      pool.baseMint,
      pool.quoteMint,
      pool.poolBaseTokenAccount,
      pool.poolQuoteTokenAccount,
    ], 'processed');
    if (!baseMintAccountInfo) throw new Error('PumpSwap base mint account not found');
    if (!quoteMintAccountInfo) throw new Error('PumpSwap quote mint account not found');
    if (!poolBaseAccountInfo || !poolQuoteAccountInfo) {
      throw new Error('PumpSwap pool reserve account not found');
    }
    const baseTokenProgram = baseMintAccountInfo.owner;
    const quoteTokenProgram = quoteMintAccountInfo.owner;
    return {
      ...staticState,
      poolKey,
      poolAccountInfo,
      pool,
      poolBaseAmount: new BN(AccountLayout.decode(poolBaseAccountInfo.data).amount.toString()),
      poolQuoteAmount: new BN(AccountLayout.decode(poolQuoteAccountInfo.data).amount.toString()),
      baseTokenProgram,
      quoteTokenProgram,
      baseMint: pool.baseMint,
      baseMintAccount: MintLayout.decode(baseMintAccountInfo.data),
      user,
      userBaseTokenAccount: getAssociatedTokenAddressSync(
        pool.baseMint,
        user,
        true,
        baseTokenProgram,
      ),
      userQuoteTokenAccount: getAssociatedTokenAddressSync(
        pool.quoteMint,
        user,
        true,
        quoteTokenProgram,
      ),
      userBaseAccountInfo: null,
      userQuoteAccountInfo: null,
    };
  }

  async _buyAmm(trade) {
    const mint = new PublicKey(trade.mint);
    const pool = this._poolForMint(mint, trade);
    const state = await this._fastAmmBuyState(pool, this.keypair.publicKey);
    if (!state.baseMint.equals(mint)) throw new Error('PumpSwap pool base mint does not match signal mint');
    const quote = toLamports(trade.buySol);
    const slippage = this.config.execution.buySlippageBps / 100;
    const quoteResult = this.ammMath.buy({ quote, slippage, ...this._ammQuoteArgs(state) });
    if (!quoteResult.base || quoteResult.base.lte(new BN(0))) throw new Error('PumpSwap quote returned zero tokens');
    const swapInstructions = await this.ammOffline.buyQuoteInput(state, quote, slippage);
    const submission = await this._buildAndSubmit(swapInstructions, 'BUY', trade);
    return {
      success: true,
      ...submission,
      venue: 'PUMP_SWAP',
      decimals: state.baseMintAccount?.decimals ?? trade.decimals,
      tokenAmountRaw: quoteResult.base.toString(),
      poolAddress: pool.toBase58(),
      tokenProgram: state.baseTokenProgram?.toBase58?.() || trade.tokenProgram || null,
    };
  }

  async _sellAmm(trade) {
    const quote = await this._ammSellQuote(trade, this.config.execution.sellSlippageBps / 100);
    const { mint, pool, state, amount, slippage, quoteResult } = quote;
    const instructions = await this.ammOffline.sellBaseInput(state, amount, slippage);
    const submission = await this._buildAndSubmit(instructions, 'SELL', trade);
    return {
      success: true,
      ...submission,
      venue: 'PUMP_SWAP',
      poolAddress: pool.toBase58(),
      expectedMinQuoteRaw: quoteResult.minQuote.toString(),
      expectedSolLamports: quoteResult.minQuote.toString(),
      tokenProgram: state.baseTokenProgram?.toBase58?.() || trade.tokenProgram || null,
    };
  }

  async _ammSellQuote(trade, slippage) {
    const mint = new PublicKey(trade.mint);
    const pool = this._poolForMint(mint, trade);
    const state = await this.ammOnline.swapSolanaState(pool, this.keypair.publicKey);
    if (!state.baseMint.equals(mint)) throw new Error('PumpSwap pool base mint does not match signal mint');
    const amount = new BN(trade.tokenAmountRaw);
    const quoteResult = this.ammMath.sell({ base: amount, slippage, ...this._ammQuoteArgs(state) });
    if (!quoteResult.minQuote || quoteResult.minQuote.lte(new BN(0))) {
      throw new Error('PumpSwap sell quote returned zero SOL');
    }
    return { mint, pool, state, amount, slippage, quoteResult };
  }

  async _quoteAmmSell(trade) {
    const quote = await this._ammSellQuote(trade, 0);
    return {
      success: true,
      venue: 'PUMP_SWAP',
      poolAddress: quote.pool.toBase58(),
      expectedSolLamports: quote.quoteResult.minQuote.toString(),
      tokenProgram: quote.state.baseTokenProgram?.toBase58?.() || trade.tokenProgram || null,
    };
  }

  async _refreshBlockhash() {
    this.blockhash = await this.rpc.getLatestBlockhash('confirmed');
    this.blockhashAt = Date.now();
    return this.blockhash;
  }

  async _getBlockhash() {
    if (
      this.blockhash &&
      Date.now() - this.blockhashAt <= this.config.execution.blockhashMaxAgeMs
    ) return this.blockhash;
    return this._refreshBlockhash();
  }

  _priorityFeeLamports(side) {
    return side === 'BUY'
      ? this.config.execution.buyPriorityFeeLamports
      : this.config.execution.sellPriorityFeeLamports;
  }

  async _buildAndSubmit(tradeInstructions, side, trade = null) {
    const startedAt = Date.now();
    const blockhash = await this._getBlockhash();
    const units = this.config.execution.computeUnitLimit;
    const totalPriorityLamports = this._priorityFeeLamports(side);
    const microLamports = Math.ceil((totalPriorityLamports * 1_000_000) / units);
    const instructions = [
      ComputeBudgetProgram.setComputeUnitLimit({ units }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports }),
    ];

    const senderEnabled = this.config.rpc.senderEndpoints.length > 0 &&
      this.config.execution.jitoTipLamports > 0;
    if (senderEnabled) {
      const tipAccount = HELIUS_TIP_ACCOUNTS[Math.floor(Math.random() * HELIUS_TIP_ACCOUNTS.length)];
      instructions.push(SystemProgram.transfer({
        fromPubkey: this.keypair.publicKey,
        toPubkey: new PublicKey(tipAccount),
        lamports: this.config.execution.jitoTipLamports,
      }));
    }
    instructions.push(...tradeInstructions);

    const message = new TransactionMessage({
      payerKey: this.keypair.publicKey,
      recentBlockhash: blockhash.blockhash,
      instructions,
    }).compileToV0Message();
    const transaction = new VersionedTransaction(message);
    transaction.sign([this.keypair]);
    const serialized = transaction.serialize();
    const localSignature = bs58.encode(transaction.signatures[0]);
    const result = await this._submit(serialized, senderEnabled);
    const submittedAt = Date.now();
    const submittedLatencyMs = submittedAt - startedAt;
    const detectedAt = Number(trade?.detectedAt || trade?.receivedAt || 0);
    const detectedToSubmittedMs = detectedAt > 0 ? Math.max(0, submittedAt - detectedAt) : null;
    const sourceSlot = Number.isFinite(Number(trade?.slot)) ? Number(trade.slot) : null;
    console.log(
      `[executor] ${side} submitted ${localSignature.slice(0, 10)}.. ` +
        `channel=${result.channel} buildSubmit=${submittedLatencyMs}ms ` +
        `detectSubmit=${detectedToSubmittedMs ?? 'n/a'}ms sourceSlot=${sourceSlot ?? 'n/a'}`,
    );
    const confirmation = await this._watchConfirmation(localSignature);
    const slotLag = sourceSlot != null && Number.isFinite(confirmation.slot)
      ? confirmation.slot - sourceSlot
      : null;
    const payerBalanceDeltaLamports = ['confirmed', 'failed'].includes(confirmation.status)
      // A failed 6002 must be retried immediately, so never wait for its
      // transaction details. Confirmed trades may briefly wait for RPC indexing.
      ? await this._payerBalanceDelta(localSignature, confirmation.status === 'confirmed' ? 3 : 1)
      : null;
    if (confirmation.status !== 'confirmed') {
      const chainError = confirmation.error || null;
      const reason = confirmation.status === 'failed'
        ? `on-chain failure: ${JSON.stringify(chainError)}`
        : `confirmation ${confirmation.status}`;
      const error = new Error(`transaction ${localSignature} ${reason}`);
      error.execution = {
        signature: localSignature,
        channel: result.channel,
        submittedLatencyMs,
        confirmationStatus: confirmation.status,
        confirmationLatencyMs: confirmation.latencyMs,
        chainError,
        confirmationPollError: confirmation.pollError || null,
        payerBalanceDeltaLamports,
        sourceSlot,
        confirmedSlot: confirmation.slot ?? null,
        slotLag,
        detectedToSubmittedMs,
      };
      throw error;
    }
    let actualSolProceedsLamports = null;
    try {
      const delta = BigInt(payerBalanceDeltaLamports || '0');
      if (side === 'SELL' && delta < 0n) actualSolProceedsLamports = (-delta).toString();
    } catch (_) {}
    console.log(
      `[executor] ${side} landed ${localSignature.slice(0, 10)}.. ` +
        `sourceSlot=${sourceSlot ?? 'n/a'} landedSlot=${confirmation.slot ?? 'n/a'} ` +
        `slotLag=${slotLag ?? 'n/a'}`,
    );
    return {
      signature: localSignature,
      channel: result.channel,
      latencyMs: submittedLatencyMs,
      confirmationStatus: confirmation.status,
      confirmationLatencyMs: confirmation.latencyMs,
      confirmedSlot: confirmation.slot,
      sourceSlot,
      slotLag,
      detectedToSubmittedMs,
      payerBalanceDeltaLamports,
      actualSolProceedsLamports,
    };
  }

  async _submit(serialized, senderEnabled) {
    const tasks = [
      this._trackSubmission('STAKED_RPC', async () => {
        const signature = await this.stakedRpc.sendRawTransaction(
          serialized,
          { skipPreflight: true, maxRetries: 0 },
        );
        return { signature, channel: 'STAKED_RPC' };
      }),
    ];
    if (senderEnabled) {
      const body = {
        jsonrpc: '2.0',
        id: 1,
        method: 'sendTransaction',
        params: [
          Buffer.from(serialized).toString('base64'),
          { encoding: 'base64', skipPreflight: true, maxRetries: 0 },
        ],
      };
      for (const endpoint of this.config.rpc.senderEndpoints) {
        const channel = `SENDER:${this._endpointLabel(endpoint)}`;
        tasks.push(
          this._trackSubmission(channel, async () => {
            const { data } = await axios.post(endpoint, body, {
              timeout: 4_000,
              httpAgent: this.senderHttpAgent,
              httpsAgent: this.senderHttpsAgent,
            });
            if (data.error) throw new Error(JSON.stringify(data.error));
            return { signature: data.result, channel };
          }),
        );
      }
    }
    return firstSuccessful(tasks);
  }

  _trackSubmission(channel, submit) {
    const startedAt = Date.now();
    return Promise.resolve()
      .then(submit)
      .then((result) => {
        this.emit('submissionChannel', {
          channel,
          status: 'success',
          latencyMs: Date.now() - startedAt,
          at: Date.now(),
        });
        return result;
      })
      .catch((error) => {
        this.emit('submissionChannel', {
          channel,
          status: 'failed',
          latencyMs: Date.now() - startedAt,
          error: error.message || String(error),
          at: Date.now(),
        });
        throw error;
      });
  }

  _senderPingEndpoint(endpoint) {
    const url = new URL(endpoint);
    url.pathname = url.pathname.replace(/\/fast\/?$/, '/ping');
    return url.toString();
  }

  _warmSenderConnections() {
    for (const endpoint of this.config.rpc.senderEndpoints) {
      const channel = `SENDER:${this._endpointLabel(endpoint)}`;
      const startedAt = Date.now();
      let pingEndpoint;
      try {
        pingEndpoint = this._senderPingEndpoint(endpoint);
      } catch (error) {
        this.emit('senderHealth', {
          channel,
          status: 'failed',
          latencyMs: 0,
          error: error.message || String(error),
          at: Date.now(),
        });
        continue;
      }
      axios.get(pingEndpoint, {
        timeout: 2_000,
        httpAgent: this.senderHttpAgent,
        httpsAgent: this.senderHttpsAgent,
      })
        .then(() => this.emit('senderHealth', {
          channel,
          status: 'connected',
          latencyMs: Date.now() - startedAt,
          at: Date.now(),
        }))
        .catch((error) => this.emit('senderHealth', {
          channel,
          status: 'failed',
          latencyMs: Date.now() - startedAt,
          error: error.message || String(error),
          at: Date.now(),
        }));
    }
  }

  async _payerBalanceDelta(signature, maxAttempts = 3) {
    if (typeof this.rpc.getTransaction !== 'function') return null;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      try {
        const transaction = await this.rpc.getTransaction(signature, {
          commitment: 'confirmed',
          maxSupportedTransactionVersion: 0,
        });
        const before = transaction?.meta?.preBalances?.[0];
        const after = transaction?.meta?.postBalances?.[0];
        if (Number.isSafeInteger(before) && Number.isSafeInteger(after)) {
          return (BigInt(before) - BigInt(after)).toString();
        }
      } catch (_) {}
      if (attempt < maxAttempts - 1) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return null;
  }

  _endpointLabel(endpoint) {
    try {
      return endpoint.replace(/^https?:\/\//, '').split(/[/:]/)[0].split('.')[0].toUpperCase();
    } catch (_) {
      return 'REGION';
    }
  }

  async _watchConfirmation(signature) {
    const startedAt = Date.now();
    const timeoutMs = this.config.execution.confirmationTimeoutMs ?? 20_000;
    const pollMs = this.config.execution.confirmationPollMs ?? 500;
    const deadline = startedAt + timeoutMs;
    let lastPollError = null;
    while (Date.now() < deadline) {
      try {
        const response = await this.rpc.getSignatureStatuses(
          [signature],
          { searchTransactionHistory: false },
        );
        const status = response.value[0];
        if (status?.err) {
          console.error(
            `[executor] transaction failed ${signature.slice(0, 10)}.. ${JSON.stringify(status.err)}`,
          );
          return {
            status: 'failed',
            error: status.err,
            slot: status.slot,
            latencyMs: Date.now() - startedAt,
          };
        }
        if (status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized') {
          console.log(`[executor] confirmed ${signature.slice(0, 10)}.. slot=${status.slot}`);
          return {
            status: 'confirmed',
            slot: status.slot,
            latencyMs: Date.now() - startedAt,
          };
        }
      } catch (error) {
        lastPollError = error.message || String(error);
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }

    // One final history lookup avoids declaring a landed transaction timed out
    // merely because it has already fallen out of the node's recent status cache.
    try {
      const response = await this.rpc.getSignatureStatuses(
        [signature],
        { searchTransactionHistory: true },
      );
      const status = response.value[0];
      if (status?.err) {
        console.error(
          `[executor] transaction failed ${signature.slice(0, 10)}.. ${JSON.stringify(status.err)}`,
        );
        return {
          status: 'failed',
          error: status.err,
          slot: status.slot,
          latencyMs: Date.now() - startedAt,
        };
      }
      if (status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized') {
        console.log(`[executor] confirmed ${signature.slice(0, 10)}.. slot=${status.slot}`);
        return {
          status: 'confirmed',
          slot: status.slot,
          latencyMs: Date.now() - startedAt,
        };
      }
    } catch (error) {
      lastPollError = error.message || String(error);
    }
    console.warn(`[executor] confirmation timeout ${signature.slice(0, 10)}..`);
    return {
      status: 'timeout',
      latencyMs: Date.now() - startedAt,
      pollError: lastPollError,
    };
  }
}

module.exports = { TradeExecutor, firstSuccessful, toLamports };
