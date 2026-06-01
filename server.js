const express = require("express");
const axios   = require("axios");
const crypto  = require("crypto");
const fs      = require("fs");
const path    = require("path");

const {
  buildAuthUrl,
  validateState,
  exchangeCodeForToken,
  getInstagramAccounts,
  subscribePageWebhook,
} = require("./oauth");

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const CONFIG_PATH = path.join(__dirname, "config.json");

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    const defaults = {
      appId: "", appSecret: "", redirectUri: "",
      verifyToken: crypto.randomBytes(16).toString("hex"),
      accounts: [], scenarios: [],
      commentReplies: ["Написал(а) вам в директ, там всё подробно"],
    };
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(defaults, null, 2));
    return defaults;
  }

  const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));

  // Миграция старого ключа oauthRedirectUri → redirectUri
  if (cfg.oauthRedirectUri && !cfg.redirectUri) {
    cfg.redirectUri = cfg.oauthRedirectUri;
    delete cfg.oauthRedirectUri;
  }

  // Автогенерация verifyToken если отсутствует
  if (!cfg.verifyToken) {
    cfg.verifyToken = crypto.randomBytes(16).toString("hex");
    saveConfig(cfg);
  }

  return cfg;
}

function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

// ВАЖНО: всегда строим redirectUri из реального хоста запроса
// cfg.redirectUri используется ТОЛЬКО если задан явно (кастомный домен)
// иначе берём из заголовков запроса — это исключает рассинхрон
function getRedirectUri(req, cfg) {
  if (cfg.redirectUri && cfg.redirectUri.trim()) {
    // Нормализуем: всегда /auth/callback, никогда /auth/instagram
    return cfg.redirectUri.trim().replace(/\/auth\/instagram$/, "/auth/callback");
  }
  const proto = req.headers["x-forwarded-proto"] || req.protocol;
  const host  = req.headers["x-forwarded-host"]  || req.get("host");
  return `${proto}://${host}/auth/callback`;
}

// ─── ЛОГИ ─────────────────────────────────────────────────────────────────────
const userState = new Map();
const eventLog  = [];

function log(type, account, message, ok = true) {
  const entry = { time: new Date().toISOString(), type, account, message, ok };
  eventLog.unshift(entry);
  if (eventLog.length > 500) eventLog.pop();
  console.log(`[${entry.time}] [${type}] ${account}: ${message}`);
}

// ─── OAUTH ────────────────────────────────────────────────────────────────────

app.get("/auth/instagram", (req, res) => {
  const cfg = loadConfig();
  if (!cfg.appId || !cfg.appSecret) {
    return res.status(400).json({ error: "Заполните ID и секрет приложения в Настройках" });
  }
  const redirectUri = getRedirectUri(req, cfg);
  const { url, state } = buildAuthUrl({ appId: cfg.appId, redirectUri });
  res.json({ url, state, redirectUri }); // возвращаем для отладки
});

