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
      appId: "", appSecret: "", redirectUri: "", verifyToken: "my_verify_token",
      accounts: [], scenarios: [], commentReplies: [
        "Написал(а) вам в директ, там всё подробно",
        "Отправил(а) информацию в личные сообщения",
        "В директе уже всё есть — загляните",
        "Ответил(а) в личку",
        "Написали вам — проверьте входящие",
      ],
    };
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(defaults, null, 2));
  }
  return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
}

function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

// ─── ЛОГИ И СОСТОЯНИЯ ────────────────────────────────────────────────────────
const userState = new Map();
const eventLog  = [];

function log(type, account, message) {
  const entry = { time: new Date().toISOString(), type, account, message };
  eventLog.unshift(entry);
  if (eventLog.length > 500) eventLog.pop();
  console.log("[" + entry.time + "] [" + type + "] " + account + ": " + message);
}

// ─── HELPER: отправить ответ в popup и закрыть его ───────────────────────────
function sendPopupMessage(res, type, payload) {
  const data = JSON.stringify({ type, ...payload });
  res.send(
    "<!DOCTYPE html><html><body><script>" +
    "try{window.opener&&window.opener.postMessage(" + data + ",'*');}catch(e){}" +
    "setTimeout(function(){window.close();},300);" +
    "</script><p>Закрываем окно...</p></body></html>"
  );
}

// ─── OAUTH: шаг 1 — фронтенд запрашивает URL ─────────────────────────────────
app.get("/auth/instagram", (req, res) => {
  const cfg = loadConfig();
  if (!cfg.appId) {
    return res.status(400).json({ error: "Заполните ID приложения в разделе Настройки" });
  }
  if (!cfg.appSecret) {
    return res.status(400).json({ error: "Заполните Секрет приложения в разделе Настройки" });
  }
  // Используем redirectUri из конфига, или строим автоматически
  const redirectUri = cfg.redirectUri && cfg.redirectUri.startsWith("http")
    ? cfg.redirectUri
    : req.protocol + "://" + req.get("host") + "/auth/callback";

  const { url, state } = buildAuthUrl({ appId: cfg.appId, redirectUri });
  console.log("[oauth] Redirect URI:", redirectUri);
  res.json({ url, state, redirectUri });
});

// ─── OAUTH: шаг 2 — Meta редиректит сюда с code ──────────────────────────────
app.get("/auth/callback", async (req, res) => {
  const { code, state, error, error_description } = req.query;

  // Ошибка от Meta (пользователь отказал)
  if (error) {
    return sendPopupMessage(res, "oauth_error", {
      message: error_description || error
    });
  }

  // Проверка state (в dev-режиме пропускается)
  if (!validateState(state)) {
    return sendPopupMessage(res, "oauth_error", {
      message: "Сессия устарела — нажмите «Подключить через Meta» ещё раз"
    });
  }

  if (!code) {
    return sendPopupMessage(res, "oauth_error", { message: "Код авторизации не получен" });
  }

  try {
    const cfg = loadConfig();
    const redirectUri = cfg.redirectUri && cfg.redirectUri.startsWith("http")
      ? cfg.redirectUri
      : req.protocol + "://" + req.get("host") + "/auth/callback";

    // Меняем code на токен
    const { accessToken, expiresAt } = await exchangeCodeForToken({
      code, appId: cfg.appId, appSecret: cfg.appSecret, redirectUri,
    });

    // Получаем Instagram-аккаунты
    const igAccounts = await getInstagramAccounts(accessToken);

    if (!igAccounts.length) {
      return sendPopupMessage(res, "oauth_error", {
        message: "Instagram Business-аккаунтов не найдено.\n\nПроверьте:\n1. Аккаунт переведён в «Бизнес» или «Автор»\n2. Instagram привязан к Facebook-странице\n3. Вы выдали все запрошенные разрешения"
      });
    }

    // Сохраняем аккаунты
    const saved = [];
    for (const acct of igAccounts) {
      const existing = cfg.accounts.find(a => a.pageId === acct.pageId);
      if (existing) {
        // Обновляем токен существующего
        existing.token       = acct.pageToken;
        existing.tokenExpiry = expiresAt;
        existing.followers   = acct.followers;
        existing.avatar      = acct.avatar;
        if (acct.username) existing.username = acct.username;
        saved.push(existing);
      } else {
        const newAcct = {
          id:          Date.now() + Math.floor(Math.random() * 9999),
          username:    acct.username    || "",
          displayName: acct.displayName || "",
          pageId:      acct.pageId,
          igId:        acct.igId,
          token:       acct.pageToken,
          tokenExpiry: expiresAt,
          followers:   acct.followers,
          avatar:      acct.avatar,
          active:      true,
          link:        "",
        };
        cfg.accounts.push(newAcct);
        saved.push(newAcct);
      }
      // Подписываем страницу на webhook
      await subscribePageWebhook(acct.pageId, acct.pageToken);
    }

    saveConfig(cfg);
    log("oauth", igAccounts.map(a => "@" + (a.username || a.displayName)).join(", "), "Подключено: " + igAccounts.length);
    sendPopupMessage(res, "oauth_success", {
      accounts: saved.map(a => ({ id: a.id, username: a.username, displayName: a.displayName }))
    });

  } catch (err) {
    const metaErr = err.response?.data?.error;
    let msg = err.message;
    if (metaErr) {
      msg = metaErr.message || JSON.stringify(metaErr);
      // Частые ошибки Meta — переводим
      if (msg.includes("redirect_uri")) {
        msg = "Ошибка redirect_uri: URI в настройках должен точно совпадать с тем, что прописан в Meta App → Facebook Login → Допустимые URI перенаправления OAuth";
      } else if (msg.includes("Invalid OAuth")) {
        msg = "Недействительный OAuth токен. Проверьте App ID и App Secret в настройках.";
      }
    }
    console.error("[oauth] Ошибка:", err.response?.data || err.message);
    sendPopupMessage(res, "oauth_error", { message: msg });
  }
});

