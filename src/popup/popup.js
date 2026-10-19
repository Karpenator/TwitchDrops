import {
  formatDateTime,
  formatMinutes,
  formatRelative,
  formatTimeLeft,
} from '../shared/time.js';
import { formatPoints } from '../shared/points-model.js';
import {
  campaignCategoryUrl,
  campaignPlayDisabledReason,
  campaignPool,
  sanitizeImageUrl,
} from '../shared/drops-model.js';
import { INTERVAL_OPTIONS } from '../shared/settings.js';
import { normalizeLogin } from '../shared/twitch-url.js';
import { DROPS_URL, EXTENSION_VERSION } from '../shared/constants.js';

const ICONS = {
  check: '<path d="m5 12.5 4.2 4.2L19 6.8"/>',
  gift: '<path d="M20 8H4v5h16V8Z"/><path d="M12 8v13M4 13v8h16v-8"/><path d="M12 8C10.5 8 7.8 7.7 7.8 5.6A2.1 2.1 0 0 1 12 5a2.1 2.1 0 0 1 4.2.6C16.2 7.7 13.5 8 12 8Z"/>',
  lock: '<rect x="5" y="10" width="14" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
  play: '<path d="M8 5.5v13l10-6.5-10-6.5Z"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7v5l3.5 2"/>',
  external: '<path d="M14 4h6v6M20 4l-9 9"/><path d="M18 13v5.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6H11"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  x: '<path d="m6 6 12 12M18 6 6 18"/>',
  refresh: '<path d="M20 12a8 8 0 1 1-2.34-5.66M20 4v5h-5"/>',
  spark: '<path d="m12 3 2.6 5.7 6.2.6-4.7 4.2 1.4 6.1L12 16.5 6.5 19.6l1.4-6.1L3.2 9.3l6.2-.6L12 3Z"/>',
  user: '<circle cx="12" cy="8" r="3.5"/><path d="M5 20c.7-3.6 3.4-5.5 7-5.5s6.3 1.9 7 5.5"/>',
  info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5M12 8h.01"/>',
  alert: '<path d="M12 4 3 20h18L12 4Z"/><path d="M12 10v4M12 17h.01"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1.3 1.3"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3A4 4 0 0 0 11 18.7l1.3-1.3"/>',
  trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>',
  tv: '<rect x="3" y="6" width="18" height="12" rx="2"/><path d="M8 21h8M12 18v3"/>',
  arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  chevron: '<path d="m9 6 6 6-6 6"/>',
  shield: '<path d="M12 3 5 6v5c0 4.5 3 8 7 10 4-2 7-5.5 7-10V6l-7-3Z"/><path d="m9 12 2 2 4-4"/>',
  chart: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
  bolt: '<path d="M13 2 4 14h6l-1 8 9-12h-6l1-8Z"/>',
};

function icon(name, size = 14) {
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ''}</svg>`;
}

const HTML_ESCAPES = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => HTML_ESCAPES[char]);
}

function attr(value) {
  return esc(value).replace(/`/g, '&#96;');
}

