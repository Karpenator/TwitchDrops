import {
  CURRENT_USER_QUERY,
  MAX_CAMPAIGN_DETAILS,
  MAX_CLAIMS_PER_CYCLE,
  queries,
} from '../shared/constants.js';
import {
  flattenClaimableDrops,
  isClaimResponseSuccessful,
  markDropClaimed,
  mergeCampaignsWithDetails,
  normalizeCampaign,
  sortCampaigns,
} from '../shared/drops-model.js';
import { ERROR_CODES, TwitchApiError, describeError } from '../shared/errors.js';
import { addHistory } from './state.js';

const DETAIL_BATCH_SIZE = 15;
const CLAIM_FAILURE_BACKOFF_MS = 10 * 60_000;

function extractDashboardCampaigns(data) {
  return (
    data?.currentUser?.dropCampaigns ||
    data?.viewer?.dropCampaigns ||
    data?.currentUser?.rewardCampaigns ||
    []
  );
}

function extractInventoryCampaigns(data) {
  return data?.currentUser?.inventory?.dropCampaignsInProgress || [];
}

function chunk(list, size) {
  const chunks = [];
  for (let index = 0; index < list.length; index += size) {
    chunks.push(list.slice(index, index + size));
  }
  return chunks;
}

function campaignEnd(campaign) {
  return campaign?.endsAt || Number.MAX_SAFE_INTEGER;
}

export class DropsService {
  constructor({ store, gql, session, notify, onUpdate = null, logger = console }) {
    this.store = store;
    this.gql = gql;
    this.session = session;
    this.notify = notify;
    this.onUpdate = onUpdate;
    this.logger = logger;
    this.inflight = null;
  }

