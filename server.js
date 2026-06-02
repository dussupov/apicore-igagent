const express  = require("express");
const axios    = require("axios");
const crypto   = require("crypto");
const bcrypt   = require("bcryptjs");
const jwt      = require("jsonwebtoken");
const path     = require("path");
const { v4: uuid } = require("uuid");

const db = require("./db");
const { handleKeywordComment, handleIncomingDM, log } = require("./agent");

const app    = express();
const SECRET = process.env.JWT_SECRET || "ig_agent_secret_change_in_prod";
const BASE   = "https://graph.facebook.com/v19.0";

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ─── MIDDLEWARE ───────────────────────────────────────────────────────────────
function auth(req, res, next) {
  const token = (req.headers.authorization || "").replace("Bearer ", "");
  if (!token) return res.status(401).json({ error: "Не авторизован" });
  try { req.user = jwt.verify(token, SECRET); next(); }
  catch { res.status(401).json({ error: "Токен недействителен" }); }
}

// ─── AUTH ─────────────────────────────────────────────────────────────────────
app.post("/api/register", async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password)   return res.status(400).json({ error: "Заполните email и пароль" });
  if (password.length < 6)   return res.status(400).json({ error: "Пароль минимум 6 символов" });
  if (db.prepare("SELECT id FROM users WHERE email=?").get(email))
    return res.status(400).json({ error: "Email уже зарегистрирован" });

  const id   = uuid();
  const hash = await bcrypt.hash(password, 10);
  db.prepare("INSERT INTO users (id,email,password) VALUES (?,?,?)").run(id, email, hash);

  const defaultReplies = [
    "Написал(а) вам в директ, там всё подробно",
    "Отправил(а) информацию в личные сообщения",
    "В директе уже всё есть — загляните",
    "Ответил(а) в личку",
    "Написали вам — проверьте входящие",
  ];
  defaultReplies.forEach(text =>
    db.prepare("INSERT INTO replies (id,user_id,text) VALUES (?,?,?)").run(uuid(), id, text)
  );

  const token = jwt.sign({ id, email }, SECRET, { expiresIn: "30d" });
  res.json({ token, email });
});

app.post("/api/login", async (req, res) => {
  const { email, password } = req.body;
  const user = db.prepare("SELECT * FROM users WHERE email=?").get(email);
  if (!user) return res.status(400).json({ error: "Email не найден" });
  if (!await bcrypt.compare(password, user.password))
    return res.status(400).json({ error: "Неверный пароль" });
  const token = jwt.sign({ id: user.id, email: user.email }, SECRET, { expiresIn: "30d" });
  res.json({ token, email: user.email });
});

// ─── FB SDK TOKEN EXCHANGE ────────────────────────────────────────────────────
// Фронтенд получает short-lived token через FB SDK и передаёт сюда
// Сервер меняет его на long-lived и сохраняет аккаунт
app.post("/api/accounts/connect", auth, async (req, res) => {
  const { accessToken, userID } = req.body;
  if (!accessToken || !userID)
    return res.status(400).json({ error: "accessToken и userID обязательны" });

  const cfg = loadServerConfig();
  if (!cfg.appId || !cfg.appSecret)
    return res.status(400).json({ error: "Заполните App ID и App Secret в настройках сервера (config.json)" });

  try {
    // 1. Short-lived → long-lived token (60 дней)
    const longRes = await axios.get(BASE + "/oauth/access_token", {
      params: {
        grant_type:        "fb_exchange_token",
        client_id:         cfg.appId,
        client_secret:     cfg.appSecret,
        fb_exchange_token: accessToken,
      },
    });
    const longToken  = longRes.data.access_token;
    const expiresIn  = longRes.data.expires_in || 5184000;
    const tokenExpiry = new Date(Date.now() + expiresIn * 1000).toISOString().slice(0, 10);

    // 2. Получаем FB-страницы пользователя
    const pagesRes = await axios.get(BASE + "/me/accounts", {
      params: { access_token: longToken, fields: "id,name,access_token,instagram_business_account" },
    });
    const pages = pagesRes.data.data || [];

    if (!pages.length)
      return res.status(400).json({ error: "Нет Facebook-страниц. Создайте страницу и привяжите Instagram Business аккаунт." });

    const saved = [];
    for (const page of pages) {
      if (!page.instagram_business_account) continue;
      const igId = page.instagram_business_account.id;

      // 3. Данные Instagram аккаунта
      let igData = {};
      try {
        const r = await axios.get(BASE + "/" + igId, {
          params: { fields: "id,username,name,profile_picture_url", access_token: page.access_token },
        });
        igData = r.data;
      } catch (e) {
        console.warn("[connect] Не удалось получить IG данные:", e.message);
      }

      // 4. Сохраняем или обновляем
      const existing = db.prepare("SELECT * FROM ig_accounts WHERE user_id=? AND ig_user_id=?")
        .get(req.user.id, igId);

      if (existing) {
        db.prepare("UPDATE ig_accounts SET access_token=?,token_expiry=?,active=1 WHERE id=?")
          .run(page.access_token, tokenExpiry, existing.id);
        saved.push({ ...existing, access_token: "***", username: existing.username });
      } else {
        const id = uuid();
        db.prepare(`INSERT INTO ig_accounts
          (id,user_id,ig_user_id,username,full_name,avatar,page_id,page_name,access_token,token_expiry)
          VALUES (?,?,?,?,?,?,?,?,?,?)`)
          .run(id, req.user.id, igId,
            igData.username || "", igData.name || "",
            igData.profile_picture_url || "",
            page.id, page.name, page.access_token, tokenExpiry);

        // Подписываем страницу на webhook
        try {
          await axios.post(BASE + "/" + page.id + "/subscribed_apps",
            { subscribed_fields: ["comments", "messages"] },
            { params: { access_token: page.access_token } }
          );
        } catch (e) {
          console.warn("[webhook] Ошибка подписки:", e.response?.data?.error?.message || e.message);
        }

        saved.push({ id, username: igData.username, full_name: igData.name });
        log(req.user.id, igData.username || page.name, "login",
          "Аккаунт подключён через Facebook SDK");
      }
    }

    if (!saved.length)
      return res.status(400).json({
        error: "Instagram Business-аккаунт не найден.\n\nПроверьте:\n1. Аккаунт переведён в «Бизнес» или «Автор»\n2. Instagram привязан к Facebook-странице"
      });

    res.json({ ok: true, accounts: saved });
  } catch (e) {
    const msg = e.response?.data?.error?.message || e.message;
    console.error("[connect]", msg);
    res.status(500).json({ error: msg });
  }
});

