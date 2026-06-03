import { query, getSetting } from './db.js';
import { replyToComment, privateReply, sendInstagramMessage, getCommentDetails, getMessageDetails } from './meta.js';

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
  return String(keyword).split(/[\n,;]+/).map(normalize).filter(Boolean);
}

function pickRandom(arr = []) { return arr[Math.floor(Math.random() * arr.length)] || ''; }

function apiError(err) {
  return err?.response?.data ? JSON.stringify(err.response.data) : (err?.message || String(err));
}

function isMetaSampleEvent(payload, extracted = {}) {
  const text = normalize(extracted.text || '');
  const raw = JSON.stringify(payload || {}).toLowerCase();
  return text === 'this is an example' ||
    String(extracted.commentId || '').startsWith('test_') ||
    raw.includes('this is an example') ||
    raw.includes('"test"');
}

function matches(rule, text) {
  const t = normalize(text);
  const keywords = (rule.keywords || []).flatMap(keywordVariants);
  const checked = [];
  for (const kk of keywords) {
    checked.push(kk);
    if (!kk) continue;
    if (rule.match_mode === 'exact') {
      if (t === kk) return { ok: true, keyword: kk, checked };
    } else if (t.includes(kk)) {
      return { ok: true, keyword: kk, checked };
    }
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

function firstNonEmpty(...vals) {
  for (const v of vals) {
    if (v !== undefined && v !== null && String(v).trim() !== '') return v;
  }
  return null;
}

function walkObjects(root, limit = 200) {
  const out = [];
  const seen = new Set();
  function walk(x) {
    if (!x || typeof x !== 'object' || seen.has(x) || out.length > limit) return;
    seen.add(x);
    out.push(x);
    for (const v of Object.values(x)) {
      if (v && typeof v === 'object') {
        if (Array.isArray(v)) v.forEach(walk); else walk(v);
      }
    }
  }
  walk(root);
  return out;
}

function extractCommentEvent(changeOrEvent) {
  const value = changeOrEvent?.value || changeOrEvent || {};
  const entryId = changeOrEvent?.entry_id || changeOrEvent?.id || null;
  const objects = walkObjects(value);
  const possibleCommentObj = objects.find(o => o.comment && typeof o.comment === 'object')?.comment || {};
  const textObj = objects.find(o => typeof o.text === 'string' || typeof o.message === 'string') || {};
  const idObj = objects.find(o => o.comment_id || o.commentId) || objects.find(o => o.id && (o.text || o.message || o.from || o.username)) || value;
  const mediaObj = objects.find(o => o.media && typeof o.media === 'object')?.media || objects.find(o => o.media_id || o.mediaId || o.post_id || o.media?.id) || {};
  const fromObj = objects.find(o => o.from && typeof o.from === 'object')?.from || objects.find(o => o.user && typeof o.user === 'object')?.user || objects.find(o => o.username || o.user_id) || {};

  return {
    value,
    commentId: firstNonEmpty(value.comment_id, value.commentId, possibleCommentObj.id, possibleCommentObj.comment_id, idObj.comment_id, idObj.commentId, (idObj !== value ? idObj.id : null), value.id),
    mediaId: firstNonEmpty(value.media_id, value.mediaId, value.post_id, value.media?.id, mediaObj.id, mediaObj.media_id, mediaObj.mediaId, mediaObj.post_id),
    text: firstNonEmpty(value.text, value.message, value.comment?.text, value.comment?.message, possibleCommentObj.text, possibleCommentObj.message, textObj.text, textObj.message) || '',
    from: value.from || value.user || value.sender || fromObj || {},
    igBusinessId: firstNonEmpty(value.ig_id, value.owner_id, value.user_id, value.recipient?.id, value.media?.owner?.id, entryId),
    parserDebug: {
      topKeys: Object.keys(value || {}),
      objectCount: objects.length,
      textFound: Boolean(firstNonEmpty(value.text, value.message, value.comment?.text, value.comment?.message, possibleCommentObj.text, possibleCommentObj.message, textObj.text, textObj.message)),
      idFound: Boolean(firstNonEmpty(value.comment_id, value.commentId, possibleCommentObj.id, possibleCommentObj.comment_id, idObj.comment_id, idObj.commentId, idObj.id, value.id))
    }
  };
}


function extractMessageEvent(msg) {
  const message = msg?.message || msg?.messages?.[0] || {};
  const messageEdit = msg?.message_edit || message?.message_edit || null;
  const postback = msg?.postback || message?.postback || {};
  const referral = msg?.referral || message?.referral || postback?.referral || {};
  const quickReply = message?.quick_reply || msg?.quick_reply || {};
  const reaction = msg?.reaction || message?.reaction || {};
  const read = msg?.read || null;
  const delivery = msg?.delivery || null;
  const attachments = Array.isArray(message?.attachments) ? message.attachments : (Array.isArray(msg?.attachments) ? msg.attachments : []);

  // Instagram/Messenger webhooks have several shapes depending on event type and API mode.
  // We deliberately collect many candidates instead of assuming only message.text.
  const textCandidates = [
    message.text,
    message.message,
    message.body,
    msg.text,
    msg.message_text,
    msg.body,
    msg?.text_data?.text,
    msg?.message_data?.text,
    quickReply.payload,
    quickReply.text,
    postback.payload,
    postback.title,
    referral.ref,
    referral.source,
    reaction.emoji
  ];
  const text = firstNonEmpty(...textCandidates) || '';

  let eventKind = 'message';
  if (messageEdit?.mid) eventKind = 'message_edit';
  else if (read) eventKind = 'read';
  else if (delivery) eventKind = 'delivery';
  else if (reaction?.mid || reaction?.emoji) eventKind = 'reaction';
  else if (postback?.payload || postback?.title) eventKind = 'postback';
  else if (attachments.length) eventKind = `attachment:${attachments.map(a => a.type || 'unknown').join(',')}`;
  else if (!text) eventKind = 'message_without_text';

  return {
    senderId: msg?.sender?.id || msg?.from?.id || msg?.user?.id || null,
    recipientId: msg?.recipient?.id || msg?.to?.id || msg?.entry_id || null,
    messageId: message.mid || message.id || msg?.message_id || messageEdit?.mid || null,
    text,
    eventKind,
    attachments,
    commentId: referral.comment_id || referral.comment?.id || message?.reply_to?.comment_id || message?.reply_to?.mid || null,
    raw: msg,
    parserDebug: {
      topKeys: Object.keys(msg || {}),
      messageKeys: Object.keys(message || {}),
      hasText: Boolean(text),
      eventKind,
      hasMessageEdit: Boolean(messageEdit?.mid)
    }
  };
}

async function loadEnabledRules() {
  const { rows: accounts } = await query('SELECT * FROM instagram_accounts WHERE is_active=TRUE ORDER BY id DESC');
  if (!accounts.length) return { accounts, rules: [] };
  const accountIds = accounts.map(a => a.id);
  const { rows: rules } = await query(
    `SELECT r.*, a.username AS account_username, a.ig_user_id, a.page_id, a.access_token
     FROM automation_rules r
     JOIN instagram_accounts a ON a.id = r.account_id
     WHERE r.enabled=TRUE AND a.is_active=TRUE AND r.account_id = ANY($1::int[])
     ORDER BY r.id DESC`, [accountIds]
  );
  return { accounts, rules };
}

function selectRule(rules, text) {
  const checkedRules = [];
  for (const rule of rules) {
    const m = matches(rule, text);
    checkedRules.push({ ruleId: rule.id, ruleName: rule.name, account: rule.account_username, keywords: rule.keywords || [], checked: m.checked, matchedKeyword: m.keyword });
    if (m.ok) return { selected: rule, matchInfo: m, checkedRules };
  }
  return { selected: null, matchInfo: null, checkedRules };
}

async function logIgnored(reason, event, data = {}) {
  const e = extractCommentEvent(event);
  await query(
    `INSERT INTO automation_logs(event_type,ig_user_id,ig_username,media_id,comment_id,comment_text,status,error,raw_event)
     VALUES($1,$2,$3,$4,$5,$6,'ignored',$7,$8)`,
    [data.eventType || 'comment', e.from.id || data.senderId || null, e.from.username || e.from.name || null, e.mediaId, e.commentId || data.commentId || null, e.text || data.text || '', reason, { reason, ...data, event }]
  );
  return { matched: false, status: 'ignored', reason, ...data };
}

export async function processCommentEvent(changeOrEvent, options = {}) {
  const e = extractCommentEvent(changeOrEvent);
  let { commentId, mediaId, text, from } = e;
  const simulate = Boolean(options.simulate);

  if (!simulate && isMetaSampleEvent(changeOrEvent, e)) {
    console.log('[WEBHOOK_SAMPLE_IGNORED]', { text, commentId });
    await query(`INSERT INTO automation_logs(event_type,status,error,comment_id,comment_text,raw_event) VALUES('comment','ignored','meta_sample_event_ignored',$1,$2,$3)`, [commentId || null, text || '', { event: changeOrEvent, parserDebug: e.parserDebug }]);
    return { matched: false, status: 'ignored', reason: 'meta_sample_event_ignored', sample: true };
  }

  const { accounts, rules } = await loadEnabledRules();

  // Some real Instagram API webhook payloads contain only an object/comment ID.
  // In that case fetch the comment details before keyword matching.
  if ((!text || !normalize(text)) && commentId && accounts.length) {
    const tokenAccount = accounts.find(a => a.is_active) || accounts[0];
    try {
      const details = await getCommentDetails(commentId, tokenAccount.access_token);
      if (details) {
        text = firstNonEmpty(details.text, details.message, text) || '';
        mediaId = firstNonEmpty(mediaId, details.media?.id, details.media_id);
        from = details.from || (details.username ? { username: details.username } : from);
      }
    } catch (err) {
      await query(`INSERT INTO automation_logs(event_type,status,error,comment_id,comment_text,raw_event) VALUES('comment','received',$1,$2,$3,$4)`, [`comment_details_fetch_failed: ${apiError(err)}`, commentId || null, text || '', { event: changeOrEvent, parserDebug: e.parserDebug }]);
    }
  }

  if (!text || !normalize(text)) return logIgnored('empty_comment_text', changeOrEvent, { commentId, parserDebug: e.parserDebug });

  if (!accounts.length) return logIgnored('no_active_instagram_accounts', changeOrEvent);
  if (!rules.length) return logIgnored('no_enabled_rules', changeOrEvent, { activeAccounts: accounts.map(a => a.username) });

  const { selected, matchInfo, checkedRules } = selectRule(rules, text);
  if (!selected) return logIgnored('keyword_not_matched', changeOrEvent, { text: normalize(text), checkedRules });

  const account = accounts.find(a => a.id === selected.account_id) || selected;
  const publicReply = pickRandom(selected.public_replies || []);
  const dmText = [selected.dm_message, selected.target_url].filter(Boolean).join('\n\n');
  const apiResponses = {};
  const errors = [];
  let status = simulate ? 'simulation_ok' : 'matched';

  if (!simulate) {
    const ok = await rateLimitOk(selected.account_id, selected.rate_limit_per_minute || Number(await getSetting('DEFAULT_RATE_LIMIT_PER_MINUTE', '15')));
    if (!ok) errors.push('rate_limit_exceeded');
    if (!commentId) errors.push('no_comment_id_in_webhook_event');

    if (ok && commentId) {
      if (selected.use_public_reply && publicReply) {
        try { apiResponses.publicReply = await replyToComment(commentId, publicReply, account.access_token || selected.access_token); }
        catch (err) { errors.push(`public_reply_error: ${apiError(err)}`); }
      }
      if (selected.use_private_reply && dmText) {
        try { apiResponses.privateReply = await privateReply(account.ig_user_id, commentId, dmText, account.access_token || selected.access_token); }
        catch (err) { errors.push(`private_reply_error: ${apiError(err)}`); }
      }
    }

    const hasSuccess = Boolean(apiResponses.publicReply || apiResponses.privateReply);
    status = hasSuccess ? 'sent' : 'error';
  }

  const error = errors.length ? errors.join('\n') : null;
  await query(
    `INSERT INTO automation_logs(account_id,rule_id,event_type,ig_user_id,ig_username,media_id,comment_id,comment_text,selected_public_reply,dm_text,status,error,raw_event)
     VALUES($1,$2,'comment',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [selected.account_id, selected.id, from.id || null, from.username || from.name || null, mediaId || null, commentId || null, text, publicReply, dmText, status, error, { matchedKeyword: matchInfo?.keyword, simulate, apiResponses, errors, parserDebug: e.parserDebug, event: changeOrEvent }]
  );

  return { matched: true, status, account: selected.account_username, rule: selected.name, keyword: matchInfo?.keyword, commentId, pageId: account.page_id, igUserId: account.ig_user_id, publicReply: selected.use_public_reply ? publicReply : null, privateReply: selected.use_private_reply ? dmText : null, error, apiResponses };
}

export async function processMessageEvent(msg, options = {}) {
  const e = extractMessageEvent(msg);
  const simulate = Boolean(options.simulate);
  if (isMetaSampleEvent(msg, e)) return { matched: false, status: 'ignored', reason: 'meta_sample_event_ignored' };

  // message_edit is NOT a new inbound DM. It usually contains only { message_edit: { mid } }
  // and often has no sender, recipient, or text. Treat it as a non-actionable event so it
  // does not look like a failed automation. Real auto-replies require a webhook payload with
  // messaging[].message.text and sender.id.
  if (e.eventKind === 'message_edit') {
    if ((!e.text || !normalize(e.text)) && e.messageId) {
      try {
        const { accounts } = await loadEnabledRules();
        const account = accounts.find(a => String(a.ig_user_id || '') === String(e.recipientId || '')) || accounts[0];
        if (account?.access_token) {
          const details = await getMessageDetails(e.messageId, account.access_token);
          e.text = firstNonEmpty(details?.text, details?.message, details?.body, e.text) || '';
          e.senderId = firstNonEmpty(e.senderId, details?.from?.id, details?.sender?.id);
          e.recipientId = firstNonEmpty(e.recipientId, details?.to?.data?.[0]?.id, details?.to?.id, account.ig_user_id);
          e.parserDebug.hydratedMessage = Boolean(e.text);
          e.parserDebug.hydratedKeys = Object.keys(details || {});
        }
      } catch (err) {
        e.parserDebug.hydrateError = apiError(err);
      }
    }
    if (!e.text || !normalize(e.text) || !e.senderId) {
      const reason = 'message_edit_ignored_enable_messages_webhook';
      await query(`INSERT INTO automation_logs(event_type,status,error,comment_text,ig_user_id,raw_event) VALUES('message','ignored',$1,$2,$3,$4)`, [reason, e.text || '', e.senderId, { msg, parserDebug: e.parserDebug, senderId: e.senderId, recipientId: e.recipientId, messageId: e.messageId, eventKind: e.eventKind, fix: 'In Meta Webhooks subscribe to real Instagram messages, not only message_edit/message_edits events.' }]);
      return { matched: false, status: 'ignored', reason, senderId: e.senderId, recipientId: e.recipientId, messageId: e.messageId, eventKind: e.eventKind, parserDebug: e.parserDebug };
    }
  }

  if (!e.text || !normalize(e.text)) {
    const reason = `message_without_text:${e.eventKind || 'unknown'}`;
    await query(`INSERT INTO automation_logs(event_type,status,error,comment_text,ig_user_id,raw_event) VALUES('message','ignored',$1,$2,$3,$4)`, [reason, e.text || '', e.senderId, { msg, parserDebug: e.parserDebug, senderId: e.senderId, recipientId: e.recipientId, messageId: e.messageId, eventKind: e.eventKind }]);
    return { matched: false, status: 'ignored', reason, senderId: e.senderId, recipientId: e.recipientId, messageId: e.messageId, eventKind: e.eventKind, parserDebug: e.parserDebug };
  }

  // Log visible inbound text before matching so it is obvious that Direct parsing works.
  await query(`INSERT INTO automation_logs(event_type,status,error,comment_text,ig_user_id,raw_event) VALUES('message','received','dm_text_received',$1,$2,$3)`, [e.text, e.senderId, { parserDebug: e.parserDebug, senderId: e.senderId, recipientId: e.recipientId, messageId: e.messageId, eventKind: e.eventKind }]);

  const { accounts, rules } = await loadEnabledRules();
  if (!accounts.length) return logIgnored('no_active_instagram_accounts', msg, { eventType: 'message', senderId: e.senderId, text: e.text });
  if (!rules.length) return logIgnored('no_enabled_rules', msg, { eventType: 'message', senderId: e.senderId, text: e.text });

  const recipientAccount = accounts.find(a => String(a.ig_user_id || '') === String(e.recipientId || '') || String(a.page_id || '') === String(e.recipientId || ''));
  const candidateRules = recipientAccount ? rules.filter(r => r.account_id === recipientAccount.id) : rules;
  const { selected, matchInfo, checkedRules } = selectRule(candidateRules, e.text);
  if (!selected) return logIgnored('keyword_not_matched', msg, { eventType: 'message', senderId: e.senderId, recipientId: e.recipientId, text: normalize(e.text), checkedRules, accountFiltered: Boolean(recipientAccount) });

  const account = accounts.find(a => a.id === selected.account_id) || recipientAccount || selected;
  const dmText = [selected.dm_message, selected.target_url].filter(Boolean).join('\n\n');
  const apiResponses = {};
  const errors = [];
  let status = simulate ? 'simulation_ok' : 'matched';

  if (!simulate) {
    const ok = await rateLimitOk(selected.account_id, selected.rate_limit_per_minute || Number(await getSetting('DEFAULT_RATE_LIMIT_PER_MINUTE', '15')));
    if (!ok) errors.push('rate_limit_exceeded');
    if (!e.senderId) errors.push('no_sender_id_in_message_event');
    if (!dmText) errors.push('empty_dm_template');
    if (ok && e.senderId && dmText) {
      try { apiResponses.messageReply = await sendInstagramMessage(account.ig_user_id, e.senderId, dmText, account.access_token || selected.access_token); }
      catch (err) { errors.push(`message_reply_error: ${apiError(err)}`); }
    }
    status = apiResponses.messageReply ? 'sent' : 'error';
  }

  const error = errors.length ? errors.join('\n') : null;
  await query(
    `INSERT INTO automation_logs(account_id,rule_id,event_type,ig_user_id,comment_id,comment_text,dm_text,status,error,raw_event)
     VALUES($1,$2,'message',$3,$4,$5,$6,$7,$8,$9)`,
    [selected.account_id, selected.id, e.senderId || null, e.commentId || null, e.text, dmText, status, error, { matchedKeyword: matchInfo?.keyword, simulate, apiResponses, errors, senderId: e.senderId, recipientId: e.recipientId, messageId: e.messageId, eventKind: e.eventKind, parserDebug: e.parserDebug, event: msg }]
  );
  return { matched: true, status, account: selected.account_username, rule: selected.name, keyword: matchInfo?.keyword, senderId: e.senderId, error, apiResponses };
}

export async function debugMatchComment(text = 'ремонт') {
  const { rows: accounts } = await query('SELECT id,username,is_active,ig_user_id,page_id FROM instagram_accounts ORDER BY id DESC');
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
