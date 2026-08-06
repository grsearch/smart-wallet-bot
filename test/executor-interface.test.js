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
    },
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

  const confirmed = await executor._buildAndSubmit([], 'BUY');
  assert.equal(confirmed.confirmationStatus, 'confirmed');
  assert.equal(confirmed.confirmedSlot, 42);
  assert.equal(confirmed.confirmationLatencyMs, 7);

  const chainError = { InstructionError: [3, { Custom: 6002 }] };
  executor._watchConfirmation = async () => ({
    status: 'failed',
    error: chainError,
    slot: 43,
    latencyMs: 9,
  });
  await assert.rejects(
    executor._buildAndSubmit([], 'BUY'),
    (error) => {
      assert.match(error.message, /on-chain failure/);
      assert.equal(error.execution.confirmationStatus, 'failed');
      assert.deepEqual(error.execution.chainError, chainError);
      assert.equal(error.execution.channel, 'test');
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
