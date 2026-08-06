'use strict';

const bs58Module = require('bs58');
const bs58 = bs58Module.default || bs58Module;
const { PublicKey } = require('@solana/web3.js');

function keyToBase58(value) {
  if (!value) return null;
  if (typeof value === 'string') return value;
  if (value.pubkey) return keyToBase58(value.pubkey);
  if (typeof value.toBase58 === 'function') return value.toBase58();
  if (Buffer.isBuffer(value) || value instanceof Uint8Array || Array.isArray(value)) {
    return bs58.encode(Uint8Array.from(value));
  }
  return null;
}

function signatureToBase58(value) {
  return keyToBase58(value);
}

function numericSlot(value) {
  if (value == null) return null;
  const slot = Number(value);
  return Number.isFinite(slot) ? slot : null;
}

function rawTokenAmount(balance) {
  const amount = balance?.uiTokenAmount?.amount;
  if (amount == null || !/^\d+$/.test(String(amount))) return 0n;
  return BigInt(amount);
}

function transactionParts(update) {
  if (!update) return null;

  // SmartWalletStream passes msg.transaction. Depending on the Yellowstone
  // client version that object can contain the transaction info directly or
  // one wrapper deeper.
  let info = null;
  if (update.meta && update.transaction) info = update;
  else if (update.transaction?.meta && update.transaction?.transaction) info = update.transaction;
  else if (update.transaction?.transaction?.meta) info = update.transaction.transaction;
  if (!info) return null;

  const wireTransaction = info.transaction;
  const message = wireTransaction?.message;
  if (!message || !info.meta) return null;

  return {
    info,
    meta: info.meta,
    message,
    slot: numericSlot(update.slot ?? info.slot),
  };
}

function allAccountKeys(message, meta) {
  const staticKeys = message.accountKeys || message.staticAccountKeys || [];
  const loaded = meta.loadedAddresses || {};
  const writable = meta.loadedWritableAddresses || loaded.writable || [];
  const readonly = meta.loadedReadonlyAddresses || loaded.readonly || [];
  return [...staticKeys, ...writable, ...readonly]
    .map(keyToBase58)
    .filter(Boolean);
}

function signerKeys(message, keys) {
  const header = message.header || {};
  const required = Number(
    header.numRequiredSignatures ?? header.num_required_signatures ?? 1,
  );
  return keys.slice(0, Number.isFinite(required) && required > 0 ? required : 1);
}

function ownerMintBalances(balances, wallet) {
  const totals = new Map();
  const decimals = new Map();
  for (const balance of balances || []) {
    if (keyToBase58(balance.owner) !== wallet || !balance.mint) continue;
    const mint = keyToBase58(balance.mint) || balance.mint;
    totals.set(mint, (totals.get(mint) || 0n) + rawTokenAmount(balance));
    if (!decimals.has(mint)) decimals.set(mint, balance.uiTokenAmount?.decimals ?? 0);
  }
  return { totals, decimals };
}

function validMint(mint) {
  try {
    new PublicKey(mint);
    return true;
  } catch (_) {
    return false;
  }
}

class SmartWalletParser {
  constructor({ trackedWallets, programs, maxCandidateMints = 1 }) {
    this.trackedWallets = new Set(trackedWallets || []);
    this.programs = programs;
    this.maxCandidateMints = maxCandidateMints;
    this.quoteMints = new Set([programs.wsol, programs.usdc].filter(Boolean));
  }

  parse(update, context = {}) {
    const parts = transactionParts(update);
    if (!parts || parts.meta.err) return [];

    const { info, meta, message, slot } = parts;
    const keys = allAccountKeys(message, meta);
    const signers = signerKeys(message, keys);
    const trackedSigner = signers.find((key) => this.trackedWallets.has(key));
    if (!trackedSigner) return [];

    const keySet = new Set(keys);
    let venue = null;
    if (keySet.has(this.programs.pumpAmm)) venue = 'PUMP_SWAP';
    else if (keySet.has(this.programs.pump)) venue = 'PUMP_CURVE';
    else return [];
    const tokenProgram = keySet.has(this.programs.token2022)
      ? this.programs.token2022
      : this.programs.token;

    const pre = ownerMintBalances(meta.preTokenBalances, trackedSigner);
    const post = ownerMintBalances(meta.postTokenBalances, trackedSigner);
    const usdcDelta = (post.totals.get(this.programs.usdc) || 0n) -
      (pre.totals.get(this.programs.usdc) || 0n);
    const quoteMint = usdcDelta !== 0n ? this.programs.usdc : this.programs.wsol;
    const mints = new Set([...pre.totals.keys(), ...post.totals.keys()]);
    const candidates = [];

    for (const mint of mints) {
      if (this.quoteMints.has(mint) || !validMint(mint)) continue;
      const preRaw = pre.totals.get(mint) || 0n;
      const postRaw = post.totals.get(mint) || 0n;
      const deltaRaw = postRaw - preRaw;
      if (deltaRaw === 0n) continue;
      candidates.push({
        mint,
        preRaw,
        postRaw,
        deltaRaw,
        decimals: post.decimals.get(mint) ?? pre.decimals.get(mint) ?? 0,
      });
    }

    // Pump swaps should change exactly one non-quote token for the signer.
    // Multiple changes are more likely liquidity, routing, or a transfer and
    // are intentionally ignored instead of risking the wrong copy trade.
    if (candidates.length === 0 || candidates.length > this.maxCandidateMints) return [];

    const signature = signatureToBase58(
      info.signature || info.transaction?.signatures?.[0],
    );
    if (!signature) return [];

    const walletIndex = keys.indexOf(trackedSigner);
    const preLamports = walletIndex >= 0 ? Number(meta.preBalances?.[walletIndex]) : NaN;
    const postLamports = walletIndex >= 0 ? Number(meta.postBalances?.[walletIndex]) : NaN;
    const nativeDeltaLamports = Number.isFinite(preLamports) && Number.isFinite(postLamports)
      ? postLamports - preLamports
      : null;

    const detectedAt = Date.now();
    return candidates.map((candidate) => {
      const side = candidate.deltaRaw > 0n ? 'BUY' : 'SELL';
      const absoluteDelta = candidate.deltaRaw < 0n ? -candidate.deltaRaw : candidate.deltaRaw;
      const sellBps = side === 'SELL' && candidate.preRaw > 0n
        ? Number((absoluteDelta * 10_000n) / candidate.preRaw)
        : null;
      return {
        signature,
        slot,
        sourceWallet: trackedSigner,
        venue,
        tokenProgram,
        quoteMint,
        side,
        mint: candidate.mint,
        decimals: candidate.decimals,
        tokenDeltaRaw: absoluteDelta.toString(),
        walletPreTokenRaw: candidate.preRaw.toString(),
        walletPostTokenRaw: candidate.postRaw.toString(),
        sellBps: sellBps == null ? null : Math.max(1, Math.min(10_000, sellBps)),
        smartWalletSolDelta: nativeDeltaLamports == null ? null : nativeDeltaLamports / 1e9,
        approximateSmartBuySol: side === 'BUY' && nativeDeltaLamports != null
          ? Math.max(0, -nativeDeltaLamports / 1e9)
          : null,
        detectedAt,
        receivedAt: context.receivedAt || detectedAt,
        region: context.region || null,
      };
    });
  }
}

module.exports = {
  SmartWalletParser,
  allAccountKeys,
  keyToBase58,
  ownerMintBalances,
  transactionParts,
};