app.get("/auth/callback", async (req, res) => {
  const { code, state, error, error_description } = req.query;

  const send = (type, payload) =>
    res.send(`<script>window.opener&&window.opener.postMessage(${JSON.stringify({ type, ...payload })},'*');window.close()</script>`);

  if (error) return send("oauth_error", { message: error_description || error });
  if (!validateState(state)) return send("oauth_error", { message: "Ошибка безопасности (invalid state). Попробуйте снова." });

  try {
    const cfg = loadConfig();
    const redirectUri = getRedirectUri(req, cfg);

    const { accessToken, expiresAt } = await exchangeCodeForToken({
      code, appId: cfg.appId, appSecret: cfg.appSecret, redirectUri,
    });

    const igAccounts = await getInstagramAccounts(accessToken);

    if (!igAccounts.length) {
      return send("oauth_error", { message: "Instagram Business-аккаунтов не найдено. Убедитесь, что аккаунт бизнес/автор и привязан к Facebook-странице." });
    }

    const saved = [];
    for (const acct of igAccounts) {
      const existing = cfg.accounts.find(a => a.pageId === acct.pageId);
      if (existing) {
        existing.token       = acct.pageToken;
        existing.tokenExpiry = expiresAt;
        existing.followers   = acct.followers;
        existing.avatar      = acct.avatar;
        saved.push(existing);
      } else {
        const newAcct = {
          id: Date.now() + Math.floor(Math.random() * 1000),
          username: acct.username, displayName: acct.displayName,
          pageId: acct.pageId, igId: acct.igId,
          token: acct.pageToken, tokenExpiry: expiresAt,
          followers: acct.followers, avatar: acct.avatar,
          active: true, link: "",
        };
        cfg.accounts.push(newAcct);
        saved.push(newAcct);
      }
      try { await subscribePageWebhook(acct.pageId, acct.pageToken); }
      catch (e) { console.warn(`Webhook для ${acct.pageId}:`, e.message); }
    }

    saveConfig(cfg);
    log("oauth", igAccounts.map(a => `@${a.username}`).join(", "), `Подключено: ${igAccounts.length}`);
    send("oauth_success", { accounts: saved });

  } catch (err) {
    const msg = err.response?.data?.error?.message || err.message;
    console.error("OAuth error:", err.response?.data || err.message);
    send("oauth_error", { message: msg });
  }
});

// ─── WEBHOOK ──────────────────────────────────────────────────────────────────

app.get("/webhook", (req, res) => {
  const cfg = loadConfig();
  const { "hub.mode": mode, "hub.verify_token": token, "hub.challenge": challenge } = req.query;
  if (mode === "subscribe" && token === cfg.verifyToken) return res.send(challenge);
  res.status(403).send("Forbidden");
});

app.post("/webhook", (req, res) => {
  const cfg = loadConfig();

  if (cfg.appSecret) {
    const sig      = req.headers["x-hub-signature-256"];
    const expected = "sha256=" + crypto.createHmac("sha256", cfg.appSecret)
      .update(JSON.stringify(req.body)).digest("hex");
    if (sig !== expected) return res.status(403).send("Invalid signature");
  }

  res.status(200).send("EVENT_RECEIVED");
  const body = req.body;
  if (!body.object) return;

  body.entry?.forEach(entry => {
    const account = cfg.accounts.find(a => a.pageId === entry.id && a.active);
    if (!account) return;

    entry.changes?.forEach(change => {
      if (change.field === "comments") {
        const { from, id: commentId, message } = change.value;
        const userId = from?.id;
        const scenario = findScenario(cfg.scenarios, account.id, message || "");
        if (userId && commentId && scenario) {
          log("keyword", `@${account.username}`, `"${message?.slice(0,30)}" → "${scenario.name}"`);
          handleComment(account, scenario, cfg.commentReplies, userId, commentId);
        }
      }
      if (change.field === "follows") {
        const userId = change.value?.id;
        if (userId) handleFollow(account, userId);
      }
    });

    entry.messaging?.forEach(event => {
      if (event.message && !event.message.is_echo) {
        const userId = event.sender?.id;
        const text   = event.message?.text;
        if (userId && text) handleDM(account, userId, text);
      }
    });
  });
});

// ─── ЛОГИКА АГЕНТА ────────────────────────────────────────────────────────────

function findScenario(scenarios, accountId, text) {
  const lower = text.toLowerCase();
  return scenarios.find(s =>
    (s.accountIds || []).includes(accountId) &&
    (s.keywords   || []).some(k => lower.includes(k.toLowerCase()))
  );
}

function stateKey(accountId, userId) { return `${accountId}:${userId}`; }

async function getUserName(token, userId) {
  try {
    const r = await axios.get(`https://graph.facebook.com/v19.0/${userId}`, {
      params: { fields: "name", access_token: token },
    });
    return r.data.name || "друг";
  } catch { return "друг"; }
}

async function replyComment(token, commentId, text) {
  try {
    await axios.post(`https://graph.facebook.com/v19.0/${commentId}/replies`,
      { message: text }, { params: { access_token: token } });
  } catch (e) { console.error("reply:", e.response?.data); }
}

