'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const BN = require('bn.js');
const { Keypair, PublicKey } = require('@solana/web3.js');
const { TradeExecutor } = require('../src/TradeExecutor');

const MINT = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6QdaEnpP5ZSUXP1B';
const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const WSOL = 'So11111111111111111111111111111111111111112';

function executorConfig() {
  return {
    dryRun: false,
    rpc: { url: 'http://127.0.0.1:8899', stakedUrl: '', senderEndpoints: [] },
    wallet: { privateKeyBs58: '' },
    smartWallets: [],
    programs: { token: TOKEN_2022, wsol: WSOL },
    execution: {
      buySlippageBps: 1500,
      sellSlippageBps: 1500,
      computeUnitLimit: 250000,
      buyPriorityFeeLamports: 1,
      sellPriorityFeeLamports: 1,
      jitoTipLamports: 0,
      blockhashMaxAgeMs: 25000,
      confirmationTimeoutMs: 20000,
      confirmationPollMs: 500,
      curveBuyRetry6002: true,
      curveBuyRetryMaxSignalAgeMs: 5000,
    },
    follow: { maxSignalAgeMs: 5000 },
  };
}

function curveState() {
  return {
    complete: false,
    tokenTotalSupply: new BN('1000000000'),
    isMayhemMode: true,
    isCashbackCoin: true,
  };
}

test('bonding-curve execution fetches online state and builds with offline PUMP_SDK', async () => {
  const executor = new TradeExecutor(executorConfig());
  executor.keypair = Keypair.generate();
  let fetchedTokenProgram = null;
  let buyArgs = null;
  let sellArgs = null;
  const bondingCurve = curveState();
  executor.curveSdk = {
    fetchBuyState: async (_mint, _user, tokenProgram) => {
      fetchedTokenProgram = tokenProgram;
      return { bondingCurve, bondingCurveAccountInfo: {}, associatedUserAccountInfo: null };
    },
    fetchSellState: async (_mint, _user, tokenProgram) => {
      fetchedTokenProgram = tokenProgram;
      return { bondingCurve, bondingCurveAccountInfo: {} };
    },
  };
  executor.curveOffline = {
    buyInstructions: async (args) => { buyArgs = args; return []; },
    sellInstructions: async (args) => { sellArgs = args; return []; },
  };
  executor.curveMath = {
    buy: () => new BN('123456'),
    sell: () => new BN('1000'),
  };
  executor._curveStaticState = async () => ({ global: {}, feeConfig: {} });
  executor._buildAndSubmit = async () => ({ signature: 'copy', channel: 'test' });

  const buy = await executor._buyCurve({
    mint: MINT,
    tokenProgram: TOKEN_2022,
    buySol: 0.1,
    decimals: 6,
  });
  assert.equal(buy.success, true);
  assert.equal(buy.tokenAmountRaw, '123456');
  assert(fetchedTokenProgram.equals(new PublicKey(TOKEN_2022)));
  assert.equal(buyArgs.tokenProgram.toBase58(), TOKEN_2022);
  assert.equal(buyArgs.slippage, 15);

  const sell = await executor._sellCurve({
    mint: MINT,
    tokenProgram: TOKEN_2022,
    tokenAmountRaw: '50000',
  });
  assert.equal(sell.success, true);
  assert.equal(sell.expectedSolLamports, '1000');
  assert.equal(sellArgs.mayhemMode, true);
  assert.equal(sellArgs.cashback, true);
  assert.equal(sellArgs.tokenProgram.toBase58(), TOKEN_2022);
  assert.equal(sellArgs.slippage, 15);
});

