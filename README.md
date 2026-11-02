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

存档用的 token 来自环境变量 `MAOWO_TOKEN`；没设置的话，第一次启动时会自动生成，写在 `data/maowo-token.txt`。所有数据都在 `data/` 目录，备份时拷走这个目录就行。
