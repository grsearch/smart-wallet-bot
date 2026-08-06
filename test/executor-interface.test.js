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
