# 部署指南

[首页](../README.zh-CN.md) · [English](deployment.md)

日常账号、模型与日志管理优先使用 [WebUI](webui.zh-CN.md)。以下命令均在仓库根目录执行。

## 配置与数据

首次部署运行 `cp .env.example .env`，并将 `CODEBUDDY2API_KEY` 设置为自己的随机密钥。已有 `.env` 请保留，只按需追加配置。

| 配置 | 作用 |
|------|------|
| `CODEBUDDY2API_IMAGE` | Compose 镜像；默认使用已发布的 `latest` 标签 |
| `CODEBUDDY2API_BIND` / `CODEBUDDY2API_PORT` | 本地监听与 Compose 宿主机映射；默认 `127.0.0.1:8787` |
| `CODEBUDDY2API_AUTH_PATH` | Compose 宿主机数据目录；默认 `./auth`，挂载到容器 `/data/auth` |
| `TZ` | 容器时区；每日任务按它跨天，未设置时保持 UTC |
| `CODEBUDDY2API_ENV_FILE` | 可选的 Compose 覆盖项，指定 env 文件路径；默认 `.env` |
| `CODEBUDDY2API_ALLOW_OPEN_NOAUTH` | 镜像与 Compose 的后台免鉴权选项，在两者中都固定为 `true`；对外暴露端口前请配置 `CODEBUDDY2API_KEY` |
| `CODEBUDDY2API_TRUSTED_PROXIES` | 可信代理 IP/CIDR（逗号分隔）；直连地址命中时审计改记 `X-Forwarded-For`/`X-Real-IP` 里的真实客户端地址，而不是代理地址 |
| `CODEBUDDY_AUTH_DIR` | 本地 Python 数据目录；默认仓库内 `auth/`。Compose 在容器内固定为 `/data/auth` |
| `CODEBUDDY_IMPORT_DIR` | 可选导入目录；默认数据目录下的 `imports/`。Compose 中请使用容器路径 |

`.env.example` 列出了全部生效的运行时变量及其默认值。Compose 会整体加载该文件，注释掉的键仍可在 WebUI 配置（工具元数据、Responses 投影、来源白名单、故障转移等）。取零表示关闭聚合/并发限制、Responses 单项裁剪或额外重试，而入站上限必须为正值。

Compose 会把 `.env` 加载进容器；镜像、宿主机映射与数据路径仍以 shell 变量优先。默认宿主机映射仅回环。开放远程访问前请设置随机密钥、HTTPS 与访问限制。容器内监听保持 `0.0.0.0:8787`；调整对外暴露用 `BIND/PORT`，不要改容器监听参数。