// ─── WEBHOOK ──────────────────────────────────────────────────────────────────
app.get("/webhook", (req, res) => {
  const cfg = loadConfig();
  const { "hub.mode": mode, "hub.verify_token": token, "hub.challenge": challenge } = req.query;
  if (mode === "subscribe" && token === cfg.verifyToken) {
    console.log("[webhook] Верифицирован");
    return res.send(challenge);
  }
  res.status(403).send("Forbidden");
});

app.post("/webhook", (req, res) => {
  const cfg = loadConfig();

  if (cfg.appSecret) {
    const sig      = req.headers["x-hub-signature-256"];
    const expected = "sha256=" + crypto
      .createHmac("sha256", cfg.appSecret)
      .update(JSON.stringify(req.body))
      .digest("hex");
    if (sig && sig !== expected) return res.status(403).send("Invalid signature");
  }

  res.status(200).send("EVENT_RECEIVED");
  const body = req.body;
  if (!body.object) return;

  (body.entry || []).forEach(entry => {
    const account = cfg.accounts.find(a => a.pageId === entry.id && a.active);
    if (!account) return;

    (entry.changes || []).forEach(change => {
      if (change.field === "comments") {
        const { from, id: commentId, message } = change.value;
        const userId   = from?.id;
        const scenario = findScenario(cfg.scenarios, account.id, message || "");
        if (userId && commentId && scenario) {
          log("keyword", "@" + account.username, '"' + (message || "").slice(0, 30) + '" → "' + scenario.name + '"');
          handleComment(account, scenario, cfg.commentReplies, userId, commentId);
        }
      }
      if (change.field === "follows") {
        const userId = change.value?.id;
        if (userId) handleFollow(account, userId);
      }
    });

    (entry.messaging || []).forEach(event => {
      if (event.message && !event.message.is_echo) {
        const userId = event.sender?.id;
        const text   = event.message?.text;
        if (userId && text) handleDM(account, userId, text);
      }
    });
  });
});

// ─── АГЕНТ ───────────────────────────────────────────────────────────────────
function findScenario(scenarios, accountId, text) {
  const lower = text.toLowerCase();
  return (scenarios || []).find(s =>
    ((s.accountIds || []).map(String)).includes(String(accountId)) &&
    (s.keywords || []).some(k => lower.includes(k.toLowerCase()))
  );
}

function stateKey(accountId, userId) { return accountId + ":" + userId; }

async function getUserName(token, userId) {
  try {
    const r = await axios.get("https://graph.facebook.com/v19.0/" + userId, {
      params: { fields: "name", access_token: token },
    });
    return r.data.name || "друг";
  } catch { return "друг"; }
}

async function replyComment(token, commentId, text) {
  try {
    await axios.post("https://graph.facebook.com/v19.0/" + commentId + "/replies",
      { message: text }, { params: { access_token: token } });
  } catch (e) { console.error("[reply]", e.response?.data?.error?.message || e.message); }
}

async function sendDM(token, pageId, userId, text) {
  try {
    await axios.post("https://graph.facebook.com/v19.0/" + pageId + "/messages",
      { recipient: { id: userId }, message: { text }, messaging_type: "RESPONSE" },
      { params: { access_token: token } });
  } catch (e) { console.error("[dm]", e.response?.data?.error?.message || e.message); }
}

