# BlockVectra HyperEVM Event and Log Backfill Script

A minimal TypeScript example demonstrating how to backfill contract logs and token transfer events on HyperEVM (`hyperevm_mainnet`) using BlockVectra JSON-RPC and Data API endpoints.

This implementation complies with the official specifications:
- [BlockVectra JSON-RPC API Specification](https://docs.blockvectra.com/openapi/json-rpc.yaml?ref=gh-hyperevm-backfill)
- [BlockVectra Data API Specification](https://docs.blockvectra.com/openapi/data.yaml?ref=gh-hyperevm-backfill)
- [HyperEVM Backfill Guide](https://docs.blockvectra.com/en/guides/hyperevm-backfill/?ref=gh-hyperevm-backfill)
- [Block Range Limits Guide](https://docs.blockvectra.com/en/guides/getlogs-block-range/?ref=gh-hyperevm-backfill)
- [Billing Rules and Error Codes](https://docs.blockvectra.com/en/guides/billing-rules/?ref=gh-hyperevm-backfill)

---

## Features

1. **Dynamic Block Span Discovery**: Queries `GET https://api.blockvectra.com/v1/chains` at runtime to read `max_logs_block_range` (1000 blocks for `hyperevm_mainnet`). Never hardcodes block ranges. Exceeding this limit causes JSON-RPC error `-32602 eth_getLogs block range too large` (not billed).
2. **Error Body & Header Backoff**: Reads the error body's `data.retryable` flag and the HTTP `Retry-After` header to perform backoff on transient errors (`-32005 rate limit exceeded`, `-32010 node syncing`, `-32021 billing sync`, `503 gateway overloaded`). Immediately halts on non-retryable errors (`401 missing_api_key`, `402 insufficient_balance`, `-32602 logs_range_too_large`).
3. **Resumption Support**: Persists backfill progress to a local `checkpoint.json` file. If interrupted, subsequent runs resume from `lastBlock + 1`.
4. **Data API Transfer Endpoint**: Supports an optional `--data` flag to backfill token transfer events via `GET https://api.blockvectra.com/v1/data/hyperevm_mainnet/addresses/{address}/transfers` with keyset cursor pagination (`next_cursor`) and `clamp=true`.
5. **Streaming JSONL Storage**: Appends backfilled records incrementally to a local `.jsonl` file (`backfill_events.jsonl`).

---

## Architecture and Endpoints

### 1. Chain Catalog Endpoint (`GET /v1/chains`)
- **URL**: `https://api.blockvectra.com/v1/chains`
- **Auth**: None (public, unmetered, unbilled, CORS `*`).
- **Response**: Returns supported chains and per-chain limits:
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

### 2. JSON-RPC Endpoint (`POST /v1/{chain}`)
- **URL**: `https://api.blockvectra.com/v1/hyperevm_mainnet`
- **Auth**: Passed via `x-api-key: <key>` header (or URL path `/v1/hyperevm_mainnet/<key>`).
- **Method**: `eth_getLogs` with parameters `[{ address, fromBlock, toBlock }]`.
- **Span Constraint**: `toBlock - fromBlock + 1 <= max_logs_block_range`.
- **Metering**: Consumes Compute Units (CU) based on actual method weights.

### 3. Data API Transfers Endpoint (`GET /v1/data/{chain}/addresses/{address}/transfers`)
- **URL**: `https://api.blockvectra.com/v1/data/hyperevm_mainnet/addresses/{address}/transfers`
- **Auth**: Passed via `x-api-key: <key>` header.
- **Parameters**:
  - `standard`: `erc20` or `erc721` (required; `erc1155` returns `422 no_coverage`).
  - `from_block`: Lower block bound (required).
  - `to_block`: Upper block bound (required).
  - `clamp`: `"true"` (optional; truncates `to_block` to `finalized_block` instead of returning `409 finality_exceeded`).
  - `cursor`: Keyset pagination token from previous `next_cursor`.
- **Metering**: Consumes Compute Units (CU) based on actual method weights.

---

## Compute Unit (CU) & Billing Rules

Calls to each endpoint consume Compute Units (CU) according to their established method weights. Requests that fail before execution (such as missing API keys, rate limits, or invalid block ranges) do not consume CU.

For current CU rates, billing policies, and pricing tiers, refer to the [BlockVectra Pricing Page](https://blockvectra.com/en/pricing/?ref=gh-hyperevm-backfill).

---

## Getting an API Key

API keys function across all supported networks, JSON-RPC, and Data API endpoints:

1. **Web Console**: Log in and generate a key at [https://blockvectra.com/en/get-api-key/](https://blockvectra.com/en/get-api-key/?ref=gh-hyperevm-backfill).
2. **Programmatic Onboarding**: Create keys automatically using Ethereum wallet signatures (EIP-191 / SIWE) via the Console API. See the [Programmatic Sign-up Guide](https://docs.blockvectra.com/en/guides/programmatic-signup/?ref=gh-hyperevm-backfill).

---

## Installation & Usage

### 1. Install Dependencies
```bash
npm install
```

### 2. Verify TypeScript Types
```bash
npm run typecheck
```

### 3. Configure Environment (Optional)
```bash
cp .env.example .env
# Edit .env and supply your BLOCKVECTRA_API_KEY
```

### 4. Run the Backfill Script

- **Default JSON-RPC mode (`eth_getLogs`)**:
  ```bash
  npm start
  ```

- **Data API mode (Address Transfers)**:
  ```bash
  npm start -- --data
  ```

- **Custom Block Range & Contract**:
  ```bash
  npm start -- --from=0 --to=5000 --address=0x1111111111111111111111111111111111111111
  ```

---

## Verification Results

### Unauthenticated Verification (No Fake Accounts Created)

Running without `BLOCKVECTRA_API_KEY` verifies:
1. Dynamic retrieval of HyperEVM parameters from `GET /v1/chains` (`max_logs_block_range: 1000`).
2. Correct chunking interval calculation `[0 .. 999]`.
3. Upstream gateway authentication enforcement returning `401 missing_api_key`.

#### JSON-RPC Mode Output
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
To obtain an API key, visit the web console: https://blockvectra.com/en/get-api-key/
Or follow the programmatic signup guide: https://docs.blockvectra.com/en/guides/programmatic-signup/
```

#### Data API Mode Output
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
To obtain an API key, visit the web console: https://blockvectra.com/en/get-api-key/
Or follow the programmatic signup guide: https://docs.blockvectra.com/en/guides/programmatic-signup/
```

#### Checkpoint Resumption Output
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
To obtain an API key, visit the web console: https://blockvectra.com/en/get-api-key/
Or follow the programmatic signup guide: https://docs.blockvectra.com/en/guides/programmatic-signup/
```

---

## Notice

On-chain activity data only; not stock prices, and does not constitute investment advice.
