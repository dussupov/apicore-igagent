import axios from 'axios';
import { getSetting } from './db.js';

export async function metaConfig() {
  const graphVersionRaw = await getSetting('META_GRAPH_VERSION', 'v23.0');
  const graphVersion = String(graphVersionRaw || 'v23.0').trim() || 'v23.0';
  const loginMode = String(await getSetting('META_LOGIN_MODE', 'instagram') || 'instagram').trim();
  return {
    appId: await getSetting('META_APP_ID', process.env.META_APP_ID || ''),
    appSecret: await getSetting('META_APP_SECRET', process.env.META_APP_SECRET || ''),
    graphVersion,
    loginMode,
    baseUrl: await getSetting('APP_BASE_URL', process.env.APP_BASE_URL || ''),
    verifyToken: await getSetting('META_WEBHOOK_VERIFY_TOKEN', process.env.META_WEBHOOK_VERIFY_TOKEN || ''),
    dryRun: String(await getSetting('DRY_RUN', process.env.DRY_RUN || 'true')) === 'true',
    graphBaseUrl: String(await getSetting('META_GRAPH_BASE_URL', loginMode === 'instagram' ? 'https://graph.instagram.com' : 'https://graph.facebook.com') || '').replace(/\/$/, '') || 'https://graph.instagram.com'
  };
}

export function instagramBusinessScopes() {
  // New Instagram API / Instagram Login permissions. No Page permissions here.
  return ['instagram_business_basic', 'instagram_business_manage_comments', 'instagram_business_manage_messages'];
}

export function facebookLegacyScopes() {
  // Fallback for old Facebook Page flow. Kept only for compatibility and not used by default.
  return ['pages_show_list', 'pages_read_engagement', 'instagram_basic', 'instagram_manage_comments', 'instagram_manage_messages', 'business_management'];
}

export async function graphGet(path, params = {}, token) {
  const cfg = await metaConfig();
  const url = `${cfg.graphBaseUrl}/${cfg.graphVersion}${path}`;
  const { data } = await axios.get(url, { params: { ...params, access_token: token } });
  return data;
}

export async function graphPost(path, payload = {}, token) {
  const cfg = await metaConfig();
  if (cfg.dryRun) return { dry_run: true, path, payload };
  const url = `${cfg.graphBaseUrl}/${cfg.graphVersion}${path}`;
  const { data } = await axios.post(url, payload, { params: { access_token: token } });
  return data;
}

export async function exchangeInstagramCodeForToken(code, redirectUri) {
  const cfg = await metaConfig();
  const form = new URLSearchParams();
  form.set('client_id', cfg.appId);
  form.set('client_secret', cfg.appSecret);
  form.set('grant_type', 'authorization_code');
  form.set('redirect_uri', redirectUri);
  form.set('code', code);
  const { data } = await axios.post('https://api.instagram.com/oauth/access_token', form, {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
  });
  return data;
}

export async function exchangeInstagramLongLived(shortToken) {
  const cfg = await metaConfig();
  const { data } = await axios.get(`https://graph.instagram.com/${cfg.graphVersion}/access_token`, {
    params: { grant_type: 'ig_exchange_token', client_secret: cfg.appSecret, access_token: shortToken }
  });
  return data;
}

export async function getInstagramMe(token) {
  try {
    return await graphGet('/me', { fields: 'id,user_id,username,account_type' }, token);
  } catch {
    return await graphGet('/me', { fields: 'id,username' }, token);
  }
}

// Legacy Facebook Login helpers. They are not used in the new Instagram mode.
export async function exchangeFacebookCodeForToken(code, redirectUri) {
  const cfg = await metaConfig();
  const url = `https://graph.facebook.com/${cfg.graphVersion}/oauth/access_token`;
  const { data } = await axios.get(url, {
    params: { client_id: cfg.appId, client_secret: cfg.appSecret, redirect_uri: redirectUri, code }
  });
  return data;
}

export async function exchangeFacebookLongLived(shortToken) {
  const cfg = await metaConfig();
  const url = `https://graph.facebook.com/${cfg.graphVersion}/oauth/access_token`;
  const { data } = await axios.get(url, {
    params: { grant_type: 'fb_exchange_token', client_id: cfg.appId, client_secret: cfg.appSecret, fb_exchange_token: shortToken }
  });
  return data;
}

export async function getPagesWithInstagram(token) {
  const cfg = await metaConfig();
  const url = `https://graph.facebook.com/${cfg.graphVersion}/me/accounts`;
  const { data: pages } = await axios.get(url, { params: { fields: 'id,name,access_token,instagram_business_account{id,username}', access_token: token } });
  return (pages.data || []).filter(p => p.instagram_business_account);
}

export async function replyToComment(commentId, message, token) {
  return graphPost(`/${commentId}/replies`, { message }, token);
}

export async function privateReply(igUserId, commentId, message, token) {
  return graphPost(`/${igUserId}/messages`, {
    recipient: { comment_id: String(commentId) },
    message: { text: String(message || '') }
  }, token);
}

export async function sendInstagramMessage(igUserId, recipientId, message, token) {
  return graphPost(`/${igUserId}/messages`, {
    recipient: { id: String(recipientId) },
    message: { text: String(message || '') }
  }, token);
}


export async function getCommentDetails(commentId, token) {
  if (!commentId) return null;
  return graphGet(`/${commentId}`, { fields: 'id,text,username,timestamp,media{id},from{id,username}' }, token);
}


export async function getMessageDetails(messageId, token) {
  if (!messageId) return null;
  // Instagram may send message_edit / delivery events with only a mid.
  // Try the common Graph fields; if Meta denies the lookup, the caller will log the exact error.
  try {
    return await graphGet(`/${messageId}`, { fields: 'id,mid,text,message,from,to,created_time' }, token);
  } catch (err) {
    try { return await graphGet(`/${messageId}`, { fields: 'id,text,from,to' }, token); }
    catch { throw err; }
  }
}
