# IG Agent Pro — рабочая версия для Instagram

Эта версия убирает внутреннюю авторизацию и использует Meta OAuth только для подключения Instagram Professional аккаунтов.

## Что исправлено

- `/api/test-webhook` теперь работает только как симуляция и не вызывает Meta API с fake comment id.
- Реальный webhook `/webhook/meta` отвечает только на настоящие Instagram comment id.
- Private Reply отправляется через официальный Page messages endpoint: `/{PAGE_ID}/messages` с `recipient.comment_id`.
- Public reply отправляется через `/{COMMENT_ID}/replies`.
- В OAuth scope добавлен `pages_messaging`, нужный для private replies.
- В логах сохраняются `apiResponses`, `commentId`, `pageId`, причина ошибок и выбранные тексты.

## Важное

После деплоя нужно заново нажать «Подключить Instagram», потому что OAuth теперь запрашивает дополнительное разрешение `pages_messaging`.

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
