/*
 * Demo-only chrome.* shim for the interactive popup preview.
 * No Twitch requests are made; every number below is fake.
 */
(() => {
  const now = Date.now();
  const MINUTE = 60_000;
  const HOUR = 60 * MINUTE;
  const DAY = 24 * HOUR;

  function recompute(campaign) {
    campaign.totalDrops = campaign.drops.length;
    campaign.claimedCount = campaign.drops.filter((drop) => drop.isClaimed).length;
    campaign.claimableCount = campaign.drops.filter((drop) => drop.claimable).length;
    campaign.inProgressCount = campaign.drops.filter(
      (drop) => !drop.isClaimed && drop.currentMinutes > 0 && !drop.claimable,
    ).length;
    campaign.remainingMinutes = campaign.drops.reduce(
      (sum, drop) => sum + (drop.isClaimed ? 0 : Math.max(0, drop.requiredMinutes - drop.currentMinutes)),
      0,
    );
    campaign.progressPct = campaign.totalDrops
      ? Math.round((campaign.claimedCount / campaign.totalDrops) * 100)
      : 0;
    campaign.completed = campaign.drops.length > 0 && campaign.drops.every((drop) => drop.isClaimed);
    return campaign;
  }

  function makeDrop({ id, name, required, current, claimed = false, claimable = false, locked = false }) {
    const isClaimed = claimed;
    const ready = claimable;
    const currentMinutes = isClaimed || ready ? required : Math.min(current, required);
    const progressPct = isClaimed || ready ? 100 : Math.round((currentMinutes / required) * 100);
    return {
      id,
      name,
      rewardText: name,
      requiredMinutes: required,
      currentMinutes,
      remainingMinutes: isClaimed ? 0 : Math.max(0, required - currentMinutes),
      progressPct,
      isClaimed,
      claimable: ready,
      claimId: `demo#${id}`,
      preconditionsMet: !locked,
      startsAt: now - DAY,
      endsAt: now + DAY,
      benefits: [{ id: `${id}-benefit`, name, type: 'DIRECT_ENTITLEMENT', imageUrl: '' }],
      status: isClaimed ? 'claimed' : ready ? 'claimable' : locked ? 'locked' : current > 0 ? 'watching' : 'pending',
    };
  }

  function makeCampaign({ id, name, game, slug, endsIn, startsIn = -DAY, drops, linked = true }) {
    const campaign = {
      id,
      name,
      game: { id: `${slug}-id`, name: game, slug, boxArtUrl: '' },
      imageUrl: '',
      status: startsIn > 0 ? 'UPCOMING' : 'ACTIVE',
      startsAt: now + startsIn,
      endsAt: now + endsIn,
      linked,
      accountLinkUrl: '',
      allowedChannels: [],
      active: startsIn <= 0,
      upcoming: startsIn > 0,
      expired: false,
      completed: false,
      drops,
      categoryUrl: `https://www.twitch.tv/directory/category/${slug}?filter=drops`,
      isAvailable: false,
      isInProgress: true,
    };
    return recompute(campaign);
  }

  const rust = makeCampaign({
    id: 'rust-campaign',
    name: 'Rust: Twitch Drops',
    game: 'Rust',
    slug: 'rust',
    endsIn: 2 * DAY + 4 * HOUR,
    drops: [
      makeDrop({ id: 'rust-1', name: 'Набор «Пустынный рейдер»', required: 60, current: 60, claimed: true }),
      makeDrop({ id: 'rust-2', name: 'Ящик с инструментами', required: 120, current: 120, claimed: true }),
      makeDrop({ id: 'rust-3', name: 'Скины для оружия', required: 180, current: 180, claimable: true }),
      makeDrop({ id: 'rust-4', name: 'Эксклюзивная одежда', required: 240, current: 95 }),
    ],
  });

  const rustPrime = makeCampaign({
    id: 'rust-prime',
    name: 'Rust: Prime Rewards',
    game: 'Rust',
    slug: 'rust',
    endsIn: 4 * DAY + 2 * HOUR,
    drops: [
      makeDrop({ id: 'prime-1', name: 'Prime-набор «Выживший»', required: 60, current: 22 }),
      makeDrop({ id: 'prime-2', name: 'Скин рюкзака', required: 150, current: 0 }),
    ],
  });

  const delta = makeCampaign({
    id: 'delta-campaign',
    name: 'Delta Force: Season Rewards',
    game: 'Delta Force',
    slug: 'delta-force',
    endsIn: 13 * HOUR,
    drops: [
      makeDrop({ id: 'delta-1', name: 'Нашивка «Авангард»', required: 30, current: 30, claimed: true }),
      makeDrop({ id: 'delta-2', name: 'Скин штурмовой винтовки', required: 60, current: 42 }),
      makeDrop({ id: 'delta-3', name: 'Тайник снабжения', required: 90, current: 0, locked: true }),
    ],
  });

  const wot = makeCampaign({
    id: 'wot-campaign',
    name: 'World of Tanks: Steel Hunt',
    game: 'World of Tanks',
    slug: 'world-of-tanks',
    endsIn: 5 * DAY,
    drops: [
      makeDrop({ id: 'wot-1', name: 'Двухнедельный премиум', required: 45, current: 45, claimable: true }),
      makeDrop({ id: 'wot-2', name: 'Командир «Стальной охотник»', required: 90, current: 12 }),
    ],
  });

  function availableCampaign({ id, name, game, slug, startsIn = -DAY, endsIn, linked = true, rewardsPending = false }) {
    return {
      ...makeCampaign({
        id, name, game, slug, startsIn, endsIn, linked,
        drops: rewardsPending ? [] : [makeDrop({ id: `${id}-reward`, name: 'Демонстрационная награда', required: 60, current: 0 })],
      }),
      isAvailable: true,
      isInProgress: false,
    };
  }

  const state = {
    version: 1,
    settings: {
      autoClaimDrops: true,
      autoClaimPoints: true,
      notifyClaims: true,
      dropsIntervalMin: 5,
      pointsIntervalMin: 5,
      autoFarm: false,
      farmMuted: true,
      backgroundWatch: true,
      farmStrategy: 'random',
      farmPriority: 'deadline',
      farmAutoSwitch: true,
    },
    user: { id: 'demo-user', login: 'karpenator', displayName: 'Karpenator', profileImageURL: '' },
    session: { authenticated: true, error: null, checkedAt: now },
    drops: {
      campaigns: [rust, rustPrime, delta, wot],
      available: [
        availableCampaign({
          id: 'rivals-campaign',
          name: 'Marvel Rivals: Season 4',
          game: 'Marvel Rivals',
          slug: 'marvel-rivals',
          startsIn: 2 * HOUR,
          endsIn: 6 * DAY,
        }),
        availableCampaign({
          id: 'apex-campaign',
          name: 'Apex Legends: Battle Pass',
          game: 'Apex Legends',
          slug: 'apex-legends',
          startsIn: -DAY,
          endsIn: 6 * DAY,
        }),
        availableCampaign({
          id: 'apex-community', name: 'Apex Legends: Community Drops',
          game: 'Apex Legends', slug: 'apex-legends', endsIn: 7 * DAY, rewardsPending: true,
        }),
        availableCampaign({
          id: 'apex-next-week', name: 'Apex Legends: Next Event',
          game: 'Apex Legends', slug: 'apex-legends', startsIn: DAY, endsIn: 8 * DAY,
        }),
        ...[
          ['warframe', 'Warframe', 'Warframe: Community Drops'],
          ['escape-from-tarkov', 'Escape from Tarkov', 'Escape from Tarkov: Weekend Drops'],
          ['overwatch-2', 'Overwatch 2', 'Overwatch 2: Season Rewards'],
          ['sea-of-thieves', 'Sea of Thieves', 'Sea of Thieves: Community Weekend'],
          ['path-of-exile', 'Path of Exile', 'Path of Exile: Livestream Rewards'],
          ['throne-and-liberty', 'Throne and Liberty', 'Throne and Liberty: Adventure Drops'],
        ].map(([slug, game, name]) => availableCampaign({
          id: `${slug}-campaign`, name, game, slug, endsIn: 7 * DAY, linked: slug !== 'warframe',
        })),
      ],
      lastSync: now - 20_000,
      error: null,
      claimFailures: {},
      lastClaimAt: now - 12 * MINUTE,
    },
    points: {
      channels: {
        shroud: {
          login: 'shroud',
          channelId: '37402112',
          displayName: 'shroud',
          avatarUrl: '',
          balance: 12450,
          availableClaimId: 'demo-claim-shroud',
          multiplier: 1.2,
          isLive: true,
          gameName: 'Rust',
          streamTitle: 'Rust drops',
          updatedAt: now,
          error: null,
          tracked: false,
          open: true,
        },
        kaicenat: {
          login: 'kaicenat',
          channelId: '668',
          displayName: 'Kai Cenat',
          avatarUrl: '',
          balance: 3940,
          availableClaimId: '',
          multiplier: 1,
          isLive: true,
          gameName: 'Just Chatting',
          streamTitle: 'Stream',
          updatedAt: now,
          error: null,
          tracked: false,
          open: true,
        },
        summit1g: {
          login: 'summit1g',
          channelId: '26490481',
          displayName: 'summit1g',
          avatarUrl: '',
          balance: 8120,
          availableClaimId: '',
          multiplier: 1,
          isLive: false,
          gameName: '',
          streamTitle: '',
          updatedAt: now,
          error: null,
          tracked: true,
          open: false,
        },
        zackrawrr: {
          login: 'zackrawrr',
          channelId: '207813352',
          displayName: 'zackrawrr',
          avatarUrl: '',
          balance: 21300,
          availableClaimId: '',
          multiplier: 1,
          isLive: false,
          gameName: '',
          streamTitle: '',
          updatedAt: now,
          error: null,
          tracked: true,
          open: false,
        },
      },
      tracked: [
        { login: 'summit1g', addedAt: now - 5 * DAY },
        { login: 'zackrawrr', addedAt: now - 2 * DAY },
      ],
      lastSync: now - 40_000,
      error: null,
      lastClaimAt: now - 2 * MINUTE,
      recentClaims: {},
    },
    farm: {
      enabled: false,
      tabId: null,
      channelLogin: null,
      channelDisplayName: '',
      campaignId: null,
      manualCampaignId: null,
      campaignName: '',
      campaignIds: [],
      campaignNames: [],
      gameName: '',
      gameSlug: '',
      startedAt: 0,
      lastSwitchAt: 0,
      lastProgressMark: null,
      lastProgressAt: 0,
      error: null,
    },
    history: [
      {
        id: 'h1',
        type: 'points',
        title: 'Бонус канала',
        subtitle: 'shroud',
        imageUrl: '',
        amount: 0,
        at: now - 2 * MINUTE,
      },
      {
        id: 'h2',
        type: 'drop',
        title: 'Набор «Пустынный рейдер»',
        subtitle: 'Rust · Rust: Twitch Drops',
        imageUrl: '',
        amount: 0,
        at: now - 12 * MINUTE,
      },
      {
        id: 'h3',
        type: 'drop',
        title: 'Ящик с инструментами',
        subtitle: 'Rust · Rust: Twitch Drops',
        imageUrl: '',
        amount: 0,
        at: now - 70 * MINUTE,
      },
      {
        id: 'h4',
        type: 'points',
        title: 'Бонус канала',
        subtitle: 'summit1g',
        imageUrl: '',
        amount: 0,
        at: now - 3 * HOUR,
      },
    ],
    stats: { dropsClaimed: 14, pointsBonuses: 37 },
  };

  let openTabs = [
    { login: 'shroud', tabId: 101 },
    { login: 'kaicenat', tabId: 102 },
  ];

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function payload() {
    return {
      ok: true,
      state: clone(state),
      openTabs: clone(openTabs),
      version: '1.3.0',
      now: Date.now(),
    };
  }

  function addHistory(entry) {
    state.history.unshift({
      id: `h-${Date.now()}`,
      type: entry.type,
      title: entry.title,
      subtitle: entry.subtitle,
      imageUrl: '',
      amount: 0,
      at: Date.now(),
    });
    state.history = state.history.slice(0, 80);
  }

  function findCampaign(id) {
    return state.drops.campaigns.find((campaign) => campaign.id === id);
  }

  function startFarm() {
    state.settings.autoFarm = true;
    state.farm = {
      enabled: true,
      tabId: 777,
      channelLogin: 'shroud',
      channelDisplayName: 'shroud',
      campaignId: 'rust-campaign',
      manualCampaignId: null,
      campaignName: 'Rust: Twitch Drops',
      campaignIds: ['rust-campaign', 'rust-prime'],
      campaignNames: ['Rust: Twitch Drops', 'Rust: Prime Rewards'],
      gameName: 'Rust',
      gameSlug: 'rust',
      startedAt: now - 5 * MINUTE,
      lastSwitchAt: now - 5 * MINUTE,
      lastProgressMark: 42,
      lastProgressAt: now - MINUTE,
      error: null,
    };
  }

  function playFarm(campaignId) {
    const all = [...state.drops.campaigns, ...state.drops.available];
    const selected = all.find((campaign) => campaign.id === campaignId);
    if (!selected) return { ok: false, error: 'Кампания не найдена' };
    if (selected.upcoming) return { ok: false, error: 'Кампания ещё не началась' };
    if (!selected.active || selected.completed) {
      return { ok: false, error: 'Кампания недоступна для просмотра' };
    }
    const campaigns = [selected, ...all.filter((campaign) =>
      campaign !== selected && campaign.game.slug === selected.game.slug &&
      campaign.active && campaign.linked && !campaign.completed && campaign.drops.length > 0,
    )];
    state.settings.autoFarm = true;
    const login = selected.game.slug === 'rust' ? 'shroud' : `${selected.game.slug.slice(0, 18).replaceAll('-', '_')}_demo`;
    state.farm = {
      ...state.farm,
      enabled: true,
      tabId: state.farm.tabId || 777,
      channelLogin: login,
      channelDisplayName: login,
      campaignId: selected.id,
      manualCampaignId: selected.id,
      campaignName: selected.name,
      campaignIds: campaigns.map((campaign) => campaign.id),
      campaignNames: campaigns.map((campaign) => campaign.name),
      gameName: selected.game.name,
      gameSlug: selected.game.slug,
      startedAt: state.farm.startedAt || Date.now(),
      lastSwitchAt: Date.now(),
      lastProgressAt: Date.now(),
      error: null,
    };
    const warnings = [];
    if (!selected.drops.length) {
      warnings.push('Трансляция запущена. Twitch пока не вернул данные о наградах; прогресс и получение дропсов ещё не подтверждены.');
    }
    if (selected.linked === false) {
      warnings.push('Просмотр запущен без привязки игрового аккаунта. Получение наград зависит от привязки.');
    }
    return { ...payload(), warning: warnings.join(' ') || null };
  }

  function stopFarm() {
    state.settings.autoFarm = false;
    state.farm = {
      enabled: false,
      tabId: null,
      channelLogin: null,
      channelDisplayName: '',
      campaignId: null,
      manualCampaignId: null,
      campaignName: '',
      campaignIds: [],
      campaignNames: [],
      gameName: '',
      gameSlug: '',
      startedAt: 0,
      lastSwitchAt: 0,
      lastProgressMark: null,
      lastProgressAt: 0,
      error: null,
    };
  }

  function simulateRefresh() {
    const active = state.drops.campaigns
      .flatMap((campaign) => campaign.drops)
      .filter((drop) => !drop.isClaimed && !drop.claimable && drop.preconditionsMet);
    for (const drop of active.slice(0, 3)) {
      if (drop.currentMinutes >= drop.requiredMinutes) continue;
      drop.currentMinutes = Math.min(drop.requiredMinutes, drop.currentMinutes + 1);
      drop.progressPct = Math.round((drop.currentMinutes / drop.requiredMinutes) * 100);
      drop.remainingMinutes = drop.requiredMinutes - drop.currentMinutes;
    }
    state.drops.campaigns.forEach(recompute);
    state.drops.lastSync = Date.now();
    state.points.lastSync = Date.now();
    state.points.channels.shroud.balance += 10;
  }

  const handlers = {
    GET_STATE: () => payload(),

    REFRESH: () => {
      simulateRefresh();
      return payload();
    },

    SET_SETTINGS: (message) => {
      Object.assign(state.settings, message.patch || {});
      if (message.patch?.autoFarm === true) startFarm();
      if (message.patch?.autoFarm === false) stopFarm();
      state.drops.lastSync = Date.now();
      return payload();
    },

    START_FARM: () => {
      startFarm();
      return payload();
    },

    STOP_FARM: () => {
      stopFarm();
      return payload();
    },

    FARM_PLAY: (message) => playFarm(message.campaignId),

    FARM_SKIP: () => {
      const current = state.farm.channelLogin;
      const nextChannel = state.farm.gameSlug === 'rust'
        ? current === 'shroud' ? 'summit1g' : 'shroud'
        : current?.endsWith('_alt') ? current.slice(0, -4) : `${current || 'demo'}_alt`;
      state.farm.channelLogin = nextChannel;
      state.farm.channelDisplayName = nextChannel;
      state.farm.lastSwitchAt = Date.now();
      state.farm.lastProgressAt = Date.now();
      return payload();
    },

    CLAIM_DROP: (message) => {
      const campaign = findCampaign(message.campaignId);
      const drop = campaign?.drops.find((item) => item.id === message.dropId);
      if (!campaign || !drop || !drop.claimable) {
        return { ok: false, error: 'Демо: награда уже получена или недоступна' };
      }
      drop.claimable = false;
      drop.isClaimed = true;
      drop.status = 'claimed';
      drop.currentMinutes = drop.requiredMinutes;
      drop.progressPct = 100;
      drop.remainingMinutes = 0;
      recompute(campaign);
      state.stats.dropsClaimed += 1;
      addHistory({
        type: 'drop',
        title: drop.rewardText,
        subtitle: `${campaign.game.name} · ${campaign.name}`,
      });
      state.drops.lastSync = Date.now();
      return payload();
    },

    CLAIM_ALL_DROPS: () => {
      const claimed = [];
      for (const campaign of state.drops.campaigns) {
        for (const drop of campaign.drops) {
          if (!drop.claimable) continue;
          drop.claimable = false;
          drop.isClaimed = true;
          drop.status = 'claimed';
          drop.currentMinutes = drop.requiredMinutes;
          drop.progressPct = 100;
          drop.remainingMinutes = 0;
          recompute(campaign);
          state.stats.dropsClaimed += 1;
          addHistory({
            type: 'drop',
            title: drop.rewardText,
            subtitle: `${campaign.game.name} · ${campaign.name}`,
          });
          claimed.push({ campaignId: campaign.id, dropId: drop.id });
        }
      }
      state.drops.lastSync = Date.now();
      return { ...payload(), result: { claimed, failed: [] } };
    },

    CLAIM_POINTS: (message) => {
      const channel = state.points.channels[message.login];
      if (!channel?.availableClaimId) {
        return { ok: false, error: 'Демо: бонус пока недоступен' };
      }
      channel.availableClaimId = '';
      channel.balance += 450;
      state.stats.pointsBonuses += 1;
      addHistory({
        type: 'points',
        title: 'Бонус канала',
        subtitle: channel.displayName || channel.login,
      });
      state.points.lastSync = Date.now();
      return payload();
    },

    ADD_CHANNEL: (message) => {
      const login = String(message.login || '').toLowerCase();
      if (!login) return { ok: false, error: 'Нет имени канала' };
      if (!state.points.channels[login]) {
        state.points.channels[login] = {
          login,
          channelId: `demo-${login}`,
          displayName: login,
          avatarUrl: '',
          balance: 1200,
          availableClaimId: '',
          multiplier: 1,
          isLive: false,
          gameName: '',
          streamTitle: '',
          updatedAt: Date.now(),
          error: null,
          tracked: true,
          open: false,
        };
      } else {
        state.points.channels[login].tracked = true;
      }
      if (!state.points.tracked.some((item) => item.login === login)) {
        state.points.tracked.push({ login, addedAt: Date.now() });
      }
      return payload();
    },

    REMOVE_CHANNEL: (message) => {
      state.points.tracked = state.points.tracked.filter((item) => item.login !== message.login);
      if (state.points.channels[message.login]) {
        state.points.channels[message.login].tracked = false;
        if (!state.points.channels[message.login].open) delete state.points.channels[message.login];
      }
      return payload();
    },

    CLEAR_HISTORY: () => {
      state.history = [];
      return payload();
    },

    RESET_STATS: () => {
      state.stats = { dropsClaimed: 0, pointsBonuses: 0 };
      return payload();
    },

    OPEN_TWITCH: () => {
      window.open('https://www.twitch.tv/drops/campaigns', '_blank', 'noopener');
      return { ok: true };
    },

    OPEN_CHANNEL: (message) => {
      window.open(`https://www.twitch.tv/${encodeURIComponent(message.login || '')}`, '_blank', 'noopener');
      return { ok: true };
    },

    OPEN_URL: (message) => {
      if (String(message.url || '').startsWith('https://www.twitch.tv/')) {
        window.open(message.url, '_blank', 'noopener');
      }
      return { ok: true };
    },
  };

  const demoChrome = {
    runtime: {
      id: 'twitchautopilot-demo',
      sendMessage(message) {
        const handler = handlers[message?.type];
        let result;
        try {
          result = handler ? handler(message) : { ok: false, error: 'Демо: неизвестное действие' };
        } catch (error) {
          result = { ok: false, error: String(error?.message || error) };
        }
        return new Promise((resolve) => setTimeout(() => resolve(result), 240));
      },
      onMessage: {
        addListener() {},
        removeListener() {},
      },
      getManifest: () => ({ version: '1.3.0' }),
    },
  };

  // Regular web pages already expose a `chrome` object (with a few unrelated
  // APIs), so extend it when present; otherwise create it.
  try {
    if (window.chrome && typeof window.chrome === 'object') {
      Object.assign(window.chrome, demoChrome);
    } else {
      Object.defineProperty(window, 'chrome', {
        value: demoChrome,
        configurable: true,
        writable: true,
      });
    }
  } catch {
    /* fall through to the last-resort check below */
  }
  if (typeof window.chrome?.runtime?.sendMessage !== 'function') {
    try {
      Object.defineProperty(window, 'chrome', {
        value: demoChrome,
        configurable: true,
        writable: true,
      });
    } catch {
      try {
        window.chrome = demoChrome;
      } catch {
        /* last resort: nothing else we can do */
      }
    }
  }
})();
