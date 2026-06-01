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

// ─── OAUTH РЕЗУЛЬТАТЫ (polling вместо postMessage) ────────────────────────────
// Храним результат авторизации по session-токену, фронтенд опрашивает /api/oauth/result/:token
const oauthResults = new Map(); // token → { status, data, expires }

function setOAuthResult(token, status, data) {
  oauthResults.set(token, { status, data, expires: Date.now() + 5 * 60 * 1000 });
}

function getOAuthResult(token) {
  const r = oauthResults.get(token);
  if (!r) return null;
  if (r.expires < Date.now()) { oauthResults.delete(token); return null; }
  return r;
}

// ─── CONFIG ───────────────────────────────────────────────────────────────────
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
  // Миграция старого ключа
  if (cfg.oauthRedirectUri && !cfg.redirectUri) {
    cfg.redirectUri = cfg.oauthRedirectUri;
    delete cfg.oauthRedirectUri;
  }
  if (!cfg.verifyToken) {
    cfg.verifyToken = crypto.randomBytes(16).toString("hex");
    saveConfig(cfg);
  }
  return cfg;
}

function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

// Строим redirectUri — ВСЕГДА /auth/callback, берём из конфига или из заголовков
function getRedirectUri(req, cfg) {
  if (cfg.redirectUri && cfg.redirectUri.trim()) {
    return cfg.redirectUri.trim().replace(/\/auth\/instagram\/?$/, "/auth/callback");
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
  const redirectUri   = getRedirectUri(req, cfg);
  const sessionToken  = crypto.randomBytes(16).toString("hex");
  const { url, state } = buildAuthUrl({ appId: cfg.appId, redirectUri });

  // Связываем state с sessionToken чтобы в callback знать кому вернуть результат
  // sessionToken передаём фронтенду — он им будет опрашивать /api/oauth/result/:token
  // Сохраняем в state-маппинге дополнительно sessionToken
  // (buildAuthUrl уже сохранил redirectUri в pendingStates[state])
  // Добавляем sessionToken через отдельную карту
  oauthSessions.set(state, sessionToken);
  setTimeout(() => oauthSessions.delete(state), 10 * 60 * 1000);

  res.json({ url, sessionToken, redirectUri });
});

// Карта state → sessionToken
const oauthSessions = new Map();