test('PumpSwap BUY uses the two-round fast state path instead of the online SDK path', async () => {
  const executor = new TradeExecutor(executorConfig());
  executor.keypair = Keypair.generate();
  const poolAddress = Keypair.generate().publicKey;
  const baseMint = new PublicKey(MINT);
  const quoteMint = new PublicKey(WSOL);
  let fastStateCalls = 0;
  let onlineStateCalls = 0;
  let submittedTrade = null;
  executor._fastAmmBuyState = async () => {
    fastStateCalls += 1;
    return {
      globalConfig: {},
      feeConfig: null,
      pool: {
        virtualQuoteReserves: new BN(0),
        coinCreator: PublicKey.default,
        creator: PublicKey.default,
      },
      poolBaseAmount: new BN('1000000'),
      poolQuoteAmount: new BN('2000000'),
      baseMintAccount: { decimals: 6 },
      baseMint,
      baseTokenProgram: new PublicKey(TOKEN_2022),
      quoteMint,
    };
  };
  executor.ammOnline = {
    swapSolanaState: async () => { onlineStateCalls += 1; throw new Error('slow path used'); },
  };
  executor.ammMath = { buy: () => ({ base: new BN('12345') }) };
  executor.ammOffline = { buyQuoteInput: async () => [] };
  executor._buildAndSubmit = async (_instructions, _side, trade) => {
    submittedTrade = trade;
    return { signature: 'copy', channel: 'test' };
  };

  const trade = {
    venue: 'PUMP_SWAP',
    mint: MINT,
    poolAddress: poolAddress.toBase58(),
    buySol: 0.05,
    decimals: 6,
    slot: 123,
  };
  const result = await executor._buyAmm(trade);
  assert.equal(result.success, true);
  assert.equal(result.tokenAmountRaw, '12345');
  assert.equal(fastStateCalls, 1);
  assert.equal(onlineStateCalls, 0);
  assert.equal(submittedTrade, trade);
});

test('confirmed Pump Curve Custom:6002 is requoted once and includes failed fee cost', async () => {
  const executor = new TradeExecutor(executorConfig());
  const chainError = { InstructionError: [3, { Custom: 6002 }] };
  let calls = 0;
  let refreshed = 0;
  executor._refreshBlockhash = async () => { refreshed += 1; };
  executor._buyCurve = async () => {
    calls += 1;
    if (calls === 1) {
      const error = new Error('transaction failed');
      error.execution = {
        signature: 'failed-copy-buy',
        channel: 'SENDER:SLC',
        confirmationStatus: 'failed',
        chainError,
        payerBalanceDeltaLamports: '5000',
      };
      throw error;
    }
    return {
      success: true,
      signature: 'retry-copy-buy',
      channel: 'STAKED_RPC',
      confirmationStatus: 'confirmed',
      payerBalanceDeltaLamports: '50000000',
      venue: 'PUMP_CURVE',
    };
  };

  const result = await executor.buy({
    venue: 'PUMP_CURVE',
    mint: MINT,
    buySol: 0.05,
    detectedAt: Date.now(),
  });
  assert.equal(result.success, true);
  assert.equal(result.retryCount, 1);
  assert.equal(result.actualBuyCostLamports, '50005000');
  assert.equal(result.attempts.length, 2);
  assert.equal(calls, 2);
  assert.equal(refreshed, 1);
});

test('timeouts and unknown outcomes never trigger a buy retry', async () => {
  const executor = new TradeExecutor(executorConfig());
  let calls = 0;
  executor._buyCurve = async () => {
    calls += 1;
    const error = new Error('confirmation timeout');
    error.execution = { confirmationStatus: 'timeout', chainError: null };
    throw error;
  };
  const result = await executor.buy({
    venue: 'PUMP_CURVE',
    mint: MINT,
    buySol: 0.05,
    detectedAt: Date.now(),
  });
  assert.equal(result.success, false);
  assert.equal(result.retryCount, 0);
  assert.equal(calls, 1);
});

test('submission channel telemetry records the result of every raced channel', async () => {
  const executor = new TradeExecutor(executorConfig());
  executor.stakedRpc = {
    sendRawTransaction: async () => 'copy-signature',
  };
  const events = [];
  executor.on('submissionChannel', (event) => events.push(event));
  const result = await executor._submit(Buffer.from('transaction'), false);
  assert.equal(result.channel, 'STAKED_RPC');
  assert.equal(events.length, 1);
  assert.equal(events[0].channel, 'STAKED_RPC');
  assert.equal(events[0].status, 'success');
});

