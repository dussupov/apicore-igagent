import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import { z } from 'zod';
import { initDb, query, getSetting, setSetting, pool, databaseState, hasDatabase } from './db.js';
import { metaConfig, exchangeCodeForToken, exchangeLongLived, getPagesWithInstagram, subscribePageToApp } from './meta.js';
import { processCommentEvent, processMessageEvent, debugMatchComment } from './automation.js';

const app = express();
const asyncRoute = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
app.set('trust proxy', true);
await initDb();

app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

app.get('/healthz', async (req, res) => {
  if (!pool) {
    return res.status(200).json({ ok: true, app: 'running', database: 'not_configured', message: databaseState.message });
  }
  try {
    await query('SELECT 1');
    res.json({ ok: true, app: 'running', database: 'connected' });
  } catch (err) {
    res.status(200).json({ ok: true, app: 'running', database: 'error', message: err.message });
  }
});

app.get('/api/system', (req, res) => {
  res.json({
    app: 'running',
    database: databaseState.connected ? 'connected' : (pool ? 'error' : 'not_configured'),
    databaseMessage: databaseState.message,
    node: process.version,
    dryRun: process.env.DRY_RUN ?? 'true'
  });
});


function publicBaseUrl(req) {
  const fromSettings = process.env.APP_BASE_URL;
  const proto = req.get('x-forwarded-proto') || req.protocol || 'https';
  const host = req.get('host');
  return (fromSettings && fromSettings.trim()) ? fromSettings.trim().replace(/\/$/, '') : `${proto}://${host}`;
}

async function getRuntimeMetaConfig(req) {
  const cfg = await metaConfig();
  cfg.baseUrl = (cfg.baseUrl || publicBaseUrl(req)).replace(/\/$/, '');
  return cfg;
}

