const axios = require("axios");
const db = require("./db");

const BASE = "https://graph.facebook.com/v19.0";

// userState хранится в БД для персистентности
function getState(key) {
  const row = db.prepare("SELECT data FROM user_states WHERE key=?").get(key);
  return row ? JSON.parse(row.data) : {};
}
function setState(key, data) {
  db.prepare("INSERT OR REPLACE INTO user_states (key,data,updated_at) VALUES (?,?,datetime('now'))")
    .run(key, JSON.stringify(data));
}

function log(userId, account, type, message) {
  console.log("[" + type + "] @" + account + ": " + message);
  db.prepare("INSERT INTO event_logs (user_id,account,type,message) VALUES (?,?,?,?)")
    .run(userId || null, account, type, message);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function randomReply(replies) {
  if (!replies.length) return "Написал(а) в директ";
  return replies[Math.floor(Math.random() * replies.length)];
}

function findScenario(scenarios, accountId, text) {
  const lower = text.toLowerCase();
  return scenarios.find(s =>
    JSON.parse(s.account_ids || "[]").map(String).includes(String(accountId)) &&
    JSON.parse(s.keywords || "[]").some(k => lower.includes(k.toLowerCase()))
  );
}

// ─── REPLY TO COMMENT ────────────────────────────────────────────────────────
async function replyToComment(token, commentId, text) {
  try {
    await axios.post(BASE + "/" + commentId + "/replies",
      { message: text },
      { params: { access_token: token } }
    );
  } catch (e) {
    console.error("[reply_comment]", e.response?.data?.error?.message || e.message);
  }
}

// ─── SEND DM ─────────────────────────────────────────────────────────────────
async function sendDM(token, igAccountId, recipientId, text) {
  try {
    await axios.post(BASE + "/" + igAccountId + "/messages",
      {
        recipient: { id: recipientId },
        message: { text }
      },
      { params: { access_token: token } }
    );
  } catch (e) {
    console.error("[send_dm]", e.response?.data?.error?.message || e.message);
  }
}

// ─── CHECK FOLLOWER ──────────────────────────────────────────────────────────
async function isFollower(token, igAccountId, userId) {
  try {
    const r = await axios.get(BASE + "/" + igAccountId + "/followers", {
      params: { access_token: token, fields: "id", limit: 1 }
    });
    // Simplified check — in production use /{ig-user-id} with fields=followed_by_count
    // or check via /{ig-user-id}?fields=is_user_follow_business
    const check = await axios.get(BASE + "/" + userId, {
      params: { access_token: token, fields: "id" }
    });
    return !!check.data?.id;
  } catch { return false; }
}

// ─── MAIN HANDLER ────────────────────────────────────────────────────────────
async function handleKeywordComment(account, commentId, commentText, fromUserId, fromUsername) {
  const scenarios = db.prepare("SELECT * FROM scenarios WHERE user_id=?").all(account.user_id);
  const scenario  = findScenario(scenarios, account.id, commentText);
  if (!scenario) return;

  const key   = account.id + ":" + String(fromUserId);
  const state = getState(key);
  if (state.replied) return;

  const replies = db.prepare("SELECT text FROM replies WHERE user_id=?").all(account.user_id).map(r => r.text);
  const reply   = randomReply(replies);

  // 1. Ответить на комментарий
  await replyToComment(account.access_token, commentId, "@" + fromUsername + " " + reply);
  log(account.user_id, account.username, "comment_reply", reply.slice(0, 60));

  await sleep(2000);

  // 2. Отправить DM
  const name   = fromUsername || "друг";
  const dmText = (scenario.dm_text || "Привет! Написал(а) в директ.").replace(/\{\{name\}\}/g, name);
  await sendDM(account.access_token, account.ig_user_id, fromUserId, dmText);
  log(account.user_id, account.username, "dm_sent", "DM → @" + name);

  await sleep(2500);

  // 3. Проверить подписку
  const follower = await isFollower(account.access_token, account.ig_user_id, fromUserId);
  const link     = account.link || "";

  if (follower && link) {
    await sendDM(account.access_token, account.ig_user_id, fromUserId,
      name + ", вот ваша ссылка:\n\n" + link);
    setState(key, { replied: true, linkSent: true });
    log(account.user_id, account.username, "link_sent", "→ @" + name);
  } else {
    if (link) {
      await sendDM(account.access_token, account.ig_user_id, fromUserId,
        name + ", подпишитесь на аккаунт и напишите «готово» — пришлю ссылку 🎁");
    }
    setState(key, { replied: true, linkSent: false, name, link });

    if (scenario.follow_up && link) {
      setTimeout(async () => {
        const cur = getState(key);
        if (cur.linkSent) return;
        const nowFollower = await isFollower(account.access_token, account.ig_user_id, fromUserId);
        if (nowFollower) {
          await sendDM(account.access_token, account.ig_user_id, fromUserId, name + ", вот ваша ссылка:\n\n" + link);
          setState(key, { ...cur, linkSent: true });
          log(account.user_id, account.username, "link_sent", "Follow-up → @" + name);
        } else {
          await sendDM(account.access_token, account.ig_user_id, fromUserId,
            name + ", напишите «готово» после подписки — пришлю материалы");
        }
      }, 60 * 60 * 1000);
    }
  }
}

async function handleIncomingDM(account, fromUserId, fromUsername, text) {
  const lower = text.toLowerCase().trim();
  if (!["готово", "подписался", "подписалась", "done"].includes(lower)) return;

  const key  = account.id + ":" + String(fromUserId);
  const state = getState(key);
  if (!state.replied || state.linkSent) return;

  const link = state.link || account.link || "";
  if (!link) return;

  const follower = await isFollower(account.access_token, account.ig_user_id, fromUserId);
  const name     = fromUsername || state.name || "друг";

  if (follower) {
    await sendDM(account.access_token, account.ig_user_id, fromUserId, name + ", вот ваша ссылка:\n\n" + link);
    setState(key, { ...state, linkSent: true });
    log(account.user_id, account.username, "link_sent", "По «готово» → @" + name);
  } else {
    await sendDM(account.access_token, account.ig_user_id, fromUserId,
      name + ", пока подписку не вижу — попробуйте через минуту");
  }
}

module.exports = { handleKeywordComment, handleIncomingDM, log };
