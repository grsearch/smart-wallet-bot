'use strict';

const elements = Object.fromEntries([
  'modePill', 'modeText', 'lastUpdated', 'openPositions', 'totalInvested',
  'realizedPnl', 'trackedSignals', 'submittedSignals', 'failedSignals',
  'positionsBody', 'positionMeta', 'serviceOrb', 'serviceStatus', 'uptime',
  'buySize', 'sellMode', 'trailingTakeProfit', 'maxExposure', 'regionCount', 'regionList',
  'senderCount', 'senderList', 'walletList', 'activityList', 'footerClock', 'errorToast',
].map((id) => [id, document.getElementById(id)]));

const number = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 6 });
const REFRESH_INTERVAL_MS = 1000;
let refreshTimer = null;
let errorTimer = null;
let refreshInFlight = false;

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function short(value, front = 6, back = 5) {
  const text = String(value || '?');
  return text.length > front + back + 2 ? `${text.slice(0, front)}?${text.slice(-back)}` : text;
}

function gmgnTokenUrl(mint) {
  return `https://gmgn.ai/sol/token/${encodeURIComponent(String(mint || ''))}`;
}

function reasonLabel(reason) {
  const labels = {
    already_closed: 'already_closed ? ???????',
    buy_failed_no_position: 'buy_failed_no_position ? ??????',
    buy_skipped_no_position: 'buy_skipped_no_position ? ???????',
    no_copy_history: 'no_copy_history ? ??????',
    ata_missing: 'ata_missing ? ?????????',
    ata_balance_zero: 'ata_balance_zero ? ??????? 0',
  };
  return labels[reason] || reason;
}