function plural(count, one, few, many) {
  const value = Math.abs(Math.round(Number(count) || 0));
  const mod10 = value % 10;
  const mod100 = value % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

function pct(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Math.max(0, Math.min(100, Math.round(numeric)));
}

function hueFor(name) {
  let hash = 0;
  for (const char of String(name || 'Twitch')) hash = (hash * 31 + char.codePointAt(0)) % 360;
  return hash;
}

function fallbackStyle(name) {
  const hue = hueFor(name);
  return `background:linear-gradient(145deg,hsl(${hue} 55% 38%),hsl(${(hue + 34) % 360} 62% 15%))`;
}

function thumb(imageUrl, name, small = false) {
  const safe = sanitizeImageUrl(imageUrl);
  const initial = esc((String(name || '?').trim().charAt(0) || '?').toUpperCase());
  return `<span class="thumb${small ? ' is-small' : ''}" style="${fallbackStyle(name)}">
    ${safe ? `<img src="${attr(safe)}" alt="" loading="lazy" data-img-fallback />` : ''}
    <span class="thumb-fallback${safe ? ' hidden' : ''}">${initial}</span>
  </span>`;
}

function avatar(imageUrl, name) {
  const safe = sanitizeImageUrl(imageUrl);
  const initial = esc((String(name || '?').trim().charAt(0) || '?').toUpperCase());
  return `<span class="avatar" style="${fallbackStyle(name)}">
    ${safe ? `<img src="${attr(safe)}" alt="" loading="lazy" data-img-fallback />` : ''}
    <span class="thumb-fallback${safe ? ' hidden' : ''}">${initial}</span>
  </span>`;
}

function pill(text, className = '', extra = '') {
  return `<span class="pill ${className}" ${extra}>${text}</span>`;
}

const els = {
  panelDrops: document.getElementById('panel-drops'),
  panelPoints: document.getElementById('panel-points'),
  panelSettings: document.getElementById('panel-settings'),
  tabs: Array.from(document.querySelectorAll('[data-tab]')),
  master: document.getElementById('masterToggle'),
  refreshBtn: document.getElementById('refreshBtn'),
  userBar: document.getElementById('userBar'),
  dropsBadge: document.getElementById('dropsBadge'),
  pointsBadge: document.getElementById('pointsBadge'),
  syncDot: document.getElementById('syncDot'),
  syncText: document.getElementById('syncText'),
  version: document.getElementById('versionLabel'),
  toast: document.getElementById('toast'),
  modal: document.getElementById('modal'),
};

let state = null;
let openTabs = [];
let activeTab = 'drops';
let busy = false;
let toastTimer = null;
let reloadTimer = null;
let autoRefreshDone = false;
const actionLocks = new Set();
let playingCampaignId = null;
let playError = null;

// ---------------------------------------------------------------------------
// Messaging
// ---------------------------------------------------------------------------

async function sendRaw(message) {
  try {
    const response = await chrome.runtime.sendMessage(message);
    return response || { ok: false, error: 'Нет ответа от фонового процесса' };
  } catch (error) {
    return { ok: false, error: String(error?.message || error) };
  }
}

function applyPayload(payload) {
  if (!payload) return;
  if (payload.state) state = payload.state;
  if (Array.isArray(payload.openTabs)) openTabs = payload.openTabs;
  els.version.textContent = `v${payload.version || EXTENSION_VERSION}`;
  render();
}

async function reloadState() {
  const response = await sendRaw({ type: 'GET_STATE' });
  if (response.ok) applyPayload(response);
}

function scheduleReload() {
  if (reloadTimer) return;
  reloadTimer = setTimeout(() => {
    reloadTimer = null;
    reloadState().catch(() => {});
  }, 250);
}

async function refresh(scope = 'all', { silent = false } = {}) {
  if (busy) return;
  busy = true;
  renderChrome();
  const response = await sendRaw({ type: 'REFRESH', scope });
  busy = false;
  if (response.ok) {
    playError = null;
    applyPayload(response);
    const errors = response.errors || {};
    const firstError = errors.drops || errors.points;
    if (firstError) showToast(firstError, 'error', 4500);
    else if (!silent) showToast('Данные обновлены', 'success');
  } else {
    showToast(response.error || 'Не удалось обновить данные', 'error');
  }
  render();
}

async function runAction(type, payload = {}, { success = '', errorPrefix = '' } = {}) {
  const key = `${type}:${payload.login || payload.campaignId || ''}`;
  if (actionLocks.has(key)) return null;
  actionLocks.add(key);
  const response = await sendRaw({ type, ...payload });
  actionLocks.delete(key);
  if (response?.ok) {
    applyPayload(response);
    if (response.warning) showToast(response.warning, 'warn', 4200);
    else if (success) showToast(success, 'success');
    return response;
  }
  showToast(`${errorPrefix}${response?.error || 'Не получилось. Попробуйте ещё раз.'}`, 'error', 4200);
  scheduleReload();
  return response;
}

// ---------------------------------------------------------------------------
// UI helpers
// ---------------------------------------------------------------------------

function showToast(message, kind = '', duration = 3200) {
  if (!message) return;
  clearTimeout(toastTimer);
  els.toast.textContent = message;
  els.toast.className = `toast is-visible${kind ? ` is-${kind}` : ''}`;
  toastTimer = setTimeout(() => {
    els.toast.className = 'toast';
  }, duration);
}

function isAuthenticated() {
  return Boolean(state?.session?.authenticated && state?.user?.login);
}

function allCampaigns() {
  return Array.isArray(state?.drops?.campaigns) ? state.drops.campaigns : [];
}

function totalReady() {
  return campaignPool(state?.drops).reduce((sum, campaign) => sum + (campaign.claimableCount || 0), 0);
}

function totalPoints() {
  return Object.values(state?.points?.channels || {}).reduce((sum, channel) => {
    if (!channel || channel.error) return sum;
    return sum + Math.max(0, Number(channel.balance) || 0);
  }, 0);
}

function bonusReadyCount() {
  return Object.values(state?.points?.channels || {}).filter(
    (channel) => channel?.availableClaimId && !channel.error,
  ).length;
}

function visibleChannels() {
  const channels = Object.values(state?.points?.channels || {});
  return channels
    .filter((channel) => channel && (channel.tracked || channel.open || channel.availableClaimId))
    .sort((a, b) => {
      const aReady = a.availableClaimId ? 1 : 0;
      const bReady = b.availableClaimId ? 1 : 0;
      if (aReady !== bReady) return bReady - aReady;
      if (a.open !== b.open) return a.open ? -1 : 1;
      if (a.tracked !== b.tracked) return a.tracked ? -1 : 1;
      return (b.balance || 0) - (a.balance || 0);
    });
}

function loginHero(message = '') {
  return `<section class="hero">
    <div class="hero-icon">${icon('user', 23)}</div>
    <h2>Подключитесь к Twitch</h2>
    <p>TwitchAutoPilot использует вашу текущую сессию браузера. Войдите на Twitch — токены и настройки останутся только в этом браузере.</p>
    ${message ? `<div class="banner is-error" style="margin-top:12px;text-align:left">${icon('alert', 15)}<div class="banner-main">${esc(message)}</div></div>` : ''}
    <button type="button" class="btn btn-primary" data-action="open-twitch">${icon('external', 13)} Открыть Twitch</button>
    <p class="section-note" style="margin-top:10px">После входа вернитесь и нажмите обновить.</p>
  </section>`;
}

function sectionHead(title, note = '') {
  return `<div class="section-head"><h2 class="section-title">${esc(title)}</h2>${note ? `<span class="section-note">${esc(note)}</span>` : ''}</div>`;
}

function errorBanner(text, action = 'refresh', actionLabel = 'Повторить') {
  if (!text) return '';
  return `<div class="banner is-error">${icon('alert', 15)}
    <div class="banner-main"><div class="banner-title">Не удалось синхронизироваться</div><div>${esc(text)}</div></div>
    ${action ? `<button type="button" class="btn btn-sm btn-ghost" data-action="${attr(action)}">${esc(actionLabel)}</button>` : ''}
  </div>`;
}

function farmCampaignNames(farm) {
  if (!farm) return [];
  if (Array.isArray(farm.campaignNames) && farm.campaignNames.length > 0) {
    return farm.campaignNames.filter(Boolean);
  }
  return farm.campaignName ? [farm.campaignName] : [];
}

function farmBanner() {
  const farm = state?.farm;
  if (!farm || (!farm.enabled && !state.settings?.autoFarm && !farm.error)) return '';
  const isError = Boolean(farm.error);
  const names = farmCampaignNames(farm);
  const simultaneous = names.length;
  const unlinked = farm.manualCampaignId && campaignPool(state.drops).some(
    (campaign) => campaign.id === farm.manualCampaignId && campaign.linked === false,
  );
  const title =
    isError
      ? 'Автоферма · нужно внимание'
      : simultaneous > 1
        ? `Автоферма · ${simultaneous} ${plural(simultaneous, 'кампания', 'кампании', 'кампаний')} сразу`
        : farm.enabled
          ? 'Автоферма работает'
          : 'Автоферма запускается';
  const sub = farm.error || (farm.channelLogin
    ? `${farm.channelDisplayName || farm.channelLogin} · ${farm.gameName || 'Twitch'}${names.length ? ` · ${names.join(' + ')}` : ''}`
    : 'Ищем канал с активными дропсами…');
  return `<div class="banner ${isError ? 'is-warn' : 'is-farm'}">
    <span class="pulse" style="${isError ? 'background:var(--amber);box-shadow:none' : ''}"></span>
    <div class="banner-main">
      <div class="banner-title">${esc(title)}</div>
      <div class="banner-sub${isError ? ' is-wrap' : ''}">${esc(sub)}</div>
      <div class="banner-actions">
        ${farm.enabled ? `<button type="button" class="btn btn-sm btn-ghost" data-action="farm-skip">Сменить канал</button>` : ''}
        ${farm.channelLogin ? `<button type="button" class="btn btn-sm btn-ghost" data-action="open-channel" data-login="${attr(farm.channelLogin)}">Открыть</button>` : ''}
        <button type="button" class="btn btn-sm btn-danger" data-action="farm-stop">${icon('stop', 10)} Стоп</button>
      </div>
      ${unlinked ? '<div class="banner-sub is-wrap farm-link-warning">Просмотр без привязки игрового аккаунта. Получение наград зависит от привязки.</div>' : ''}
      ${state.settings?.backgroundWatch === false ? '<div class="banner-sub" style="margin-top:7px">Фоновый просмотр выключен: если свернуть вкладку или переключиться, Twitch может поставить плеер на паузу.</div>' : ''}
    </div>
  </div>`;
}

function historySection(type) {
  const items = (state.history || []).filter((item) => item.type === type).slice(0, 5);
  if (items.length === 0) return '';
  const rows = items
    .map((item) => {
      const image = sanitizeImageUrl(item.imageUrl);
      return `<div class="history-item">
        <span class="history-icon is-${type}">${image ? `<img src="${attr(image)}" alt="" loading="lazy" data-img-fallback />` : icon(type === 'points' ? 'spark' : 'gift', 12)}</span>
        <div class="history-main">
          <div class="history-title">${esc(item.title)}</div>
          <div class="history-sub">${esc(item.subtitle || 'Twitch')}</div>
        </div>
        <span class="history-time">${esc(formatRelative(item.at))}</span>
      </div>`;
    })
    .join('');
  return `${sectionHead(type === 'points' ? 'Последние бонусы' : 'Последние награды')}<div class="history">${rows}</div>`;
}

// ---------------------------------------------------------------------------
// Drops tab
// ---------------------------------------------------------------------------

function dropRow(drop) {
  const ready = Boolean(drop.claimable);
  const claimed = Boolean(drop.isClaimed);
  const locked = drop.preconditionsMet === false;
  const classes = ['drop'];
  if (ready) classes.push('is-ready');
  if (claimed) classes.push('is-claimed');
  if (locked) classes.push('is-locked');

  let meta;
  if (claimed) meta = 'получено';
  else if (ready) meta = 'готово к получению';
  else if (locked) meta = 'сначала предыдущая награда';
  else meta = `${formatMinutes(drop.currentMinutes)} из ${formatMinutes(drop.requiredMinutes)}`;

  const statusIcon = claimed
    ? icon('check', 13)
    : ready
      ? icon('gift', 13)
      : locked
        ? icon('lock', 12)
        : icon('play', 11);

  const progress = claimed
    ? ''
    : `<div class="progress"><span class="progress-fill${drop.progressPct >= 100 ? ' is-done' : ''}" style="width:${pct(drop.progressPct)}%"></span></div>`;

  return `<div class="${classes.join(' ')}">
    <span class="drop-icon">${statusIcon}</span>
    <div class="drop-main">
      <div class="drop-title">${esc(drop.rewardText || drop.name || 'Награда')}</div>
      ${progress}
      <div class="drop-meta"><span>${esc(meta)}</span>${claimed ? '' : `<span>·</span><span>${pct(drop.progressPct)}%</span>`}</div>
    </div>
    ${ready ? `<div class="drop-action"><button type="button" class="claim-btn" data-action="claim-drop" data-campaign-id="${attr(drop.campaignId || '')}" data-drop-id="${attr(drop.id)}">${icon('gift', 11)} Забрать</button></div>` : ''}
  </div>`;
}

function campaignCard(campaign) {
  const ready = campaign.claimableCount > 0;
  const soon =
    campaign.endsAt != null && campaign.endsAt - Date.now() < 24 * 60 * 60 * 1000 && !campaign.expired;
  const linked = campaign.linked !== false;
  const title = campaign.game?.name || 'Twitch';
  const subtitle =
    campaign.name && campaign.name !== title ? campaign.name : `${campaign.totalDrops || 0} наград`;
  const drops = (campaign.drops || [])
    .map((drop) => dropRow({ ...drop, campaignId: campaign.id }))
    .join('');
  const farmIds = state?.farm?.campaignIds || [];
  const farming = farmIds.includes(campaign.id);
  const linkPill = linked
    ? ''
    : `<button type="button" class="pill is-link" data-action="${campaign.accountLinkUrl ? 'open-url' : 'open-twitch'}" ${campaign.accountLinkUrl ? `data-url="${attr(campaign.accountLinkUrl)}"` : ''}>${icon('link', 10)} привязать</button>`;

  return `<article class="campaign${ready ? ' has-ready' : ''}">
    <div class="campaign-head">
      ${thumb(campaign.imageUrl, title)}
      <div class="campaign-info">
        <div class="campaign-title-row">
          <h3 class="campaign-title" title="${attr(title)}">${esc(title)}</h3>
          ${pill(`${campaign.claimedCount || 0}/${campaign.totalDrops || 0}`, ready ? 'is-ready' : '')}
        </div>
        <div class="campaign-sub" title="${attr(subtitle)}">${esc(subtitle)}</div>
        <div class="campaign-meta">
          ${pill(`${icon('clock', 10)} ${esc(formatTimeLeft(campaign.endsAt))}`, soon ? 'is-soon' : '')}
          ${ready ? pill(`${icon('gift', 10)} ${campaign.claimableCount} готово`, 'is-ready') : ''}
          ${campaign.inProgressCount ? pill('в процессе') : ''}
          ${farming ? pill(`${icon('tv', 10)} фармится`, '') : ''}
          ${linkPill}
        </div>
        <div class="campaign-progress">
          <div class="progress-row">
            <span class="progress-label">Прогресс кампании</span>
            <span class="progress-value">${pct(campaign.progressPct)}%</span>
          </div>
          <div class="progress"><span class="progress-fill${campaign.progressPct >= 100 ? ' is-done' : ''}" style="width:${pct(campaign.progressPct)}%"></span></div>
        </div>
      </div>
    </div>
    ${drops ? `<div class="drops">${drops}</div>` : ''}
  </article>`;
}

function miniCampaign(campaign) {
  const title = campaign.game?.name || 'Twitch';
  const name = campaign.name || title;
  const unavailable = campaignPlayDisabledReason(campaign);
  const upcoming = unavailable === 'Кампания ещё не началась';
  const needsLink = campaign.linked === false && !unavailable;
  const loading = playingCampaignId === campaign.id;
  const error = playError?.campaignId === campaign.id ? playError.message : '';
  const note = loading
    ? 'Проверяем кампанию и ищем канал…'
    : error || unavailable || (needsLink ? '▶ можно запустить без привязки. Получение наград зависит от привязки аккаунта.' : '');
  const playTitle = unavailable || (playingCampaignId
    ? 'Дождитесь завершения поиска канала'
    : `Play — смотреть кампанию «${name}»`);
  const farming = state.farm?.enabled && state.farm.campaignIds?.includes(campaign.id);
  return `<div class="mini${farming ? ' is-farming' : ''}">
    ${thumb(campaign.imageUrl, title, true)}
    <div class="mini-info">
      <div class="mini-title" title="${attr(title)}">${esc(title)}</div>
      ${name !== title ? `<div class="mini-sub" title="${attr(name)}">${esc(name)}</div>` : ''}
      <div class="mini-sub">${esc(upcoming ? `старт ${formatDateTime(campaign.startsAt)}` : formatTimeLeft(campaign.endsAt))}${farming ? ' · фармится' : ''}</div>
      ${note ? `<div class="mini-note${error ? ' is-error' : needsLink ? ' is-warn' : ''}" role="status">${esc(note)}</div>` : ''}
      ${needsLink ? `<button type="button" class="pill is-link mini-link" data-action="open-url" data-url="${attr(campaign.accountLinkUrl || DROPS_URL)}">${icon('link', 10)} Привязать аккаунт</button>` : ''}
    </div>
    <div class="mini-actions">
      <button type="button" class="play-btn" data-action="farm-play" data-campaign-id="${attr(campaign.id)}" title="${attr(playTitle)}" aria-label="${attr(playTitle)}" aria-busy="${loading}" ${unavailable || playingCampaignId ? 'disabled' : ''}>${loading ? '<span class="spinner"></span>' : icon('play', 16)}</button>
      <button type="button" class="btn btn-sm btn-ghost" data-action="open-url" data-url="${attr(campaignCategoryUrl(campaign))}" title="Открыть категорию на Twitch" aria-label="${attr(`Открыть категорию ${title} на Twitch`)}">${icon('external', 11)}</button>
    </div>
  </div>`;
}

function renderDrops() {
  if (!state) return;
  if (!isAuthenticated()) {
    els.panelDrops.innerHTML = loginHero(state.session?.error || '');
    return;
  }

  const campaigns = allCampaigns();
  const ready = totalReady();
  const stats = `<div class="stats">
    <div class="stat${ready > 0 ? ' is-ready' : ''}"><span class="stat-value">${ready}</span><span class="stat-label">готово</span></div>
    <div class="stat"><span class="stat-value">${campaigns.length}</span><span class="stat-label">кампаний</span></div>
    <div class="stat"><span class="stat-value">${state.stats?.dropsClaimed || 0}</span><span class="stat-label">получено</span></div>
  </div>
  ${ready > 1 ? `<div class="bulk-actions"><button type="button" class="btn btn-sm btn-primary" data-action="claim-all">${icon('gift', 12)} Забрать всё (${ready})</button></div>` : ''}`;

  const error = state.drops?.error ? errorBanner(state.drops.error) : '';
  const farm = farmBanner();
  const cards = campaigns.map(campaignCard).join('');

  const available = state.drops?.available || [];
  const availableBlock = available.length
    ? `${sectionHead('Доступные кампании', `${available.length}`)}<p class="section-note available-note">▶ запускает автоферму или переключает её на выбранную кампанию.</p><div class="mini-list">${available.map(miniCampaign).join('')}</div>`
    : '';

  const body = campaigns.length
    ? cards
    : `<div class="empty">
        <div class="empty-icon">${icon('gift', 20)}</div>
        <div class="empty-title">Пока нет активных дропсов</div>
        <div class="empty-text">Новые кампании появятся автоматически. Можно посмотреть все кампании на Twitch прямо сейчас.</div>
        <button type="button" class="btn btn-primary" data-action="open-twitch">${icon('external', 12)} Открыть кампании</button>
      </div>`;

  const history = historySection('drop');
  const syncNote = state.drops?.lastSync
    ? `обновлено ${formatRelative(state.drops.lastSync)}`
    : 'ещё не обновлялось';

  els.panelDrops.innerHTML = `${stats}${error}${farm}
    ${sectionHead('Активные дропсы', syncNote)}
    ${body}
    ${availableBlock}
    ${history}`;
}

// ---------------------------------------------------------------------------
// Points tab
// ---------------------------------------------------------------------------

function channelRow(channel) {
  const ready = Boolean(channel.availableClaimId);
  const name = channel.displayName || channel.login;
  const meta = channel.error
    ? channel.error
    : ready
      ? 'бонус готов — заберите его'
      : channel.isLive
        ? `в эфире${channel.gameName ? ` · ${channel.gameName}` : ''}`
        : channel.open
          ? 'открыт в вкладке'
          : 'ждём следующий бонус';
  const openButton = `<button type="button" class="icon-mini" data-action="open-channel" data-login="${attr(channel.login)}" title="Открыть канал">${icon('external', 13)}</button>`;
  const removeButton = channel.tracked
    ? `<button type="button" class="icon-mini is-danger" data-action="remove-channel" data-login="${attr(channel.login)}" title="Убрать из отслеживаемых">${icon('x', 13)}</button>`
    : `<button type="button" class="icon-mini" data-action="add-channel" data-login="${attr(channel.login)}" title="Отслеживать канал">${icon('plus', 13)}</button>`;
  const claimButton = ready
    ? `<button type="button" class="claim-btn" data-action="claim-points" data-login="${attr(channel.login)}">${icon('gift', 11)} Забрать</button>`
    : '';

  return `<div class="channel${ready ? ' has-bonus' : ''}">
    ${avatar(channel.avatarUrl, name)}
    <div class="channel-info">
      <div class="channel-name">${channel.isLive ? '<span class="live-dot"></span>' : ''}${esc(name)}</div>
      <div class="channel-meta${ready ? ' is-ready' : ''}">${esc(meta)}</div>
    </div>
    <div class="channel-right">
      <div class="channel-balance">${formatPoints(channel.balance)}<small>очков</small></div>
      ${claimButton}
      ${openButton}
      ${removeButton}
    </div>
  </div>`;
}

function renderPoints() {
  if (!state) return;
  if (!isAuthenticated()) {
    els.panelPoints.innerHTML = loginHero(state.session?.error || '');
    return;
  }
  const channels = visibleChannels();
  const suggestions = openTabs.filter((tab) => {
    const known = state.points?.channels?.[tab.login];
    return tab.login && !known?.tracked;
  });
  const uniqueSuggestions = [];
  const seen = new Set();
  for (const tab of suggestions) {
    if (seen.has(tab.login)) continue;
    seen.add(tab.login);
    uniqueSuggestions.push(tab);
  }

  const error = state.points?.error ? errorBanner(state.points.error) : '';
  const autoClaim = state.settings?.autoClaimPoints !== false;

  const hero = `<div class="points-hero">
    <span class="points-hero-icon">${icon('spark', 21)}</span>
    <div>
      <div class="points-balance">${formatPoints(totalPoints())}</div>
      <div class="points-caption">очков на каналах</div>
    </div>
    <div class="points-meta"><strong>${state.stats?.pointsBonuses || 0}</strong>бонусов получено</div>
  </div>`;

  const autoRow = `<div class="card settings-card">
    <div class="setting-row" style="padding-top:2px">
      <div class="setting-copy">
        <div class="setting-title">Забирать бонусы автоматически</div>
        <div class="setting-sub">Сундук на открытых каналах и доступные бонусы через API Twitch.</div>
      </div>
      <label class="switch"><input type="checkbox" data-setting="autoClaimPoints" ${autoClaim ? 'checked' : ''} aria-label="Автоматически забирать бонусы" /><span class="switch-track"></span></label>
    </div>
  </div>`;

  const form = `<form class="add-channel" id="addChannelForm">
    <input class="input" id="channelInput" type="text" placeholder="Имя канала или ссылка twitch.tv/…" maxlength="80" autocomplete="off" aria-label="Канал для отслеживания" />
    <button type="submit" class="btn btn-primary">${icon('plus', 12)} Добавить</button>
  </form>`;

  const chips = uniqueSuggestions.length
    ? `<div class="chips">${uniqueSuggestions
        .slice(0, 5)
        .map(
          (tab) =>
            `<button type="button" class="chip" data-action="add-channel" data-login="${attr(tab.login)}">${icon('plus', 10)} ${esc(tab.login)}</button>`,
        )
        .join('')}</div>`
    : '';

  const list = channels.length
    ? `<div class="channel-list">${channels.map(channelRow).join('')}</div>`
    : `<div class="empty">
        <div class="empty-icon">${icon('spark', 20)}</div>
        <div class="empty-title">Пока нечего отслеживать</div>
        <div class="empty-text">Добавьте канал вручную или откройте его на Twitch — TwitchAutoPilot подхватит открытую вкладку и покажет баланс.</div>
      </div>`;

  const note = `<p class="settings-footer">Бонусные очки начисляет Twitch. TwitchAutoPilot только забирает бесплатный сундук, когда он появляется; ваши баллы никуда не передаются.</p>`;

  els.panelPoints.innerHTML = `${hero}${error}${sectionHead('Автосбор очков')}${autoRow}${sectionHead('Каналы', `${channels.length}`)}${form}${chips}${list}${historySection('points')}${note}`;
}

// ---------------------------------------------------------------------------
// Settings tab
// ---------------------------------------------------------------------------

function intervalOptions(selected) {
  return INTERVAL_OPTIONS.map(
    (value) =>
      `<option value="${value}" ${Number(selected) === value ? 'selected' : ''}>${value} мин</option>`,
  ).join('');
}

function priorityOptions(selected) {
  return [
    ['deadline', 'Сначала те, что скоро закончатся'],
    ['progress', 'Сначала самые близкие к финишу'],
  ]
    .map(
      ([value, label]) =>
        `<option value="${value}" ${selected === value ? 'selected' : ''}>${label}</option>`,
    )
    .join('');
}

function strategyOptions(selected) {
  return [
    ['random', 'Случайные'],
    ['low', 'С небольшим онлайном'],
    ['top', 'С большим онлайном'],
  ]
    .map(
      ([value, label]) =>
        `<option value="${value}" ${selected === value ? 'selected' : ''}>${label}</option>`,
    )
    .join('');
}

function settingSwitch(key, title, subtitle, checked) {
  return `<div class="setting-row">
    <div class="setting-copy"><div class="setting-title">${esc(title)}</div>${subtitle ? `<div class="setting-sub">${esc(subtitle)}</div>` : ''}</div>
    <label class="switch"><input type="checkbox" data-setting="${attr(key)}" ${checked ? 'checked' : ''} aria-label="${attr(title)}" /><span class="switch-track"></span></label>
  </div>`;
}

function farmStatusBlock() {
  const farm = state.farm || {};
  if (!farm.enabled && !farm.error) return '';
  const isError = Boolean(farm.error);
  const names = farmCampaignNames(farm);
  const heading = isError
    ? 'Нужно внимание'
    : names.length > 1
      ? `Ферма работает · ${names.length} ${plural(names.length, 'кампания', 'кампании', 'кампаний')}`
      : 'Ферма работает';
  return `<div class="farm-status${isError ? ' is-error' : ''}">
    <div class="farm-status-title">${isError ? icon('alert', 12) : '<span class="pulse"></span>'} ${esc(heading)}</div>
    <div class="farm-status-sub">${
      farm.error
        ? esc(farm.error)
        : esc(
            `${farm.channelDisplayName || farm.channelLogin || 'канал'} · ${farm.gameName || 'Twitch'}${names.length ? ` · ${names.join(' + ')}` : ''}`,
          )
    }</div>
    <div class="farm-actions">
      ${farm.enabled ? `<button type="button" class="btn btn-sm btn-ghost" data-action="farm-skip">Сменить канал</button>` : ''}
      <button type="button" class="btn btn-sm btn-danger" data-action="farm-stop">${icon('stop', 10)} Остановить</button>
    </div>
  </div>`;
}

function renderSettings() {
  if (!state) return;
  const settings = state.settings || {};
  const farm = state.farm || {};
  const authenticated = isAuthenticated();
  const hero = `<div class="banner is-warn">${icon('shield', 15)}<div class="banner-main">
    <div class="banner-title">Всё локально</div>
    <div>TwitchAutoPilot не отправляет данные на сторонние серверы. Токен Twitch хранится в памяти расширения и используется только для запросов к Twitch.</div>
  </div></div>`;

  const claims = `<div class="card settings-card">
    <div class="settings-head">${icon('gift', 14)}<h3>Что забирать</h3></div>
    <div class="settings-desc">Можно включить только одну часть — вторая продолжит работать отдельно.</div>
    ${settingSwitch('autoClaimDrops', 'Готовые дропсы', 'Забирать награды, когда прогресс достиг 100%.', settings.autoClaimDrops)}
    ${settingSwitch('autoClaimPoints', 'Бонусы каналов', 'Кликать сундук на открытых вкладках и забирать доступные бонусы.', settings.autoClaimPoints)}
    ${settingSwitch('notifyClaims', 'Уведомления', 'Показывать системные уведомления о полученных наградах.', settings.notifyClaims)}
  </div>`;

  const intervals = `<div class="card settings-card">
    <div class="settings-head">${icon('clock', 14)}<h3>Интервалы проверки</h3></div>
    <div class="settings-desc">Частые проверки быстрее ловят готовые награды, но создают больше запросов к Twitch.</div>
    <div class="select-row">
      <div class="setting-copy"><div class="setting-title">Дропсы и кампании</div><div class="setting-sub">прогресс и автосбор</div></div>
      <select class="select" data-setting="dropsIntervalMin" aria-label="Интервал проверки дропсов">${intervalOptions(settings.dropsIntervalMin)}</select>
    </div>
    <div class="select-row">
      <div class="setting-copy"><div class="setting-title">Очки каналов</div><div class="setting-sub">балансы и бонусы</div></div>
      <select class="select" data-setting="pointsIntervalMin" aria-label="Интервал проверки очков">${intervalOptions(settings.pointsIntervalMin)}</select>
    </div>
  </div>`;

  const farmCard = `<div class="card settings-card">
    <div class="settings-head">${icon('tv', 14)}<h3>Автоферма</h3></div>
    <div class="settings-desc">TwitchAutoPilot откроет одну настоящую вкладку Twitch и будет вести её, пока дропсы не закончатся. Twitch засчитывает минуты всем кампаниям одной игры, которые идут на канале, поэтому TwitchAutoPilot выбирает канал, покрывающий их максимум, и затем переходит к следующей игре.</div>
    ${settingSwitch('autoFarm', 'Держать канал с дропсами', 'Реальная вкладка Twitch, без подделки просмотров.', settings.autoFarm)}
    ${settingSwitch('backgroundWatch', 'Фоновый просмотр', 'Twitch ставит плеер на паузу в скрытой вкладке. Настройка не даёт ему это сделать — дропсы идут, даже если вкладка не активна.', settings.backgroundWatch)}
    ${settingSwitch('farmMuted', 'Без звука', 'Мьютить вкладку автофермы, чтобы не мешала.', settings.farmMuted)}
    ${settingSwitch('farmAutoSwitch', 'Менять канал при простое', 'Если прогресс не растёт 20 минут — попробовать другой канал.', settings.farmAutoSwitch)}
    <div class="select-row">
      <div class="setting-copy"><div class="setting-title">Как выбирать канал</div><div class="setting-sub">среди подходящих стримов</div></div>
      <select class="select" data-setting="farmStrategy" aria-label="Стратегия выбора канала">${strategyOptions(settings.farmStrategy)}</select>
    </div>
    <div class="select-row">
      <div class="setting-copy"><div class="setting-title">Что брать следующим</div><div class="setting-sub">после закрытия текущей игры</div></div>
      <select class="select" data-setting="farmPriority" aria-label="Приоритет кампаний">${priorityOptions(settings.farmPriority)}</select>
    </div>
    <p class="settings-footer" style="text-align:left;margin-top:9px">Кампании разных игр Twitch не засчитывает одновременно — TwitchAutoPilot проходит их по очереди. Кампании одной игры на выбранном канале идут параллельно.</p>
    ${farmStatusBlock()}
    <p class="settings-footer" style="text-align:left;margin-top:9px">Автоматический просмотр может противоречить правилам Twitch. Включайте автоферму осознанно и на свой риск.</p>
  </div>`;

  const data = `<div class="card settings-card">
    <div class="settings-head">${icon('chart', 14)}<h3>Данные и статистика</h3></div>
    <div class="settings-desc">История хранится только в этом браузере. Статистика считает полученные TwitchAutoPilot награды.</div>
    <div class="setting-row">
      <div class="setting-copy"><div class="setting-title">Получено дропсов</div><div class="setting-sub">за всё время</div></div>
      <strong>${state.stats?.dropsClaimed || 0}</strong>
    </div>
    <div class="setting-row">
      <div class="setting-copy"><div class="setting-title">Получено бонусов</div><div class="setting-sub">за всё время</div></div>
      <strong>${state.stats?.pointsBonuses || 0}</strong>
    </div>
    <div class="setting-row" style="gap:6px;flex-wrap:wrap">
      <button type="button" class="btn btn-sm btn-ghost" data-action="clear-history">Очистить историю</button>
      <button type="button" class="btn btn-sm btn-ghost" data-action="reset-stats">Сбросить статистику</button>
    </div>
  </div>`;

  const footer = `<p class="settings-footer">TwitchAutoPilot ${EXTENSION_VERSION} · неофициальное расширение. Не связано с Twitch.<br />${
    authenticated ? 'Сессия Twitch активна. Данные не покидают браузер.' : 'Войдите на Twitch, чтобы включить синхронизацию.'
  }</p>`;

  els.panelSettings.innerHTML = `${hero}${claims}${intervals}${farmCard}${data}${footer}`;
}

// ---------------------------------------------------------------------------
// Chrome / tabs / status
// ---------------------------------------------------------------------------

function renderUserBar() {
  if (!isAuthenticated()) {
    els.userBar.classList.add('hidden');
    return;
  }
  const user = state.user;
  const name = user.displayName || user.login;
  els.userBar.innerHTML = `${avatar(user.profileImageURL, name)}
    <div class="user-info">
      <span class="user-name">${esc(name)}</span>
      <span class="user-status is-live">сессия Twitch активна</span>
    </div>
    <button type="button" class="icon-mini" data-action="open-twitch" title="Открыть Twitch">${icon('external', 13)}</button>`;
  els.userBar.classList.remove('hidden');
}

function renderBadges() {
  const ready = totalReady();
  const bonus = bonusReadyCount();
  if (ready > 0) {
    els.dropsBadge.textContent = String(ready);
    els.dropsBadge.classList.remove('hidden');
  } else {
    els.dropsBadge.classList.add('hidden');
  }
  if (bonus > 0) {
    els.pointsBadge.textContent = String(bonus);
    els.pointsBadge.classList.remove('hidden');
  } else {
    els.pointsBadge.classList.add('hidden');
  }
}

function renderMaster() {
  if (!state) return;
  const dropsOn = state.settings?.autoClaimDrops !== false;
  const pointsOn = state.settings?.autoClaimPoints !== false;
  const allOn = dropsOn && pointsOn;
  els.master.checked = allOn;
  els.master.indeterminate = !allOn && (dropsOn || pointsOn);
}

function renderRefreshState() {
  els.refreshBtn.classList.toggle('spinning', busy);
  els.refreshBtn.disabled = busy;
}

function renderStatusBar() {
  let text;
  let kind = '';
  if (busy) {
    text = 'Обновляем данные…';
    kind = 'is-syncing';
  } else if (!state) {
    text = 'Подключаемся к Twitch…';
  } else if (!isAuthenticated()) {
    text = state.session?.error ? 'Нужна авторизация Twitch' : 'Войдите на Twitch';
    kind = state.session?.error ? 'is-error' : '';
  } else if (state.session?.error) {
    text = state.session.error;
    kind = 'is-error';
  } else if (state.drops?.error || state.points?.error) {
    text = 'Есть ошибка синхронизации';
    kind = 'is-error';
  } else if (state.drops?.lastSync) {
    text = `Обновлено ${formatRelative(state.drops.lastSync)}`;
    kind = 'is-ok';
  } else {
    text = 'Сессия активна';
    kind = 'is-ok';
  }
  els.syncDot.className = `dot ${kind}`;
  els.syncText.textContent = text;
}

function renderTabs() {
  for (const tab of els.tabs) {
    const isActive = tab.dataset.tab === activeTab;
    tab.classList.toggle('is-active', isActive);
    tab.setAttribute('aria-selected', isActive ? 'true' : 'false');
  }
  els.panelDrops.classList.toggle('hidden', activeTab !== 'drops');
  els.panelPoints.classList.toggle('hidden', activeTab !== 'points');
  els.panelSettings.classList.toggle('hidden', activeTab !== 'settings');
}

function renderChrome() {
  renderUserBar();
  renderBadges();
  renderMaster();
  renderRefreshState();
  renderStatusBar();
}

function render() {
  if (!state) return;
  const channelInput = document.getElementById('channelInput');
  const savedChannelValue = channelInput?.value || '';
  const focusedId = document.activeElement?.id || '';

  renderTabs();
  renderChrome();
  renderDrops();
  renderPoints();
  renderSettings();

  if (savedChannelValue) {
    const nextInput = document.getElementById('channelInput');
    if (nextInput && !nextInput.value) nextInput.value = savedChannelValue;
  }
  if (focusedId === 'channelInput') {
    const nextInput = document.getElementById('channelInput');
    if (nextInput && nextInput.value && document.activeElement !== nextInput) {
      nextInput.focus({ preventScroll: true });
    }
  }
  attachImageFallbacks();
}

function attachImageFallbacks() {
  document.querySelectorAll('img[data-img-fallback]').forEach((img) => {
    if (img.dataset.bound) return;
    img.dataset.bound = '1';
    img.addEventListener('error', () => {
      img.classList.add('hidden');
      const fallback = img.nextElementSibling;
      if (fallback) fallback.classList.remove('hidden');
    });
  });
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

els.tabs.forEach((tab) => {
  tab.addEventListener('click', () => {
    activeTab = tab.dataset.tab || 'drops';
    renderTabs();
    if (activeTab === 'points' && state?.session?.authenticated) {
      const stale = Date.now() - (state.points?.lastSync || 0) > 60_000;
      if (stale && !busy) refresh('points', { silent: true });
    }
  });
});

els.refreshBtn.addEventListener('click', () => refresh('all'));

els.master.addEventListener('change', async () => {
  if (!state) return;
  const target = !(state.settings?.autoClaimDrops !== false && state.settings?.autoClaimPoints !== false);
  state.settings.autoClaimDrops = target;
  state.settings.autoClaimPoints = target;
  renderChrome();
  const response = await sendRaw({
    type: 'SET_SETTINGS',
    patch: { autoClaimDrops: target, autoClaimPoints: target },
  });
  if (response.ok) {
    applyPayload(response);
    showToast(target ? 'Автосбор включён' : 'Автосбор выключен', target ? 'success' : '');
  } else {
    showToast(response.error || 'Не удалось изменить настройки', 'error');
    reloadState();
  }
});

document.addEventListener('click', async (event) => {
  const actionEl = event.target.closest('[data-action]');
  if (!actionEl || actionEl.disabled) return;
  const action = actionEl.dataset.action;
  if (actionLocks.has(`click:${action}`)) return;

  switch (action) {
    case 'refresh':
      await refresh('all');
      break;

    case 'open-twitch':
      await sendRaw({ type: 'OPEN_TWITCH' });
      break;

    case 'open-url': {
      const url = actionEl.dataset.url || '';
      if (url) await sendRaw({ type: 'OPEN_URL', url });
      break;
    }

    case 'open-channel': {
      const login = actionEl.dataset.login || '';
      if (login) await sendRaw({ type: 'OPEN_CHANNEL', login });
      break;
    }

    case 'claim-drop': {
      const campaignId = actionEl.dataset.campaignId || '';
      const dropId = actionEl.dataset.dropId || '';
      if (!campaignId || !dropId) break;
      const original = actionEl.innerHTML;
      actionEl.disabled = true;
      actionEl.innerHTML = '<span class="spinner"></span> Забираем';
      await runAction(
        'CLAIM_DROP',
        { campaignId, dropId },
        { success: 'Награда получена!', errorPrefix: '' },
      );
      if (actionEl.isConnected) {
        actionEl.disabled = false;
        actionEl.innerHTML = original;
      }
      break;
    }

    case 'claim-all': {
      const original = actionEl.innerHTML;
      actionEl.disabled = true;
      actionEl.innerHTML = '<span class="spinner"></span> Забираем';
      const response = await sendRaw({ type: 'CLAIM_ALL_DROPS' });
      if (response.ok) {
        applyPayload(response);
        const claimed = response.result?.claimed?.length || 0;
        const failed = response.result?.failed?.length || 0;
        const message = claimed === 0 && failed === 0
          ? 'Пока нечего забирать'
          : failed > 0
            ? `Забрано: ${claimed}, не удалось: ${failed}`
            : `Забрано наград: ${claimed}`;
        showToast(message, failed > 0 ? 'error' : 'success', 4200);
      } else {
        showToast(response.error || 'Не удалось забрать награды', 'error');
        scheduleReload();
      }
      if (actionEl.isConnected) {
        actionEl.disabled = false;
        actionEl.innerHTML = original;
      }
      break;
    }

    case 'claim-points': {
      const login = actionEl.dataset.login || '';
      if (!login) break;
      actionEl.disabled = true;
      actionEl.innerHTML = '<span class="spinner"></span>';
      await runAction('CLAIM_POINTS', { login }, { success: 'Бонус получен!' });
      break;
    }

    case 'add-channel': {
      const login = actionEl.dataset.login || '';
      if (!login) break;
      await runAction('ADD_CHANNEL', { login }, { success: `Канал ${login} добавлен` });
      break;
    }

    case 'remove-channel': {
      const login = actionEl.dataset.login || '';
      if (!login) break;
      await runAction('REMOVE_CHANNEL', { login }, { success: `Канал ${login} убран` });
      break;
    }

    case 'farm-play': {
      const campaignId = actionEl.dataset.campaignId || '';
      if (!campaignId || playingCampaignId) break;
      playingCampaignId = campaignId;
      playError = null;
      render();
      try {
        const response = await runAction('FARM_PLAY', { campaignId }, { success: 'Просмотр выбранной кампании запущен' });
        if (!response?.ok) {
          playError = { campaignId, message: response?.error || 'Не удалось переключить кампанию. Попробуйте ещё раз.' };
        }
      } finally {
        playingCampaignId = null;
        render();
      }
      break;
    }

    case 'farm-skip': {
      actionEl.disabled = true;
      await runAction('FARM_SKIP', {}, { success: 'Канал автофермы изменён' });
      break;
    }

    case 'farm-stop': {
      actionEl.disabled = true;
      await runAction('STOP_FARM', {}, { success: 'Автоферма остановлена' });
      break;
    }

    case 'clear-history': {
      if (window.confirm('Очистить историю полученных наград?')) {
        await runAction('CLEAR_HISTORY', {}, { success: 'История очищена' });
      }
      break;
    }

    case 'reset-stats': {
      if (window.confirm('Сбросить статистику полученных наград?')) {
        await runAction('RESET_STATS', {}, { success: 'Статистика сброшена' });
      }
      break;
    }

    case 'modal-cancel':
      els.modal.classList.add('hidden');
      break;

    case 'modal-confirm': {
      els.modal.classList.add('hidden');
      if (state) {
        state.settings.autoFarm = true;
        render();
      }
      const response = await sendRaw({ type: 'START_FARM' });
      if (response.ok) {
        applyPayload(response);
        showToast(response.warning || 'Автоферма включена', response.warning ? 'error' : 'success', 4200);
      } else {
        showToast(response.error || 'Не удалось включить автоферму', 'error');
      }
      break;
    }

    default:
      break;
  }
});

document.addEventListener('change', async (event) => {
  const input = event.target.closest('[data-setting]');
  if (!input || !state) return;
  const key = input.dataset.setting;
  const isCheckbox = input.type === 'checkbox';
  const value = isCheckbox ? input.checked : input.value;

  if (key === 'autoFarm' && value === true) {
    input.checked = false;
    renderSettings();
    attachImageFallbacks();
    els.modal.classList.remove('hidden');
    return;
  }

  const normalizedValue =
    key === 'dropsIntervalMin' || key === 'pointsIntervalMin' ? Number(value) : value;
  state.settings[key] = normalizedValue;
  renderChrome();

  const response = await sendRaw({ type: 'SET_SETTINGS', patch: { [key]: normalizedValue } });
  if (response.ok) {
    applyPayload(response);
    if (key === 'autoFarm' && normalizedValue === false) showToast('Автоферма выключена');
  } else {
    showToast(response.error || 'Не удалось сохранить настройку', 'error');
    reloadState();
  }
});

document.addEventListener('submit', async (event) => {
  const form = event.target.closest('#addChannelForm');
  if (!form) return;
  event.preventDefault();
  const input = document.getElementById('channelInput');
  const login = normalizeLogin(input?.value || '');
  if (!login) {
    showToast('Введите имя канала, например shroud', 'error');
    input?.focus();
    return;
  }
  const response = await runAction(
    'ADD_CHANNEL',
    { login },
    { success: `Канал ${login} добавлен` },
  );
  if (response?.ok && input) input.value = '';
});

els.modal.addEventListener('click', (event) => {
  if (event.target === els.modal) els.modal.classList.add('hidden');
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') els.modal.classList.add('hidden');
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === 'STATE_UPDATED') scheduleReload();
  return false;
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function boot() {
  const response = await sendRaw({ type: 'GET_STATE' });
  if (!response.ok) {
    els.syncText.textContent = response.error || 'Фоновый процесс недоступен';
    els.syncDot.className = 'dot is-error';
    return;
  }
  applyPayload(response);
  if (!autoRefreshDone && isAuthenticated()) {
    autoRefreshDone = true;
    const lastSync = Math.max(state?.drops?.lastSync || 0, state?.points?.lastSync || 0);
    if (Date.now() - lastSync > 30_000) refresh('all', { silent: true });
  }
}

setInterval(() => {
  if (!state) return;
  reloadState().catch(() => {});
}, 30_000);

boot().catch((error) => {
  els.panelDrops.innerHTML = `<div class="banner is-error">${icon('alert', 15)}<div class="banner-main">${esc(String(error?.message || error))}</div></div>`;
});
