'use strict';

const elements = Object.fromEntries([
  'modePill', 'modeText', 'lastUpdated', 'openPositions', 'totalInvested',
  'totalRealizedPnl', 'todayRealizedPnl', 'trackedSignals', 'submittedSignals', 'failedSignals',
  'positionsBody', 'positionMeta', 'serviceOrb', 'serviceStatus', 'uptime',
  'buySize', 'sellMode', 'trailingTakeProfit', 'maxExposure', 'regionCount', 'regionList',
  'senderCount', 'senderList', 'walletList', 'walletStatsBody', 'walletStatsMeta',
  'activityList', 'footerClock', 'errorToast',
].map((id) => [id, document.getElementById(id)]));

const number = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 6 });
const REFRESH_INTERVAL_MS = 1000;
let refreshTimer = null;
let errorTimer = null;
let refreshInFlight = false;
const closingPositions = new Set();

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function short(value, front = 6, back = 5) {
  const text = String(value || '\u2014');
  return text.length > front + back + 2 ? `${text.slice(0, front)}\u2026${text.slice(-back)}` : text;
}

function gmgnTokenUrl(mint) {
  return `https://gmgn.ai/sol/token/${encodeURIComponent(String(mint || ''))}`;
}

function reasonLabel(reason) {
  const labels = {
    MANUAL_DASHBOARD: 'MANUAL_DASHBOARD \u00b7 \u624b\u52a8\u5e73\u4ed3',
    already_closed: 'already_closed \u00b7 \u9996\u7b14\u5356\u51fa\u5df2\u6e05\u4ed3',
    buy_failed_no_position: 'buy_failed_no_position \u00b7 \u524d\u5e8f\u4e70\u5165\u5931\u8d25',
    buy_skipped_no_position: 'buy_skipped_no_position \u00b7 \u524d\u5e8f\u4e70\u5165\u88ab\u8df3\u8fc7',
    first_buy_already_copied: 'first_buy_already_copied \u00b7 \u672c\u8f6e\u5df2\u8ddf\u9996\u7b14\u4e70\u5165',
    no_copy_history: 'no_copy_history \u00b7 \u6ca1\u6709\u8ddf\u4e70\u8bb0\u5f55',
    ata_missing: 'ata_missing \u00b7 \u94fe\u4e0a\u4ee3\u5e01\u8d26\u6237\u5df2\u5173\u95ed',
    ata_balance_zero: 'ata_balance_zero \u00b7 \u94fe\u4e0a\u4ee3\u5e01\u4f59\u989d\u4e3a 0',
  };
  return labels[reason] || reason;
}

function formatSol(value, digits = 4) {
  const numeric = Number(value || 0);
  return Number.isFinite(numeric) ? numeric.toFixed(digits) : '0.0000';
}

function formatSignedSol(value) {
  const numeric = Number(value || 0);
  return `${numeric > 0 ? '+' : ''}${formatSol(numeric)} SOL`;
}

function profitClass(value) {
  const numeric = Number(value || 0);
  return numeric > 0 ? 'positive' : numeric < 0 ? 'negative' : '';
}

function formatWinRate(value) {
  return Number.isFinite(value) ? `${value.toFixed(1)}%` : '\u2014';
}

function formatToken(raw, decimals = 0) {
  try {
    const divisor = 10n ** BigInt(decimals || 0);
    const amount = BigInt(raw || '0');
    const whole = amount / divisor;
    const fraction = (amount % divisor).toString().padStart(decimals || 0, '0').slice(0, 4);
    return number.format(Number(whole)) + (fraction && Number(fraction) ? `.${fraction}` : '');
  } catch (_) {
    return raw || '0';
  }
}

function formatAge(timestamp) {
  if (!timestamp) return '\u2014';
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (seconds < 60) return `${seconds}s \u524d`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m \u524d`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h \u524d`;
  return `${Math.floor(hours / 24)}d \u524d`;
}

function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.floor((ms || 0) / 1000));
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  if (days) return `${days}d ${hours}h`;
  if (hours) return `${hours}h ${minutes}m`;
  return `${minutes}m ${totalSeconds % 60}s`;
}

