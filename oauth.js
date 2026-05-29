const axios = require("axios");

// Хранилище state-токенов для защиты от CSRF
const pendingStates = new Set();

const oauthStates = new Map();

function createState() {
  const state = `igagent_${Date.now()}_${Math.random().toString(36).slice(2)}`;

  oauthStates.set(state, {
    createdAt: Date.now(),
  });

  return state;
}

function validateState(state) {
  if (!state) return false;

  const saved = oauthStates.get(state);
  if (!saved) return false;

  const maxAge = 10 * 60 * 1000; // 10 минут
  const isExpired = Date.now() - saved.createdAt > maxAge;

  oauthStates.delete(state); // одноразовый state

  return !isExpired;
}


// Строим URL для редиректа на Meta OAuth
function buildAuthUrl({ appId, redirectUri }) {
  const state = createState();

  const params = new URLSearchParams({
    client_id: appId,
    redirect_uri: redirectUri,
    response_type: "code",
    state,
    scope: [
      "instagram_manage_comments",
      "instagram_manage_messages",
      "pages_messaging",
      "pages_read_engagement",
      "pages_show_list",
      "business_management",
    ].join(","),
  });

  return {
    url: `https://www.facebook.com/v19.0/dialog/oauth?${params.toString()}`,
    state,
  };
}

// Обмен code на долгосрочный токен (60 дней)
async function exchangeCodeForToken({ code, appId, appSecret, redirectUri }) {
  // Шаг 1: code → short-lived user token
  const short = await axios.get("https://graph.facebook.com/v19.0/oauth/access_token", {
    params: { client_id: appId, client_secret: appSecret, redirect_uri: redirectUri, code },
  });

  // Шаг 2: short-lived → long-lived (60 дней)
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

// Получаем все Facebook-страницы и их Instagram Business аккаунты
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

// Подписываем Facebook-страницу на webhook-события
async function subscribePageWebhook(pageId, pageToken) {
  await axios.post(
    `https://graph.facebook.com/v19.0/${pageId}/subscribed_apps`,
    { subscribed_fields: ["comments", "messages", "follows"] },
    { params: { access_token: pageToken } }
  );
}

module.exports = { buildAuthUrl, validateState, exchangeCodeForToken, getInstagramAccounts, subscribePageWebhook };
