'use strict';

const axios = require('axios');
const BN = require('bn.js');
const bs58Module = require('bs58');
const bs58 = bs58Module.default || bs58Module;
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
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
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

class TradeExecutor {
  constructor(config) {
    this.config = config;
    this.dryRun = config.dryRun;
    this.rpc = new Connection(config.rpc.url || 'http://127.0.0.1:8899', 'confirmed');
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
    this.curveStatic = null;
    this.curveStaticAt = 0;
    this.blockhash = null;
    this.blockhashAt = 0;
    this.blockhashTimer = null;
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
    this.curveSdk = new pump.OnlinePumpSdk(this.rpc);
    this.curveOffline = pump.PUMP_SDK;
    this.curveMath = {
      buy: pump.getBuyTokenAmountFromSolAmount,
      sell: pump.getSellSolAmountFromTokenAmount,
    };
    this.ammOffline = new pumpSwap.PumpAmmSdk();
    this.ammOnline = new pumpSwap.OnlinePumpAmmSdk(this.rpc);
    this.ammMath = {
      buy: pumpSwap.buyQuoteInput,
      sell: pumpSwap.sellBaseInput,
    };
    this.canonicalPumpPoolPda = pumpSwap.canonicalPumpPoolPda;

    await Promise.all([this._refreshBlockhash(), this._curveStaticState()]);
    this.blockhashTimer = setInterval(() => {
      this._refreshBlockhash().catch((error) => console.warn(`[executor] blockhash: ${error.message}`));
    }, 5_000);
    if (typeof this.blockhashTimer.unref === 'function') this.blockhashTimer.unref();
    console.log(`[executor] live wallet ${this.keypair.publicKey.toBase58()}`);
  }

  stop() {
    if (this.blockhashTimer) clearInterval(this.blockhashTimer);
    this.blockhashTimer = null;
  }

