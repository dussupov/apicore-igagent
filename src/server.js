import 'dotenv/config';
import express from 'express';
import session from 'express-session';
import pgSession from 'connect-pg-simple';
import helmet from 'helmet';
import bcrypt from 'bcryptjs';
import pg from 'pg';
import { z } from 'zod';
import { initDb, query, getSetting, setSetting } from './db.js';
import { metaConfig, exchangeCodeForToken, exchangeLongLived, getPagesWithInstagram } from './meta.js';
import { processCommentEvent } from './automation.js';

const app = express();
const PgSession = pgSession(session);
const pgPool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false });
await initDb();

app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(session({
  store: new PgSession({ pool: pgPool, createTableIfMissing: true }),
  secret: process.env.SESSION_SECRET || 'dev-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 1000*60*60*24*7 }
}));
app.use(express.static('public'));

function requireAuth(req,res,next){ if(req.session.user) return next(); res.status(401).json({error:'Unauthorized'}); }
function mask(v){ if(!v) return ''; return v.length <= 6 ? '******' : `${v.slice(0,3)}***${v.slice(-3)}`; }

app.post('/api/login', async (req,res)=>{
  const { username, password } = req.body;
  const admin = process.env.ADMIN_USERNAME || 'admin';
  const pass = process.env.ADMIN_PASSWORD || 'admin';
  const ok = username === admin && (password === pass || bcrypt.compareSync(password, pass));
  if(!ok) return res.status(401).json({error:'Wrong login'});
  req.session.user = { username };
  res.json({ok:true});
});
app.post('/api/logout', (req,res)=> req.session.destroy(()=>res.json({ok:true})));
app.get('/api/me', (req,res)=> res.json({user:req.session.user||null}));

app.get('/api/dashboard', requireAuth, async (req,res)=>{
  const [[accounts],[rules],[today],[sent],[errors]] = await Promise.all([
    query('SELECT COUNT(*)::int n FROM instagram_accounts'),
    query('SELECT COUNT(*)::int n FROM automation_rules WHERE enabled=TRUE'),
    query("SELECT COUNT(*)::int n FROM automation_logs WHERE created_at > NOW() - INTERVAL '24 hours'"),
    query("SELECT COUNT(*)::int n FROM automation_logs WHERE status='sent' AND created_at > NOW() - INTERVAL '24 hours'"),
    query("SELECT COUNT(*)::int n FROM automation_logs WHERE status='error' AND created_at > NOW() - INTERVAL '24 hours'")
  ]);
  res.json({accounts:accounts.rows[0].n,rules:rules.rows[0].n,today:today.rows[0].n,sent:sent.rows[0].n,errors:errors.rows[0].n});
});

app.get('/api/settings', requireAuth, async (req,res)=>{
  const keys = ['META_APP_ID','META_APP_SECRET','META_GRAPH_VERSION','META_WEBHOOK_VERIFY_TOKEN','APP_BASE_URL','DRY_RUN','DEFAULT_RATE_LIMIT_PER_MINUTE'];
  const data = {};
  for (const k of keys) data[k] = await getSetting(k, process.env[k] || '');
  data.META_APP_SECRET_MASKED = mask(data.META_APP_SECRET);
  res.json(data);
});
app.post('/api/settings', requireAuth, async (req,res)=>{
  const schema = z.object({
    META_APP_ID:z.string().optional(), META_APP_SECRET:z.string().optional(), META_GRAPH_VERSION:z.string().default('v23.0'),
    META_WEBHOOK_VERIFY_TOKEN:z.string().optional(), APP_BASE_URL:z.string().optional(), DRY_RUN:z.string().default('true'), DEFAULT_RATE_LIMIT_PER_MINUTE:z.string().default('15')
  });
  const data = schema.parse(req.body);
  for (const [k,v] of Object.entries(data)) await setSetting(k, v ?? '');
  res.json({ok:true});
});

app.get('/auth/meta/start', requireAuth, async (req,res)=>{
  const cfg = await metaConfig();
  const redirect = `${cfg.baseUrl}/auth/meta/callback`;
  const scope = ['pages_show_list','pages_read_engagement','instagram_basic','instagram_manage_comments','instagram_manage_messages','business_management'].join(',');
  const url = `https://www.facebook.com/${cfg.graphVersion}/dialog/oauth?client_id=${encodeURIComponent(cfg.appId)}&redirect_uri=${encodeURIComponent(redirect)}&scope=${encodeURIComponent(scope)}&response_type=code`;
  res.redirect(url);
});
app.get('/auth/meta/callback', requireAuth, async (req,res)=>{
  try {
    const cfg = await metaConfig();
    const redirect = `${cfg.baseUrl}/auth/meta/callback`;
    const shortToken = await exchangeCodeForToken(req.query.code, redirect);
    const longToken = await exchangeLongLived(shortToken.access_token);
    const pages = await getPagesWithInstagram(longToken.access_token);
    for (const p of pages) {
      await query(`INSERT INTO instagram_accounts(ig_user_id,username,page_id,page_name,access_token,token_expires_at,updated_at)
        VALUES($1,$2,$3,$4,$5,NOW() + INTERVAL '55 days',NOW())
        ON CONFLICT(ig_user_id) DO UPDATE SET username=EXCLUDED.username,page_id=EXCLUDED.page_id,page_name=EXCLUDED.page_name,access_token=EXCLUDED.access_token,token_expires_at=EXCLUDED.token_expires_at,updated_at=NOW()`,
        [p.instagram_business_account.id, p.instagram_business_account.username, p.id, p.name, p.access_token || longToken.access_token]);
    }
    res.redirect('/?connected=1');
  } catch(e) {
    res.status(500).send(`<pre>Meta OAuth error: ${e?.response?.data ? JSON.stringify(e.response.data,null,2) : e.message}</pre>`);
  }
});

