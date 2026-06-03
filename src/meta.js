import axios from 'axios';
import { getSetting } from './db.js';

export async function metaConfig() {
  const graphVersionRaw = await getSetting('META_GRAPH_VERSION', 'v23.0');
  const graphVersion = String(graphVersionRaw || 'v23.0').trim() || 'v23.0';
  return {
    appId: await getSetting('META_APP_ID'),
    appSecret: await getSetting('META_APP_SECRET'),
    graphVersion,
    baseUrl: await getSetting('APP_BASE_URL'),
    verifyToken: await getSetting('META_WEBHOOK_VERIFY_TOKEN'),
    dryRun: String(await getSetting('DRY_RUN', 'true')) === 'true'
  };
}

export async function graphGet(path, params = {}, token) {
  const cfg = await metaConfig();
  const url = `https://graph.facebook.com/${cfg.graphVersion}${path}`;
  const { data } = await axios.get(url, { params: { ...params, access_token: token } });
  return data;
}

export async function graphPost(path, payload = {}, token) {
  const cfg = await metaConfig();
  if (cfg.dryRun) return { dry_run: true, path, payload };
  const url = `https://graph.facebook.com/${cfg.graphVersion}${path}`;
  const { data } = await axios.post(url, payload, { params: { access_token: token } });
  return data;
}

export async function exchangeCodeForToken(code, redirectUri) {
  const cfg = await metaConfig();
  const url = `https://graph.facebook.com/${cfg.graphVersion}/oauth/access_token`;
  const { data } = await axios.get(url, {
    params: { client_id: cfg.appId, client_secret: cfg.appSecret, redirect_uri: redirectUri, code }
  });
  return data;
}

export async function exchangeLongLived(shortToken) {
  const cfg = await metaConfig();
  const url = `https://graph.facebook.com/${cfg.graphVersion}/oauth/access_token`;
  const { data } = await axios.get(url, {
    params: { grant_type: 'fb_exchange_token', client_id: cfg.appId, client_secret: cfg.appSecret, fb_exchange_token: shortToken }
  });
  return data;
}

export async function getPagesWithInstagram(token) {
  const pages = await graphGet('/me/accounts', { fields: 'id,name,access_token,instagram_business_account{id,username}' }, token);
  return (pages.data || []).filter(p => p.instagram_business_account);
}

export async function subscribePageToApp(pageId, pageAccessToken) {
  // Needed for real-time Page/Instagram webhooks. Safe to call multiple times.
  return graphPost(`/${pageId}/subscribed_apps`, { subscribed_fields: 'feed,messages,messaging_postbacks,messaging_referrals' }, pageAccessToken);
}

export async function replyToComment(commentId, message, token) {
  return graphPost(`/${commentId}/replies`, { message }, token);
}

export async function privateReply(igUserId, commentId, message, token) {
  // Instagram Private Replies: send one DM to the user who commented.
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
