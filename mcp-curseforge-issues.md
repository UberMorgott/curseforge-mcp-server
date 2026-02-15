# MCP CurseForge Server — Issues

Документ для доработки MCP сервера CurseForge.

## 1. `get_upload_game_versions` — 404 для Hytale

**Инструмент:** `mcp__curseforge__get_upload_game_versions`
**Вызов:** `game_slug: "hytale"`
**Ожидание:** Список доступных версий игры для формы загрузки
**Результат:** HTTP 404 — возвращает HTML-страницу "Hytale Modding Official Launch" вместо JSON

**Проблема:** Эндпоинт Upload API для Hytale, вероятно, отличается от стандартного CurseForge API. Сервер использует `https://hytale.curseforge.com/api/game/versions` или аналогичный URL, который редиректит на лендинг.

**Workaround:** Для загрузки файлов Hytale `game_version_ids` не обязателен — CurseForge принимает загрузку без указания версий (определяет автоматически).

---

## 2. `update_project_description` — 403 CloudFront

**Инструмент:** `mcp__curseforge__update_project_description`
**Вызов:** `project_id: 1437738, description: "<h1>...</h1>"`
**Ожидание:** Обновление описания проекта
**Результат:** HTTP 403 — CloudFront блокирует запрос: "This distribution is not configured to allow the HTTP request method that was used for this request."

**Проблема:** CurseForge CDN (CloudFront) блокирует POST/PUT/PATCH запросы к `/api/v1/mods/{id}/description`. Этот эндпоинт, вероятно, требует:
- Другой базовый URL (например `authors.curseforge.com`)
- Авторизацию через CURSEFORGE_AUTHOR_TOKEN (Author API), а не стандартный API key
- Cookie-based авторизацию (сессия автора)

**Workaround:** Описание обновляется вручную через https://authors.curseforge.com/ или через Playwright-автоматизацию.

---

## 3. `get_mod_description` — работает, но с оговорками

**Инструмент:** `mcp__curseforge__get_mod_description`
**Статус:** Работает (HTTP 200)
**Но:** Возвращает огромный HTML (> 900K символов), включая полный HTML лендинга CurseForge, а не только контент описания мода. Это может приводить к переполнению контекста LLM.

---

## 4. `upload_file` — не работает через MCP

**Инструмент:** `mcp__curseforge__upload_file`
**Статус:** Не тестировалось напрямую (использовали curl), но `get_upload_game_versions` (зависимость) не работает.

**Workaround:** Используется curl напрямую:
```bash
curl -X POST \
  -H "X-Api-Token: TOKEN" \
  -F 'metadata={"changelog":"...","releaseType":"release","changelogType":"markdown"}' \
  -F "file=@./build/libs/Mod.jar" \
  "https://www.curseforge.com/api/projects/PROJECT_ID/upload-file"
```

---

## Общая проблема

CurseForge API разделён на несколько доменов:
- `api.curseforge.com` — публичный API (чтение, поиск модов)
- `www.curseforge.com/api/projects/` — Upload API (загрузка файлов, требует Author Token)
- `authors.curseforge.com` — Author Console (управление проектами, описание)
- `www.curseforge.com/api/v1/` — v1 API (комментарии, некоторые данные)

MCP сервер, похоже, смешивает эти эндпоинты. Нужно:
1. Разделить обращения по доменам
2. Использовать Author Token (`X-Api-Token`) для Upload API
3. Для `update_project_description` исследовать правильный эндпоинт (возможно `authors.curseforge.com` API)
4. Фильтровать HTML из ответов `get_mod_description` (возвращать только content, не весь DOM)

---

## Возможная причина: отсутствие API ключей

MCP серверу CurseForge могут требоваться API ключи для корректной работы:
- **CURSEFORGE_API_KEY** — для публичного API (`api.curseforge.com`)
- **CURSEFORGE_AUTHOR_TOKEN** — для Author API (загрузка, обновление описания)

Если ключи не настроены в конфигурации MCP сервера, он может пытаться обращаться к API без авторизации, что вызывает 403/404.

Текущий рабочий Author Token: `0f851db2-91d9-4bf3-b463-ca60a5c0c097` (из `DEV/DOCS/PUBLISHING.md`)

Нужно проверить конфигурацию MCP сервера и убедиться, что токены переданы.

---

## Рабочие инструменты (проверено)

| Инструмент | Статус | Примечание |
|------------|--------|------------|
| `get_mod_description` | Работает | Но возвращает слишком много HTML |
| `search_mods` | Работает | — |
| `get_mod` | Работает | — |
| `get_comments` | Работает | — |
| `upload_file` | Не проверен | Зависимость на game_versions ломает flow |
| `update_project_description` | Не работает | 403 CloudFront |
| `get_upload_game_versions` | Не работает | 404 для Hytale |
| `get_upload_game_version_types` | Не проверен | Вероятно аналогичная проблема |