app.get('/api/accounts', requireAuth, async (req,res)=>{
  const { rows } = await query('SELECT id,ig_user_id,username,page_id,page_name,is_active,token_expires_at,created_at FROM instagram_accounts ORDER BY id DESC');
  res.json(rows);
});
app.post('/api/accounts/:id/toggle', requireAuth, async (req,res)=>{
  await query('UPDATE instagram_accounts SET is_active=NOT is_active, updated_at=NOW() WHERE id=$1',[req.params.id]); res.json({ok:true});
});

app.get('/api/rules', requireAuth, async (req,res)=>{
  const { rows } = await query(`SELECT r.*, a.username account_username FROM automation_rules r JOIN instagram_accounts a ON a.id=r.account_id ORDER BY r.id DESC`);
  res.json(rows);
});
app.post('/api/rules', requireAuth, async (req,res)=>{
  const s = z.object({ id:z.number().optional(), account_id:z.coerce.number(), name:z.string().min(1), keywords:z.array(z.string()).default([]), match_mode:z.string().default('contains'), public_replies:z.array(z.string()).default([]), dm_message:z.string().default(''), target_url:z.string().optional(), use_private_reply:z.boolean().default(true), use_public_reply:z.boolean().default(true), enabled:z.boolean().default(true), rate_limit_per_minute:z.coerce.number().default(15) });
  const r = s.parse(req.body);
  if (r.id) {
    await query(`UPDATE automation_rules SET account_id=$1,name=$2,keywords=$3,match_mode=$4,public_replies=$5,dm_message=$6,target_url=$7,use_private_reply=$8,use_public_reply=$9,enabled=$10,rate_limit_per_minute=$11,updated_at=NOW() WHERE id=$12`,
      [r.account_id,r.name,r.keywords,r.match_mode,r.public_replies,r.dm_message,r.target_url||'',r.use_private_reply,r.use_public_reply,r.enabled,r.rate_limit_per_minute,r.id]);
  } else {
    await query(`INSERT INTO automation_rules(account_id,name,keywords,match_mode,public_replies,dm_message,target_url,use_private_reply,use_public_reply,enabled,rate_limit_per_minute) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [r.account_id,r.name,r.keywords,r.match_mode,r.public_replies,r.dm_message,r.target_url||'',r.use_private_reply,r.use_public_reply,r.enabled,r.rate_limit_per_minute]);
  }
  res.json({ok:true});
});
app.delete('/api/rules/:id', requireAuth, async (req,res)=>{ await query('DELETE FROM automation_rules WHERE id=$1',[req.params.id]); res.json({ok:true}); });

app.get('/api/logs', requireAuth, async (req,res)=>{
  const { rows } = await query(`SELECT l.*, a.username account_username, r.name rule_name FROM automation_logs l LEFT JOIN instagram_accounts a ON a.id=l.account_id LEFT JOIN automation_rules r ON r.id=l.rule_id ORDER BY l.id DESC LIMIT 200`);
  res.json(rows);
});

app.get('/webhook/meta', async (req,res)=>{
  const token = await getSetting('META_WEBHOOK_VERIFY_TOKEN');
  if(req.query['hub.mode']==='subscribe' && req.query['hub.verify_token']===token) return res.send(req.query['hub.challenge']);
  res.sendStatus(403);
});
app.post('/webhook/meta', async (req,res)=>{
  res.sendStatus(200);
  try {
    for (const entry of req.body.entry || []) {
      for (const change of entry.changes || []) {
        if (['comments','mentions'].includes(change.field) || change.value?.text) await processCommentEvent(change);
      }
      for (const msg of entry.messaging || []) {
        await query(`INSERT INTO automation_logs(event_type,status,raw_event) VALUES('message','received',$1)`, [msg]);
      }
    }
  } catch(e) { console.error('Webhook processing error', e); }
});

app.post('/api/test-webhook', requireAuth, async (req,res)=>{
  const event = { field:'comments', value:{ id:`test_${Date.now()}`, text:req.body.text || 'ремонт', from:{username:'test_user'} } };
  const out = await processCommentEvent(event); res.json(out);
});

const port = process.env.PORT || 10000;
app.listen(port, ()=> console.log(`IG Agent Pro running on ${port}`));