function formatSol(value, digits = 4) {
  const numeric = Number(value || 0);
  return Number.isFinite(numeric) ? numeric.toFixed(digits) : '0.0000';
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
  if (!timestamp) return '?';
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (seconds < 60) return `${seconds}s ?`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ?`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ?`;
  return `${Math.floor(hours / 24)}d ?`;
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

function showError(message) {
  elements.errorToast.textContent = message;
  elements.errorToast.classList.add('show');
  clearTimeout(errorTimer);
  errorTimer = setTimeout(() => elements.errorToast.classList.remove('show'), 4000);
}

function regionTitle(stream) {
  const value = `${stream.label} ${stream.endpointHost}`.toLowerCase();
  if (value.includes('lax')) return 'LAX ? LOS ANGELES';
  if (value.includes('slc')) return 'SLC ? SALT LAKE CITY';
  if (value.includes('ewr')) return 'EWR ? NEWARK';
  return String(stream.label || 'REGION').toUpperCase();
}

function renderMode(data) {
  const running = data.runtime.status === 'running';
  const live = data.runtime.mode === 'LIVE';
  elements.modePill.className = `live-pill ${running ? (live ? '' : 'dry') : 'offline'}`;
  elements.modeText.textContent = running ? data.runtime.mode : data.runtime.status.toUpperCase();
  elements.serviceOrb.className = `status-orb ${running ? '' : 'offline'}`;
  elements.serviceStatus.textContent = running ? 'ONLINE' : data.runtime.status.toUpperCase();
  elements.lastUpdated.textContent = `??? ${new Date(data.generatedAt).toLocaleTimeString('zh-CN', { hour12: false })}`;
  elements.footerClock.textContent = new Date(data.generatedAt).toLocaleString('zh-CN', { hour12: false });
}

function renderMetrics(data) {
  elements.openPositions.textContent = data.stats.openPositions;
  elements.totalInvested.textContent = formatSol(data.stats.totalInvestedSol);
  const pnl = Number(data.stats.estimatedRealizedPnlSol || 0);
  elements.realizedPnl.textContent = `${pnl > 0 ? '+' : ''}${formatSol(pnl)} SOL`;
  elements.realizedPnl.className = pnl > 0 ? 'positive' : pnl < 0 ? 'negative' : '';
  elements.trackedSignals.textContent = data.stats.trackedSignals24h;
  elements.submittedSignals.textContent = data.stats.submittedSignals;
  elements.failedSignals.textContent = data.stats.failedSignals;
}

function renderPositions(data) {
  elements.positionMeta.textContent = `${data.positions.length} OPEN ? ${formatSol(data.stats.totalInvestedSol)} SOL`;
  if (!data.positions.length) {
    elements.positionsBody.innerHTML = '<tr><td colspan="7" class="empty-cell">???????????????????????</td></tr>';
    return;
  }
  elements.positionsBody.innerHTML = data.positions.map((position) => {
    const trailing = position.trailingTakeProfit;
    const trailingSettings = data.configuration.trailingTakeProfit;
    const trailingLabel = !trailingSettings?.enabled
      ? '??'
      : trailing?.active
        ? `??? ? ?? ${formatSol(trailing.peakValueSol)} SOL`
        : `?? +${trailingSettings.activationPercent ?? 80}%`;
    return `<tr>
      <td><div class="token-cell"><span class="token-icon">${escapeHtml(String(position.mint || '?').slice(0, 2).toUpperCase())}</span><div><a class="address" href="${gmgnTokenUrl(position.mint)}" target="_blank" rel="noreferrer">${escapeHtml(short(position.mint))}</a><span class="sub-address">SRC ${escapeHtml(short(position.sourceWallet, 5, 4))}</span></div></div></td>
      <td><span class="venue-tag">${escapeHtml(position.venue || 'UNKNOWN')}</span></td>
      <td class="mono">${escapeHtml(formatToken(position.tokenAmountRaw, position.decimals))}</td>
      <td class="mono">${formatSol(position.investedSol)} SOL</td>
      <td class="mono">${escapeHtml(trailingLabel)}</td>
      <td class="mono">${escapeHtml(position.buyCount || 0)}</td>
      <td class="mono">${escapeHtml(formatAge(position.updatedAt))}</td>
    </tr>`;
  }).join('');
}

function renderRuntime(data) {
  elements.uptime.textContent = formatDuration(data.runtime.uptimeMs);
  elements.buySize.textContent = `${formatSol(data.configuration.buySol, 3)} SOL`;
  elements.sellMode.textContent = data.configuration.sellMode === 'FULL' ? '??????' : '?????';
  const trailing = data.configuration.trailingTakeProfit;
  elements.trailingTakeProfit.textContent = trailing?.enabled
    ? `+${trailing.activationPercent}% ? ?? ${trailing.drawdownPercent}%`
    : '??';
  elements.maxExposure.textContent = `${formatSol(data.configuration.maxTotalSol, 2)} SOL`;
  const connected = data.streams.filter((stream) => stream.status === 'connected').length;
  elements.regionCount.textContent = `${connected} / ${data.streams.length}`;
  elements.regionList.innerHTML = data.streams.length ? data.streams.map((stream) => `
    <div class="region-row ${stream.status === 'connected' ? 'connected' : ''}">
      <span class="region-dot"></span>
      <span class="region-name">${escapeHtml(regionTitle(stream))}</span>
      <span class="region-detail">${escapeHtml(stream.status.toUpperCase())}<br>${stream.lastMessageAt ? escapeHtml(formatAge(stream.lastMessageAt)) : 'NO DATA'}</span>
    </div>`).join('') : '<div class="region-placeholder">??? LaserStream</div>';
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
      <span class="region-detail">${escapeHtml(String(status || 'WAITING').toUpperCase())}<br>${latency != null ? `${escapeHtml(latency)} ms ? ` : ''}${escapeHtml(channel.successes || 0)} OK / ${escapeHtml(channel.failures || 0)} FAIL</span>
    </div>`;
  }).join('') : '<div class="region-placeholder">?????????</div>';
  elements.walletList.innerHTML = data.configuration.trackedWallets
    .map((wallet) => `<span class="wallet-chip" title="${escapeHtml(wallet)}">${escapeHtml(wallet)}</span>`)
    .join('');
}

function activityAmount(item) {
  if (item.kind === 'BUY' && item.buySol != null) return `${formatSol(item.buySol)} SOL`;
  if (item.kind === 'SELL' && item.estimatedProceedsSol != null) return `? ${formatSol(item.estimatedProceedsSol)} SOL`;
  return reasonLabel(item.reason) || item.error || '?';
}

function renderActivity(data) {
  if (!data.activity.length) {
    elements.activityList.innerHTML = '<div class="empty-activity">??????????????????????</div>';
    return;
  }
  elements.activityList.innerHTML = data.activity.map((item) => {
    const kindClass = item.kind.toLowerCase();
    const signature = item.copySignature || item.sourceSignature;
    const routeLabel = [item.channel, reasonLabel(item.reason)].filter(Boolean).join(' ? ') || item.error || 'LOCAL';
    const signatureView = signature
      ? `<a href="https://solscan.io/tx/${escapeHtml(signature)}" target="_blank" rel="noreferrer">${escapeHtml(short(signature, 7, 5))}</a>`
      : '<strong>NO SIGNATURE</strong>';
    const mintView = item.mint
      ? `<a class="token-link" href="${gmgnTokenUrl(item.mint)}" target="_blank" rel="noreferrer">${escapeHtml(short(item.mint, 7, 5))}</a>`
      : '<strong>UNKNOWN MINT</strong>';
    return `<div class="activity-row">
      <span class="activity-time">${escapeHtml(new Date(item.timestamp).toLocaleTimeString('zh-CN', { hour12: false }))}</span>
      <span class="activity-kind ${kindClass}">${escapeHtml(item.kind)}</span>
      <div class="activity-main">${mintView}<span>${escapeHtml(item.venue || 'UNKNOWN')} ? ${escapeHtml(short(item.sourceWallet, 5, 4))}</span></div>
      <div class="activity-copy">${signatureView}<span>${escapeHtml(routeLabel)}</span></div>
      <div class="activity-amount">${escapeHtml(activityAmount(item))}<span>${item.latencyMs != null ? `${escapeHtml(item.latencyMs)} ms` : ''}</span></div>
    </div>`;
  }).join('');
}

async function refresh() {
  if (refreshInFlight) return false;
  refreshInFlight = true;
  try {
    const response = await fetch('/api/dashboard', { cache: 'no-store' });
    if (!response.ok) throw new Error(`Dashboard API ${response.status}`);
    const data = await response.json();
    renderMode(data);
    renderMetrics(data);
    renderPositions(data);
    renderRuntime(data);
    renderActivity(data);
    return true;
  } catch (error) {
    elements.modePill.className = 'live-pill offline';
    elements.modeText.textContent = 'DISCONNECTED';
    showError(`??????????${error.message}`);
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

refresh().finally(() => schedule());
