# maowo
绫家机专用mcp 猫窝

和Claude、ChatGPT玩游戏用的mcp～（迁移自 game-mcp-server）

## 运行

```bash
npm install
npm start
```

- 网页：`http://localhost:3000`
- 存档：`http://localhost:3000/vault`
- MCP（SSE）：`http://localhost:3000/mcp?token=<token>`

存档用的 token 来自环境变量 `MAOWO_TOKEN`；没设置的话，第一次启动时会自动生成，写在 `data/maowo-token.txt`。所有数据都在 `data/` 目录。存档页的「导出全部」会把笔记和文件打包成一个 zip；换服务器后，在新的猫窝里「从备份导入」，就能原样恢复。
