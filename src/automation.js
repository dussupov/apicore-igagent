import { query, getSetting } from './db.js';
import { replyToComment, privateReply } from './meta.js';

function normalize(s = '') {
  return String(s)
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/[^\p{L}\p{N}\s_-]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function keywordVariants(keyword = '') {
  return String(keyword)
    .split(/[\n,;]+/)
    .map(normalize)
    .filter(Boolean);
}

function pickRandom(arr = []) { return arr[Math.floor(Math.random() * arr.length)] || ''; }

function matches(rule, text) {
  const t = normalize(text);
  const keywords = (rule.keywords || []).flatMap(keywordVariants);
  const checked = [];
  for (const kk of keywords) {
    checked.push(kk);
    if (!kk) continue;
    if (rule.match_mode === 'exact') {
      if (t === kk) return { ok: true, keyword: kk, checked };
      continue;
    }
    // contains mode: match full phrase or a word boundary-like match for short keywords.
    if (t.includes(kk)) return { ok: true, keyword: kk, checked };
  }
  return { ok: false, keyword: null, checked };
}

async function rateLimitOk(accountId, limit) {
  const minute = new Date().toISOString().slice(0, 16);
  const bucket = `m:${minute}`;
  const { rows } = await query(
    `INSERT INTO rate_limits(account_id,bucket,count) VALUES($1,$2,1)
     ON CONFLICT(account_id,bucket) DO UPDATE SET count=rate_limits.count+1
     RETURNING count`, [accountId, bucket]
  );
  return rows[0].count <= limit;
}

function extractEvent(changeOrEvent) {
  const value = changeOrEvent?.value || changeOrEvent || {};
  const entryId = changeOrEvent?.entry_id || changeOrEvent?.id || null;
  return {
    value,
    commentId: value.id || value.comment_id || value.comment?.id || null,
    mediaId: value.media?.id || value.media_id || value.post_id || null,
    text: value.text || value.message || value.comment?.text || '',
    from: value.from || value.user || value.sender || {},
    igBusinessId: value.ig_id || value.owner_id || value.media?.owner?.id || entryId || null,
  };
}

async function logIgnored(reason, event, data = {}) {
  const e = extractEvent(event);
  const raw = { reason, ...data, event };
  await query(
    `INSERT INTO automation_logs(event_type,ig_user_id,ig_username,media_id,comment_id,comment_text,status,error,raw_event)
     VALUES('comment',$1,$2,$3,$4,$5,'ignored',$6,$7)`,
    [e.from.id || null, e.from.username || e.from.name || null, e.mediaId, e.commentId, e.text, reason, raw]
  );
  return { matched: false, status: 'ignored', reason, ...data };
}

export async function processCommentEvent(changeOrEvent) {
  const e = extractEvent(changeOrEvent);
  const { commentId, mediaId, text, from } = e;

  if (!text || !normalize(text)) {
    return logIgnored('empty_comment_text', changeOrEvent);
  }

  const { rows: accounts } = await query('SELECT * FROM instagram_accounts WHERE is_active=TRUE ORDER BY id DESC');
  if (!accounts.length) {
    return logIgnored('no_active_instagram_accounts', changeOrEvent);
  }

  const accountIds = accounts.map(a => a.id);
  const { rows: rules } = await query(
    `SELECT r.*, a.username AS account_username, a.ig_user_id, a.access_token
     FROM automation_rules r
     JOIN instagram_accounts a ON a.id = r.account_id
     WHERE r.enabled=TRUE AND a.is_active=TRUE AND r.account_id = ANY($1::int[])
     ORDER BY r.id DESC`,
    [accountIds]
  );

  if (!rules.length) {
    return logIgnored('no_enabled_rules', changeOrEvent, { activeAccounts: accounts.map(a => a.username) });
  }

  const checkedRules = [];
  let selected = null;
  let matchInfo = null;
  for (const rule of rules) {
    const m = matches(rule, text);
    checkedRules.push({ ruleId: rule.id, ruleName: rule.name, account: rule.account_username, keywords: rule.keywords || [], checked: m.checked, matchedKeyword: m.keyword });
    if (m.ok) { selected = rule; matchInfo = m; break; }
  }

  if (!selected) {
    return logIgnored('keyword_not_matched', changeOrEvent, { text: normalize(text), checkedRules });
  }

  const account = accounts.find(a => a.id === selected.account_id) || selected;
  const ok = await rateLimitOk(selected.account_id, selected.rate_limit_per_minute || Number(await getSetting('DEFAULT_RATE_LIMIT_PER_MINUTE', '15')));
  const publicReply = pickRandom(selected.public_replies || []);
  const dmText = [selected.dm_message, selected.target_url].filter(Boolean).join('\n\n');
  let status = 'matched';
  let error = null;

  try {
    if (!ok) throw new Error('Rate limit exceeded for this account/minute');
    if (!commentId) throw new Error('No comment id in webhook event');
    if (selected.use_public_reply && publicReply) await replyToComment(commentId, publicReply, account.access_token || selected.access_token);
    if (selected.use_private_reply && dmText) await privateReply(commentId, dmText, account.access_token || selected.access_token);
    status = 'sent';
  } catch (err) {
    status = 'error';
    error = err?.response?.data ? JSON.stringify(err.response.data) : (err.message || String(err));
  }

  await query(
    `INSERT INTO automation_logs(account_id,rule_id,event_type,ig_user_id,ig_username,media_id,comment_id,comment_text,selected_public_reply,dm_text,status,error,raw_event)
     VALUES($1,$2,'comment',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [selected.account_id, selected.id, from.id || null, from.username || from.name || null, mediaId || null, commentId || null, text, publicReply, dmText, status, error, { matchedKeyword: matchInfo?.keyword, event: changeOrEvent }]
  );
  return { matched: true, status, account: selected.account_username, rule: selected.name, keyword: matchInfo?.keyword, error };
}

export async function debugMatchComment(text = 'ремонт') {
  const { rows: accounts } = await query('SELECT id,username,is_active FROM instagram_accounts ORDER BY id DESC');
  const { rows: rules } = await query(`SELECT r.*, a.username account_username FROM automation_rules r JOIN instagram_accounts a ON a.id=r.account_id ORDER BY r.id DESC`);
  return {
    text,
    normalizedText: normalize(text),
    accounts,
    rules: rules.map(r => {
      const m = matches(r, text);
      return { id: r.id, name: r.name, account: r.account_username, enabled: r.enabled, keywords: r.keywords, matchMode: r.match_mode, match: m.ok, matchedKeyword: m.keyword, checkedKeywords: m.checked };
    })
  };
}
