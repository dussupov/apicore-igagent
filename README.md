# Instagram AI Agent Pro — MVP для Render

Рабочий MVP для 3–5 Instagram Professional аккаунтов: Meta OAuth, аккаунты, правила по ключевым словам, случайные публичные ответы, private replies/DM, логи, лимиты и DRY_RUN.

## Что внутри

- Express + PostgreSQL
- Render-ready `render.yaml`
- Web UI без сборки frontend
- Meta OAuth для подключения страниц и Instagram Business/Creator аккаунтов
- Meta Webhook endpoint
- Правила: ключевые слова, варианты ответов, DM-шаблон, ссылка, лимиты
- Отдельная вкладка **Секреты / Настройки**

## Деплой на Render

1. Создай новый GitHub repo и залей эти файлы.
2. В Render нажми **New → Blueprint** и выбери repo с `render.yaml`.
3. Render создаст Web Service и PostgreSQL.
4. После деплоя открой URL сервиса.
5. Войди в панель: `ADMIN_USERNAME` и `ADMIN_PASSWORD` из Render env.
6. Открой вкладку **Секреты** и добавь:
   - `META_APP_ID`
   - `META_APP_SECRET`
   - `META_WEBHOOK_VERIFY_TOKEN`
   - `APP_BASE_URL=https://your-service.onrender.com`
   - `DRY_RUN=true` для тестов, потом `false`.

## Meta настройки

В Meta App нужны продукты:

- Facebook Login
- Instagram Graph API
- Webhooks
- Instagram Messaging API

OAuth redirect URI:

```text
https://your-service.onrender.com/auth/meta/callback
```

Webhook callback URL:

```text
https://your-service.onrender.com/webhook/meta
```

Webhook verify token должен совпадать с `META_WEBHOOK_VERIFY_TOKEN`.

## Важно про DRY_RUN

Пока `DRY_RUN=true`, система не отправляет реальные запросы в Meta для reply/private reply. Это безопасный режим для проверки правил и логов.

Когда всё настроено, поставь `DRY_RUN=false`.

## Ограничения v1

- Проверка подписки не включена: официальный API не всегда позволяет надёжно проверить любого пользователя на подписку.
- Для публичного продакшена потребуется App Review Meta и Live Mode.
- Private reply обычно работает в рамках сценария комментария и политик Instagram Messaging.

## Лучшие практики, уже заложенные

- Несколько вариантов публичного ответа, чтобы не выглядеть как спам.
- Лимит отправок на аккаунт в минуту.
- DRY_RUN перед реальным запуском.
- Логи всех событий и ошибок Meta.
- Секреты вынесены из кода.
- Один сервис для Render, без лишней микросервисной сложности.
