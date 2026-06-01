const axios = require("axios");
const crypto = require("crypto");

// state → { redirectUri, expires }
const pendingStates = new Map();

function buildAuthUrl({ appId, redirectUri }) {
  const state = "igagent_" + Date.now() + "_" + crypto.randomBytes(8).toString("hex");
  pendingStates.set(state, {
    redirectUri,
    expires: Date.now() + 10 * 60 * 1000,
  });
  // Чистим старые state
  for (const [k, v] of pendingStates) {
    if (v.expires < Date.now()) pendingStates.delete(k);
  }

  const params = new URLSearchParams({
    client_id:     appId,
    redirect_uri:  redirectUri,
    response_type: "code",
    state,
    scope: [
      "instagram_manage_comments",
      "instagram_manage_messages",
      "pages_read_engagement",
      "pages_show_list",
      "business_management",
    ].join(","),
  });

  return { url: `https://www.facebook.com/v19.0/dialog/oauth?${params}`, state };
}

// Возвращает сохранённый redirectUri для этого state
function validateState(state) {
  if (!state || !pendingStates.has(state)) return null;
  const entry = pendingStates.get(state);
  pendingStates.delete(state);
  if (entry.expires < Date.now()) return null;
  return entry.redirectUri; // возвращаем URI, а не boolean
}

async function exchangeCodeForToken({ code, appId, appSecret, redirectUri }) {
  const short = await axios.get("https://graph.facebook.com/v19.0/oauth/access_token", {
    params: { client_id: appId, client_secret: appSecret, redirect_uri: redirectUri, code },
  });
  const long = await axios.get("https://graph.facebook.com/v19.0/oauth/access_token", {
    params: {
      grant_type:        "fb_exchange_token",
      client_id:         appId,
      client_secret:     appSecret,
      fb_exchange_token: short.data.access_token,
    },
  });
  const expiresIn = long.data.expires_in || 5184000;
  return {
    accessToken: long.data.access_token,
    expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString().slice(0, 10),
  };
}

async function getInstagramAccounts(userToken) {
  const pagesRes = await axios.get("https://graph.facebook.com/v19.0/me/accounts", {
    params: {
      access_token: userToken,
      fields: "id,name,access_token,instagram_business_account",
    },
  });
  const accounts = [];
  for (const page of pagesRes.data.data || []) {
    if (!page.instagram_business_account) continue;
    const igId = page.instagram_business_account.id;
    const igRes = await axios.get(`https://graph.facebook.com/v19.0/${igId}`, {
      params: {
        fields: "id,username,profile_picture_url,followers_count",
        access_token: page.access_token,
      },
    });
    accounts.push({
      igId,
      username:    igRes.data.username,
      displayName: page.name,
      pageId:      page.id,
      pageToken:   page.access_token,
      followers:   igRes.data.followers_count || 0,
      avatar:      igRes.data.profile_picture_url || null,
    });
  }
  return accounts;
}

async function subscribePageWebhook(pageId, pageToken) {
  await axios.post(
    `https://graph.facebook.com/v19.0/${pageId}/subscribed_apps`,
    { subscribed_fields: ["comments", "messages", "follows"] },
    { params: { access_token: pageToken } }
  );
}

module.exports = { buildAuthUrl, validateState, exchangeCodeForToken, getInstagramAccounts, subscribePageWebhook };