// ─── ACCOUNTS ─────────────────────────────────────────────────────────────────
app.get("/api/accounts", auth, (req, res) => {
  const rows = db.prepare(
    "SELECT id,ig_user_id,username,full_name,avatar,page_name,token_expiry,active,link FROM ig_accounts WHERE user_id=?"
  ).all(req.user.id);
  res.json(rows.map(a => {
    const exp  = new Date(a.token_expiry);
    const days = Math.ceil((exp - Date.now()) / 86400000);
    return { ...a, tokenDays: isNaN(days) ? null : days };
  }));
});

app.patch("/api/accounts/:id", auth, (req, res) => {
  const a = db.prepare("SELECT * FROM ig_accounts WHERE id=? AND user_id=?").get(req.params.id, req.user.id);
  if (!a) return res.status(404).json({ error: "Не найдено" });
  if (req.body.active !== undefined)
    db.prepare("UPDATE ig_accounts SET active=? WHERE id=?").run(req.body.active ? 1 : 0, req.params.id);
  if (req.body.link !== undefined)
    db.prepare("UPDATE ig_accounts SET link=? WHERE id=?").run(req.body.link, req.params.id);
  res.json({ ok: true });
});

app.delete("/api/accounts/:id", auth, (req, res) => {
  db.prepare("DELETE FROM ig_accounts WHERE id=? AND user_id=?").run(req.params.id, req.user.id);
  res.json({ ok: true });
});

// ─── SCENARIOS ────────────────────────────────────────────────────────────────
app.get("/api/scenarios", auth, (req, res) => {
  const rows = db.prepare("SELECT * FROM scenarios WHERE user_id=?").all(req.user.id);
  res.json(rows.map(s => ({
    ...s,
    keywords:    JSON.parse(s.keywords    || "[]"),
    account_ids: JSON.parse(s.account_ids || "[]"),
  })));
});

app.post("/api/scenarios", auth, (req, res) => {
  const id = uuid();
  const { name, keywords, dm_text, follow_up, account_ids } = req.body;
  db.prepare("INSERT INTO scenarios (id,user_id,name,keywords,dm_text,follow_up,account_ids) VALUES (?,?,?,?,?,?,?)")
    .run(id, req.user.id, name || "Новый сценарий",
      JSON.stringify(keywords || []), dm_text || "", follow_up ? 1 : 0,
      JSON.stringify(account_ids || []));
  res.json({ ok: true, id });
});

