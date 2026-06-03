# IG Agent Pro — Instagram Login API build

Версия пересобрана под новый Instagram API / Instagram Login flow.

## Главное отличие

В этой сборке удалены проблемные вызовы и permissions:

- `pages_manage_metadata` не используется
- `pages_messaging` не используется
- `/{pageId}/subscribed_apps` не используется
- `/{igUserId}/subscribed_apps` не используется

По умолчанию OAuth идет через Instagram Login:

```env
META_LOGIN_MODE=instagram
META_GRAPH_BASE_URL=https://graph.instagram.com
```

Scopes:

```text
instagram_business_basic
instagram_business_manage_comments
instagram_business_manage_messages
```

Meta подтверждает, что Instagram API with Instagram Login предназначен для Instagram professional accounts, а Webhooks настраиваются в Instagram Platform / Webhooks. См. официальные документы Meta по Instagram API with Instagram Login и Webhooks.

## Render

1. Залей проект в GitHub.
2. Render → New → Blueprint или Web Service.
3. Build command:

```bash
npm install
```

4. Start command:

```bash
npm start
```

5. Добавь PostgreSQL и переменную:

```env
DATABASE_URL=Internal Database URL from Render PostgreSQL
```

## Environment

```env
META_APP_ID=
META_APP_SECRET=
META_GRAPH_VERSION=v23.0
META_LOGIN_MODE=instagram
META_GRAPH_BASE_URL=https://graph.instagram.com
META_WEBHOOK_VERIFY_TOKEN=
APP_BASE_URL=https://your-service.onrender.com
DRY_RUN=false
DEFAULT_RATE_LIMIT_PER_MINUTE=15
OPENAI_API_KEY=
```

`OPENAI_API_KEY` нужен только для AI-помощника в разделе «Автоматизации». Если ключ не задан, система вернёт шаблонные варианты.

## Meta настройки

В Meta App используй продукт Instagram API / Instagram Login.

Callback OAuth:

```text
https://your-service.onrender.com/auth/meta/callback
```

Webhook URL:

```text
https://your-service.onrender.com/webhook/meta
```

Webhook fields:

```text
comments
live_comments
mentions
messages
```

## Проверки

```text
/healthz
/api/meta/debug
/api/accounts/debug
/api/webhook/events
```

## AI помощник

В разделе «Автоматизации» есть блок «AI помощник». Он генерирует:

- варианты ответов на комментарии;
- DM-сообщение;
- естественные тексты с разным тоном.



## Важно по кнопке Webhook
В режиме нового Instagram API платформа не вызывает `/{page_id}/subscribed_apps` и не использует `pages_manage_metadata`. Webhook подключается в Meta → Instagram API → Webhooks. Кнопка в аккаунте только показывает диагностический статус и не делает подписку через API.

## Webhook parser fix
This build adds robust parsing for Instagram API comment webhook payloads:
- stores every raw webhook in `webhook_audit`;
- exposes `/api/webhook/events/:id` to inspect a raw payload;
- tries to fetch comment details from Graph API when webhook contains only an ID;
- logs `change_processed`, parser debug, `comment_id`, and text extraction status.

After deploy, test a real comment and check:
- `/api/webhook/events`
- `/api/webhook/events/NEW_ID`
- `/api/logs`


## Direct messages: important

If logs show `message_edit_ignored_enable_messages_webhook`, Meta sent only a message edit/update event.
That payload does not include `sender.id` or `message.text`, so the bot cannot match keywords or reply.

In Meta Developers → Instagram API → Webhooks, subscribe to real message events (`messages`) in addition to comments/mentions.
A real inbound DM payload must contain something like:

```json
{ "messaging": [{ "sender": { "id": "..." }, "recipient": { "id": "..." }, "message": { "mid": "...", "text": "апикор" } }] }
```

Payloads with only `message_edit.mid` are now ignored and logged as diagnostic events.


## Fix: Direct messages permission

В Facebook legacy mode OAuth теперь запрашивает `instagram_manage_messages`. После деплоя обязательно переподключите Instagram, чтобы новый access token получил это разрешение. В OAuth по-прежнему нет `pages_messaging` и `pages_manage_metadata`.
