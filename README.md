# Instagram AI Agent Pro — Render-ready MVP

Рабочий MVP для 3–5 Instagram Professional аккаунтов: Meta OAuth, аккаунты, правила по ключевым словам, случайные публичные ответы, private replies/DM, логи, лимиты и DRY_RUN.

## Самый правильный деплой на Render

1. Создай новый GitHub репозиторий и загрузи туда файлы из архива.
2. В Render нажми **New → Blueprint**.
3. Выбери репозиторий.
4. Render прочитает `render.yaml` и сам создаст:
   - Web Service `ig-agent-pro`
   - PostgreSQL `ig-agent-db`
   - переменную `DATABASE_URL`
   - `SESSION_SECRET`
   - `ADMIN_PASSWORD`
   - `META_WEBHOOK_VERIFY_TOKEN`
5. После деплоя открой `/healthz`.

Нормальный ответ:

```json
{"ok":true,"app":"running","database":"connected"}
```

## Если делаешь Web Service вручную

Обязательно создай PostgreSQL в Render и добавь в Web Service → Environment:

```env
DATABASE_URL=Internal Database URL из Render PostgreSQL
PGSSLMODE=require
NODE_ENV=production
PORT=10000
SESSION_SECRET=любая-длинная-строка
ADMIN_USERNAME=admin
ADMIN_PASSWORD=твой-пароль
DRY_RUN=true
META_GRAPH_VERSION=v23.0
META_WEBHOOK_VERIFY_TOKEN=любой-токен-для-webhook
```

Build Command:

```bash
npm install
```

Start Command:

```bash
npm start
```

## Почему раньше была ошибка ECONNREFUSED 127.0.0.1:5432

Это происходило потому, что сервис запускался без `DATABASE_URL`, и драйвер PostgreSQL пытался найти базу на localhost. В этой версии:

- приложение больше не падает при отсутствии `DATABASE_URL`;
- `/healthz` показывает статус базы;
- UI показывает баннер с причиной;
- `render.yaml` создаёт базу автоматически при Blueprint-деплое.

## Первый вход

Логин и пароль смотри в Render → Web Service → Environment:

```text
ADMIN_USERNAME
ADMIN_PASSWORD
```

## Вкладка «Секреты / Настройки»

После входа добавь:

- `META_APP_ID`
- `META_APP_SECRET`
- `META_WEBHOOK_VERIFY_TOKEN`
- `APP_BASE_URL=https://your-service.onrender.com`
- `DRY_RUN=true` для тестов, потом `false`

Секреты также можно хранить напрямую в Render Environment Variables.

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

## Что умеет MVP

- подключать Instagram аккаунты через Meta OAuth;
- хранить 3–5 рабочих аккаунтов;
- создавать правила по ключевым словам;
- добавлять разные варианты публичного ответа;
- отправлять private reply/DM-шаблон;
- включать DRY_RUN;
- смотреть логи;
- ограничивать частоту отправок.

## Ограничения v1

Проверка «подписан пользователь или нет» не включена, потому что официальный Instagram Graph API не всегда даёт надёжный способ проверить любого пользователя на подписку. Эту функцию лучше добавлять после проверки доступных permissions и App Review.


## Если при подключении Instagram появляется 503

В этой версии OAuth больше не должен ронять сервис. Открой:

```
https://YOUR-RENDER-DOMAIN/healthz
https://YOUR-RENDER-DOMAIN/api/meta/debug
```

Проверь:

- `database` должен быть `connected`;
- `hasAppId` должен быть `true`;
- `hasAppSecret` должен быть `true`;
- `callbackUrl` нужно добавить в Meta App → Facebook Login → Valid OAuth Redirect URIs.

Для Render укажи переменные окружения:

```env
DATABASE_URL=Internal Database URL from Render PostgreSQL
APP_BASE_URL=https://YOUR-RENDER-DOMAIN.onrender.com
META_APP_ID=your_app_id
META_APP_SECRET=your_app_secret
META_GRAPH_VERSION=v23.0
META_WEBHOOK_VERIFY_TOKEN=any_random_token
DRY_RUN=true
```

После изменения Environment Variables сделай `Manual Deploy → Clear build cache & deploy`.
