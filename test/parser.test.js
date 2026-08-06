'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { PublicKey } = require('@solana/web3.js');
const { SmartWalletParser } = require('../src/SmartWalletParser');

const WALLET = '7yd579zXmWPoxEE22BUYTzAo8nyMmQtPyEWS3g1BFhH4';
const OTHER = '11111111111111111111111111111111';
const PUMP = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const PUMP_AMM = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';
const WSOL = 'So11111111111111111111111111111111111111112';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const MINT = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6QdaEnpP5ZSUXP1B';
const SECOND_MINT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';

const parser = new SmartWalletParser({
  trackedWallets: [WALLET],
  programs: {
    pump: PUMP,
    pumpAmm: PUMP_AMM,
    token: TOKEN,
    token2022: TOKEN_2022,
    wsol: WSOL,
    usdc: USDC,
  },
});

function balance(owner, mint, amount, decimals = 6, accountIndex = 2) {
  return { owner, mint, accountIndex, uiTokenAmount: { amount: String(amount), decimals } };
}

function update({
  owner = WALLET,
  program = PUMP,
  pre = '0',
  post = '1000000',
  extraPre = [],
  extraPost = [],
} = {}) {
  return {
    slot: '123456',
    transaction: {
      signature: Buffer.alloc(64, 7),
      transaction: {
        signatures: [Buffer.alloc(64, 7)],
        message: {
          header: { numRequiredSignatures: 1 },
          accountKeys: [
            new PublicKey(owner).toBuffer(),
            new PublicKey(program).toBuffer(),
            new PublicKey(MINT).toBuffer(),
          ],
        },
      },
      meta: {
        err: null,
        fee: 5000,
        preBalances: [2_000_000_000, 0, 0],
        postBalances: [1_898_000_000, 0, 0],
        preTokenBalances: [balance(owner, MINT, pre), ...extraPre],
        postTokenBalances: [balance(owner, MINT, post), ...extraPost],
        loadedWritableAddresses: [],
        loadedReadonlyAddresses: [],
      },
    },
  };
}

test('parses a tracked Pump bonding-curve buy from wallet token deltas', () => {
  const [trade] = parser.parse(update(), { region: 'test', receivedAt: 100 });
  assert.equal(trade.sourceWallet, WALLET);
  assert.equal(trade.side, 'BUY');
  assert.equal(trade.venue, 'PUMP_CURVE');
  assert.equal(trade.mint, MINT);
  assert.equal(trade.tokenDeltaRaw, '1000000');
  assert.equal(trade.quoteMint, WSOL);
  assert.equal(trade.tokenProgram, TOKEN);
  assert.equal(trade.slot, 123456);
});

test('parses a proportional PumpSwap sell', () => {
  const [trade] = parser.parse(update({ program: PUMP_AMM, pre: '4000000', post: '1000000' }));
  assert.equal(trade.side, 'SELL');
  assert.equal(trade.venue, 'PUMP_SWAP');
  assert.equal(trade.tokenDeltaRaw, '3000000');
  assert.equal(trade.sellBps, 7500);
});

test('ignores a transaction where the tracked wallet did not sign', () => {
  const trades = parser.parse(update({ owner: OTHER }));
  assert.deepEqual(trades, []);
});

test('ignores ambiguous multi-token Pump transactions', () => {
  const trades = parser.parse(update({
    extraPre: [balance(WALLET, SECOND_MINT, '0', 6, 3)],
    extraPost: [balance(WALLET, SECOND_MINT, '2', 6, 3)],
  }));
  assert.deepEqual(trades, []);
});

test('marks USDC-quoted activity so execution can reject it safely', () => {
  const [trade] = parser.parse(update({
    extraPre: [balance(WALLET, USDC, '10000000', 6, 3)],
    extraPost: [balance(WALLET, USDC, '9000000', 6, 3)],
  }));
  assert.equal(trade.quoteMint, USDC);
});