app.get("/auth/callback", async (req, res) => {
  const { code, state, error, error_description } = req.query;

  const sessionToken = oauthSessions.get(state);

  // HTML-страница которая красиво закрывает popup
  const closePage = (title, msg, isError) => res.send(`<!DOCTYPE html>
<html><head><meta charset="UTF-8">
<style>
  body{font-family:system-ui,sans-serif;background:#0e0e10;color:#f0f0f2;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
  .box{text-align:center;padding:32px;background:#16161a;border-radius:14px;border:1px solid ${isError?'#ef4444':'#22c55e'};max-width:360px}
  .icon{font-size:40px;margin-bottom:12px}
  h2{margin:0 0 8px;font-size:18px}
  p{color:#8a8a9a;font-size:14px;margin:0 0 20px}
  .hint{font-size:12px;color:#52525e}
</style></head><body>
<div class="box">
  <div class="icon">${isError ? '❌' : '✅'}</div>
  <h2>${title}</h2>
  <p>${msg}</p>
  <div class="hint">Это окно закроется автоматически...</div>
</div>
<script>
  // Закрываем через 2 секунды
  setTimeout(() => { try { window.close(); } catch(e){} }, 2000);
</script>
</body></html>`);

  if (error) {
    if (sessionToken) setOAuthResult(sessionToken, "error", { message: error_description || error });
    oauthSessions.delete(state);
    return closePage("Ошибка авторизации", error_description || error, true);
  }

  // validateState теперь возвращает redirectUri (или null если невалидный)
  const redirectUri = validateState(state);
  if (!redirectUri) {
    if (sessionToken) setOAuthResult(sessionToken, "error", { message: "Ошибка безопасности (invalid state). Попробуйте снова." });
    return closePage("Ошибка безопасности", "Попробуйте начать авторизацию заново.", true);
  }

  oauthSessions.delete(state);

  try {
    const cfg = loadConfig();

    const { accessToken, expiresAt } = await exchangeCodeForToken({
      code, appId: cfg.appId, appSecret: cfg.appSecret, redirectUri,
    });

    const igAccounts = await getInstagramAccounts(accessToken);

    if (!igAccounts.length) {
      const msg = "Instagram Business-аккаунтов не найдено. Убедитесь что аккаунт бизнес/автор и привязан к Facebook-странице.";
      if (sessionToken) setOAuthResult(sessionToken, "error", { message: msg });
      return closePage("Аккаунт не найден", msg, true);
    }

    const saved = [];
    for (const acct of igAccounts) {
      const existing = cfg.accounts.find(a => a.pageId === acct.pageId);
      if (existing) {
        existing.token = acct.pageToken; existing.tokenExpiry = expiresAt;
        existing.followers = acct.followers; existing.avatar = acct.avatar;
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

    if (sessionToken) setOAuthResult(sessionToken, "success", { accounts: saved });
    closePage("Аккаунт подключён!", `Подключено: ${saved.map(a => "@" + (a.username || a.displayName)).join(", ")}`, false);

  } catch (err) {
    const msg = err.response?.data?.error?.message || err.message;
    console.error("OAuth error:", err.response?.data || err.message);
    if (sessionToken) setOAuthResult(sessionToken, "error", { message: msg });
    closePage("Ошибка подключения", msg, true);
  }
});

// Фронтенд опрашивает этот эндпоинт пока popup открыт
app.get("/api/oauth/result/:token", (req, res) => {
  const result = getOAuthResult(req.params.token);
  if (!result) return res.json({ status: "pending" });
  oauthResults.delete(req.params.token);
  res.json(result);
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
        const scenario = findScenario(cfg.scenarios, account.id, message || "");
        if (from?.id && commentId && scenario) {
          log("keyword", `@${account.username}`, `"${message?.slice(0,30)}" → "${scenario.name}"`);
          handleComment(account, scenario, cfg.commentReplies, from.id, commentId);
        }
      }
      if (change.field === "follows") {
        if (change.value?.id) handleFollow(account, change.value.id);
      }
    });
    entry.messaging?.forEach(event => {
      if (event.message && !event.message.is_echo && event.sender?.id)
        handleDM(account, event.sender.id, event.message?.text || "");
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
  const key = stateKey(account.id, userId);
  const state = userState.get(key) || {};
  if (state.commentReplied) return;
  const name  = await getUserName(account.token, userId);
  const reply = replies.length ? replies[Math.floor(Math.random() * replies.length)] : "Написал(а) в директ";
  await replyComment(account.token, commentId, reply);
  log("comment_reply", `@${account.username}`, reply.slice(0, 50));
  await new Promise(r => setTimeout(r, 2000));
  await sendDM(account.token, account.pageId, userId, `${name}, ${scenario.dmText}`);
  log("dm_sent", `@${account.username}`, `DM → ${userId}`);
  const link = scenario.link || account.link || "";
  const isFollower = (userState.get(key) || {}).isFollower;
  await new Promise(r => setTimeout(r, 2500));
  if (isFollower && link) {
    await sendDM(account.token, account.pageId, userId, `${name}, вот ваша ссылка:\n\n${link}`);
    userState.set(key, { ...state, commentReplied: true, linkSent: true });
    log("link_sent", `@${account.username}`, `Ссылка → ${userId}`);
  } else {
    if (link) await sendDM(account.token, account.pageId, userId,
      `${name}, подпишитесь на аккаунт и напишите "готово" — пришлю ссылку`);
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
  const key = stateKey(account.id, userId);
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
  const key = stateKey(account.id, userId);
  const state = userState.get(key) || {};
  if (!["готово", "подписался", "подписалась", "done"].includes(lower) || state.linkSent) return;
  const isFollower = (userState.get(key) || {}).isFollower;
  const name = await getUserName(account.token, userId);
  const link = account.link || "";
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
  if (!apiKey) return res.status(500).json({ error: { message: "ANTHROPIC_API_KEY не задан в .env" } });
  try {
    const response = await axios.post("https://api.anthropic.com/v1/messages", req.body, {
      headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
    });
    res.json(response.data);
  } catch (err) {
    res.status(err.response?.status || 500).json(err.response?.data || { error: { message: err.message } });
  }
});

// ─── REST API ─────────────────────────────────────────────────────────────────

app.get("/api/config", (req, res) => {
  const cfg = loadConfig();
  const autoRedirectUri = getRedirectUri(req, cfg);
  res.json({
    ...cfg,
    appSecret: cfg.appSecret ? "***" : "",
    redirectUri: cfg.redirectUri || autoRedirectUri,
    autoRedirectUri,
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
  if (redirectUri !== undefined) cfg.redirectUri = redirectUri.replace(/\/auth\/instagram\/?$/, "/auth/callback");
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
      params: { grant_type: "fb_exchange_token", client_id: cfg.appId, client_secret: cfg.appSecret, fb_exchange_token: a.token },
    });
    a.token = r.data.access_token;
    a.tokenExpiry = new Date(Date.now() + (r.data.expires_in || 5184000) * 1000).toISOString().slice(0, 10);
    saveConfig(cfg);
    res.json({ ok: true, expiry: a.tokenExpiry });
  } catch (err) {
    res.status(500).json({ error: err.response?.data || err.message });
  }
});

app.patch("/api/config/scenarios", (req, res) => {
  const cfg = loadConfig(); cfg.scenarios = req.body.scenarios; saveConfig(cfg); res.json({ ok: true });
});

app.patch("/api/config/replies", (req, res) => {
  const cfg = loadConfig(); cfg.commentReplies = req.body.replies; saveConfig(cfg); res.json({ ok: true });
});

app.get("/api/logs", (req, res) => res.json(eventLog.slice(0, 100)));
app.get("/healthz", (req, res) => res.json({ status: "ok", accounts: loadConfig().accounts.length }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  const cfg = loadConfig();
  console.log(`IG Agent: http://localhost:${PORT}`);
  console.log(`Webhook:  http://localhost:${PORT}/webhook`);
  console.log(`Verify Token: ${cfg.verifyToken}`);
});
