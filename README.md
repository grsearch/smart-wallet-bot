# SOL 聪明钱包自动跟单机器人

这是原 Pump 交易机器人旁边的一份独立副本。它不会改动或替换上级目录里的旧机器人文件。

默认跟踪钱包：

```text
7yd579zXmWPoxEE22BUYTzAo8nyMmQtPyEWS3g1BFhH4
```

## 工作方式

1. 用多区域 Yellowstone/LaserStream 的 `PROCESSED` 数据流，只订阅被跟踪钱包涉及的交易。
2. 要求被跟踪钱包是交易签名者，并从 `preTokenBalances` / `postTokenBalances` 的真实余额变化判断买卖，避免只看日志关键字造成误跟。
3. 当前直接支持 Pump bonding curve 和 PumpSwap 的 SOL 交易。检测到非 SOL 报价、流动性操作、一次改变多个非报价币等歧义交易时会安全跳过。
4. 买入采用固定金额或按聪明钱包估算买入额的比例跟单。
5. 卖出默认采用首单清仓：聪明钱包出现第一笔卖出时，立即卖掉该来源钱包对应的全部复制仓位；以后也可以改为按比例减仓。
6. 源交易签名、复制仓位和执行结果会落盘，重连或重启后不会重复提交同一个源交易。
7. 内置只读 Web Dashboard，实时展示运行状态、区域连接、持仓、交易记录和预估已实现盈亏。

低延迟路径包含：多区域首包去重、内存余额解析、预缓存 blockhash、Pump/PumpSwap 直连构建交易，以及 Staked RPC 与多个 Sender 区域并发提交。

> 跟单只能在被跟踪交易已经被节点观察到后发出，因此无法保证相同成交价、相同 slot 或一定盈利。低流动性币的滑点、夹子、源钱包诱导交易和交易落链失败都可能造成亏损。

## 安装

在本目录中执行：

```powershell
npm install
Copy-Item .env.example .env
npm test
npm start
```

`.env.example` 已按硅谷服务器预设美国西部端点。先编辑 `.env`，填入：

- `HELIUS_LASERSTREAM_ENDPOINTS`
- `HELIUS_LASERSTREAM_TOKEN`
- `HELIUS_RPC_URL`
- 可选的 `HELIUS_STAKED_RPC_URL` 和 `HELIUS_SENDER_ENDPOINTS`

## 硅谷服务器端点

项目默认同时连接最接近硅谷的两个美国西部 LaserStream 区域，哪个区域先收到同一笔交易就使用哪个，重复信号会被签名去重：

```env
HELIUS_LASERSTREAM_ENDPOINTS=https://laserstream-mainnet-lax.helius-rpc.com,https://laserstream-mainnet-slc.helius-rpc.com
HELIUS_SENDER_ENDPOINTS=http://slc-sender.helius-rpc.com/fast
```

- `lax`：洛杉矶，美国西部。
- `slc`：盐湖城，美国西部，也是 Helius 当前公开的美国西部后端 Sender 区域。
- 标准 `HELIUS_RPC_URL` 会由 Helius 自动路由到附近节点，不需要手工指定区域。