  async buy(trade) {
    if (this.dryRun) {
      return {
        success: true,
        signature: `DRYRUN_BUY_${Date.now()}`,
        channel: 'DRY_RUN',
        venue: trade.venue,
        decimals: trade.decimals,
        tokenAmountRaw: trade.tokenDeltaRaw,
        poolAddress: null,
      };
    }
    try {
      if (trade.venue === 'PUMP_CURVE') return await this._buyCurve(trade);
      if (trade.venue === 'PUMP_SWAP') return await this._buyAmm(trade);
      throw new Error(`unsupported venue: ${trade.venue}`);
    } catch (error) {
      return { success: false, error: error.message };
    }
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
      return { success: false, error: error.message };
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
      slippage: this.config.execution.buySlippageBps / 10_000,
      tokenProgram,
    });
    const submission = await this._buildAndSubmit(instructions, 'BUY');
    return {
      success: true,
      ...submission,
      venue: 'PUMP_CURVE',
      decimals: trade.decimals,
      tokenAmountRaw: expectedTokens.toString(),
      poolAddress: null,
    };
  }

  async _sellCurve(trade) {
    const mint = new PublicKey(trade.mint);
    const user = this.keypair.publicKey;
    const tokenProgram = new PublicKey(trade.tokenProgram || this.config.programs.token);
    const [sellState, staticState] = await Promise.all([
      this.curveSdk.fetchSellState(mint, user, tokenProgram),
      this._curveStaticState(),
    ]);
    if (sellState.bondingCurve.complete) return this._sellAmm({ ...trade, venue: 'PUMP_SWAP' });
    const amount = new BN(trade.tokenAmountRaw);
    const expectedSol = this.curveMath.sell({
      global: staticState.global,
      feeConfig: staticState.feeConfig,
      mintSupply: sellState.bondingCurve.tokenTotalSupply,
      bondingCurve: sellState.bondingCurve,
      amount,
    });
    const instructions = await this.curveOffline.sellInstructions({
      ...sellState,
      global: staticState.global,
      mint,
      user,
      amount,
      solAmount: expectedSol,
      slippage: this.config.execution.sellSlippageBps / 10_000,
      tokenProgram,
      mayhemMode: Boolean(sellState.bondingCurve.isMayhemMode),
      cashback: Boolean(sellState.bondingCurve.isCashbackCoin),
    });
    const submission = await this._buildAndSubmit(instructions, 'SELL');
    return { success: true, ...submission, venue: 'PUMP_CURVE', poolAddress: null };
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

  async _buyAmm(trade) {
    const mint = new PublicKey(trade.mint);
    const pool = this._poolForMint(mint, trade);
    const state = await this.ammOnline.swapSolanaState(pool, this.keypair.publicKey);
    if (!state.baseMint.equals(mint)) throw new Error('PumpSwap pool base mint does not match signal mint');
    const quote = toLamports(trade.buySol);
    const slippage = this.config.execution.buySlippageBps / 100;
    const quoteResult = this.ammMath.buy({ quote, slippage, ...this._ammQuoteArgs(state) });
    if (!quoteResult.base || quoteResult.base.lte(new BN(0))) throw new Error('PumpSwap quote returned zero tokens');
    const swapInstructions = await this.ammOffline.buyQuoteInput(state, quote, slippage);
    const ataInstructions = this._ammAtaInstructions(mint, state.baseTokenProgram);
    const submission = await this._buildAndSubmit([...ataInstructions, ...swapInstructions], 'BUY');
    return {
      success: true,
      ...submission,
      venue: 'PUMP_SWAP',
      decimals: state.baseMintAccount?.decimals ?? trade.decimals,
      tokenAmountRaw: quoteResult.base.toString(),
      poolAddress: pool.toBase58(),
    };
  }

  async _sellAmm(trade) {
    const mint = new PublicKey(trade.mint);
    const pool = this._poolForMint(mint, trade);
    const state = await this.ammOnline.swapSolanaState(pool, this.keypair.publicKey);
    if (!state.baseMint.equals(mint)) throw new Error('PumpSwap pool base mint does not match signal mint');
    const amount = new BN(trade.tokenAmountRaw);
    const slippage = this.config.execution.sellSlippageBps / 100;
    const quoteResult = this.ammMath.sell({ base: amount, slippage, ...this._ammQuoteArgs(state) });
    if (!quoteResult.minQuote || quoteResult.minQuote.lte(new BN(0))) {
      throw new Error('PumpSwap sell quote returned zero SOL');
    }
    const instructions = await this.ammOffline.sellBaseInput(state, amount, slippage);
    const submission = await this._buildAndSubmit(instructions, 'SELL');
    return {
      success: true,
      ...submission,
      venue: 'PUMP_SWAP',
      poolAddress: pool.toBase58(),
      expectedMinQuoteRaw: quoteResult.minQuote.toString(),
    };
  }

  _ammAtaInstructions(mint, baseTokenProgram) {
    const owner = this.keypair.publicKey;
    const wsol = new PublicKey(this.config.programs.wsol);
    const baseProgram = baseTokenProgram || TOKEN_PROGRAM_ID;
    const baseAta = getAssociatedTokenAddressSync(
      mint,
      owner,
      false,
      baseProgram,
      ASSOCIATED_TOKEN_PROGRAM_ID,
    );
    const wsolAta = getAssociatedTokenAddressSync(
      wsol,
      owner,
      false,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID,
    );
    return [
      createAssociatedTokenAccountIdempotentInstruction(owner, baseAta, owner, mint, baseProgram),
      createAssociatedTokenAccountIdempotentInstruction(owner, wsolAta, owner, wsol, TOKEN_PROGRAM_ID),
    ];
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

  async _buildAndSubmit(tradeInstructions, side) {
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
    this._watchConfirmation(localSignature).catch(() => {});
    console.log(
      `[executor] ${side} submitted ${localSignature.slice(0, 10)}.. ` +
        `channel=${result.channel} latency=${Date.now() - startedAt}ms`,
    );
    return {
      signature: localSignature,
      channel: result.channel,
      latencyMs: Date.now() - startedAt,
    };
  }

  async _submit(serialized, senderEnabled) {
    const tasks = [
      this.stakedRpc.sendRawTransaction(serialized, { skipPreflight: true, maxRetries: 0 })
        .then((signature) => ({ signature, channel: 'STAKED_RPC' })),
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
        tasks.push(
          axios.post(endpoint, body, { timeout: 4_000 }).then(({ data }) => {
            if (data.error) throw new Error(JSON.stringify(data.error));
            return { signature: data.result, channel: `SENDER:${this._endpointLabel(endpoint)}` };
          }),
        );
      }
    }
    return firstSuccessful(tasks);
  }

  _endpointLabel(endpoint) {
    try {
      return endpoint.replace(/^https?:\/\//, '').split(/[/:]/)[0].split('.')[0].toUpperCase();
    } catch (_) {
      return 'REGION';
    }
  }

  async _watchConfirmation(signature) {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 750));
      const response = await this.rpc.getSignatureStatuses([signature], { searchTransactionHistory: false });
      const status = response.value[0];
      if (!status) continue;
      if (status.err) {
        console.error(`[executor] transaction failed ${signature.slice(0, 10)}.. ${JSON.stringify(status.err)}`);
        return false;
      }
      if (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized') {
        console.log(`[executor] confirmed ${signature.slice(0, 10)}.. slot=${status.slot}`);
        return true;
      }
    }
    console.warn(`[executor] confirmation timeout ${signature.slice(0, 10)}..`);
    return false;
  }
}

module.exports = { TradeExecutor, firstSuccessful, toLamports };