app.put("/api/scenarios/:id", auth, (req, res) => {
  const s = db.prepare("SELECT * FROM scenarios WHERE id=? AND user_id=?").get(req.params.id, req.user.id);
  if (!s) return res.status(404).json({ error: "Не найдено" });
  const { name, keywords, dm_text, follow_up, account_ids } = req.body;
  db.prepare("UPDATE scenarios SET name=?,keywords=?,dm_text=?,follow_up=?,account_ids=? WHERE id=?")
    .run(name, JSON.stringify(keywords || []), dm_text, follow_up ? 1 : 0,
      JSON.stringify(account_ids || []), req.params.id);
  res.json({ ok: true });
});

app.delete("/api/scenarios/:id", auth, (req, res) => {
  db.prepare("DELETE FROM scenarios WHERE id=? AND user_id=?").run(req.params.id, req.user.id);
  res.json({ ok: true });
});

// ─── REPLIES ──────────────────────────────────────────────────────────────────
app.get("/api/replies", auth, (req, res) => {
  res.json(db.prepare("SELECT * FROM replies WHERE user_id=?").all(req.user.id));
});
app.post("/api/replies", auth, (req, res) => {
  const id = uuid();
  db.prepare("INSERT INTO replies (id,user_id,text) VALUES (?,?,?)").run(id, req.user.id, req.body.text);
  res.json({ ok: true, id });
});
app.put("/api/replies/:id", auth, (req, res) => {
  db.prepare("UPDATE replies SET text=? WHERE id=? AND user_id=?").run(req.body.text, req.params.id, req.user.id);
  res.json({ ok: true });
});
app.delete("/api/replies/:id", auth, (req, res) => {
  db.prepare("DELETE FROM replies WHERE id=? AND user_id=?").run(req.params.id, req.user.id);
  res.json({ ok: true });
});

// ─── LOGS ─────────────────────────────────────────────────────────────────────
app.get("/api/logs", auth, (req, res) => {
  res.json(db.prepare("SELECT * FROM event_logs WHERE user_id=? ORDER BY id DESC LIMIT 100").all(req.user.id));
});

// ─── SERVER CONFIG (appId/appSecret) ─────────────────────────────────────────
const fs   = require("fs");
const CONF = path.join(__dirname, "config.json");

function loadServerConfig() {
  if (!fs.existsSync(CONF)) {
    fs.writeFileSync(CONF, JSON.stringify({ appId: "", appSecret: "", verifyToken: "ig_verify_token" }, null, 2));
  }
  return JSON.parse(fs.readFileSync(CONF, "utf8"));
}

app.get("/api/server-config", auth, (req, res) => {
  const c = loadServerConfig();
  res.json({ appId: c.appId, verifyToken: c.verifyToken, hasSecret: !!c.appSecret });
});

app.post("/api/server-config", auth, (req, res) => {
  const c = loadServerConfig();
  if (req.body.appId       !== undefined) c.appId       = req.body.appId;
  if (req.body.appSecret   !== undefined) c.appSecret   = req.body.appSecret;
  if (req.body.verifyToken !== undefined) c.verifyToken = req.body.verifyToken;
  fs.writeFileSync(CONF, JSON.stringify(c, null, 2));
  res.json({ ok: true });
});

// Публичный эндпоинт для FB SDK — отдаём appId фронтенду
app.get("/api/public/app-id", (req, res) => {
  const c = loadServerConfig();
  res.json({ appId: c.appId });
});

// ─── WEBHOOK ─────────────────────────────────────────────────────────────────
app.get("/webhook", (req, res) => {
  const c = loadServerConfig();
  const { "hub.mode": mode, "hub.verify_token": token, "hub.challenge": challenge } = req.query;
  if (mode === "subscribe" && token === c.verifyToken) {
    console.log("[webhook] Верифицирован");
    return res.send(challenge);
  }
  res.status(403).send("Forbidden");
});

app.post("/webhook", (req, res) => {
  res.status(200).send("EVENT_RECEIVED");
  const body = req.body;
  if (!body.object) return;

  (body.entry || []).forEach(entry => {
    // Находим аккаунт по page_id
    const account = db.prepare("SELECT * FROM ig_accounts WHERE page_id=? AND active=1").get(entry.id);
    if (!account) return;

    // Комментарии
    (entry.changes || []).forEach(change => {
      if (change.field === "comments") {
        const { from, id: commentId, text } = change.value;
        if (from && commentId && text) {
          handleKeywordComment(account, commentId, text, from.id, from.username);
        }
      }
    });

    // Входящие DM
    (entry.messaging || []).forEach(event => {
      if (event.message && !event.message.is_echo) {
        const text = event.message?.text;
        const from = event.sender;
        if (from && text) {
          handleIncomingDM(account, from.id, from.username || "", text);
        }
      }
    });
  });
});

app.get("/healthz", (req, res) => res.json({ status: "ok" }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("IG Agent v3: http://localhost:" + PORT));