端点来源：[Helius LaserStream 区域文档](https://www.helius.dev/docs/laserstream/grpc)和 [Helius Sender 文档](https://www.helius.dev/docs/sending-transactions/sender)。实际延迟取决于服务器机房和网络路由，建议上线后比较 LAX/SLC 的首包数据再决定是否只保留一个区域。

第一次启动务必保留：

```env
DRY_RUN=true
```

观察到 BUY、SELL、比例、币种和跳过原因均符合预期后，再填入独立的小额热钱包私钥并切换：

```env
DRY_RUN=false
WALLET_PRIVATE_KEY_BS58=你的Base58私钥
```

不要把 `.env`、私钥或整个实盘数据目录提交到 Git。

## Dashboard

Dashboard 会随机器人一起启动，默认地址：

```text
http://127.0.0.1:8787
```

页面每 2 秒刷新，显示：

- LIVE / DRY_RUN 模式、运行时长和最近错误。
- LAX、SLC 数据流连接与最后消息时间。
- 当前复制仓位、持仓成本、来源钱包和交易场所。
- 最近买入、卖出、跳过与失败记录，以及提交延迟和 Solscan 链接。
- 按卖出时报价估算的已实现盈亏；它不是钱包余额，也不包含最终成交偏差、优先费和 Sender tip。

Dashboard 默认只允许服务器本机访问。推荐用 SSH 隧道从自己的电脑查看：

```powershell
ssh -L 8787:127.0.0.1:8787 用户名@服务器IP
```

然后在本机打开 `http://127.0.0.1:8787`。如果必须监听公网地址，需要同时设置访问密码：

```env
DASHBOARD_HOST=0.0.0.0
DASHBOARD_TOKEN=请设置一个足够长的随机密码
```

浏览器会弹出 HTTP Basic 登录框，用户名固定为 `dashboard`，密码为 `DASHBOARD_TOKEN`。更推荐继续使用回环地址，并在服务器防火墙或反向代理层保护访问。

## 添加更多聪明钱包

用英文逗号分隔：

```env
SMART_WALLETS=7yd579zXmWPoxEE22BUYTzAo8nyMmQtPyEWS3g1BFhH4,第二个钱包,第三个钱包
```

仓位按“来源钱包 + mint”分开记账。同一个币被多个聪明钱包买入时，各来源仓位的跟卖比例不会互相覆盖。

## 买卖规则

固定金额跟买（默认）：

```env
FOLLOW_BUY_MODE=FIXED
FOLLOW_BUY_SOL=0.05
FOLLOW_MIN_BUY_SOL=0.02
FOLLOW_MAX_BUY_SOL=0.30
```

按源钱包买入额的 10% 跟买：

```env
FOLLOW_BUY_MODE=PROPORTIONAL
FOLLOW_BUY_SCALE=0.10
FOLLOW_MIN_BUY_SOL=0.02
FOLLOW_MAX_BUY_SOL=0.30
```

源钱包第一次卖出就清掉对应复制仓位（默认，适合当前小额实测）：

```env
FOLLOW_SELL_MODE=FULL
```

以后如需按源钱包卖出比例分批跟卖：

```env
FOLLOW_SELL_MODE=PROPORTIONAL
```

## 风控

常用限制：

```env
FOLLOW_MAX_SIGNAL_AGE_MS=5000
FOLLOW_MAX_OPEN_POSITIONS=20
FOLLOW_MAX_TOTAL_SOL=2
FOLLOW_ALLOW_SCALE_IN=true
FOLLOW_MAX_BUYS_PER_WALLET_MINT=5
BUY_SLIPPAGE_BPS=3000
SELL_SLIPPAGE_BPS=3000
TX_CONFIRMATION_TIMEOUT_MS=20000
TX_CONFIRMATION_POLL_MS=500
```

`FOLLOW_MAX_TOTAL_SOL` 是复制仓位的累计成本上限，不包含优先费和 Sender tip。程序默认不设置止盈止损；源钱包首次卖出时会立即清掉对应复制仓位。若源钱包不卖，复制仓位也会继续持有。

## 数据文件

- `data/state.json`：复制仓位和源交易去重状态。
- `data/trades.jsonl`：源交易、复制结果、失败和跳过原因的逐行审计日志。

如果需要清空模拟数据，请先停止程序并自行备份这两个文件；程序不会自动清理它们。

## 当前边界

- 直接执行路径只覆盖 SOL 报价的 Pump bonding curve 与 PumpSwap canonical pool。
- 交易中同时改变多个非报价代币时不猜测，直接跳过。
- 普通转账不会跟单，因为交易必须同时命中 Pump/PumpSwap 且被跟踪钱包必须签名。
- 当前不复制创建币、加/撤流动性、收取费用或非 Pump DEX 操作。
- 交易仍会立即并发提交，但只有链上达到 `confirmed` 后才写入持仓或扣减持仓。链上失败及确认超时会写入审计日志，并阻止后续基于错误状态卖出；程序不会自动重复提交同一源交易。
