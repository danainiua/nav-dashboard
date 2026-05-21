# 导航站 - Docker 版本（主要维护）

一个基于卡片式布局的现代化导航站点，采用磨砂玻璃设计风格，支持 Docker 自托管部署。这是目前项目的主要维护版本。

> 维护状态：Docker 版是主维护线，后续新功能和安全加固默认只进入 Docker 版；Cloudflare 版仅保留给既有部署兼容使用。

![导航站截图](../screenshot.png)

## ✨ 特性

- 🎨 磨砂玻璃效果 + 暖色调设计
- 🌙 暗色模式切换
- 🔍 多引擎搜索 (Google/Bing/GitHub)
- 📱 响应式布局
- 🖼️ 灵活图标支持 (URL/本地上传)
- 🔒 密码保护管理后台

## 🚀 快速部署

### 使用 Docker Compose（推荐）

```bash
# 1) 创建 .env 并设置强密码（必填）
cat > .env <<'EOF'
ADMIN_PASSWORD=replace-with-a-strong-password
TZ=Asia/Shanghai
EOF

# 启动服务
docker-compose up -d

# 查看日志
docker-compose logs -f

# 停止服务
docker-compose down
```

访问：`http://localhost:3000`

> 请务必在启动前设置强 `ADMIN_PASSWORD`，不要使用弱口令。

### 使用 Docker 命令

```bash
# 构建镜像
docker build -t nav-dashboard .

# 运行容器
docker run -d \
  --name nav-dashboard \
  -p 3000:3000 \
  -v $(pwd)/data:/app/data \
  -v $(pwd)/uploads:/app/uploads \
  -e ADMIN_PASSWORD=replace-with-a-strong-password \
  nav-dashboard
```

## ⚙️ 配置

### 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PORT` | `3000` | 服务端口 |
| `ADMIN_PASSWORD` | *(必填，无安全默认值建议)* | 管理后台密码 |
| `TZ` | `UTC` | 时区 |
| `CORS_ORIGINS` | *(空)* | 允许跨域访问的来源，多个来源用英文逗号分隔；为空时仅同源/无 Origin 请求可用 |
| `COOKIE_SECURE` | `false` | 设为 `true` 时登录 Cookie 添加 `Secure` 属性，适合 HTTPS 部署 |
| `TRUST_PROXY` | `false` | 反向代理 HTTPS 部署时设为 `true`，同时信任代理并启用安全 Cookie 判断 |
| `ALLOWED_IMAGE_DOMAINS` | *(内置常用图标源)* | 额外允许代理/缓存远程图标的域名，多个域名用英文逗号分隔 |

### 数据持久化

```yaml
volumes:
  - ./data:/app/data       # SQLite 数据库
  - ./uploads:/app/uploads # 上传的图片
```

这两个目录是最重要的运行数据，升级、迁移和回滚前都应先备份。

## 🧭 维护流程

### 升级前备份

在 `docker/` 目录执行：

```bash
npm run backup:upgrade
```

脚本会把 `./data` 和 `./uploads` 复制到 `./upgrade-backups/backup-时间戳/`。如果你的持久化目录不在默认位置，可以指定路径：

```bash
NAV_DATA_DIR=/path/to/data NAV_UPLOADS_DIR=/path/to/uploads NAV_BACKUP_DIR=/path/to/backups npm run backup:upgrade
```

Windows PowerShell 示例：

```powershell
$env:NAV_DATA_DIR="D:\\nav-dashboard\\data"; $env:NAV_UPLOADS_DIR="D:\\nav-dashboard\\uploads"; npm run backup:upgrade
```

### Docker Compose 升级

```bash
# 1) 先备份
npm run backup:upgrade

# 2) 拉取新镜像
docker-compose pull

# 3) 重新创建容器
docker-compose up -d

# 4) 查看日志和健康状态
docker-compose logs -f --tail=100
docker-compose ps
```

如果你使用的是固定版本镜像，先修改 `docker-compose.yml` 中的 `image` 标签，再执行上述命令。

### 健康检查

容器内置健康检查会请求：

```text
/health/ready
```

也可以手动验证：

```bash
curl -fsS http://localhost:3000/health/ready
```

### 回滚

如果升级后发现问题：

```bash
# 1) 停止服务
docker-compose down

# 2) 恢复升级前备份
rm -rf ./data ./uploads
cp -a ./upgrade-backups/backup-时间戳/data ./data
cp -a ./upgrade-backups/backup-时间戳/uploads ./uploads

# 3) 把 docker-compose.yml 的 image 改回旧版本，然后启动
docker-compose up -d
```

Windows PowerShell 示例：

```powershell
docker-compose down
Remove-Item -Recurse -Force .\\data, .\\uploads
Copy-Item -Recurse .\\upgrade-backups\\backup-时间戳\\data .\\data
Copy-Item -Recurse .\\upgrade-backups\\backup-时间戳\\uploads .\\uploads
docker-compose up -d
```

### 管理后台备份恢复

管理后台内置备份/恢复适合日常导出和 WebDAV 同步；升级前仍建议使用本地目录备份，因为它同时覆盖 SQLite 数据库和上传图片。

恢复备份时建议：

1. 先执行 `npm run backup:upgrade` 保留当前状态。
2. 在管理后台执行恢复。
3. 刷新首页和后台，确认站点、分类、标签、图标都正常。
4. 如恢复失败，停止服务并用本地目录备份回滚。

## 📂 目录结构

```
docker/
├── server/
│   ├── index.js    # Express 后端
│   └── db.js       # 数据库模块
├── public/         # 前端静态文件
├── data/           # SQLite 数据 (运行时)
├── uploads/        # 上传图片 (运行时)
├── Dockerfile
├── docker-compose.yml
└── package.json
```

## 🔧 管理后台

访问 `/admin.html` 进入管理后台

**管理密码**：使用部署时设置的 `ADMIN_PASSWORD`

管理员相关写操作和备份接口由服务端鉴权保护，未登录请求会返回 `401`。

## ✅ 基础验证

```bash
npm test
```

当前测试覆盖 Docker 端服务启动、鉴权边界、输入校验、图片上传/代理、导入/备份恢复和前端渲染安全回归。

## 📄 许可证

MIT License
