# MCP CurseForge Server — Issues

Документ для отслеживания известных проблем MCP сервера CurseForge.

## 1. `get_upload_game_versions` — 404 для Hytale

**Инструмент:** `get_upload_game_versions`
**Вызов:** `game_slug: "hytale"`
**Ожидание:** Список доступных версий игры для формы загрузки
**Результат:** HTTP 404 — возвращает HTML-страницу вместо JSON

**Проблема:** Эндпоинт Upload API для Hytale отличается от стандартного. URL `https://hytale.curseforge.com/api/game/versions` редиректит на лендинг.

**Workaround:** Для загрузки файлов Hytale `game_version_ids` не обязателен — CurseForge принимает загрузку без указания версий.

---

## 2. `upload_file` — Cloudflare блокирует upload (Mar 7, 2026)

**Инструмент:** `upload_file`
**Вызов:** `project_id: 1437738, file_path: "...NickNameChanger-0.0.17.jar"`
**Ожидание:** Успешная загрузка файла
**Результат:** Cloudflare блокирует запрос (403 или challenge page)

**Контекст:** После применения gameVersions fix, upload через MCP и curl к `https://www.curseforge.com/api/projects/PROJECT_ID/upload-file` периодически блокируется Cloudflare. Агент-релизёр v0.0.17 был вынужден загрузить через Authors Dashboard вручную.

**Возможные причины:**
- Cloudflare rate limiting при множественных запросах за сессию
- User-Agent фильтрация (curl без browser-like headers)
- IP reputation / bot detection

**Возможные решения:**
- Добавить browser-like headers (User-Agent, Accept, Referer)
- Использовать BrowserClient (Playwright) для upload как fallback
- Retry с задержкой при 403

**Workaround:** Загрузка через Authors Dashboard (`https://authors.curseforge.com/#/projects/PROJECT_ID/files`) или через curl с правильными headers в отдельной сессии.

---

## Статус инструментов

| Инструмент | Статус | Примечание |
|------------|--------|------------|
| `search_mods` | Работает | — |
| `get_mod` | Работает | — |
| `get_mod_description` | Работает | HTML фильтруется |
| `get_comments` | Работает | Через BrowserClient |
| `post_comment` | Работает | Через BrowserClient |
| `delete_comment` | Работает | Через BrowserClient |
| `upload_file` | Частично | gameVersions fix applied, но Cloudflare иногда блокирует (см. issue #2) |
| `update_project_description` | Работает | Authors API |
| `get_project_settings` | Работает | Authors API |
| `get_upload_game_versions` | Не работает | 404 для Hytale |
| `get_upload_game_version_types` | Работает | — |
| `get_project` | Работает | CFWidget |
| `search_author` | Работает | CFWidget |
| `cf_fetch_page` | Работает | BrowserClient |
