'use strict';

const elements = Object.fromEntries([
  'modePill', 'modeText', 'lastUpdated', 'openPositions', 'totalInvested',
  'realizedPnl', 'trackedSignals', 'submittedSignals', 'failedSignals',
  'positionsBody', 'positionMeta', 'serviceOrb', 'serviceStatus', 'uptime',
  'buySize', 'sellMode', 'maxExposure', 'regionCount', 'regionList',
  'walletList', 'activityList', 'footerClock', 'errorToast',
].map((id) => [id, document.getElementById(id)]));

const number = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 6 });
let refreshTimer = null;
let errorTimer = null;

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function short(value, front = 6, back = 5) {
  const text = String(value || '—');
  return text.length > front + back + 2 ? `${text.slice(0, front)}…${text.slice(-back)}` : text;
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
  if (!timestamp) return '—';
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (seconds < 60) return `${seconds}s 前`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m 前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h 前`;
  return `${Math.floor(hours / 24)}d 前`;
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
  if (value.includes('lax')) return 'LAX · LOS ANGELES';
  if (value.includes('slc')) return 'SLC · SALT LAKE CITY';
  if (value.includes('ewr')) return 'EWR · NEWARK';
  return String(stream.label || 'REGION').toUpperCase();
}

function renderMode(data) {
  const running = data.runtime.status === 'running';
  const live = data.runtime.mode === 'LIVE';
  elements.modePill.className = `live-pill ${running ? (live ? '' : 'dry') : 'offline'}`;
  elements.modeText.textContent = running ? data.runtime.mode : data.runtime.status.toUpperCase();
  elements.serviceOrb.className = `status-orb ${running ? '' : 'offline'}`;
  elements.serviceStatus.textContent = running ? 'ONLINE' : data.runtime.status.toUpperCase();
  elements.lastUpdated.textContent = `更新于 ${new Date(data.generatedAt).toLocaleTimeString('zh-CN', { hour12: false })}`;
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
  elements.positionMeta.textContent = `${data.positions.length} OPEN · ${formatSol(data.stats.totalInvestedSol)} SOL`;
  if (!data.positions.length) {
    elements.positionsBody.innerHTML = '<tr><td colspan="6" class="empty-cell">暂无复制仓位，机器人正在等待聪明钱包买入信号。</td></tr>';
    return;
  }
  elements.positionsBody.innerHTML = data.positions.map((position) => {
    const mint = escapeHtml(position.mint);
    const wallet = escapeHtml(position.sourceWallet);
    return `<tr>
      <td><div class="token-cell"><span class="token-icon">${escapeHtml(String(position.mint || '?').slice(0, 2).toUpperCase())}</span><div><a class="address" href="https://solscan.io/token/${mint}" target="_blank" rel="noreferrer">${escapeHtml(short(position.mint))}</a><span class="sub-address">SRC ${escapeHtml(short(position.sourceWallet, 5, 4))}</span></div></div></td>
      <td><span class="venue-tag">${escapeHtml(position.venue || 'UNKNOWN')}</span></td>
      <td class="mono">${escapeHtml(formatToken(position.tokenAmountRaw, position.decimals))}</td>
      <td class="mono">${formatSol(position.investedSol)} SOL</td>
      <td class="mono">${escapeHtml(position.buyCount || 0)}</td>
      <td class="mono">${escapeHtml(formatAge(position.updatedAt))}</td>
    </tr>`;
  }).join('');
}

function renderRuntime(data) {
  elements.uptime.textContent = formatDuration(data.runtime.uptimeMs);
  elements.buySize.textContent = `${formatSol(data.configuration.buySol, 3)} SOL`;
  elements.sellMode.textContent = data.configuration.sellMode === 'FULL' ? '首笔卖出清仓' : '按比例跟卖';
  elements.maxExposure.textContent = `${formatSol(data.configuration.maxTotalSol, 2)} SOL`;
  const connected = data.streams.filter((stream) => stream.status === 'connected').length;
  elements.regionCount.textContent = `${connected} / ${data.streams.length}`;
  elements.regionList.innerHTML = data.streams.length ? data.streams.map((stream) => `
    <div class="region-row ${stream.status === 'connected' ? 'connected' : ''}">
      <span class="region-dot"></span>
      <span class="region-name">${escapeHtml(regionTitle(stream))}</span>
      <span class="region-detail">${escapeHtml(stream.status.toUpperCase())}<br>${stream.lastMessageAt ? escapeHtml(formatAge(stream.lastMessageAt)) : 'NO DATA'}</span>
    </div>`).join('') : '<div class="region-placeholder">未配置 LaserStream</div>';
  elements.walletList.innerHTML = data.configuration.trackedWallets
    .map((wallet) => `<span class="wallet-chip" title="${escapeHtml(wallet)}">${escapeHtml(wallet)}</span>`)
    .join('');
}

function activityAmount(item) {
  if (item.kind === 'BUY' && item.buySol != null) return `${formatSol(item.buySol)} SOL`;
  if (item.kind === 'SELL' && item.estimatedProceedsSol != null) return `≈ ${formatSol(item.estimatedProceedsSol)} SOL`;
  return item.reason || item.error || '—';
}

function renderActivity(data) {
  if (!data.activity.length) {
    elements.activityList.innerHTML = '<div class="empty-activity">暂无交易记录。第一笔跟单执行后会显示在这里。</div>';
    return;
  }
  elements.activityList.innerHTML = data.activity.map((item) => {
    const kindClass = item.kind.toLowerCase();
    const signature = item.copySignature || item.sourceSignature;
    const signatureView = signature
      ? `<a href="https://solscan.io/tx/${escapeHtml(signature)}" target="_blank" rel="noreferrer">${escapeHtml(short(signature, 7, 5))}</a>`
      : '<strong>NO SIGNATURE</strong>';
    return `<div class="activity-row">
      <span class="activity-time">${escapeHtml(new Date(item.timestamp).toLocaleTimeString('zh-CN', { hour12: false }))}</span>
      <span class="activity-kind ${kindClass}">${escapeHtml(item.kind)}</span>
      <div class="activity-main"><strong>${escapeHtml(short(item.mint, 7, 5))}</strong><span>${escapeHtml(item.venue || 'UNKNOWN')} · ${escapeHtml(short(item.sourceWallet, 5, 4))}</span></div>
      <div class="activity-copy">${signatureView}<span>${escapeHtml(item.channel || item.reason || item.error || 'LOCAL')}</span></div>
      <div class="activity-amount">${escapeHtml(activityAmount(item))}<span>${item.latencyMs != null ? `${escapeHtml(item.latencyMs)} ms` : ''}</span></div>
    </div>`;
  }).join('');
}

async function refresh() {
  try {
    const response = await fetch('/api/dashboard', { cache: 'no-store' });
    if (!response.ok) throw new Error(`Dashboard API ${response.status}`);
    const data = await response.json();
    renderMode(data);
    renderMetrics(data);
    renderPositions(data);
    renderRuntime(data);
    renderActivity(data);
  } catch (error) {
    elements.modePill.className = 'live-pill offline';
    elements.modeText.textContent = 'DISCONNECTED';
    showError(`无法读取机器人状态：${error.message}`);
  }
}

function schedule() {
  clearInterval(refreshTimer);
  refreshTimer = setInterval(() => {
    if (!document.hidden) refresh();
  }, 2000);
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) refresh();
});

refresh();
schedule();