async function sendDM(token, pageId, userId, text) {
  try {
    await axios.post(`https://graph.facebook.com/v19.0/${pageId}/messages`,
      { recipient: { id: userId }, message: { text }, messaging_type: "RESPONSE" },
      { params: { access_token: token } });
  } catch (e) { console.error("dm:", e.response?.data); }
}

async function handleComment(account, scenario, replies, userId, commentId) {
  const key   = stateKey(account.id, userId);
  const state = userState.get(key) || {};
  if (state.commentReplied) return;

  const name  = await getUserName(account.token, userId);
  const reply = replies.length ? replies[Math.floor(Math.random() * replies.length)] : "Написал(а) в директ";

  await replyComment(account.token, commentId, reply);
  log("comment_reply", `@${account.username}`, reply.slice(0, 50));

  await new Promise(r => setTimeout(r, 2000));
  await sendDM(account.token, account.pageId, userId, `${name}, ${scenario.dmText}`);
  log("dm_sent", `@${account.username}`, `DM → ${userId}`);

  const link       = scenario.link || account.link || "";
  const isFollower = (userState.get(key) || {}).isFollower;

  await new Promise(r => setTimeout(r, 2500));
  if (isFollower && link) {
    await sendDM(account.token, account.pageId, userId, `${name}, вот ваша ссылка:\n\n${link}`);
    userState.set(key, { ...state, commentReplied: true, linkSent: true });
    log("link_sent", `@${account.username}`, `Ссылка → ${userId}`);
  } else {
    if (link) {
      await sendDM(account.token, account.pageId, userId,
        `${name}, подпишитесь на аккаунт и напишите "готово" — пришлю ссылку`);
    }
    const timer = scenario.followUp ? setTimeout(async () => {
      const cur = userState.get(key) || {};
      if (!cur.linkSent && link) {
        if (cur.isFollower) {
          await sendDM(account.token, account.pageId, userId, `${name}, вот ваша ссылка:\n\n${link}`);
          userState.set(key, { ...cur, linkSent: true });
        } else {
          await sendDM(account.token, account.pageId, userId,
            `${name}, напишите "готово" после подписки — пришлю материалы`);
        }
      }
    }, 60 * 60 * 1000) : null;
    userState.set(key, { ...state, commentReplied: true, followUpTimer: timer });
  }
}

async function handleFollow(account, userId) {
  const key   = stateKey(account.id, userId);
  const state = userState.get(key) || {};
  userState.set(key, { ...state, isFollower: true });
  log("follow", `@${account.username}`, `Новый подписчик ${userId}`);

  if (state.commentReplied && !state.linkSent && account.link) {
    const name = await getUserName(account.token, userId);
    await sendDM(account.token, account.pageId, userId, `${name}, вот ваша ссылка:\n\n${account.link}`);
    if (state.followUpTimer) clearTimeout(state.followUpTimer);
    userState.set(key, { ...userState.get(key), linkSent: true });
    log("link_sent", `@${account.username}`, `Ссылка после подписки → ${userId}`);
  }
}

async function handleDM(account, userId, text) {
  const lower = text.toLowerCase().trim();
  const key   = stateKey(account.id, userId);
  const state = userState.get(key) || {};
  if (!["готово", "подписался", "подписалась", "done"].includes(lower) || state.linkSent) return;

  const isFollower = (userState.get(key) || {}).isFollower;
  const name       = await getUserName(account.token, userId);
  const link       = account.link || "";

  if (isFollower && link) {
    await sendDM(account.token, account.pageId, userId, `${name}, вот ваша ссылка:\n\n${link}`);
    userState.set(key, { ...state, linkSent: true });
    log("link_sent", `@${account.username}`, `Ссылка по "готово" → ${userId}`);
  } else if (!isFollower) {
    await sendDM(account.token, account.pageId, userId,
      `${name}, пока подписку не вижу — попробуйте через минуту`);
  }
}

