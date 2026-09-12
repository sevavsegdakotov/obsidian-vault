# Obsidian Vault MCP

Безопасный коннектор между Obsidian, ChatGPT и Codex. Он даёт ИИ прямой доступ к Markdown-файлам без кликов по интерфейсу Obsidian и без платного Obsidian Sync.

Поддерживаются два режима:

- **Mac / Codex:** локальный MCP через `stdio` и официальный Obsidian CLI.
- **VPS / ChatGPT:** копия хранилища через Syncthing, MCP в Docker и официальный OpenAI Secure MCP Tunnel.

```text
Obsidian на устройствах
        ↕ Syncthing
копия хранилища на VPS
        ↕ локальный Docker-порт 127.0.0.1
Obsidian Vault MCP
        ↕ OpenAI Secure MCP Tunnel
ChatGPT
```

## Что умеет

- искать по всему хранилищу и показывать строки совпадений;
- читать заметки и их структуру;
- создавать новые заметки без перезаписи существующих;
- добавлять текст и точечно обновлять разделы;
- блокировать запись, если файл изменился после чтения;
- работать без включённого Mac, если VPS и Syncthing доступны;
- напоминать модели учитывать не только Obsidian, но и контекст разговора или память, чётко разделяя подтверждённое и непроверенное.

Коннектор намеренно не умеет удалять и перемещать заметки.

## Быстрый локальный запуск

Понадобятся Node.js 22+, Obsidian и включённый официальный Obsidian CLI.

```bash
git clone https://github.com/sevavsegdakotov/obsidian-vault.git
cd obsidian-vault
npm ci
export OBSIDIAN_VAULT_ROOT="/полный/путь/к/вашему/vault"
npm test
./scripts/launch-stdio
```

Для Codex установите папку как локальный плагин. Переменная `OBSIDIAN_VAULT_ROOT` должна быть доступна процессу Codex; `.mcp.json` уже передаёт её MCP-серверу.

Если официальный CLI недоступен, можно использовать встроенный файловый поиск:

```bash
export OBSIDIAN_BACKEND=filesystem
```

## Запуск на VPS

1. Установите Docker и Syncthing.
2. Синхронизируйте vault с отдельной папкой на VPS в двустороннем режиме. Включите версионирование файлов на сервере.
3. Скопируйте `.env.example` в `.env` и укажите реальный путь к серверной копии vault.
4. Запустите контейнер:

```bash
docker compose -f compose.vps.yaml up -d --build
curl -fsS http://127.0.0.1:3777/healthz
```

Порт `3777` привязан только к `127.0.0.1`. Не открывайте его в интернет.

## Подключение ChatGPT

Для доступа из ChatGPT используйте официальный [OpenAI Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels). Туннель сам устанавливает исходящее защищённое соединение с OpenAI, поэтому входящий MCP-порт на VPS открывать не требуется.

После регистрации туннеля:

1. направьте его на `http://127.0.0.1:3777/mcp`;
2. храните выданный ключ и профиль вне репозитория;
3. запустите tunnel client как системную службу;
4. добавьте MCP в ChatGPT через режим разработчика и проверьте, что определились девять инструментов.

Актуальные шаги подключения сверяйте с официальными руководствами OpenAI: [MCP](https://learn.chatgpt.com/docs/extend/mcp) и [Plugins](https://learn.chatgpt.com/docs/plugins).

Файл `deploy/obsidian-tunnel.service` — безопасный пример systemd-службы. Перед установкой замените пользователя, пути и имя профиля на свои.

## Настройки

| Переменная | Для чего | По умолчанию |
|---|---|---|
| `OBSIDIAN_VAULT_ROOT` | Абсолютный путь к vault внутри текущей системы | обязательна |
| `OBSIDIAN_BACKEND` | `filesystem` для VPS без приложения Obsidian | официальный CLI |
| `OBSIDIAN_CLI_PATH` | Путь к Obsidian CLI | стандартный путь macOS |
| `OBSIDIAN_NEW_NOTE_FOLDER` | Папка для новых заметок | корень локально, `Inbox` в Docker Compose |
| `OBSIDIAN_TIME_ZONE` | Часовой пояс дат | `UTC` |
| `HOST`, `PORT` | Адрес HTTP-сервера | `127.0.0.1:3777` |
| `ALLOWED_HOSTS` | Допустимые HTTP Host | loopback и имя контейнера |

## Безопасная запись

Перед изменением заметки модель обязана сначала вызвать `read_obsidian_note`. Чтение возвращает SHA-256 текущего текста. Этот SHA-256 передаётся в операцию записи. Если Syncthing, Obsidian или другой пользователь успел изменить файл, запись отменяется — старый текст не затирается.

Дополнительно блокируются выход за пределы vault, скрытые пути и символьные ссылки. Полная модель угроз описана в [SECURITY.md](SECURITY.md).

## Проверка

```bash
npm test
docker compose -f compose.vps.yaml config
```

После запуска проверьте:

```bash
curl -fsS http://127.0.0.1:3777/healthz
```

Затем в ChatGPT или Codex попросите:

1. найти тестовую заметку;
2. прочитать её;
3. добавить строку;
4. убедиться, что изменение появилось в Obsidian на другом устройстве.

## Лицензия

[MIT](LICENSE)