数据目录需整体挂载在可写本地存储，不要只挂载单个 SQLite 文件，也不要在多个实例间共享。升级前停止网关并备份整个目录，见[数据与备份](webui.zh-CN.md#数据与备份)。

## Docker Compose

### 使用已发布镜像

Compose 会把 `.env` 中的每个键加载进容器，可选配置无需在 Compose 里重复变量名；缺少 `.env` 时仍以网关默认值和 SQLite 中保存的设置为准。将 `CODEBUDDY2API_IMAGE` 设为 `ghcr.io/maiphucgiang/codebuddy2api:<版本>` 可固定使用已发布版本，然后运行：

```bash
docker compose pull
docker compose up -d --no-build
```

镜像支持 `linux/amd64` 与 `linux/arm64`。版本标签固定发行版，`latest` 跟随稳定版，`edge` 跟随 main。功能以所选版本为准；旧镜像可能不包含当前源码的 WebUI。

### 构建当前源码

```bash
docker compose build
docker compose up -d
```

构建包含 WebUI；宿主机无需安装 Node.js 和 Python。启动后打开 `http://127.0.0.1:8787/dashboard` 添加账号。

### 升级与重建

WebUI「版本更新」页也可在运行中的容器里一键更新或回滚，见[版本更新](webui.zh-CN.md#版本更新)。这些改动写在容器可写层，重新创建容器后回到镜像版本。若要跟随新镜像，可在宿主机 crontab 定期执行 `docker compose pull -q && docker compose up -d --no-build`。

修改 `.env` 后重新执行对应的 `docker compose up -d` 以重建配置发生变化的容器。更新本地源码后需重新构建；使用发布镜像时选择并拉取新版本。仅执行 `docker compose restart` 不会应用新的环境变量。保留数据目录即可保留登录状态。

## 反向代理与 HTTPS

默认的回环映射是唯一无需额外工作的安全暴露方式。将网关放到域名反代之后时：

- 在反代终止 TLS，并转发原始 Host 与协议（nginx 配置 `proxy_set_header Host $host` 与 `X-Forwarded-Proto $scheme`）。
- WebUI 会比较浏览器 `Origin` 与网关实际看到的地址。反代改写转发的 Host/协议时（例如域名 HTTPS 访问而容器内看到 HTTP），登录会报 Origin 校验失败。此时把对外地址加入「系统设置 → 管理页额外信任来源」，或设置 `CODEBUDDY2API_ADMIN_ORIGINS` / `--admin-allowed-origins`，而不是关闭 CSRF 保护；见[管理 Origin 校验](advanced.zh-CN.md#管理-origin--csrf-开关)。
- 任何非回环暴露都必须保持鉴权（`CODEBUDDY2API_KEY`）。

## 本地 Python 运行

需要 Python 3.12+ 与 uv。仅在发行包未自带界面时才需构建：Node.js 24 与 `web/package.json` 中 `vite-plus` 锁定的 vp CLI。

```bash
uv sync --locked --no-build --python 3.12
(cd web && vp install --frozen-lockfile && vp build)
uv run --locked --no-build converter.py --host 127.0.0.1 --port 8787
```

`uv.lock` 过期时 `--locked` 会直接失败而不是重新解析，因此源码启动不会升级依赖。当前工作目录的 `.env` 会被自动读取，`uv run` 无需 `--env-file`。发行包已包含 WebUI，可跳过界面构建。

本地启动无需 `.env`。没有显式 key 时，首次回环启动会生成 `cb-…` 默认密钥，保存到 `auth/control.sqlite3`，监听成功后仅在交互终端显示一次；以后重启复用且不再打印。请妥善保存，管理登录与 API 请求共用。首次后台或非回环部署请显式配置 key。

密码提示直接写入控制终端（`/dev/tty` 或 Windows `CONOUT$`），不经过 stdout/stderr，重定向标准输出不会收集密码；外部终端录制不在程序控制范围内。

终端写入或数据库提交失败时，同一密钥保留为待显示，下次交互启动可重试。显示后、提交前崩溃可能再次提示；成功提交后不重复显示。

没有 uv 时，用虚拟环境安装同一份带哈希的依赖：

```bash
python3 -m venv .venv
. .venv/bin/activate          # Windows：.venv\Scripts\activate
python3 -m pip install --require-hashes --only-binary=:all: -r requirements.txt
python3 converter.py --host 127.0.0.1 --port 8787
```

两种启动方式都会读取当前工作目录的 `.env`（若存在），不搜索父目录。优先级：显式 CLI > 进程环境变量 > `.env` > SQLite 保存值 > 默认值。覆盖不改写已保存的默认 key；显式空 key 仍锁定管理。修改监听需重启，`CODEBUDDY2API_IMAGE/AUTH_PATH` 只作用于 Compose。

### 配置迁移

`.env` 中的值仍然优先，因此任何写在里面的运行参数都会占住 WebUI 的对应项。要统一到配置库，先停止服务，再执行离线命令；命令不会改动 `.env` 本身：

```bash
python3 converter.py config migrate            # 当前目录 .env -> ./auth/control.sqlite3
python3 converter.py config migrate --env-file /srv/app/.env --data-dir /srv/app/auth
python3 converter.py config status --db /srv/app/auth/control.sqlite3   # 只读
```

两条命令都先解析 env 文件，再采用其中声明的数据目录（`CODEBUDDY_AUTH_DIR`），`--data-dir`/`--db` 只覆盖解析结果。写入前 `migrate` 会验证目标确实是本项目的控制库（SQLite 魔数、`user_version=2`、`control`/`runtime_state`/`gateway_secrets`、可解析的 payload、`quick_check`），并在检测到运行中实例的租约或写锁时拒绝；`--force` 只跳过租约提示。部署类键（密钥、监听地址、数据路径）不会迁移。容器内没有 `.env` 文件，改用进程环境变量：

```bash
docker compose stop
docker compose run --rm --no-deps -e CODEBUDDY_AUTH_DIR=/data/auth \
  codebuddy2api python3 converter.py config migrate --no-env --data-dir /data/auth
```

成功时值写入与“关闭 Dashboard 提醒”在同一次 revision 内提交；按提示删除 `.env` 中对应行后，这些项改由配置库提供、可在 WebUI 修改。旧版本启动的实例不写租约，升级后首次迁移前请自行确认服务已停止。`config status` 不写库。`--lang zh|en|auto` 决定 CLI 输出语言，并在 `serve`、`login`、`config migrate` 时把界面语言一并保存；见[配置与 CLI](advanced.zh-CN.md#配置与-cli)。

> 审计库为单写者设计：升级新版本前先停止旧实例，不要让两个版本的网关共用同一 auth 目录。

### 升级与数据迁移

发布包安装与 Git 工作区可在 WebUI「版本更新」页一键更新或回滚：校验发布包、备份配置库后原地替换程序文件，并按原启动参数重启；见[版本更新](webui.zh-CN.md#版本更新)。手动升级时，先停止网关并备份整个数据目录。首次启动将旧 JSON 会话、冷却、积分/领取、目录和用量状态一次性导入 `control.sqlite3`；原文件保留作备份，不再参与读写。关键数据损坏或迁移失败会阻止启动，请修复或恢复备份，不要删除账本绕过检查。

SQLite 状态读取或校验失败会阻止启动，不删除会话、不回退为空状态；修复控制库后再启动。仅可重建缓存的写入失败允许保留当前内存数据并告警。

所有运行日志使用 `logs.sqlite3`；旧 `--log` / `CODEBUDDY2API_LOG` 仅提示弃用，不再输出文本文件。自动生成的 key 只进私有配置，不进任何日志。限制数据目录访问权限；Windows 应使用当前用户的私有目录。

旧版本不能读取升级后的控制库。回滚须停机并迁回匹配的状态，不能只切代码后复用旧 JSON；升级后发生的领取、派遣或会话撤销不能用过期备份覆盖。

## 依赖锁定

`pyproject.toml` 声明直接依赖；`uv.lock` 锁定全部解析版本。带哈希的 `requirements.txt` 是供 pip、Docker 与 CI 使用的生成文件：

```bash
uv lock
python3 scripts/export_requirements.py
```

有意调整依赖时使用 `uv add`/`uv remove`，然后导出并核对锁定文件。日常启动使用 `--locked`，不会升级任何包。元数据与当前 `VERSION` 保持一致；发版必须同时更新两处版本字段。pip/Docker 仍要求哈希匹配与二进制 wheel，不要关闭这些校验。

Docker 构建所用的前端、Node 与 Python 镜像均按多平台摘要锁定。刷新它们时保留 `linux/amd64` 与 `linux/arm64` 支持并验证构建。锁定只能防止漂移，不能免疫未来漏洞；安全更新仍需评审后刷新。

## 命令行登录

WebUI 不可用时不启动服务也能完成浏览器登录：

```bash
uv run --locked --no-build converter.py login
uv run --locked --no-build converter.py login --site intl --no-browser
uv run --locked --no-build converter.py login --site intl-codebuddy --no-browser
```

第一条使用国内站。`--site intl` 选择国际 WorkBuddy（`www.workbuddy.ai`）；`--site intl-codebuddy` 选择国际 CodeBuddy（`www.codebuddy.ai`）。`--no-browser` 打印授权链接，可在其他设备打开。即使浏览器显示成功，也要等终端确认凭证已保存。链接 10 分钟过期；按 `Ctrl+C` 取消。

Docker 中使用 `docker compose exec codebuddy2api python3 converter.py login --no-browser`；按所选国际产品追加 `--site intl` 或 `--site intl-codebuddy`。镜像版本需包含对应登录选项。

登录与服务必须使用同一个 `CODEBUDDY_AUTH_DIR`。默认目录扫描会自动加载新账号；重复登录会更新同一身份。以 `--auth-file` 启动的服务只使用指定文件。

在默认本地模式且未设置 `CODEBUDDY_AUTH_DIR` 时，启动会从已登录的桌面客户端导入缺失凭证。也可以直接向管理目录放入 `.info` 文件。桌面端与网关各自的独立刷新可能互相挤掉 token；建议使用独立的浏览器登录。

## 不使用 Compose

准备 `.env` 后，构建并运行本地源码镜像：

```bash
docker build -t codebuddy2api:local .
docker run -d --name codebuddy2api -p 127.0.0.1:8787:8787 \
  --env-file .env -v "$PWD/auth:/data/auth" \
  -e CODEBUDDY_AUTH_DIR=/data/auth codebuddy2api:local
```

该命令显式使用默认端口与目录，不依赖 Compose 的端口映射。在 WebUI 添加账号，或运行 `docker exec -it codebuddy2api python3 converter.py login --no-browser`。

## 验证

`curl http://127.0.0.1:8787/health` 应返回 `{"status":"ok"}`。它只表示存活，不代表账号或模型可用；请在 WebUI 中查看。API 接入见[客户端配置](clients.zh-CN.md)，错误与重试边界见[进阶参考](advanced.zh-CN.md)。

## Rakserver 生产部署

部署仓库 `ccfwwm/codebuddy2api-private`（现为公开仓库）的 `main` 分支每次通过 CI 后，会构建并发布 GHCR 镜像，再通过受限 SSH 命令部署镜像摘要。公开仓库可使用标准 GitHub 托管 runner 构建，不消耗私有仓库分钟数。服务器仅重建 `codebuddy2api` 容器，持久数据保存在 `/opt/codebuddy2api/auth`；GitHub Actions 不上传应用凭据。

生产容器名为 `codebuddy2api`，加入 `sub2api-deploy_sub2api-network`。同一网络中的容器可用 `http://codebuddy2api:8787` 访问。宿主机只在 `127.0.0.1:8787` 发布端口，由 Nginx 提供 `https://qqapi.aicodeme.xyz`。

生产 Compose 仅信任回环地址和 Docker 网络网关 `192.168.64.1` 的转发头，使应用能够识别 Nginx 转发的 HTTPS 请求，并为管理会话 Cookie 添加 Secure 标志。如果重建网络后网关地址变化，需要同步修改 `FORWARDED_ALLOW_IPS`。

额外信任的管理来源 `https://qqapi.aicodeme.xyz` 保存在 `auth/control.sqlite3`，可直接在 WebUI 中修改。不要再向 Compose 或容器环境中加入 `CODEBUDDY2API_ADMIN_ORIGINS`：环境变量即使已迁移，也会继续覆盖配置库并锁定该项。密钥、路径及代理信任仍由部署配置管理。

如果现有部署还在注入这个变量，须先使用旧 Compose 迁移实际生效的值，再移除变量。下面的命令在 Rakserver 上执行，不是在 Windows 项目目录执行：

```bash
cd /opt/codebuddy2api
docker compose --env-file .env stop codebuddy2api
# 先完整备份 auth/ 目录，备份仅限 root 读取，并验证备份可读。
docker compose --env-file .env run --rm --no-deps --pull never codebuddy2api \
  python3 converter.py config migrate --no-env --data-dir /data/auth \
  --keys admin_allowed_origins --dry-run
docker compose --env-file .env run --rm --no-deps --pull never codebuddy2api \
  python3 converter.py config migrate --no-env --data-dir /data/auth \
  --keys admin_allowed_origins
# 从 Compose 及其他环境来源中移除 CODEBUDDY2API_ADMIN_ORIGINS。
docker compose --env-file .env up -d --no-deps --pull never codebuddy2api
```

容器停止后不能用 `docker exec` 执行命令，也不要用 `--force` 绕过运行中实例检查。完成后确认 `/admin/settings` 中 `admin_allowed_origins` 的来源为 `management`、`locked` 为 `false`，并验证管理登录正常。

WebUI 没有单独的用户名密码账号，使用 `CODEBUDDY2API_KEY` 登录。该密钥保存在服务器 `/opt/codebuddy2api/.env`，权限为 root-only；更换后需要用新密钥重新登录。账号凭证保存在 `auth/`，备份和升级时须保留整个目录。

生产升级沿用 CI 镜像部署流程。部署脚本先拉取并核对镜像摘要，再停止此服务、备份整个 `auth/` 目录并重建容器；健康检查失败时恢复旧镜像和对应数据快照。升级会造成短暂停机，应先完成测试和镜像构建。WebUI 的就地更新只修改容器可写层，重建容器后会丢失，因此生产版本应通过 CI 构建的镜像统一更新。
