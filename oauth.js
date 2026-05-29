const axios = require("axios");

// ─── СТРОИМ URL АВТОРИЗАЦИИ ───────────────────────────────────────────────────
function buildAuthUrl({ appId, redirectUri }) {
  const params = new URLSearchParams({
    client_id:     appId,
    redirect_uri:  redirectUri,
    response_type: "code",
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
    url: "https://www.facebook.com/v19.0/dialog/oauth?" + params.toString(),
  };
}

// ─── ОБМЕН CODE НА ТОКЕНЫ ────────────────────────────────────────────────────
async function exchangeCodeForToken({ code, appId, appSecret, redirectUri }) {
  // code → short-lived user token
  const short = await axios.get("https://graph.facebook.com/v19.0/oauth/access_token", {
    params: { client_id: appId, client_secret: appSecret, redirect_uri: redirectUri, code },
  });

  // short-lived → long-lived (60 дней)
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
    expiresAt:   new Date(Date.now() + expiresIn * 1000).toISOString().slice(0, 10),
  };
}

// ─── ПОЛУЧАЕМ IG АККАУНТЫ ────────────────────────────────────────────────────
async function getInstagramAccounts(userToken) {
  const pagesRes = await axios.get("https://graph.facebook.com/v19.0/me/accounts", {
    params: {
      access_token: userToken,
      fields:       "id,name,access_token,instagram_business_account",
    },
  });

  const accounts = [];
  for (const page of (pagesRes.data.data || [])) {
    if (!page.instagram_business_account) continue;

    const igId = page.instagram_business_account.id;
    let igData = {};
    try {
      const r = await axios.get("https://graph.facebook.com/v19.0/" + igId, {
        params: {
          fields:       "id,username,profile_picture_url,followers_count",
          access_token: page.access_token,
        },
      });
      igData = r.data;
    } catch (e) {
      console.warn("[oauth] Не удалось получить данные IG:", e.message);
    }

    accounts.push({
      igId,
      username:    igData.username             || "",
      displayName: page.name                   || "",
      pageId:      page.id,
      pageToken:   page.access_token,
      followers:   igData.followers_count      || 0,
      avatar:      igData.profile_picture_url  || null,
    });
  }
  return accounts;
}

// ─── ПОДПИСКА СТРАНИЦЫ НА WEBHOOK ────────────────────────────────────────────
async function subscribePageWebhook(pageId, pageToken) {
  try {
    await axios.post(
      "https://graph.facebook.com/v19.0/" + pageId + "/subscribed_apps",
      { subscribed_fields: ["comments", "messages", "follows"] },
      { params: { access_token: pageToken } }
    );
    console.log("[webhook] Подписка активирована для страницы", pageId);
  } catch (e) {
    console.warn("[webhook] Ошибка подписки:", e.response?.data?.error?.message || e.message);
  }
}

module.exports = { buildAuthUrl, exchangeCodeForToken, getInstagramAccounts, subscribePageWebhook };
