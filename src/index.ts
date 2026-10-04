import fs from "node:fs";
import { createPublicClient, http, toHex } from "viem";

const GATEWAY_URL = "https://api.blockvectra.com/v1";
const DATA_API_URL = "https://api.blockvectra.com/v1/data";
const CHECKPOINT_FILE = "checkpoint.json";
const OUTPUT_FILE = "backfill_events.jsonl";
const DEFAULT_TARGET = "0x1111111111111111111111111111111111111111";

export interface ChainCatalogEntry {
  chain: string;
  name: string;
  chain_id: number;
  max_logs_block_range: number;
  data: boolean;
}

export function createHyperEVMClient(apiKey?: string) {
  return createPublicClient({
    transport: http(`${GATEWAY_URL}/hyperevm_mainnet`, {
      fetchOptions: { headers: apiKey ? { "x-api-key": apiKey } : {} },
    }),
  });
}

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function requestWithRetry(
  url: string,
  options: RequestInit,
  maxRetries = 5,
): Promise<{ ok: boolean; status: number; data: any; headers: Headers }> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const res = await fetch(url, options);
    const body: any = await res.json().catch(() => ({}));
    if (res.ok && !body?.error) {
      return { ok: true, status: res.status, data: body, headers: res.headers };
    }

    const err = body?.error;
    const retryable =
      res.status === 429 ||
      res.status === 503 ||
      err?.data?.retryable === true ||
      err?.code === -32010 ||
      err?.code === -32005;

    if (res.status === 401 || err?.data?.retryable === false || !retryable) {
      return { ok: false, status: res.status, data: body, headers: res.headers };
    }

    if (attempt < maxRetries) {
      const retryHeader = res.headers.get("Retry-After");
      const waitSec = retryHeader ? Math.max(1, parseInt(retryHeader, 10)) : Math.min(16, 2 ** attempt);
      console.warn(`[Retry] Attempt ${attempt + 1}/${maxRetries} failed (${err?.message || res.statusText}). Waiting ${waitSec}s...`);
      await sleep(waitSec * 1000);
    } else {
      return { ok: false, status: res.status, data: body, headers: res.headers };
    }
  }
  throw new Error("Exceeded maximum retries");
}

