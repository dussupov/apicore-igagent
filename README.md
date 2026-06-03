# IG Agent Pro — рабочая версия для Instagram

Эта версия убирает внутреннюю авторизацию и использует Meta OAuth только для подключения Instagram Professional аккаунтов.

## Что исправлено

- `/api/test-webhook` теперь работает только как симуляция и не вызывает Meta API с fake comment id.
- Реальный webhook `/webhook/meta` отвечает только на настоящие Instagram comment id.
- Private Reply отправляется через официальный Page messages endpoint: `/{PAGE_ID}/messages` с `recipient.comment_id`.
- Public reply отправляется через `/{COMMENT_ID}/replies`.
- OAuth больше не запрашивает invalid scope `pages_messaging`.
- Для публичных ответов используется `instagram_manage_comments`.
- Для private reply используется Instagram messages edge и permission `instagram_manage_messages`; если Meta не выдала это разрешение, публичный ответ всё равно работает, а private reply попадёт в лог как ошибка.
- В логах сохраняются `apiResponses`, `commentId`, `pageId`, причина ошибок и выбранные тексты.

## Важное

После деплоя нужно заново нажать «Подключить Instagram», чтобы токен был выдан без invalid scope `pages_messaging` и с актуальными Instagram permissions.

## Render переменные

Обязательные:

```env
DATABASE_URL=...
META_APP_ID=...
META_APP_SECRET=...
```

Необязательные:

```env
META_GRAPH_VERSION=v23.0
META_WEBHOOK_VERIFY_TOKEN=любая_строка_для_проверки_webhook
APP_BASE_URL=https://apicore-igagent.onrender.com
DRY_RUN=false
DEFAULT_RATE_LIMIT_PER_MINUTE=15
```

## Meta Webhook

Callback URL:

```text
https://apicore-igagent.onrender.com/webhook/meta
```

Verify Token должен совпадать с `META_WEBHOOK_VERIFY_TOKEN`.

Подписки Instagram:

```text
comments
mentions
messages
```

## Проверка

1. Открой `/healthz` — база должна быть connected.
2. Открой `/api/meta/debug` — проверь callbackUrl и webhookUrl.
3. Подключи Instagram заново через кнопку в панели.
4. Создай правило с ключевым словом.
5. Оставь комментарий с другого Instagram аккаунта под постом подключенного аккаунта.
6. В «Логи» статус должен стать `sent` или `error` с понятной причиной.

## Почему debug больше не отправляет в Instagram

Meta принимает ответы только на реальные comment id из webhook. Fake id вида `test_...` всегда будет давать ошибку `Object with ID does not exist`. Поэтому тестовая кнопка теперь проверяет только matching и формирует статус `simulation_ok`.

## Webhook diagnostics

Open:

```text
https://YOUR_RENDER_DOMAIN/api/webhook/debug
```

Copy `webhookUrl` into Meta Webhooks callback URL.
Use the exact same `META_WEBHOOK_VERIFY_TOKEN` in both places:

- App dashboard → Secrets / Settings → `META_WEBHOOK_VERIFY_TOKEN`
- Meta for Developers → Webhooks → Instagram → Verify token

Opening `/webhook/meta` directly in a browser now returns diagnostic JSON. Meta verification still works only when Meta sends `hub.mode=subscribe`, `hub.verify_token`, and `hub.challenge`.

For Instagram comment automation, subscribe Webhooks to Instagram fields:

```text
comments
mentions
```

If `/api/debug/match?text=...` returns `matched: true`, but real comments do not appear in Logs, the issue is Meta webhook subscription, not the rule matcher.


## OAuth scopes

В этой версии `pages_messaging` полностью удалён из OAuth. Проверка после деплоя:

```
https://YOUR_DOMAIN/api/meta/debug
```

В поле `oauthScopes` не должно быть `pages_messaging`. Если Meta всё ещё показывает `Invalid Scopes: pages_messaging`, значит на Render задеплоена старая сборка или браузер открыл старый URL. Сделай Manual Deploy -> Clear build cache & deploy.

## Fix: empty_comment_text

If Meta sends a comment webhook without text, the app now fetches the comment details from Graph API using the real `comment_id` before matching keywords. If the fetch fails, Logs will show `comment_text_fetch_failed` with the Meta API error.