function showNotice(message, kind = 'error') {
  elements.errorToast.textContent = message;
  elements.errorToast.classList.toggle('success', kind === 'success');
  elements.errorToast.classList.add('show');
  clearTimeout(errorTimer);
  errorTimer = setTimeout(() => {
    elements.errorToast.classList.remove('show', 'success');
  }, 5000);
}

function showError(message) {
  showNotice(message, 'error');
}

function regionTitle(stream) {
  const value = `${stream.label} ${stream.endpointHost}`.toLowerCase();
  if (value.includes('lax')) return 'LAX \u00b7 LOS ANGELES';
  if (value.includes('slc')) return 'SLC \u00b7 SALT LAKE CITY';
  if (value.includes('ewr')) return 'EWR \u00b7 NEWARK';
  return String(stream.label || 'REGION').toUpperCase();
}

function renderMode(data) {
  const running = data.runtime.status === 'running';
  const live = data.runtime.mode === 'LIVE';
  elements.modePill.className = `live-pill ${running ? (live ? '' : 'dry') : 'offline'}`;
  elements.modeText.textContent = running ? data.runtime.mode : data.runtime.status.toUpperCase();
  elements.serviceOrb.className = `status-orb ${running ? '' : 'offline'}`;
  elements.serviceStatus.textContent = running ? 'ONLINE' : data.runtime.status.toUpperCase();
  elements.lastUpdated.textContent = `\u66f4\u65b0\u4e8e ${new Date(data.generatedAt).toLocaleTimeString('zh-CN', { hour12: false })}`;
  elements.footerClock.textContent = new Date(data.generatedAt).toLocaleString('zh-CN', { hour12: false });
}

function renderMetrics(data) {
  elements.openPositions.textContent = data.stats.openPositions;
  elements.totalInvested.textContent = formatSol(data.stats.totalInvestedSol);
  const totalPnl = Number(data.stats.estimatedRealizedPnlSol || 0);
  const todayPnl = Number(data.stats.estimatedRealizedPnlTodaySol || 0);
  elements.totalRealizedPnl.textContent = formatSignedSol(totalPnl);
  elements.totalRealizedPnl.className = profitClass(totalPnl);
  elements.todayRealizedPnl.textContent = formatSignedSol(todayPnl);
  elements.todayRealizedPnl.className = profitClass(todayPnl);
  elements.trackedSignals.textContent = data.stats.trackedSignals24h;
  elements.submittedSignals.textContent = data.stats.submittedSignals;
  elements.failedSignals.textContent = data.stats.failedSignals;
}

function renderPositions(data) {
  elements.positionMeta.textContent = `${data.positions.length} OPEN \u00b7 ${formatSol(data.stats.totalInvestedSol)} SOL`;
  if (!data.positions.length) {
    elements.positionsBody.innerHTML = '<tr><td colspan="8" class="empty-cell">\u6682\u65e0\u590d\u5236\u4ed3\u4f4d\uff0c\u673a\u5668\u4eba\u6b63\u5728\u7b49\u5f85\u806a\u660e\u94b1\u5305\u4e70\u5165\u4fe1\u53f7\u3002</td></tr>';
    return;
  }
  elements.positionsBody.innerHTML = data.positions.map((position) => {
    const trailing = position.trailingTakeProfit;
    const trailingSettings = data.configuration.trailingTakeProfit;
    const trailingLabel = !trailingSettings?.enabled
      ? '\u5173\u95ed'
      : trailing?.active
        ? `\u5df2\u6fc0\u6d3b \u00b7 \u5cf0\u503c ${formatSol(trailing.peakValueSol)} SOL`
        : `\u7b49\u5f85 +${trailingSettings.activationPercent ?? 80}%`;
    const closeKey = `${position.sourceWallet}:${position.mint}`;
    const closing = closingPositions.has(closeKey);
    return `<tr>
      <td><div class="token-cell"><span class="token-icon">${escapeHtml(String(position.mint || '?').slice(0, 2).toUpperCase())}</span><div><a class="address" href="${gmgnTokenUrl(position.mint)}" target="_blank" rel="noreferrer">${escapeHtml(short(position.mint))}</a><span class="sub-address">SRC ${escapeHtml(short(position.sourceWallet, 5, 4))}</span></div></div></td>
      <td><span class="venue-tag">${escapeHtml(position.venue || 'UNKNOWN')}</span></td>
      <td class="mono">${escapeHtml(formatToken(position.tokenAmountRaw, position.decimals))}</td>
      <td class="mono">${formatSol(position.investedSol)} SOL</td>
      <td class="mono">${escapeHtml(trailingLabel)}</td>
      <td class="mono">${escapeHtml(position.buyCount || 0)}</td>
      <td class="mono">${escapeHtml(formatAge(position.updatedAt))}</td>
      <td><button class="close-position-button" type="button" data-source-wallet="${escapeHtml(position.sourceWallet)}" data-mint="${escapeHtml(position.mint)}" ${closing ? 'disabled' : ''}>${closing ? '\u5e73\u4ed3\u4e2d\u2026' : '\u624b\u52a8\u5e73\u4ed3'}</button></td>
    </tr>`;
  }).join('');
}