// ─── AI ПРОКСИ ────────────────────────────────────────────────────────────────
app.post("/api/ai", async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: { message: "ANTHROPIC_API_KEY не задан в .env" } });
  }
  try {
    const response = await axios.post("https://api.anthropic.com/v1/messages", req.body, {
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
    });
    res.json(response.data);
  } catch (err) {
    const errData = err.response?.data || { error: { message: err.message } };
    res.status(err.response?.status || 500).json(errData);
  }
});

// ─── REST API ─────────────────────────────────────────────────────────────────

app.get("/api/config", (req, res) => {
  const cfg = loadConfig();
  // Автоподставляем redirectUri если пустой
  const autoRedirectUri = getRedirectUri(req, cfg);
  res.json({
    ...cfg,
    appSecret: cfg.appSecret ? "***" : "",
    redirectUri: cfg.redirectUri || autoRedirectUri,
    autoRedirectUri,   // всегда передаём вычисленный URI для отображения
    accounts: cfg.accounts.map(a => ({
      ...a,
      token: a.token ? a.token.slice(0, 6) + "..." + a.token.slice(-4) : "",
    })),
  });
});

app.patch("/api/config/settings", (req, res) => {
  const cfg = loadConfig();
  const { appId, appSecret, redirectUri, verifyToken } = req.body;
  if (appId       !== undefined) cfg.appId       = appId;
  if (appSecret   !== undefined && appSecret !== "***") cfg.appSecret = appSecret;
  if (redirectUri !== undefined) cfg.redirectUri = redirectUri.replace(/\/auth\/instagram$/, "/auth/callback");
  if (verifyToken !== undefined) cfg.verifyToken = verifyToken;
  saveConfig(cfg);
  res.json({ ok: true });
});

app.patch("/api/config/account/:id", (req, res) => {
  const cfg = loadConfig();
  const a = cfg.accounts.find(x => String(x.id) === req.params.id);
  if (!a) return res.status(404).json({ error: "Not found" });
  if (req.body.active !== undefined) a.active = req.body.active;
  if (req.body.link   !== undefined) a.link   = req.body.link;
  saveConfig(cfg);
  res.json({ ok: true });
});

app.delete("/api/config/account/:id", (req, res) => {
  const cfg = loadConfig();
  cfg.accounts = cfg.accounts.filter(a => String(a.id) !== req.params.id);
  saveConfig(cfg);
  res.json({ ok: true });
});

app.post("/api/config/account/:id/refresh", async (req, res) => {
  const cfg = loadConfig();
  const a = cfg.accounts.find(x => String(x.id) === req.params.id);
  if (!a) return res.status(404).json({ error: "Not found" });
  try {
    const r = await axios.get("https://graph.facebook.com/v19.0/oauth/access_token", {
      params: {
        grant_type: "fb_exchange_token",
        client_id: cfg.appId, client_secret: cfg.appSecret,
        fb_exchange_token: a.token,
      },
    });
    a.token       = r.data.access_token;
    a.tokenExpiry = new Date(Date.now() + (r.data.expires_in || 5184000) * 1000).toISOString().slice(0, 10);
    saveConfig(cfg);
    res.json({ ok: true, expiry: a.tokenExpiry });
  } catch (err) {
    res.status(500).json({ error: err.response?.data || err.message });
  }
});

app.patch("/api/config/scenarios", (req, res) => {
  const cfg = loadConfig();
  cfg.scenarios = req.body.scenarios;
  saveConfig(cfg);
  res.json({ ok: true });
});

app.patch("/api/config/replies", (req, res) => {
  const cfg = loadConfig();
  cfg.commentReplies = req.body.replies;
  saveConfig(cfg);
  res.json({ ok: true });
});

app.get("/api/logs", (req, res) => res.json(eventLog.slice(0, 100)));

app.get("/healthz", (req, res) => res.json({ status: "ok", accounts: loadConfig().accounts.length }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  const cfg = loadConfig();
  console.log(`IG Agent запущен: http://localhost:${PORT}`);
  console.log(`Webhook URL:      http://localhost:${PORT}/webhook`);
  console.log(`Verify Token:     ${cfg.verifyToken}`);
});