async function main() {
  const apiKey = process.env.BLOCKVECTRA_API_KEY?.trim();
  const args = process.argv.slice(2);
  const useDataApi = args.includes("--data") || process.env.USE_DATA_API === "true";
  const addressArg = args.find((a) => a.startsWith("--address="))?.split("=")[1];
  const address = addressArg || process.env.TARGET_ADDRESS || DEFAULT_TARGET;
  const startArg = args.find((a) => a.startsWith("--from="))?.split("=")[1] || process.env.FROM_BLOCK;
  const endArg = args.find((a) => a.startsWith("--to="))?.split("=")[1] || process.env.TO_BLOCK;

  console.log("=== BlockVectra HyperEVM Backfill Tool ===");
  console.log(`Mode: ${useDataApi ? "Data API (/transfers)" : "JSON-RPC (eth_getLogs)"}`);
  console.log(`API Key: ${apiKey ? `${apiKey.slice(0, 8)}...` : "None (testing unauthenticated response)"}`);

  console.log("\n[1/3] Reading chain limits dynamically from GET /v1/chains...");
  const catalogRes = await fetch(`${GATEWAY_URL}/chains`);
  if (!catalogRes.ok) throw new Error(`GET /v1/chains failed with HTTP ${catalogRes.status}`);
  const { chains } = (await catalogRes.json()) as { chains: ChainCatalogEntry[] };
  const targetChain = chains.find((c) => c.chain === "hyperevm_mainnet" || c.chain.includes("hyperevm"));
  if (!targetChain) throw new Error("HyperEVM chain entry not found in /v1/chains");

  if (typeof targetChain.max_logs_block_range !== "number" || targetChain.max_logs_block_range <= 0) {
    throw new Error(`Missing or invalid max_logs_block_range from /v1/chains for ${targetChain.chain}`);
  }
  const maxRange = targetChain.max_logs_block_range;
  console.log(`Discovered: ${targetChain.name} (${targetChain.chain}, Chain ID: ${targetChain.chain_id})`);
  console.log(`Dynamic max_logs_block_range: ${maxRange} blocks`);

  let fromBlock = startArg ? parseInt(startArg, 10) : 0;
  let toBlock = endArg ? parseInt(endArg, 10) : fromBlock + maxRange * 2;

  if (fs.existsSync(CHECKPOINT_FILE)) {
    try {
      const cp = JSON.parse(fs.readFileSync(CHECKPOINT_FILE, "utf-8"));
      if (typeof cp.lastBlock === "number" && cp.lastBlock >= fromBlock) {
        console.log(`Resuming from checkpoint file: lastBlock = ${cp.lastBlock}`);
        fromBlock = cp.lastBlock + 1;
      }
    } catch {
      console.warn("Checkpoint file invalid; starting from initial block.");
    }
  }

  if (fromBlock > toBlock) {
    console.log(`Requested range [${fromBlock} .. ${toBlock}] is already completed.`);
    return;
  }

  console.log(`\n[2/3] Backfilling [${fromBlock} .. ${toBlock}] for ${address}...`);
  let cur = fromBlock;
  let totalSaved = 0;

  while (cur <= toBlock) {
    const chunkEnd = Math.min(cur + maxRange - 1, toBlock);
    console.log(`Processing chunk [${cur} .. ${chunkEnd}] (${chunkEnd - cur + 1} blocks)...`);

    if (useDataApi) {
      let cursor: string | undefined;
      do {
        const url = new URL(`${DATA_API_URL}/${targetChain.chain}/addresses/${address}/transfers`);
        url.searchParams.set("standard", "erc20");
        url.searchParams.set("from_block", cur.toString());
        url.searchParams.set("to_block", chunkEnd.toString());
        url.searchParams.set("clamp", "true");
        if (cursor) url.searchParams.set("cursor", cursor);

        const res = await requestWithRetry(url.toString(), {
          headers: apiKey ? { "x-api-key": apiKey } : {},
        });
        if (!res.ok) {
          handleFailure(res);
          return;
        }

        const transfers = res.data?.data || [];
        for (const tx of transfers) fs.appendFileSync(OUTPUT_FILE, JSON.stringify(tx) + "\n");
        totalSaved += transfers.length;
        cursor = res.data?.next_cursor;
      } while (cursor);
    } else {
      const res = await requestWithRetry(`${GATEWAY_URL}/${targetChain.chain}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(apiKey ? { "x-api-key": apiKey } : {}),
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "eth_getLogs",
          params: [{ address, fromBlock: toHex(cur), toBlock: toHex(chunkEnd) }],
        }),
      });

      if (!res.ok) {
        handleFailure(res);
        return;
      }

      const logs = res.data?.result || [];
      for (const log of logs) fs.appendFileSync(OUTPUT_FILE, JSON.stringify(log) + "\n");
      totalSaved += logs.length;
    }

    fs.writeFileSync(
      CHECKPOINT_FILE,
      JSON.stringify({ lastBlock: chunkEnd, targetAddress: address, updatedAt: new Date().toISOString() }, null, 2),
    );
    cur = chunkEnd + 1;
  }

  console.log(`\n[3/3] Backfill complete. Appended ${totalSaved} records to ${OUTPUT_FILE}`);
  console.log("Notice: On-chain activity data only; not stock prices, and does not constitute investment advice.");
}

function handleFailure(res: { status: number; data: any }) {
  const err = res.data?.error;
  if (res.status === 401 || err?.data?.reason === "missing_api_key") {
    console.log("\n[401 missing_api_key] Verified: Endpoint requires an API key for authenticated operations.");
    console.log("To obtain an API key, visit the web console: https://blockvectra.com/en/get-api-key/?ref=gh-hyperevm-backfill");
    console.log("Or follow the programmatic signup guide: https://docs.blockvectra.com/en/guides/programmatic-signup/?ref=gh-hyperevm-backfill");
  } else {
    console.error(`\nRequest failed with HTTP ${res.status}:`, err || res.data);
  }
}

main().catch((err) => {
  console.error("Execution failed:", err);
  process.exit(1);
});