async function closePosition(button) {
  const sourceWallet = button.dataset.sourceWallet;
  const mint = button.dataset.mint;
  if (!sourceWallet || !mint) return;
  const key = `${sourceWallet}:${mint}`;
  if (closingPositions.has(key)) return;
  const confirmed = window.confirm(
    `\u786e\u8ba4\u7acb\u5373\u5356\u51fa ${short(mint)} \u7684\u5168\u90e8\u6301\u4ed3\u5417\uff1f\n\n\u8fd9\u4f1a\u53d1\u9001\u771f\u5b9e\u94fe\u4e0a\u4ea4\u6613\uff0c\u6210\u4ea4\u540e\u65e0\u6cd5\u64a4\u9500\u3002`,
  );
  if (!confirmed) return;

  closingPositions.add(key);
  button.disabled = true;
  button.textContent = '\u5e73\u4ed3\u4e2d\u2026';
  try {
    const response = await fetch('/api/positions/close', {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sourceWallet, mint }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
    showNotice(
      payload.copySignature
        ? `\u5e73\u4ed3\u5df2\u786e\u8ba4\uff1a${short(payload.copySignature, 7, 5)}`
        : '\u5e73\u4ed3\u4ea4\u6613\u5df2\u786e\u8ba4',
      'success',
    );
  } catch (error) {
    showError(`\u624b\u52a8\u5e73\u4ed3\u5931\u8d25\uff1a${error.message}`);
  } finally {
    closingPositions.delete(key);
    await refresh();
  }
}

function renderRuntime(data) {
  elements.uptime.textContent = formatDuration(data.runtime.uptimeMs);
  elements.buySize.textContent = `${formatSol(data.configuration.buySol, 3)} SOL`;
  elements.sellMode.textContent = data.configuration.sellMode === 'FULL' ? '\u9996\u7b14\u5356\u51fa\u6e05\u4ed3' : '\u6309\u6bd4\u4f8b\u8ddf\u5356';
  const trailing = data.configuration.trailingTakeProfit;
  elements.trailingTakeProfit.textContent = trailing?.enabled
    ? `+${trailing.activationPercent}% \u00b7 \u56de\u64a4 ${trailing.drawdownPercent}%`
    : '\u5173\u95ed';
  elements.maxExposure.textContent = `${formatSol(data.configuration.maxTotalSol, 2)} SOL`;
  const connected = data.streams.filter((stream) => stream.status === 'connected').length;
  elements.regionCount.textContent = `${connected} / ${data.streams.length}`;
  elements.regionList.innerHTML = data.streams.length ? data.streams.map((stream) => `
    <div class="region-row ${stream.status === 'connected' ? 'connected' : ''}">
      <span class="region-dot"></span>
      <span class="region-name">${escapeHtml(regionTitle(stream))}</span>
      <span class="region-detail">${escapeHtml(stream.status.toUpperCase())}<br>${stream.lastMessageAt ? escapeHtml(formatAge(stream.lastMessageAt)) : 'NO DATA'}</span>
    </div>`).join('') : '<div class="region-placeholder">\u672a\u914d\u7f6e LaserStream</div>';
  const channels = data.submissionChannels || [];
  const readyChannels = channels.filter((channel) => (
    channel.attempts > 0
      ? channel.lastStatus === 'success'
      : channel.healthStatus === 'connected'
  )).length;
  elements.senderCount.textContent = `${readyChannels} / ${channels.length}`;
  elements.senderList.innerHTML = channels.length ? channels.map((channel) => {
    const ready = channel.attempts > 0
      ? channel.lastStatus === 'success'
      : channel.healthStatus === 'connected';
    const status = channel.attempts > 0 ? channel.lastStatus : channel.healthStatus;
    const latency = channel.lastLatencyMs ?? channel.healthLatencyMs;
    return `<div class="region-row ${ready ? 'connected' : ''}">
      <span class="region-dot"></span>
      <span class="region-name">${escapeHtml(channel.channel)}</span>
      <span class="region-detail">${escapeHtml(String(status || 'WAITING').toUpperCase())}<br>${latency != null ? `${escapeHtml(latency)} ms \u00b7 ` : ''}${escapeHtml(channel.successes || 0)} OK / ${escapeHtml(channel.failures || 0)} FAIL</span>
    </div>`;
  }).join('') : '<div class="region-placeholder">\u672a\u914d\u7f6e\u4ea4\u6613\u53d1\u9001\u901a\u9053</div>';
  elements.walletList.innerHTML = data.configuration.trackedWallets
    .map((wallet) => `<span class="wallet-chip" title="${escapeHtml(wallet)}">${escapeHtml(wallet)}</span>`)
    .join('');
}

function renderWalletStatistics(data) {
  const stats = data.smartWalletStats;
  if (!stats) {
    elements.walletStatsMeta.textContent = '\u7b49\u5f85\u7edf\u8ba1\u6570\u636e';
    elements.walletStatsBody.innerHTML = '<tr><td colspan="6" class="empty-cell">\u6682\u65e0\u94b1\u5305\u7edf\u8ba1\u6570\u636e\u3002</td></tr>';
    return;
  }
  elements.walletStatsMeta.textContent = `\u5317\u4eac\u65f6\u95f4 ${stats.dayKey} 00:00 \u8d77`;
  if (!stats.wallets.length) {
    elements.walletStatsBody.innerHTML = '<tr><td colspan="6" class="empty-cell">\u672a\u914d\u7f6e\u806a\u660e\u94b1\u5305\u3002</td></tr>';
    return;
  }
  elements.walletStatsBody.innerHTML = stats.wallets.map((wallet) => `
    <tr>
      <td><a class="wallet-address" href="https://gmgn.ai/sol/address/${encodeURIComponent(wallet.address)}" target="_blank" rel="noreferrer">${escapeHtml(wallet.address)}</a></td>
      <td class="wallet-stat-cell"><strong>${escapeHtml(wallet.totalTransactions)}</strong><span>\u4e70 ${escapeHtml(wallet.totalBuys)} \u00b7 \u5356 ${escapeHtml(wallet.totalSells)}</span></td>
      <td class="wallet-stat-cell ${profitClass(wallet.totalRealizedPnlSol)}"><strong>${escapeHtml(formatSignedSol(wallet.totalRealizedPnlSol))}</strong><span>\u5df2\u5b9e\u73b0</span></td>
      <td class="wallet-stat-cell"><strong>${escapeHtml(wallet.todayTransactions)}</strong><span>\u4e70 ${escapeHtml(wallet.todayBuys)} \u00b7 \u5356 ${escapeHtml(wallet.todaySells)}</span></td>
      <td class="wallet-stat-cell ${profitClass(wallet.todayRealizedPnlSol)}"><strong>${escapeHtml(formatSignedSol(wallet.todayRealizedPnlSol))}</strong><span>\u5df2\u5b9e\u73b0</span></td>
      <td class="wallet-stat-cell"><strong>${escapeHtml(formatWinRate(wallet.totalWinRate))}</strong><span>\u4eca\u65e5 ${escapeHtml(formatWinRate(wallet.todayWinRate))}</span></td>
    </tr>`).join('');
}

function activityAmount(item) {
  if (item.kind === 'BUY' && item.buySol != null) return `${formatSol(item.buySol)} SOL`;
  if (item.kind === 'SELL' && item.estimatedProceedsSol != null) return `\u2248 ${formatSol(item.estimatedProceedsSol)} SOL`;
  return reasonLabel(item.reason) || item.error || '\u2014';
}

function executionSpeedLabel(item) {
  const parts = [];
  const submitMs = item.detectedToSubmittedMs ?? item.latencyMs;
  if (submitMs != null) parts.push(`${submitMs} ms`);
  if (item.slotLag != null) {
    parts.push(item.slotLag === 0 ? '\u540c SLOT' : `SLOT ${item.slotLag > 0 ? '+' : ''}${item.slotLag}`);
  }
  return parts.join(' \u00b7 ');
}

function renderActivity(data) {
  if (!data.activity.length) {
    elements.activityList.innerHTML = '<div class="empty-activity">\u6682\u65e0\u4ea4\u6613\u8bb0\u5f55\u3002\u7b2c\u4e00\u7b14\u8ddf\u5355\u6267\u884c\u540e\u4f1a\u663e\u793a\u5728\u8fd9\u91cc\u3002</div>';
    return;
  }
  elements.activityList.innerHTML = data.activity.map((item) => {
    const kindClass = item.kind.toLowerCase();
    const signature = item.copySignature || item.sourceSignature;
    const routeLabel = [item.channel, reasonLabel(item.reason)].filter(Boolean).join(' \u00b7 ') || item.error || 'LOCAL';
    const signatureView = signature
      ? `<a href="https://solscan.io/tx/${escapeHtml(signature)}" target="_blank" rel="noreferrer">${escapeHtml(short(signature, 7, 5))}</a>`
      : '<strong>NO SIGNATURE</strong>';
    const mintView = item.mint
      ? `<a class="token-link" href="${gmgnTokenUrl(item.mint)}" target="_blank" rel="noreferrer">${escapeHtml(short(item.mint, 7, 5))}</a>`
      : '<strong>UNKNOWN MINT</strong>';
    return `<div class="activity-row">
      <span class="activity-time">${escapeHtml(new Date(item.timestamp).toLocaleTimeString('zh-CN', { hour12: false }))}</span>
      <span class="activity-kind ${kindClass}">${escapeHtml(item.kind)}</span>
      <div class="activity-main">${mintView}<span>${escapeHtml(item.venue || 'UNKNOWN')} \u00b7 ${escapeHtml(short(item.sourceWallet, 5, 4))}</span></div>
      <div class="activity-copy">${signatureView}<span>${escapeHtml(routeLabel)}</span></div>
      <div class="activity-amount">${escapeHtml(activityAmount(item))}<span>${escapeHtml(executionSpeedLabel(item))}</span></div>
    </div>`;
  }).join('');
}

async function refresh() {
  if (refreshInFlight) return false;
  refreshInFlight = true;
  try {
    const response = await fetch('/api/dashboard', {
      cache: 'no-store',
      credentials: 'same-origin',
    });
    if (!response.ok) throw new Error(`Dashboard API ${response.status}`);
    const data = await response.json();
    renderMode(data);
    renderMetrics(data);
    renderPositions(data);
    renderRuntime(data);
    renderWalletStatistics(data);
    renderActivity(data);
    return true;
  } catch (error) {
    elements.modePill.className = 'live-pill offline';
    elements.modeText.textContent = 'DISCONNECTED';
    showError(`\u65e0\u6cd5\u8bfb\u53d6\u673a\u5668\u4eba\u72b6\u6001\uff1a${error.message}`);
    return false;
  } finally {
    refreshInFlight = false;
  }
}

function schedule(delay = REFRESH_INTERVAL_MS) {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(async () => {
    if (!document.hidden) await refresh();
    schedule();
  }, delay);
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) refresh().finally(() => schedule());
});
window.addEventListener('online', () => refresh().finally(() => schedule()));
elements.positionsBody.addEventListener('click', (event) => {
  const button = event.target.closest('.close-position-button');
  if (button && elements.positionsBody.contains(button)) closePosition(button);
});

refresh().finally(() => schedule());