async function handleComment(account, scenario, replies, userId, commentId) {
  const key   = stateKey(account.id, userId);
  const state = userState.get(key) || {};
  if (state.commentReplied) return;

  const name  = await getUserName(account.token, userId);
  const reply = replies && replies.length
    ? replies[Math.floor(Math.random() * replies.length)]
    : "Написал(а) в директ";

  await replyComment(account.token, commentId, reply);
  log("comment_reply", "@" + account.username, reply.slice(0, 50));

  await new Promise(r => setTimeout(r, 2000));
  const dmText = scenario.dmText ? name + ", " + scenario.dmText : "Привет, " + name + "! Написали вам в директ.";
  await sendDM(account.token, account.pageId, userId, dmText);
  log("dm_sent", "@" + account.username, "DM → " + userId);

  const link       = scenario.link || account.link || "";
  const isFollower = (userState.get(key) || {}).isFollower;

  await new Promise(r => setTimeout(r, 2500));
  if (isFollower && link) {
    await sendDM(account.token, account.pageId, userId, name + ", вот ваша ссылка:\n\n" + link);
    userState.set(key, Object.assign({}, state, { commentReplied: true, linkSent: true }));
    log("link_sent", "@" + account.username, "Ссылка → " + userId);
  } else {
    if (link) {
      await sendDM(account.token, account.pageId, userId,
        name + ", подпишитесь на аккаунт и напишите «готово» — пришлю ссылку");
    }
    let followUpTimer = null;
    if (scenario.followUp && link) {
      followUpTimer = setTimeout(async () => {
        const cur = userState.get(key) || {};
        if (!cur.linkSent) {
          if (cur.isFollower) {
            await sendDM(account.token, account.pageId, userId, name + ", вот ваша ссылка:\n\n" + link);
            userState.set(key, Object.assign({}, cur, { linkSent: true }));
            log("link_sent", "@" + account.username, "Follow-up ссылка → " + userId);
          } else {
            await sendDM(account.token, account.pageId, userId,
              name + ", напишите «готово» после подписки — пришлю материалы");
          }
        }
      }, 60 * 60 * 1000);
    }
    userState.set(key, Object.assign({}, state, { commentReplied: true, followUpTimer }));
  }
}

async function handleFollow(account, userId) {
  const key   = stateKey(account.id, userId);
  const state = userState.get(key) || {};
  userState.set(key, Object.assign({}, state, { isFollower: true }));
  log("follow", "@" + account.username, "Новый подписчик " + userId);

  if (state.commentReplied && !state.linkSent && account.link) {
    const name = await getUserName(account.token, userId);
    await sendDM(account.token, account.pageId, userId, name + ", вот ваша ссылка:\n\n" + account.link);
    if (state.followUpTimer) clearTimeout(state.followUpTimer);
    userState.set(key, Object.assign({}, userState.get(key), { linkSent: true }));
    log("link_sent", "@" + account.username, "Ссылка после подписки → " + userId);
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
    await sendDM(account.token, account.pageId, userId, name + ", вот ваша ссылка:\n\n" + link);
    userState.set(key, Object.assign({}, state, { linkSent: true }));
    log("link_sent", "@" + account.username, "Ссылка по «готово» → " + userId);
  } else if (!isFollower) {
    await sendDM(account.token, account.pageId, userId,
      name + ", пока подписку не вижу — попробуйте через минуту");
  }
}

// ─── REST API ─────────────────────────────────────────────────────────────────

// ─── AI ПРОКСИ ───────────────────────────────────────────────────────────────
// FIX: OpenAI API вызывается через сервер, а не напрямую из браузера
app.post("/api/ai", async (req, res) => {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: { message: "OPENAI_API_KEY не задан в переменных окружения (.env)" } });
  }

  let body = req.body;
  body.model = "gpt-5-mini";

  try {
    const response = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      body,
      {
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${apiKey}`,
        },
      }
    );
    res.json(response.data);
  } catch (err) {
    const errData = err.response?.data || { error: { message: err.message } };
    res.status(err.response?.status || 500).json(errData);
  }
});

app.get("/api/config", (req, res) => {
  const cfg = loadConfig();
  res.json({
    ...cfg,
    appSecret: cfg.appSecret ? "***" : "",
    accounts:  cfg.accounts.map(a => ({
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
  if (redirectUri !== undefined) cfg.redirectUri = redirectUri;
  if (verifyToken !== undefined) cfg.verifyToken = verifyToken;
  saveConfig(cfg);
  res.json({ ok: true });
});

app.patch("/api/config/account/:id", (req, res) => {
  const cfg = loadConfig();
  const a   = cfg.accounts.find(x => String(x.id) === req.params.id);
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
  const a   = cfg.accounts.find(x => String(x.id) === req.params.id);
  if (!a) return res.status(404).json({ error: "Not found" });
  try {
    const r = await axios.get("https://graph.facebook.com/v19.0/oauth/access_token", {
      params: {
        grant_type:        "fb_exchange_token",
        client_id:         cfg.appId,
        client_secret:     cfg.appSecret,
        fb_exchange_token: a.token,
      },
    });
    a.token       = r.data.access_token;
    a.tokenExpiry = new Date(Date.now() + (r.data.expires_in || 5184000) * 1000).toISOString().slice(0, 10);
    saveConfig(cfg);
    res.json({ ok: true, expiry: a.tokenExpiry });
  } catch (err) {
    res.status(500).json({ error: err.response?.data?.error?.message || err.message });
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
app.get("/healthz",  (req, res) => res.json({ status: "ok", accounts: loadConfig().accounts.length }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("IG Agent запущен: http://localhost:" + PORT));