test('transaction submission is successful only after confirmed status', async () => {
  const executor = new TradeExecutor(executorConfig());
  executor.keypair = Keypair.generate();
  executor._getBlockhash = async () => ({
    blockhash: Keypair.generate().publicKey.toBase58(),
    lastValidBlockHeight: 123,
  });
  executor._submit = async () => ({ channel: 'test' });
  executor._watchConfirmation = async () => ({
    status: 'confirmed',
    slot: 42,
    latencyMs: 7,
  });
  executor._payerBalanceDelta = async () => '50001000';

  const detectedAt = Date.now() - 25;
  const confirmed = await executor._buildAndSubmit([], 'BUY', { slot: 40, detectedAt });
  assert.equal(confirmed.confirmationStatus, 'confirmed');
  assert.equal(confirmed.confirmedSlot, 42);
  assert.equal(confirmed.confirmationLatencyMs, 7);
  assert.equal(confirmed.payerBalanceDeltaLamports, '50001000');
  assert.equal(confirmed.sourceSlot, 40);
  assert.equal(confirmed.slotLag, 2);
  assert(confirmed.detectedToSubmittedMs >= 25);

  const chainError = { InstructionError: [3, { Custom: 6002 }] };
  executor._watchConfirmation = async () => ({
    status: 'failed',
    error: chainError,
    slot: 43,
    latencyMs: 9,
  });
  await assert.rejects(
    executor._buildAndSubmit([], 'BUY', { slot: 41, detectedAt }),
    (error) => {
      assert.match(error.message, /on-chain failure/);
      assert.equal(error.execution.confirmationStatus, 'failed');
      assert.deepEqual(error.execution.chainError, chainError);
      assert.equal(error.execution.channel, 'test');
      assert.equal(error.execution.sourceSlot, 41);
      assert.equal(error.execution.confirmedSlot, 43);
      assert.equal(error.execution.slotLag, 2);
      return true;
    },
  );
});

test('confirmation watcher reports chain failures and timeouts as structured results', async () => {
  const executor = new TradeExecutor(executorConfig());
  const chainError = { InstructionError: [2, { Custom: 6004 }] };
  executor.rpc = {
    getSignatureStatuses: async () => ({
      value: [{ err: chainError, slot: 99, confirmationStatus: 'processed' }],
    }),
  };
  const failed = await executor._watchConfirmation('failed-signature');
  assert.equal(failed.status, 'failed');
  assert.deepEqual(failed.error, chainError);
  assert.equal(failed.slot, 99);

  executor.config.execution.confirmationTimeoutMs = 2;
  executor.config.execution.confirmationPollMs = 1;
  executor.rpc = {
    getSignatureStatuses: async () => ({ value: [null] }),
  };
  const timedOut = await executor._watchConfirmation('timeout-signature');
  assert.equal(timedOut.status, 'timeout');
  assert.equal(timedOut.pollError, null);
});

test('trailing take-profit quotes the full bonding-curve position without submitting', async () => {
  const executor = new TradeExecutor(executorConfig());
  executor.keypair = Keypair.generate();
  let submitted = false;
  executor.curveSdk = {
    fetchSellState: async () => ({ bondingCurve: curveState() }),
  };
  executor.curveMath = {
    sell: () => new BN('180000000'),
  };
  executor._curveStaticState = async () => ({ global: {}, feeConfig: {} });
  executor._buildAndSubmit = async () => { submitted = true; return {}; };

  const quote = await executor.quoteSell({
    sourceWallet: 'source-wallet',
    mint: MINT,
    venue: 'PUMP_CURVE',
    tokenProgram: TOKEN_2022,
    tokenAmountRaw: '1000',
  });
  assert.equal(quote.success, true);
  assert.equal(quote.venue, 'PUMP_CURVE');
  assert.equal(quote.expectedSolLamports, '180000000');
  assert.equal(quote.tokenProgram, TOKEN_2022);
  assert.equal(submitted, false);
});

test('position inspection distinguishes a closed ATA from a zero-balance ATA', async () => {
  const executor = new TradeExecutor(executorConfig());
  executor.keypair = Keypair.generate();
  const tokenProgram = new PublicKey(TOKEN_2022);
  let responses = [{ owner: tokenProgram }, null];
  executor.quoteRpc = {
    getAccountInfo: async () => responses.shift(),
  };

  const missing = await executor.inspectPosition({ mint: MINT });
  assert.equal(missing.success, true);
  assert.equal(missing.status, 'missing');
  assert.equal(missing.actualTokenAmountRaw, '0');

  const tokenData = Buffer.alloc(165);
  tokenData.writeBigUInt64LE(0n, 64);
  responses = [{ owner: tokenProgram }, { owner: tokenProgram, data: tokenData }];
  const empty = await executor.inspectPosition({ mint: MINT });
  assert.equal(empty.success, true);
  assert.equal(empty.status, 'empty');
  assert.equal(empty.actualTokenAmountRaw, '0');
});
