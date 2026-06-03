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