function htmlError(title, details = '', fixes = []) {
  const list = fixes.length ? `<ul>${fixes.map(x => `<li>${x}</li>`).join('')}</ul>` : '';
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>body{font-family:Inter,Arial,sans-serif;background:#0b1020;color:#eef2ff;padding:32px}a{color:#93c5fd}.card{max-width:880px;background:#111936;border:1px solid #26345f;border-radius:18px;padding:24px}.err{color:#fca5a5;white-space:pre-wrap;background:#1f2937;padding:14px;border-radius:12px}.ok{color:#86efac}</style></head><body><div class="card"><h1>${title}</h1>${details?`<div class="err">${details}</div>`:''}${list}<p><a href="/">← Вернуться в панель</a></p></div></body></html>`;
}

async function validateMetaReady(req) {
  if (!pool || !databaseState.connected) {
    return { ok:false, title:'PostgreSQL не подключен', details:databaseState.message, fixes:[
      'В Render создай PostgreSQL базу.',
      'В Web Service → Environment добавь DATABASE_URL = Internal Database URL.',
      'После этого сделай Manual Deploy → Clear build cache & deploy.'
    ] };
  }
  const cfg = await getRuntimeMetaConfig(req);
  const missing = [];
  if (!cfg.appId) missing.push('META_APP_ID');
  if (!cfg.appSecret) missing.push('META_APP_SECRET');
  // META_GRAPH_VERSION is optional. Default is v23.0.
  if (!cfg.baseUrl) missing.push('APP_BASE_URL');
  if (missing.length) return { ok:false, title:'Не заполнены Meta настройки', details:`Не хватает: ${missing.join(', ')}`, fixes:[
    'Открой вкладку «Секреты / Настройки» и заполни поля.',
    'Или добавь эти переменные в Render → Environment.',
    'APP_BASE_URL должен быть твоим доменом Render, например https://apicore-igagent.onrender.com.'
  ] };
  return { ok:true, cfg };
}

function requireDb(req, res, next) {
  if (pool && databaseState.connected) return next();
  return res.status(503).json({
    error: 'Database is not connected',
    message: databaseState.message,
    fix: 'Deploy via render.yaml Blueprint or add DATABASE_URL from Render PostgreSQL Internal Database URL.'
  });
}


function requireAuth(req,res,next){ return next(); }
function mask(v){ if(!v) return ''; return v.length <= 6 ? '******' : `${v.slice(0,3)}***${v.slice(-3)}`; }

// Internal platform authorization is intentionally disabled for single-owner MVP.
// The dashboard opens immediately. Meta OAuth is still used only to connect Instagram accounts.
app.post('/api/login', async (req,res)=> res.json({ok:true, authDisabled:true}));
app.post('/api/logout', (req,res)=> res.json({ok:true, authDisabled:true}));
app.get('/api/me', (req,res)=> res.json({user:{username:'owner', authDisabled:true}}));

app.get('/api/dashboard', requireAuth, requireDb, asyncRoute(async (req,res)=>{
  const [accountsRes, rulesRes, todayRes, sentRes, errorsRes] = await Promise.all([
    query('SELECT COUNT(*)::int AS n FROM instagram_accounts'),
    query('SELECT COUNT(*)::int AS n FROM automation_rules WHERE enabled=TRUE'),
    query("SELECT COUNT(*)::int AS n FROM automation_logs WHERE created_at > NOW() - INTERVAL '24 hours'"),
    query("SELECT COUNT(*)::int AS n FROM automation_logs WHERE status='sent' AND created_at > NOW() - INTERVAL '24 hours'"),
    query("SELECT COUNT(*)::int AS n FROM automation_logs WHERE status='error' AND created_at > NOW() - INTERVAL '24 hours'")
  ]);
  const count = (result) => Number(result?.rows?.[0]?.n || 0);
  res.json({
    accounts: count(accountsRes),
    rules: count(rulesRes),
    today: count(todayRes),
    sent: count(sentRes),
    errors: count(errorsRes)
  });
}));

app.get('/api/settings', requireAuth, requireDb, async (req,res)=>{
  const keys = ['META_APP_ID','META_APP_SECRET','META_GRAPH_VERSION','META_WEBHOOK_VERIFY_TOKEN','APP_BASE_URL','DRY_RUN','DEFAULT_RATE_LIMIT_PER_MINUTE'];
  const data = {};
  for (const k of keys) data[k] = await getSetting(k, process.env[k] || '');
  data.META_APP_SECRET_MASKED = mask(data.META_APP_SECRET);
  res.json(data);
});
app.post('/api/settings', requireAuth, requireDb, async (req,res)=>{
  const schema = z.object({
    META_APP_ID:z.string().optional(), META_APP_SECRET:z.string().optional(), META_GRAPH_VERSION:z.string().default('v23.0'),
    META_WEBHOOK_VERIFY_TOKEN:z.string().optional(), APP_BASE_URL:z.string().optional(), DRY_RUN:z.string().default('true'), DEFAULT_RATE_LIMIT_PER_MINUTE:z.string().default('15')
  });
  const data = schema.parse(req.body);
  for (const [k,v] of Object.entries(data)) await setSetting(k, v ?? '');
  res.json({ok:true});
});

app.get('/auth/meta/start', requireAuth, async (req,res)=>{
  try {
    const ready = await validateMetaReady(req);
    if (!ready.ok) return res.status(200).send(htmlError(ready.title, ready.details, ready.fixes));
    const cfg = ready.cfg;
    const redirect = `${cfg.baseUrl}/auth/meta/callback`;
    const oauthScopes = ['pages_show_list','pages_read_engagement','instagram_basic','instagram_manage_comments','business_management'];
    // IMPORTANT: do not request pages_messaging here. Meta rejects it for this OAuth flow.
    const scope = oauthScopes.join(',');
    const url = `https://www.facebook.com/${cfg.graphVersion}/dialog/oauth?client_id=${encodeURIComponent(cfg.appId)}&redirect_uri=${encodeURIComponent(redirect)}&scope=${encodeURIComponent(scope)}&response_type=code`;
    res.redirect(url);
  } catch(e) {
    console.error('[META_START_ERROR]', e?.response?.data || e);
    res.status(200).send(htmlError('Ошибка запуска Meta OAuth', e?.response?.data ? JSON.stringify(e.response.data,null,2) : (e.message || String(e)), [
      'Проверь META_APP_ID, META_APP_SECRET и APP_BASE_URL.',
      'APP_BASE_URL должен совпадать с доменом Render.',
      'Проверь /healthz.'
    ]));
  }
});
app.get('/auth/meta/callback', requireAuth, async (req,res)=>{
  try {
    const ready = await validateMetaReady(req);
    if (!ready.ok) return res.status(200).send(htmlError(ready.title, ready.details, ready.fixes));
    if (req.query.error || !req.query.code) {
      return res.status(200).send(htmlError('Meta не вернула code', JSON.stringify(req.query,null,2), [
        'Проверь Valid OAuth Redirect URI в Meta App.',
        `Добавь точный callback: ${ready.cfg.baseUrl}/auth/meta/callback`,
        'Проверь, что приложение в Development и твой Facebook-профиль добавлен как Admin/Developer/Tester.'
      ]));
    }
    const cfg = ready.cfg;
    const redirect = `${cfg.baseUrl}/auth/meta/callback`;
    const shortToken = await exchangeCodeForToken(req.query.code, redirect);
    const longToken = await exchangeLongLived(shortToken.access_token);
    const pages = await getPagesWithInstagram(longToken.access_token);
    if (!pages.length) {
      return res.status(200).send(htmlError('Instagram аккаунты не найдены', 'Meta OAuth прошёл, но /me/accounts не вернул страниц с instagram_business_account.', [
        'Instagram должен быть Professional и привязан к Facebook Page.',
        'Разреши доступ к нужной Facebook Page в окне Meta Login.',
        'Для Creator может не всё отображаться стабильно — лучше Business аккаунт.',
        'Проверь permissions: pages_show_list, pages_read_engagement, instagram_basic.'
      ]));
    }
    for (const p of pages) {
      try { await subscribePageToApp(p.id, p.access_token || longToken.access_token); } catch (subErr) { console.warn('[PAGE_SUBSCRIBE_WARNING]', subErr?.response?.data || subErr.message || subErr); }
      await query(`INSERT INTO instagram_accounts(ig_user_id,username,page_id,page_name,access_token,token_expires_at,updated_at)
        VALUES($1,$2,$3,$4,$5,NOW() + INTERVAL '55 days',NOW())
        ON CONFLICT(ig_user_id) DO UPDATE SET username=EXCLUDED.username,page_id=EXCLUDED.page_id,page_name=EXCLUDED.page_name,access_token=EXCLUDED.access_token,token_expires_at=EXCLUDED.token_expires_at,updated_at=NOW()`,
        [p.instagram_business_account.id, p.instagram_business_account.username, p.id, p.name, p.access_token || longToken.access_token]);
    }
    res.redirect('/?connected=1');
  } catch(e) {
    console.error('[META_CALLBACK_ERROR]', e?.response?.data || e);
    res.status(200).send(htmlError('Meta OAuth error', e?.response?.data ? JSON.stringify(e.response.data,null,2) : (e.message || String(e)), [
      'Проверь, что в Meta App добавлен Valid OAuth Redirect URI: APP_BASE_URL/auth/meta/callback.',
      'Проверь, что APP_BASE_URL в настройках равен текущему домену Render без слэша на конце.',
      'Проверь, что App Secret правильный.',
      'Если приложение в Development, подключайся Facebook-профилем, который добавлен в роли приложения.'
    ]));
  }
});

app.get('/api/meta/debug', requireAuth, async (req,res)=>{
  const cfg = await getRuntimeMetaConfig(req);
  res.json({
    database: databaseState.connected ? 'connected' : (pool ? 'error' : 'not_configured'),
    databaseMessage: databaseState.message,
    baseUrl: cfg.baseUrl,
    callbackUrl: `${cfg.baseUrl}/auth/meta/callback`,
    webhookUrl: `${cfg.baseUrl}/webhook/meta`,
    hasAppId: Boolean(cfg.appId),
    hasAppSecret: Boolean(cfg.appSecret),
    graphVersion: cfg.graphVersion,
    dryRun: cfg.dryRun
  });
});

app.get('/api/accounts', requireAuth, requireDb, async (req,res)=>{
  const { rows } = await query('SELECT id,ig_user_id,username,page_id,page_name,is_active,token_expires_at,created_at FROM instagram_accounts ORDER BY id DESC');
  res.json(rows);
});
app.post('/api/accounts/:id/toggle', requireAuth, requireDb, async (req,res)=>{
  await query('UPDATE instagram_accounts SET is_active=NOT is_active, updated_at=NOW() WHERE id=$1',[req.params.id]); res.json({ok:true});
});

app.get('/api/rules', requireAuth, requireDb, async (req,res)=>{
  const { rows } = await query(`SELECT r.*, a.username account_username FROM automation_rules r JOIN instagram_accounts a ON a.id=r.account_id ORDER BY r.id DESC`);
  res.json(rows);
});
app.post('/api/rules', requireAuth, requireDb, async (req,res)=>{
  const s = z.object({ id:z.number().optional(), account_id:z.coerce.number(), name:z.string().min(1), keywords:z.array(z.string()).default([]), match_mode:z.string().default('contains'), public_replies:z.array(z.string()).default([]), dm_message:z.string().default(''), target_url:z.string().optional(), use_private_reply:z.boolean().default(true), use_public_reply:z.boolean().default(true), enabled:z.boolean().default(true), rate_limit_per_minute:z.coerce.number().default(15) });
  const r = s.parse(req.body);
  const splitList = (arr) => (arr || []).flatMap(x => String(x).split(/[\n,;]+/)).map(x => x.trim()).filter(Boolean);
  r.keywords = splitList(r.keywords);
  r.public_replies = splitList(r.public_replies);
  if (r.id) {
    await query(`UPDATE automation_rules SET account_id=$1,name=$2,keywords=$3,match_mode=$4,public_replies=$5,dm_message=$6,target_url=$7,use_private_reply=$8,use_public_reply=$9,enabled=$10,rate_limit_per_minute=$11,updated_at=NOW() WHERE id=$12`,
      [r.account_id,r.name,r.keywords,r.match_mode,r.public_replies,r.dm_message,r.target_url||'',r.use_private_reply,r.use_public_reply,r.enabled,r.rate_limit_per_minute,r.id]);
  } else {
    await query(`INSERT INTO automation_rules(account_id,name,keywords,match_mode,public_replies,dm_message,target_url,use_private_reply,use_public_reply,enabled,rate_limit_per_minute) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [r.account_id,r.name,r.keywords,r.match_mode,r.public_replies,r.dm_message,r.target_url||'',r.use_private_reply,r.use_public_reply,r.enabled,r.rate_limit_per_minute]);
  }
  res.json({ok:true});
});
app.delete('/api/rules/:id', requireAuth, requireDb, async (req,res)=>{ await query('DELETE FROM automation_rules WHERE id=$1',[req.params.id]); res.json({ok:true}); });

app.get('/api/logs', requireAuth, requireDb, async (req,res)=>{
  const { rows } = await query(`SELECT l.*, a.username account_username, r.name rule_name FROM automation_logs l LEFT JOIN instagram_accounts a ON a.id=l.account_id LEFT JOIN automation_rules r ON r.id=l.rule_id ORDER BY l.id DESC LIMIT 200`);
  res.json(rows);
});

app.get('/webhook/meta', async (req,res)=>{
  const token = await getSetting('META_WEBHOOK_VERIFY_TOKEN', process.env.META_WEBHOOK_VERIFY_TOKEN || '');
  const mode = req.query['hub.mode'];
  const verifyToken = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  // Meta verification request. Meta requires returning the raw challenge string.
  if (mode === 'subscribe') {
    if (token && verifyToken === token) {
      console.log('[WEBHOOK_VERIFY_OK]');
      return res.status(200).send(challenge);
    }
    console.warn('[WEBHOOK_VERIFY_FAILED]', { hasConfiguredToken: Boolean(token), receivedToken: verifyToken ? 'present' : 'missing' });
    return res.status(403).json({
      ok: false,
      error: 'verify_token_mismatch',
      message: 'Webhook verify token from Meta does not match META_WEBHOOK_VERIFY_TOKEN in this app.',
      configuredTokenPresent: Boolean(token),
      receivedTokenPresent: Boolean(verifyToken)
    });
  }

  // Human/browser diagnostic. This route is not supposed to be opened directly for webhook verification.
  const baseUrl = publicBaseUrl(req);
  res.status(200).json({
    ok: true,
    endpoint: '/webhook/meta',
    message: 'Webhook endpoint is online. Meta must call it with hub.mode, hub.verify_token and hub.challenge.',
    configuredTokenPresent: Boolean(token),
    callbackUrlForMeta: `${baseUrl}/webhook/meta`,
    testVerificationUrlExample: `${baseUrl}/webhook/meta?hub.mode=subscribe&hub.verify_token=YOUR_VERIFY_TOKEN&hub.challenge=12345`,
    note: 'Replace YOUR_VERIFY_TOKEN with the exact value saved in Secrets / Settings and in Meta Webhooks.'
  });
});

app.get('/api/webhook/debug', requireAuth, async (req,res)=>{
  const token = await getSetting('META_WEBHOOK_VERIFY_TOKEN', process.env.META_WEBHOOK_VERIFY_TOKEN || '');
  const baseUrl = publicBaseUrl(req);
  res.json({
    ok: true,
    webhookUrl: `${baseUrl}/webhook/meta`,
    verifyTokenConfigured: Boolean(token),
    verifyTokenMasked: mask(token),
    verificationTestUrl: `${baseUrl}/webhook/meta?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(token || 'PASTE_VERIFY_TOKEN_HERE')}&hub.challenge=12345`,
    requiredMetaFields: ['comments','mentions'],
    message: 'If real Instagram comments do not appear in logs, check Meta App → Webhooks → Instagram subscription and verify token.'
  });
});

app.get('/api/webhook/events', requireAuth, requireDb, asyncRoute(async (req,res)=>{
  const { rows } = await query(`SELECT id, object_type, entry_count, change_fields, messaging_count, processed_count, status, error, created_at
                                FROM webhook_audit ORDER BY id DESC LIMIT 50`);
  res.json({ events: rows });
}));

app.post('/api/webhook/ping', requireAuth, requireDb, asyncRoute(async (req,res)=>{
  await query(`INSERT INTO webhook_audit(object_type,entry_count,change_fields,messaging_count,processed_count,status,raw_event)
               VALUES('manual_ping',0,'{}',0,0,'received',$1)`, [{ ok: true, at: new Date().toISOString(), body: req.body || {} }]);
  res.json({ ok: true, message: 'Webhook audit table is writable. This does not test Meta delivery.' });
}));

app.post('/webhook/meta', async (req,res)=>{
  // Meta needs fast 200 OK. Processing continues async after response.
  res.sendStatus(200);
  const body = req.body || {};
  setImmediate(async () => {
    let auditId = null;
    let processed = 0;
    const entries = Array.isArray(body.entry) ? body.entry : [];
    const changeFields = entries.flatMap(entry => (entry.changes || []).map(change => String(change.field || 'unknown')));
    const messagingCount = entries.reduce((n, entry) => n + ((entry.messaging || []).length), 0);
    try {
      if (hasDatabase()) {
        const audit = await query(
          `INSERT INTO webhook_audit(object_type,entry_count,change_fields,messaging_count,status,raw_event)
           VALUES($1,$2,$3,$4,'received',$5) RETURNING id`,
          [body.object || null, entries.length, changeFields, messagingCount, body]
        );
        auditId = audit.rows[0]?.id || null;
        await query(
          `INSERT INTO automation_logs(event_type,status,error,raw_event)
           VALUES('webhook','raw_received',$1,$2)`,
          [`audit_id=${auditId}; object=${body.object || 'unknown'}; fields=${changeFields.join(',') || 'none'}; messaging=${messagingCount}`, body]
        );
      }

      for (const entry of entries) {
        for (const change of entry.changes || []) {
          const field = change.field || '';
          const value = change.value || {};
          // Real Instagram comment payloads arrive as changes. Support comments, live_comments and mentions.
          if (['comments','live_comments','mentions'].includes(field) || value.id || value.comment_id || value.text || value.message || value.comment) {
            const result = await processCommentEvent({...change, entry_id: entry.id});
            console.log('[WEBHOOK_CHANGE_PROCESSED]', field, result);
            processed++;
          }
        }
        for (const msg of entry.messaging || []) {
          const result = await processMessageEvent({...msg, entry_id: entry.id});
          console.log('[WEBHOOK_MESSAGE_PROCESSED]', result);
          processed++;
        }
      }

      if (!processed && hasDatabase()) {
        const bodyText = JSON.stringify(body || {});
        const reason = bodyText.includes('This is an example') ? 'meta_sample_event_ignored' : 'webhook_received_but_no_comment_payload';
        await query(`INSERT INTO automation_logs(event_type,status,error,raw_event) VALUES('webhook',$1,$2,$3)`, [reason === 'meta_sample_event_ignored' ? 'ignored' : 'unhandled', reason, body]);
      }
      if (auditId && hasDatabase()) await query(`UPDATE webhook_audit SET processed_count=$1,status=$2 WHERE id=$3`, [processed, processed ? 'processed' : 'unhandled', auditId]);
    } catch(e) {
      console.error('Webhook processing error', e?.response?.data || e);
      if (auditId && hasDatabase()) {
        try { await query(`UPDATE webhook_audit SET status='error', error=$1 WHERE id=$2`, [e?.response?.data ? JSON.stringify(e.response.data) : (e.message || String(e)), auditId]); } catch {}
      }
    }
  });
});

app.post('/api/test-webhook', requireAuth, requireDb, async (req,res)=>{
  const event = { field:'comments', value:{ id:`test_${Date.now()}`, text:req.body.text || 'ремонт', from:{username:'test_user'} } };
  const out = await processCommentEvent(event, { simulate: true }); res.json(out);
});

app.get('/api/debug/match', requireAuth, requireDb, asyncRoute(async (req,res)=>{
  res.json(await debugMatchComment(req.query.text || 'ремонт'));
}));

app.use((err, req, res, next) => {
  console.error('[REQUEST_ERROR]', req.method, req.originalUrl, err?.stack || err);
  if (res.headersSent) return next(err);
  res.status(500).json({
    error: 'Internal server error',
    message: err?.message || String(err),
    path: req.originalUrl
  });
});

const port = process.env.PORT || 10000;
app.listen(port, ()=> console.log(`IG Agent Pro running on ${port}`));
