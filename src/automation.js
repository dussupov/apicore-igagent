import { query, getSetting } from './db.js';
import { replyToComment, privateReply } from './meta.js';

function normalize(s='') { return s.toLowerCase().trim(); }
function pickRandom(arr=[]) { return arr[Math.floor(Math.random() * arr.length)] || ''; }
function matches(rule, text) {
  const t = normalize(text);
  return (rule.keywords || []).some(k => {
    const kk = normalize(k);
    if (!kk) return false;
    if (rule.match_mode === 'exact') return t === kk;
    return t.includes(kk);
  });
}

async function rateLimitOk(accountId, limit) {
  const minute = new Date().toISOString().slice(0,16);
  const bucket = `m:${minute}`;
  const { rows } = await query(
    `INSERT INTO rate_limits(account_id,bucket,count) VALUES($1,$2,1)
     ON CONFLICT(account_id,bucket) DO UPDATE SET count=rate_limits.count+1
     RETURNING count`, [accountId, bucket]
  );
  return rows[0].count <= limit;
}

export async function processCommentEvent(event) {
  const commentId = event?.value?.id || event?.value?.comment_id;
  const mediaId = event?.value?.media?.id || event?.value?.media_id;
  const text = event?.value?.text || event?.value?.message || '';
  const from = event?.value?.from || event?.value?.user || {};
  const igBusinessId = event?.value?.ig_id || event?.value?.owner_id || event?.value?.media?.owner?.id;

  const { rows: accounts } = await query('SELECT * FROM instagram_accounts WHERE is_active=TRUE');
  for (const account of accounts) {
    const { rows: rules } = await query('SELECT * FROM automation_rules WHERE account_id=$1 AND enabled=TRUE ORDER BY id DESC', [account.id]);
    const rule = rules.find(r => matches(r, text));
    if (!rule) continue;

    const ok = await rateLimitOk(account.id, rule.rate_limit_per_minute || Number(await getSetting('DEFAULT_RATE_LIMIT_PER_MINUTE','15')));
    const publicReply = pickRandom(rule.public_replies || []);
    const dmText = [rule.dm_message, rule.target_url].filter(Boolean).join('\n\n');
    let status = 'matched';
    let error = null;

    try {
      if (!ok) throw new Error('Rate limit exceeded for this account/minute');
      if (!commentId) throw new Error('No comment id in webhook event');
      if (rule.use_public_reply && publicReply) await replyToComment(commentId, publicReply, account.access_token);
      if (rule.use_private_reply && dmText) await privateReply(commentId, dmText, account.access_token);
      status = 'sent';
    } catch (e) {
      status = 'error';
      error = e?.response?.data ? JSON.stringify(e.response.data) : e.message;
    }

    await query(
      `INSERT INTO automation_logs(account_id,rule_id,event_type,ig_user_id,ig_username,media_id,comment_id,comment_text,selected_public_reply,dm_text,status,error,raw_event)
       VALUES($1,$2,'comment',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [account.id, rule.id, from.id || null, from.username || from.name || null, mediaId || null, commentId || null, text, publicReply, dmText, status, error, event]
    );
    return { matched: true, status, account: account.username, rule: rule.name, error };
  }
  await query(`INSERT INTO automation_logs(event_type,comment_text,status,raw_event) VALUES('comment',$1,'ignored',$2)`, [text, event]);
  return { matched: false, status: 'ignored' };
}
