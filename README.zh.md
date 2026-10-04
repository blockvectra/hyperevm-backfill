# BlockVectra HyperEVM 事件与日志回填脚本

用于在 HyperEVM（`hyperevm_mainnet`）上回填合约日志与代币转账事件的 TypeScript 开源示例，支持 BlockVectra JSON-RPC 与 Data API 两种数据通路。

遵循官方规格文档与接口定义：
- [BlockVectra JSON-RPC 规范](https://docs.blockvectra.com/openapi/json-rpc.yaml?ref=gh-hyperevm-backfill)
- [BlockVectra Data API 规范](https://docs.blockvectra.com/openapi/data.yaml?ref=gh-hyperevm-backfill)
- [HyperEVM 回填指南](https://docs.blockvectra.com/zh/guides/hyperevm-backfill/?ref=gh-hyperevm-backfill)
- [eth_getLogs 区块跨度限制指南](https://docs.blockvectra.com/zh/guides/getlogs-block-range/?ref=gh-hyperevm-backfill)
- [计费规则与错误码说明](https://docs.blockvectra.com/zh/guides/billing-rules/?ref=gh-hyperevm-backfill)

---

## 功能特性

1. **运行时动态获取区块跨度**：在运行期调用公开端点 `GET https://api.blockvectra.com/v1/chains` 读取 `hyperevm_mainnet` 的 `max_logs_block_range` 参数（当前为 1000 区块），不写死区块跨度数值。若单次请求跨度超过该限制，服务返回 JSON-RPC 错误 `-32602 eth_getLogs block range too large`（不计费）。
2. **基于错误体与响应头的退避重试**：读取错误体中的 `data.retryable` 标识以及 HTTP `Retry-After` 响应头，在遇到可重试状态（`-32005 rate limit exceeded`、`-32010 node syncing`、`-32021 billing sync`、`503 gateway overloaded`）时自动退避重试；遇到不可重试状态（`401 missing_api_key`、`402 insufficient_balance`、`-32602 logs_range_too_large`）时立即终止，避免无效重试。
3. **断点续跑支持**：将回填进度（`lastBlock`、`targetAddress`、`updatedAt`）持久化到本地 `checkpoint.json` 文件中。程序中断重启时，自动从 `lastBlock + 1` 处继续回填。
4. **Data API 转账接口支持**：支持 `--data` 命令行参数改用 Data API 地址转账接口 `GET https://api.blockvectra.com/v1/data/hyperevm_mainnet/addresses/{address}/transfers`，支持游标分页（`next_cursor`）与 `clamp=true` 截断。
5. **本地流式存储**：回填结果以 JSONL 格式（每行一个 JSON 对象）追加写入本地文件 `backfill_events.jsonl`。

---

## 架构与接口说明

### 1. 链目录端点（`GET /v1/chains`）
- **请求地址**：`https://api.blockvectra.com/v1/chains`
- **鉴权要求**：无需 API Key（公开端点、不计费、不限流、CORS `*`）。
- **返回示例**：包含各链静态参数：
  ```json
  {
    "chain": "hyperevm_mainnet",
    "name": "HyperEVM",
    "chain_id": 999,
    "jsonrpc": true,
    "data": true,
    "max_logs_block_range": 1000,
    "state_window_blocks": null
  }
  ```

### 2. JSON-RPC 端点（`POST /v1/{chain}`）
- **请求地址**：`https://api.blockvectra.com/v1/hyperevm_mainnet`
- **鉴权要求**：通过 `x-api-key: <key>` 请求头（或路径参数 `/v1/hyperevm_mainnet/<key>`）传递。
- **调用方法**：`eth_getLogs`，参数为 `[{ address, fromBlock, toBlock }]`。
- **跨度约束**：`toBlock - fromBlock + 1 <= max_logs_block_range`。
- **计量计费**：各端点按实际方法权重消耗算力单元（CU）。

### 3. Data API 地址转账端点（`GET /v1/data/{chain}/addresses/{address}/transfers`）
- **请求地址**：`https://api.blockvectra.com/v1/data/hyperevm_mainnet/addresses/{address}/transfers`
- **鉴权要求**：通过 `x-api-key: <key>` 请求头传递。
- **查询参数**：
  - `standard`：必须为 `erc20` 或 `erc721`（必填；`erc1155` 返回 `422 no_coverage`）。
  - `from_block`：起始区块号（必填）。
  - `to_block`：结束区块号（必填）。
  - `clamp`：设置为 `"true"` 时，自动截断超出 `finalized_block` 的部分，避免返回 `409 finality_exceeded`。
  - `cursor`：基于键集的分页标识（传入上一页返回的 `next_cursor`）。
- **计量计费**：各端点按实际方法权重消耗算力单元（CU）。

---

## 算力单元（CU）与计费规则

所有方法调用按其对应的实际方法权重消耗算力单元（CU）。未执行成功的请求（如缺少 API Key 的 401 报错、超额限流 429 或参数校验未通过的请求）不计入 CU 消耗。

当前价格换算、充值额度与结算说明请以 [BlockVectra 定价页面](https://blockvectra.com/zh/pricing/?ref=gh-hyperevm-backfill) 为准。

---

## 获取 API Key

同一个 API Key 适用于所有受支持链、JSON-RPC 以及 Data API 端点：

1. **控制台申请**：登录并在控制台创建 API Key：[https://blockvectra.com/zh/get-api-key/](https://blockvectra.com/zh/get-api-key/?ref=gh-hyperevm-backfill)。
2. **程序化开户**：通过以太坊钱包签名（EIP-191 / SIWE）无前端开户并创建 Key，详见[程序化开户指南](https://docs.blockvectra.com/zh/guides/programmatic-signup/?ref=gh-hyperevm-backfill)。

---

## 安装与运行

### 1. 安装依赖
```bash
npm install
```

### 2. 类型检查
```bash
npm run typecheck
```

### 3. 配置环境变量（可选）
```bash
cp .env.example .env
# 在 .env 中填入你的 BLOCKVECTRA_API_KEY
```

### 4. 启动回填程序

- **默认 JSON-RPC 模式（`eth_getLogs`）**：
  ```bash
  npm start
  ```

- **Data API 模式（地址转账）**：
  ```bash
  npm start -- --data
  ```

- **自定义区块范围与目标地址**：
  ```bash
  npm start -- --from=0 --to=5000 --address=0x1111111111111111111111111111111111111111
  ```

---

## 实测验证结果

### 未配置 Key 时的验证输出（不新开账户）

在未设置 `BLOCKVECTRA_API_KEY` 时运行，真实请求线上服务，验证：
1. 成功从 `GET /v1/chains` 获取 HyperEVM 配置与限制参数（`max_logs_block_range: 1000`）。
2. 计算出合规的切片区间 `[0 .. 999]`。
3. 真实网关拦截并返回 `401 missing_api_key`。

#### JSON-RPC 模式输出
```text
> hyperevm-backfill@1.0.0 start
> tsx src/index.ts

=== BlockVectra HyperEVM Backfill Tool ===
Mode: JSON-RPC (eth_getLogs)
API Key: None (testing unauthenticated response)

[1/3] Reading chain limits dynamically from GET /v1/chains...
Discovered: HyperEVM (hyperevm_mainnet, Chain ID: 999)
Dynamic max_logs_block_range: 1000 blocks

[2/3] Backfilling [0 .. 2000] for 0x1111111111111111111111111111111111111111...
Processing chunk [0 .. 999] (1000 blocks)...

[401 missing_api_key] Verified: Endpoint requires an API key for authenticated operations.
To obtain an API key, visit the web console: https://blockvectra.com/zh/get-api-key/?ref=gh-hyperevm-backfill
Or follow the programmatic signup guide: https://docs.blockvectra.com/zh/guides/programmatic-signup/?ref=gh-hyperevm-backfill
```

#### Data API 模式输出
```text
> hyperevm-backfill@1.0.0 start
> tsx src/index.ts --data

=== BlockVectra HyperEVM Backfill Tool ===
Mode: Data API (/transfers)
API Key: None (testing unauthenticated response)

[1/3] Reading chain limits dynamically from GET /v1/chains...
Discovered: HyperEVM (hyperevm_mainnet, Chain ID: 999)
Dynamic max_logs_block_range: 1000 blocks

[2/3] Backfilling [0 .. 2000] for 0x1111111111111111111111111111111111111111...
Processing chunk [0 .. 999] (1000 blocks)...

[401 missing_api_key] Verified: Endpoint requires an API key for authenticated operations.
To obtain an API key, visit the web console: https://blockvectra.com/zh/get-api-key/?ref=gh-hyperevm-backfill
Or follow the programmatic signup guide: https://docs.blockvectra.com/zh/guides/programmatic-signup/?ref=gh-hyperevm-backfill
```

#### 断点续跑验证输出
```text
=== BlockVectra HyperEVM Backfill Tool ===
Mode: JSON-RPC (eth_getLogs)
API Key: None (testing unauthenticated response)

[1/3] Reading chain limits dynamically from GET /v1/chains...
Discovered: HyperEVM (hyperevm_mainnet, Chain ID: 999)
Dynamic max_logs_block_range: 1000 blocks
Resuming from checkpoint file: lastBlock = 500

[2/3] Backfilling [501 .. 2000] for 0x1111111111111111111111111111111111111111...
Processing chunk [501 .. 1500] (1000 blocks)...

[401 missing_api_key] Verified: Endpoint requires an API key for authenticated operations.
To obtain an API key, visit the web console: https://blockvectra.com/zh/get-api-key/?ref=gh-hyperevm-backfill
Or follow the programmatic signup guide: https://docs.blockvectra.com/zh/guides/programmatic-signup/?ref=gh-hyperevm-backfill
```

---

## 风险提示与声明

注意：链上活动数据，不是股价，不构成投资建议。
