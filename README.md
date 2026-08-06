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

先编辑 `.env`，填入：

- `HELIUS_LASERSTREAM_ENDPOINTS`
- `HELIUS_LASERSTREAM_TOKEN`
- `HELIUS_RPC_URL`
- 可选的 `HELIUS_STAKED_RPC_URL` 和 `HELIUS_SENDER_ENDPOINTS`

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
FOLLOW_BUY_SOL=0.10
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
BUY_SLIPPAGE_BPS=1500
SELL_SLIPPAGE_BPS=1500
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
- 程序提交成功后异步检查确认；链上失败会写日志，但不会在没有新源交易的情况下自动重复买入，防止重复成交。
