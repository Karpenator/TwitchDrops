export const EXTENSION_NAME = 'TwitchAutoPilot';
export const EXTENSION_VERSION = '1.3.0';

export const GQL_ENDPOINT = 'https://gql.twitch.tv/gql';
export const INTEGRITY_ENDPOINT = 'https://gql.twitch.tv/integrity';

/** Public web client id used by twitch.tv. */
export const TWITCH_CLIENT_ID = 'kimne78kx3ncx6brgo4mv6wki5h1ko';
/** Client used by Twitch's own integrity service (see /integrity requests). */
export const INTEGRITY_CLIENT_ID = 'ue6666qo983tsx6so1t0vnawi233wa';
export const INTEGRITY_CLIENT_VERSION = 'da69d5f2-ac48-4169-9574-48fee4a96513';

export const DROPS_URL = 'https://www.twitch.tv/drops/campaigns';
export const TWITCH_URL = 'https://www.twitch.tv/';
export const DROPS_TAG_ID = 'c2542d6d-cd10-4532-919b-3d19f30a768b';
export const SPECIAL_GAME_IDS = new Set(['509663', '509672']);

export const STORAGE = {
  state: 'twitchautopilot:state',
  session: 'twitchautopilot:session',
  pageIntegrity: 'twitchautopilot:page-integrity',
};

export const ALARMS = {
  drops: 'twitchautopilot:drops',
  points: 'twitchautopilot:points',
  bonus: 'twitchautopilot:bonus',
  farm: 'twitchautopilot:farm',
};

/**
 * Keys written by releases up to 1.2.0, when the extension was called
 * DropPilot. They are only read once, to migrate the user's settings and
 * history to the new names.
 */
export const LEGACY = Object.freeze({
  state: 'droppilot:state',
  alarms: ['droppilot:drops', 'droppilot:points', 'droppilot:bonus', 'droppilot:farm'],
});

export const HISTORY_LIMIT = 80;
export const MAX_TRACKED_CHANNELS = 30;
export const MAX_CAMPAIGN_DETAILS = 40;
export const MAX_CLAIMS_PER_CYCLE = 12;

// Persisted-query hashes. Twitch rotates these occasionally; every operation
// also has a readable fallback/error path so the UI can explain what happened.
export const QUERY_HASHES = Object.freeze({
  inventory: 'd86775d0ef16a63a33ad52e80eaff963b2d5b72fada7c991504a57496e1d8e4b',
  viewerDropsDashboard: '5a4da2ab3d5b47c9f9ce864e727b2cb346af1e3ea8b897fe8f704a97ff017619',
  campaignDetails: '039277bf98f3130929262cc7c6efd9c141ca3749cb6dca442fc8ead9a53f77c1',
  claimDrop: 'a455deea71bdc9015b78eb49f4acfbce8baa7ccbedd28e549bb025bd0f751930',
  channelPointsContext: '374314de591e69925fce3ddc2bcf085796f56ebb8cad67a0daa3165c03adc345',
  claimCommunityPoints: '46aaeebe02c99afdf4fc97c7c0cba964124bf6b0af229395f1f6d1feed05b3d0',
  streamInfo: '198492e0857f6aedead9665c81c5a06d67b25b58034649687124083ff288597d',
  directoryGame: '76cb069d835b8a02914c08dc42c421d0dafda8af5b113a3f19141824b901402f',
});

function persisted(operationName, sha256Hash, variables = undefined) {
  const payload = {
    operationName,
    extensions: { persistedQuery: { version: 1, sha256Hash } },
  };
  if (variables !== undefined) payload.variables = variables;
  return payload;
}

export const queries = {
  inventory: () =>
    persisted('Inventory', QUERY_HASHES.inventory, { fetchRewardCampaigns: false }),

  viewerDropsDashboard: () =>
    persisted('ViewerDropsDashboard', QUERY_HASHES.viewerDropsDashboard, {
      fetchRewardCampaigns: false,
    }),

  campaignDetails: (dropID, channelLogin) =>
    persisted('DropCampaignDetails', QUERY_HASHES.campaignDetails, {
      dropID: String(dropID),
      channelLogin: String(channelLogin || ''),
    }),

  claimDrop: (dropInstanceID) =>
    persisted('DropsPage_ClaimDropRewards', QUERY_HASHES.claimDrop, {
      input: { dropInstanceID: String(dropInstanceID) },
    }),

  channelPointsContext: (channelLogin) =>
    persisted('ChannelPointsContext', QUERY_HASHES.channelPointsContext, {
      channelLogin: String(channelLogin),
    }),

  claimCommunityPoints: (claimID, channelID) =>
    persisted('ClaimCommunityPoints', QUERY_HASHES.claimCommunityPoints, {
      input: { claimID: String(claimID), channelID: String(channelID) },
    }),

  streamInfo: (channel) =>
    persisted('VideoPlayerStreamInfoOverlayChannel', QUERY_HASHES.streamInfo, {
      channel: String(channel),
    }),

  directoryGame: (gameName, slug) => ({
    ...persisted('DirectoryPage_Game', QUERY_HASHES.directoryGame, {
      game: String(gameName || slug).toLowerCase(),
      slug: String(slug),
      options: {
        includeRestricted: ['SUB_ONLY_LIVE'],
        sort: 'VIEWER_COUNT',
        recommendationsContext: { platform: 'web' },
        requestID: 'JIRA-VXP-2397',
        tags: [DROPS_TAG_ID],
      },
      sortTypeIsRecency: false,
      includeCostreaming: true,
      limit: 30,
    }),
  }),
};

/** Fallback used when Twitch reports PersistedQueryNotFound for the directory. */
export const DIRECTORY_FALLBACK_QUERY = `query DirectoryPage_Game($slug: String!, $first: Int!, $after: Cursor, $options: GameStreamOptions) {
  game(slug: $slug) {
    displayName
    name
    streams(first: $first, after: $after, options: $options) {
      edges {
        node {
          broadcaster { id login displayName }
          viewersCount
          title
          game { id name displayName slug }
        }
      }
      pageInfo { hasNextPage }
    }
  }
}`;

export function directoryFallbackPayload(gameName, slug) {
  return {
    operationName: 'DirectoryPage_Game',
    query: DIRECTORY_FALLBACK_QUERY,
    variables: {
      slug: String(slug),
      first: 30,
      after: null,
      options: {
        includeRestricted: ['SUB_ONLY_LIVE'],
        sort: 'VIEWER_COUNT',
        recommendationsContext: { platform: 'web' },
        requestID: 'JIRA-VXP-2397',
        tags: [DROPS_TAG_ID],
      },
    },
  };
}

/** Raw current-user query used if the profile cookie is unavailable. */
export const CURRENT_USER_QUERY = {
  operationName: 'CurrentUser',
  query: `query CurrentUser {
    currentUser {
      id
      login
      displayName
      profileImageURL(width: 70)
    }
  }`,
};
