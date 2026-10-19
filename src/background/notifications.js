import { DROPS_URL } from '../shared/constants.js';
import { channelUrl } from '../shared/twitch-url.js';

const ICON = 'src/icons/icon128.png';

function notificationId() {
  return `twitchautopilot-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

export class NotificationService {
  constructor({ getSettings, logger = console, notificationsApi = null, tabsApi = null } = {}) {
    this.getSettings = getSettings;
    this.logger = logger;
    this.notificationsApi = notificationsApi || chrome.notifications;
    this.tabsApi = tabsApi || chrome.tabs;
    this.recent = new Map();
    this.#bindClick();
  }

  #bindClick() {
    try {
      this.notificationsApi.onClicked.addListener((id) => {
        const target = this.recent.get(id);
        this.recent.delete(id);
        if (target?.url) {
          this.tabsApi.create({ url: target.url }).catch(() => {});
        }
        Promise.resolve(this.notificationsApi.clear(id)).catch(() => {});
      });
      this.notificationsApi.onClosed.addListener((id) => {
        this.recent.delete(id);
      });
    } catch {
      // Notifications can be unavailable in some Chromium forks.
    }
  }

  async #enabled() {
    try {
      const settings = await this.getSettings();
      return settings?.notifyClaims !== false;
    } catch {
      return true;
    }
  }

  async show({ title, message, url = DROPS_URL, silent = false }) {
    if (!(await this.#enabled())) return null;
    const id = notificationId();
    this.recent.set(id, { url, at: Date.now() });
    if (this.recent.size > 30) {
      const oldest = this.recent.keys().next().value;
      this.recent.delete(oldest);
    }
    try {
      await this.notificationsApi.create(id, {
        type: 'basic',
        iconUrl: chrome.runtime.getURL(ICON),
        title: String(title || 'TwitchAutoPilot'),
        message: String(message || ''),
        priority: 1,
        silent,
      });
      return id;
    } catch (error) {
      this.logger.warn?.('[TwitchAutoPilot] notification failed', error);
      this.recent.delete(id);
      return null;
    }
  }

  async dropClaimed({ campaign, drop }) {
    const game = campaign?.game?.name || 'Twitch';
    const campaignName = campaign?.name || '';
    const reward = drop?.dropName || drop?.name || 'Награда';
    const subtitle = campaignName && campaignName !== game ? ` · ${campaignName}` : '';
    return this.show({
      title: 'Дроп получен',
      message: `${reward}\n${game}${subtitle}`,
      url: DROPS_URL,
    });
  }

  async pointsClaimed({ channelLogin, displayName }) {
    const name = displayName || channelLogin || 'канал';
    return this.show({
      title: 'Бонус канала получен',
      message: `Бесплатные очки на канале ${name}`,
      url: channelUrl(channelLogin),
      silent: true,
    });
  }
}