  async #ensureUser() {
    let session = await this.session.get();
    if (!session?.token) {
      throw new TwitchApiError('No Twitch auth token', { code: ERROR_CODES.AUTH });
    }
    if (!session.user?.login) {
      try {
        const data = await this.gql.data(CURRENT_USER_QUERY);
        const user = data?.currentUser;
        if (user?.login) session = await this.session.setUser(user);
      } catch {
        // The cookie usually contains the profile; a missing profile query is fine.
      }
    }
    return session;
  }

  async #fetchCampaignDetails(ids, login) {
    const detailsById = new Map();
    if (ids.length === 0) return detailsById;
    const uniqueIds = [...new Set(ids.filter(Boolean))].slice(0, MAX_CAMPAIGN_DETAILS);
    for (const batch of chunk(uniqueIds, DETAIL_BATCH_SIZE)) {
      const responses = await this.gql
        .batch(batch.map((id) => queries.campaignDetails(id, login)))
        .catch((error) => {
          this.logger.warn?.('[TwitchAutoPilot] campaign details batch failed', error);
          return [];
        });
      responses.forEach((response, index) => {
        const campaign = response?.data?.user?.dropCampaign;
        const id = campaign?.id || batch[index];
        if (campaign && id) detailsById.set(String(id), campaign);
      });
    }
    return detailsById;
  }

  async refresh({ claim = true } = {}) {
    if (this.inflight) return this.inflight;
    this.inflight = this.#refresh(claim).finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  async #refresh(claim) {
    let session;
    try {
      session = await this.#ensureUser();
    } catch (error) {
      await this.#storeSessionError(error);
      throw error;
    }
    const userId = session.user?.id || '';

    const [dashboardResult, inventoryResult] = await Promise.allSettled([
      this.gql.data(queries.viewerDropsDashboard()),
      this.gql.data(queries.inventory()),
    ]);

    const fatalAuth =
      (dashboardResult.status === 'rejected' && dashboardResult.reason?.code === ERROR_CODES.AUTH) ||
      (inventoryResult.status === 'rejected' && inventoryResult.reason?.code === ERROR_CODES.AUTH);
    if (fatalAuth) {
      const error =
        dashboardResult.status === 'rejected' ? dashboardResult.reason : inventoryResult.reason;
      await this.#storeSessionError(error);
      throw error;
    }

    if (dashboardResult.status === 'rejected' && inventoryResult.status === 'rejected') {
      const error = inventoryResult.reason || dashboardResult.reason;
      await this.#storeDropsError(error);
      throw error;
    }

    const dashboardData = dashboardResult.status === 'fulfilled' ? dashboardResult.value : {};
    const inventoryData = inventoryResult.status === 'fulfilled' ? inventoryResult.value : {};
    const dashboardRaw = extractDashboardCampaigns(dashboardData);
    const inventoryRaw = extractInventoryCampaigns(inventoryData);
    const inventoryIds = new Set(inventoryRaw.map((campaign) => String(campaign?.id || '')));

    const detailsById = await this.#fetchCampaignDetails(
      inventoryRaw.map((campaign) => String(campaign?.id || '')),
      userId,
    );
    const mergedInventory = mergeCampaignsWithDetails(inventoryRaw, detailsById);

    const inProgress = mergedInventory
      .map((raw) => normalizeCampaign(raw, { userId, now: Date.now() }))
      .filter(Boolean)
      .map((campaign) => ({
        ...campaign,
        isInProgress: true,
        isAvailable: false,
      }));

    const available = dashboardRaw
      .filter((raw) => {
        const id = String(raw?.id || '');
        if (!id || inventoryIds.has(id)) return false;
        const status = String(raw?.status || '').toUpperCase();
        return status === 'ACTIVE' || status === 'UPCOMING';
      })
      .map((raw) =>
        normalizeCampaign(
          { ...raw, isAvailable: true, isInProgress: false },
          { userId, now: Date.now() },
        ),
      )
      .filter((campaign) => campaign && !campaign.expired)
      .sort((a, b) => campaignEnd(a) - campaignEnd(b))
      .slice(0, 30)
      .map((campaign) => ({ ...campaign, isAvailable: true, isInProgress: false }));

    await this.store.update((state) => {
      state.user = session.user
        ? {
            id: session.user.id || '',
            login: session.user.login || '',
            displayName: session.user.displayName || session.user.login || '',
          }
        : state.user;
      state.session = {
        authenticated: true,
        error: null,
        checkedAt: Date.now(),
      };
      state.drops.campaigns = sortCampaigns(inProgress);
      state.drops.available = available;
      state.drops.lastSync = Date.now();
      state.drops.error = null;
      return state;
    });

    if (claim) {
      const settings = (await this.store.get()).settings;
      if (settings.autoClaimDrops) {
        await this.claimAllReady().catch((error) => {
          this.logger.warn?.('[TwitchAutoPilot] auto claim failed', error);
        });
      }
    }

    this.onUpdate?.();
    return this.store.get();
  }

  async #storeDropsError(error) {
    await this.store.update((state) => {
      state.drops.error = describeError(error);
      return state;
    });
    this.onUpdate?.();
  }

  async #storeSessionError(error) {
    await this.store.update((state) => {
      state.session = {
        authenticated: false,
        error: describeError(error),
        checkedAt: Date.now(),
      };
      state.drops.error = describeError(error);
      return state;
    });
    this.onUpdate?.();
  }

  #findDrop(campaigns, campaignId, dropId) {
    const campaign = campaigns.find((item) => item.id === campaignId);
    if (!campaign) return { campaign: null, drop: null };
    const drop = campaign.drops.find((item) => item.id === dropId);
    return { campaign, drop };
  }

  async claimDrop(campaignId, dropId, { manual = false } = {}) {
    const state = await this.store.get();
    const { campaign, drop } = this.#findDrop(state.drops.campaigns, campaignId, dropId);
    if (!campaign || !drop) {
      throw new TwitchApiError('Награда не найдена в инвентаре', {
        code: ERROR_CODES.NOT_FOUND,
      });
    }
    if (drop.isClaimed) {
      return { ok: true, alreadyClaimed: true };
    }

    const session = await this.#ensureUser();
    const claimId = drop.claimId || `${session.user?.id || ''}#${campaignId}#${dropId}`;
    if (!claimId || claimId.startsWith('#')) {
      throw new TwitchApiError('Twitch не выдал идентификатор награды', {
        code: ERROR_CODES.NOT_FOUND,
      });
    }

    try {
      const payload = await this.gql.request(queries.claimDrop(claimId), {
        allowRelay: true,
      });
      if (!isClaimResponseSuccessful(payload)) {
        const status = payload?.data?.claimDropRewards?.status || 'UNKNOWN';
        const message = payload?.data?.claimDropRewards?.error?.message || `Twitch отклонил награду (${status})`;
        throw new TwitchApiError(message, { code: ERROR_CODES.UNKNOWN });
      }

      let updatedCampaign = null;
      await this.store.update((current) => {
        current.drops.campaigns = current.drops.campaigns.map((item) => {
          if (item.id !== campaignId) return item;
          updatedCampaign = markDropClaimed(item, dropId);
          return updatedCampaign;
        });
        current.drops.campaigns = sortCampaigns(current.drops.campaigns);
        current.drops.lastClaimAt = Date.now();
        delete current.drops.claimFailures[dropId];
        current.stats.dropsClaimed += 1;
        addHistory(current, {
          type: 'drop',
          title: drop.rewardText || drop.name || 'Награда',
          subtitle: [campaign.game?.name, campaign.name].filter(Boolean).join(' · '),
          imageUrl: drop.benefits?.find((benefit) => benefit.imageUrl)?.imageUrl || '',
        });
        return current;
      });

      await this.notify?.dropClaimed({
        campaign: updatedCampaign || campaign,
        drop: { ...drop, dropName: drop.rewardText || drop.name },
      });
      this.onUpdate?.();
      return { ok: true, status: 'claimed' };
    } catch (error) {
      if (!manual) {
        await this.store.update((current) => {
          current.drops.claimFailures = {
            ...current.drops.claimFailures,
            [dropId]: {
              until: Date.now() + CLAIM_FAILURE_BACKOFF_MS,
              message: describeError(error),
              at: Date.now(),
            },
          };
          return current;
        });
      }
      throw error;
    }
  }

  async claimAllReady() {
    const state = await this.store.get();
    const failures = state.drops.claimFailures || {};
    const now = Date.now();
    const claimable = flattenClaimableDrops(state.drops.campaigns)
      .filter((item) => {
        const failure = failures[item.dropId];
        return !failure || failure.until < now;
      })
      .slice(0, MAX_CLAIMS_PER_CYCLE);

    const result = { claimed: [], failed: [] };
    for (const item of claimable) {
      try {
        await this.claimDrop(item.campaignId, item.dropId);
        result.claimed.push(item);
      } catch (error) {
        result.failed.push({ ...item, error: describeError(error) });
      }
    }

    if (claimable.length > 0) {
      await this.store.update((current) => {
        const cutoff = Date.now() - 24 * 60 * 60 * 1000;
        current.drops.claimFailures = Object.fromEntries(
          Object.entries(current.drops.claimFailures || {}).filter(
            ([, value]) => value && value.until > cutoff,
          ),
        );
        return current;
      });
    }
    return result;
  }

  async claimAllForCampaign(campaignId) {
    const state = await this.store.get();
    const campaign = state.drops.campaigns.find((item) => item.id === campaignId);
    if (!campaign) return { claimed: 0 };
    let claimed = 0;
    for (const drop of campaign.drops) {
      if (!drop.claimable) continue;
      await this.claimDrop(campaign.id, drop.id, { manual: true });
      claimed += 1;
    }
    return { claimed };
  }
}
