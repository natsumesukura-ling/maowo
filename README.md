# maowo
绫家机专用mcp 猫窝

和Claude、ChatGPT玩游戏用的mcp～（迁移自 game-mcp-server）

## 装到服务器（Ubuntu 22.04 / 24.04）

在服务器的终端里运行：

```bash
curl -fsSL https://raw.githubusercontent.com/natsumesukura-ling/maowo/ccr-d223d08b-tyy5yy/deploy/install.sh | sudo bash
```

脚本会装好 Node.js 和 Caddy，把猫窝放在 `/opt/maowo`，数据放在 `/var/lib/maowo`，设置开机自动启动，并自动配置 HTTPS（没有域名时用 `<IP>.sslip.io`）。再运行一次就是更新。服务器防火墙需要放行 80 和 443 端口。

## 本地运行

```bash
npm install
npm start
```

- 网页：`http://localhost:3000`
- 存档：`http://localhost:3000/vault`
- MCP（Streamable HTTP，也兼容旧的 SSE）：`http://localhost:3000/mcp?token=<token>`

存档用的 token 来自环境变量 `MAOWO_TOKEN`；没设置的话，第一次启动时会自动生成，写在 `data/maowo-token.txt`。所有数据都在 `data/` 目录。存档页的「导出全部」会把笔记和文件打包成一个 zip；换服务器后，在新的猫窝里「从备份导入」，就能原样恢复。
