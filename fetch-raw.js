#!/usr/bin/env node
/**
 * Pool Fetcher  –  DEX-Native Pricing (no external oracles)
 * ─────────────────────────────────────────────────────────
 * Each DEX already publishes its own USD TVL and pool price.
 * We use THOSE values directly instead of re-pricing via Jupiter/CoinGecko.
 *
 * Why this matters for arbitrage:
 *   External oracle prices (Jupiter aggregated / CoinGecko) are the SAME for
 *   every pool.  Using them makes pool A and pool B look identical, hiding the
 *   price discrepancies you are trying to find.  Each pool's own price IS the
 *   signal – preserve it.
 *
 * DEX-native TVL & price fields used:
 *   Raydium CPMM/CLMM  →  pool.tvl          (USD, from API)
 *                          pool.price         (pool-own ratio, NOT aggregated)
 *   Orca Whirlpool      →  pool.tvl           (USD, from API)
 *                          pool.price         (pool-own tokenA/tokenB ratio)
 *   Meteora DLMM        →  pool.liquidity     (USD, from API)
 *                          pool.current_price (pool-own X-in-Y price)
 *
 * Fixes vs previous version:
 *   [1] Removed fetchTokenPrices() / Jupiter / CoinGecko entirely
 *   [2] Raydium endpoint: /list-v2 → /pools/info/list  (was returning HTTP 500)
 *   [3] BigInt: safeBigInt() rounds floats before casting  (was throwing on floats)
 *   [4] DLMM bins serialised to strings before JSON.stringify (BigInt not JSON-safe)
 */

'use strict';

const axios = require('axios');
const fs = require('fs');

// ─── Config ───────────────────────────────────────────────────────────────────

const CONFIG = {
    minTVL: 750_000,
    outputFile: './pools.json',
    fetchCount: {
        raydiumCPMM: 100,
        raydiumCLMM: 100,
        orca: 200,
        meteora: 200,
    },
};

// Well-known mint addresses for decimal inference (Meteora API omits decimals)
const KNOWN_MINTS = {
    'So11111111111111111111111111111111111111112': 9,   // SOL
    'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v': 6,  // USDC
    'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB': 6,  // USDT
    'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn': 9,  // JitoSOL
    '27G8Mt6P9b8F4Jjy3GXBC3GCaXLbJQkFHFSATFjFJ8b': 6,  // jitoSOL variant
    'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263': 5,  // BONK
    '3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh': 8,  // WBTC
    'cbbtcf3aa214zXHbiAZQwf4122FBYbraNdFqgw4iMij': 8,   // cbBTC
};

function inferDecimals(mint) {
    return KNOWN_MINTS[mint] ?? 6;  // default 6 for unknown SPL tokens
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Safe BigInt conversion.
 * Handles number, float, string-float, BigInt, null, undefined.
 * Math.round() prevents "Cannot convert a non-integer to BigInt" on floats.
 */
function safeBigInt(val) {
    if (typeof val === 'bigint') return val;
    if (val == null || val === '') return 0n;
    const n = Number(val);
    if (!isFinite(n) || isNaN(n)) return 0n;
    return BigInt(Math.round(n));
}

/** HTTP GET with exponential-backoff retry. Returns parsed JSON. */
async function fetchWithRetry(url, retries = 3) {
    let lastErr;
    for (let i = 0; i < retries; i++) {
        try {
            const res = await axios.get(url, { timeout: 15_000 });
            return res.data;
        } catch (err) {
            lastErr = err;
            if (i < retries - 1) await new Promise(r => setTimeout(r, 2000 * (i + 1)));
        }
    }
    throw lastErr;
}

/** Serialise a pool's BigInt fields to strings so JSON.stringify doesn't throw. */
function serialisePool(p) {
    return {
        ...p,
        xReserve: p.xReserve?.toString() ?? '0',
        yReserve: p.yReserve?.toString() ?? '0',
        bins: (p.bins || []).map(b => ({
            ...b,
            pxAB_Q64: (b.pxAB_Q64 ?? 0n).toString(),
            priceAB_Q64: (b.priceAB_Q64 ?? 0n).toString(),
            reserveA: (b.reserveA ?? 0n).toString(),
            reserveB: (b.reserveB ?? 0n).toString(),
        })),
    };
}

// ─── Stats ────────────────────────────────────────────────────────────────────

const stats = {
    fetched: { cpmm: 0, clmm: 0, whirlpool: 0, dlmm: 0 },
    accepted: { cpmm: 0, clmm: 0, whirlpool: 0, dlmm: 0 },
    rejected: { cpmm: 0, clmm: 0, whirlpool: 0, dlmm: 0 },
};

// ─────────────────────────────────────────────────────────────────────────────
// RAYDIUM CPMM
//
// Fixed endpoint: /pools/info/list  (was /list-v2 which returns HTTP 500)
// TVL  : pool.tvl   – USD, pre-calculated by Raydium. No oracle needed.
// Price: pool.price – pool's own price ratio. Preserved as-is (NOT aggregated).
// Note : mintAmountA/B are DECIMAL human amounts (e.g. 1000.5 SOL, not lamports).
//        Multiply × 10^decimals to get integer reserve values.
// ─────────────────────────────────────────────────────────────────────────────
async function fetchRaydiumCPMM() {
    const url = [
        'https://api-v3.raydium.io/pools/info/list',
        `?poolType=Standard&poolSortField=tvl&sortType=desc`,
        `&pageSize=${CONFIG.fetchCount.raydiumCPMM}&page=1`,
    ].join('');

    const data = await fetchWithRetry(url);
    const pools = data?.data?.data || [];
    console.log(`  Fetched ${pools.length} CPMM pools`);

    const results = [];
    for (const pool of pools) {
        const tvl = parseFloat(pool.tvl || 0);   // Raydium's own USD TVL
        stats.fetched.cpmm++;

        if (tvl < CONFIG.minTVL) { stats.rejected.cpmm++; continue; }
        stats.accepted.cpmm++;

        const feeRate = parseFloat(pool.feeRate || 0.0025);
        const decA = pool.mintA?.decimals ?? 9;
        const decB = pool.mintB?.decimals ?? 6;

        // mintAmountA/B are decimal → convert to raw integer reserves
        const xReserve = safeBigInt(parseFloat(pool.mintAmountA || 0) * Math.pow(10, decA));
        const yReserve = safeBigInt(parseFloat(pool.mintAmountB || 0) * Math.pow(10, decB));

        results.push({
            poolAddress: pool.id,
            dex: 'raydium',
            type: 'cpmm',
            baseMint: pool.mintA?.address ?? '',
            quoteMint: pool.mintB?.address ?? '',
            baseDecimals: decA,
            quoteDecimals: decB,
            baseSymbol: pool.mintA?.symbol || '',
            quoteSymbol: pool.mintB?.symbol || '',
            tvl,
            feeRate,
            feeBps: Math.round(feeRate * 10_000),
            // DEX-native price – each pool's own ratio, not the aggregated market price
            price: parseFloat(pool.price || 0),
            xReserve: xReserve.toString(),
            yReserve: yReserve.toString(),
            vaults: {
                xVault: pool.vaultA || '',
                yVault: pool.vaultB || '',
            },
            raw: pool,
        });
    }
    return results;
}

// ─────────────────────────────────────────────────────────────────────────────
// RAYDIUM CLMM
//
// Same endpoint fix and same TVL/price approach as CPMM.
// sqrtPriceX64 / liquidity / tickCurrent are fetched on-chain by the enricher.
// ─────────────────────────────────────────────────────────────────────────────
async function fetchRaydiumCLMM() {
    const url = [
        'https://api-v3.raydium.io/pools/info/list',
        `?poolType=Concentrated&poolSortField=tvl&sortType=desc`,
        `&pageSize=${CONFIG.fetchCount.raydiumCLMM}&page=1`,
    ].join('');

    const data = await fetchWithRetry(url);
    const pools = data?.data?.data || [];
    console.log(`  Fetched ${pools.length} CLMM pools`);

    const results = [];
    for (const pool of pools) {
        const tvl = parseFloat(pool.tvl || 0);
        stats.fetched.clmm++;

        if (tvl < CONFIG.minTVL) { stats.rejected.clmm++; continue; }
        stats.accepted.clmm++;

        // Raydium CLMM fee: prefer pool.feeRate (fraction), fallback to config.tradeFeeRate (millionths)
        let feeRate = 0;
        if (pool.feeRate != null) feeRate = parseFloat(pool.feeRate);
        else if (pool.config?.tradeFeeRate != null) feeRate = pool.config.tradeFeeRate / 1_000_000;

        const decA = pool.mintA?.decimals ?? 9;
        const decB = pool.mintB?.decimals ?? 6;
        const xReserve = safeBigInt(parseFloat(pool.mintAmountA || 0) * Math.pow(10, decA));
        const yReserve = safeBigInt(parseFloat(pool.mintAmountB || 0) * Math.pow(10, decB));

        results.push({
            poolAddress: pool.id,
            dex: 'raydium',
            type: 'clmm',
            baseMint: pool.mintA?.address ?? '',
            quoteMint: pool.mintB?.address ?? '',
            baseDecimals: decA,
            quoteDecimals: decB,
            baseSymbol: pool.mintA?.symbol || '',
            quoteSymbol: pool.mintB?.symbol || '',
            tvl,
            feeRate,
            feeBps: Math.round(feeRate * 10_000),
            tickSpacing: pool.config?.tickSpacing || 60,
            price: parseFloat(pool.price || 0),  // DEX-native, not aggregated
            xReserve: xReserve.toString(),
            yReserve: yReserve.toString(),
            // Enricher fills these from on-chain accounts:
            sqrtPriceX64: null,
            liquidity: '0',
            tickCurrent: 0,
            vaults: {
                aVault: pool.vaultA || '',
                bVault: pool.vaultB || '',
            },
            raw: pool,
        });
    }
    return results;
}

// ─────────────────────────────────────────────────────────────────────────────
// ORCA WHIRLPOOL
//
// TVL  : pool.tvl   – USD, authoritative from Orca API.
// Price: pool.price – pool-own tokenA/tokenB ratio in human units
//                     e.g. SOL/USDC pool.price ≈ 127.5 (USDC per SOL)
//
// Note : Orca's list endpoint often returns mintAmountA/B as null.
//        xReserve/yReserve are populated accurately by the enricher's vault reads.
//        We store '0' as placeholder when amounts are unavailable.
// ─────────────────────────────────────────────────────────────────────────────
async function fetchOrcaWhirlpools() {
    const url = 'https://api.mainnet.orca.so/v1/whirlpool/list';
    const data = await fetchWithRetry(url);

    const pools = (data.whirlpools || [])
        .sort((a, b) => (b.tvl || 0) - (a.tvl || 0))
        .slice(0, CONFIG.fetchCount.orca);

    console.log(`  Fetched ${pools.length} Whirlpools (sorted by TVL)`);

    const results = [];
    for (const pool of pools) {
        const tvl = parseFloat(pool.tvl || 0);   // Orca's own USD TVL
        stats.fetched.whirlpool++;

        if (tvl < CONFIG.minTVL) { stats.rejected.whirlpool++; continue; }
        stats.accepted.whirlpool++;

        // lpFeeRate is a decimal fraction (0.0004 = 4 bps)
        const feeRate = parseFloat(pool.lpFeeRate ?? pool.feeRate ?? 0);

        // mintAmountA/B are often null in Orca's list – derive reserves if present
        const decA = pool.tokenA?.decimals ?? 9;
        const decB = pool.tokenB?.decimals ?? 6;
        const mintAmtA = pool.mintAmountA != null ? parseFloat(pool.mintAmountA) : null;
        const mintAmtB = pool.mintAmountB != null ? parseFloat(pool.mintAmountB) : null;
        const xReserve = mintAmtA != null ? safeBigInt(mintAmtA * Math.pow(10, decA)).toString() : '0';
        const yReserve = mintAmtB != null ? safeBigInt(mintAmtB * Math.pow(10, decB)).toString() : '0';

        results.push({
            poolAddress: pool.address,
            dex: 'orca',
            type: 'whirlpool',
            baseMint: pool.tokenA?.mint ?? '',
            quoteMint: pool.tokenB?.mint ?? '',
            baseDecimals: decA,
            quoteDecimals: decB,
            baseSymbol: pool.tokenA?.symbol || '',
            quoteSymbol: pool.tokenB?.symbol || '',
            tvl,
            feeRate,
            feeBps: Math.round(feeRate * 10_000),
            tickSpacing: pool.tickSpacing || 64,
            // Pool's own price – each whirlpool's independent market price
            price: parseFloat(pool.price || 0),
            xReserve,
            yReserve,
            // Enricher fills these from on-chain state:
            sqrtPriceX64: null,
            liquidity: '0',
            tickCurrent: 0,
            raw: pool,
        });
    }
    return results;
}

// ─────────────────────────────────────────────────────────────────────────────
// METEORA DLMM
//
// TVL  : pool.liquidity     – USD, authoritative from Meteora API.
// Price: pool.current_price – pool-own price of X in Y terms
//                             e.g. SOL-USDC: current_price ≈ 80.6 (USDC per SOL)
//
// BigInt fix: reserve_x/y_amount are integers from the API but JSON.parse() can
// quietly cast large integers to JS float, losing precision and adding a decimal.
// safeBigInt() handles this with Math.round() before BigInt().
//
// Bin strategy: pair/all has no per-bin breakdown. We build one synthetic
// "active bin" at current_price so the math layer has something to work with.
// enriched-fixed.js replaces this with real multi-bin on-chain data.
// ─────────────────────────────────────────────────────────────────────────────
async function fetchMeteoraDLMM() {
    const Q64 = 1n << 64n;   // 2^64 for Q64 price encoding

    const url = 'https://dlmm-api.meteora.ag/pair/all';
    const data = await fetchWithRetry(url);
    console.log(`  Fetched ${data.length} DLMM pairs`);

    // Use Meteora's own liquidity field to sort and filter – no oracle needed
    const sorted = data
        .filter(p => parseFloat(p.liquidity || 0) >= CONFIG.minTVL
            && !p.is_blacklisted
            && !p.hide)
        .sort((a, b) => parseFloat(b.liquidity) - parseFloat(a.liquidity))
        .slice(0, CONFIG.fetchCount.meteora);

    const results = [];
    for (const pool of sorted) {
        const tvl = parseFloat(pool.liquidity || 0);
        stats.fetched.dlmm++;
        stats.accepted.dlmm++;    // already filtered above

        const feeRate = parseFloat(pool.base_fee_percentage || 0) / 100;
        const feeBps = Math.round(feeRate * 10_000);
        const binStep = pool.bin_step || 1;

        const baseDecimals = inferDecimals(pool.mint_x);
        const quoteDecimals = inferDecimals(pool.mint_y);

        // Safe BigInt reserves – Math.round handles float-cast edge cases
        const xRes = safeBigInt(pool.reserve_x_amount);
        const yRes = safeBigInt(pool.reserve_y_amount);

        // Pool-own price: current_price = X expressed in Y units (human-readable)
        // Convert to Q64.64 format for the DLMM math layer
        const currentPrice = parseFloat(pool.current_price || 0);
        const pxAB_Q64 = currentPrice > 0
            ? safeBigInt(currentPrice * Number(Q64))
            : 0n;

        // Single synthetic active bin – all liquidity at current price.
        // Enricher will expand this to the real bin distribution from on-chain.
        const syntheticBins = (xRes > 0n || yRes > 0n) && pxAB_Q64 > 0n
            ? [{
                binId: pool.active_bin ?? 0,
                pxAB_Q64,                            // BigInt (serialised to string on write)
                priceAB_Q64: pxAB_Q64,               // alias kept for legacy compat
                reserveA: xRes,
                reserveB: yRes,
                feeBps,
            }]
            : [];

        const [baseSymbol = '', quoteSymbol = ''] = (pool.name || '').split('-');

        results.push({
            poolAddress: pool.address,
            dex: 'meteora',
            type: 'dlmm',
            baseMint: pool.mint_x,
            quoteMint: pool.mint_y,
            baseDecimals,
            quoteDecimals,
            baseSymbol: baseSymbol.trim(),
            quoteSymbol: quoteSymbol.trim(),
            tvl,
            feeRate,
            feeBps,
            binStep,
            // Pool's own price – NOT aggregated, each pool is independent
            price: currentPrice,
            xReserve: xRes.toString(),
            yReserve: yRes.toString(),
            activeBinId: pool.active_bin ?? 0,
            bins: syntheticBins,      // serialised in serialisePool()
            vaults: {
                xVault: pool.reserve_x || '',
                yVault: pool.reserve_y || '',
            },
            raw: pool,
        });
    }
    return results;
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────────────────────────────────────
async function main() {
    console.log('═══════════════════════════════════════════════════════════════');
    console.log(' Pool Fetcher  –  DEX-Native Pricing');
    console.log(`   Min TVL : $${CONFIG.minTVL.toLocaleString()}`);
    console.log('   Prices  : each pool\'s own reported price (NO external oracle)');
    console.log('═══════════════════════════════════════════════════════════════\n');

    const allPools = [];

    console.log('📡  Raydium CPMM ...');
    try {
        const pools = await fetchRaydiumCPMM();
        allPools.push(...pools);
        console.log(`  ✅  ${pools.length} accepted\n`);
    } catch (e) { console.error(`  ❌  ${e.message}\n`); }

    console.log('📡  Raydium CLMM ...');
    try {
        const pools = await fetchRaydiumCLMM();
        allPools.push(...pools);
        console.log(`  ✅  ${pools.length} accepted\n`);
    } catch (e) { console.error(`  ❌  ${e.message}\n`); }

    console.log('📡  Orca Whirlpools ...');
    try {
        const pools = await fetchOrcaWhirlpools();
        allPools.push(...pools);
        console.log(`  ✅  ${pools.length} accepted\n`);
    } catch (e) { console.error(`  ❌  ${e.message}\n`); }

    console.log('📡  Meteora DLMM ...');
    try {
        const pools = await fetchMeteoraDLMM();
        allPools.push(...pools);
        console.log(`  ✅  ${pools.length} accepted\n`);
    } catch (e) { console.error(`  ❌  ${e.message}\n`); }

    // ── Summary ───────────────────────────────────────────────────────────────
    console.log('═══════════════════════════════════════════════════════════════');
    console.log(' RESULTS');
    console.log('═══════════════════════════════════════════════════════════════');
    for (const [t, label] of [['cpmm', 'CPMM'], ['clmm', 'CLMM'], ['whirlpool', 'Whirlpool'], ['dlmm', 'DLMM']]) {
        console.log(`  ${label.padEnd(10)}  ${stats.accepted[t].toString().padStart(3)} accepted / ${stats.fetched[t]} fetched`);
    }
    console.log(`\n  Total : ${allPools.length} pools ≥ $${CONFIG.minTVL.toLocaleString()}`);

    if (allPools.length === 0) {
        console.error('\n⚠️  No pools passed filter – check API connectivity.');
        process.exit(1);
    }

    // ── Top pools table ───────────────────────────────────────────────────────
    allPools.sort((a, b) => b.tvl - a.tvl);

    const byType = { cpmm: [], clmm: [], whirlpool: [], dlmm: [] };
    for (const p of allPools) {
        const t = (p.type || '').toLowerCase();
        if (byType[t]) byType[t].push(p);
    }

    console.log('\n  DEX-native prices shown – these are each pool\'s INDEPENDENT price');
    console.log('  Differences between same-pair pools = potential arbitrage signal\n');

    for (const [type, list] of Object.entries(byType)) {
        if (!list.length) continue;
        console.log(`${type.toUpperCase()} (${list.length} pools):`);
        console.log('   # | Pair                 | TVL         | bps | DEX Price       | Address');
        console.log('  ---|----------------------|-------------|-----|-----------------|--------');
        list.slice(0, 10).forEach((p, i) => {
            const tvl = p.tvl >= 1e6 ? `$${(p.tvl / 1e6).toFixed(2)}M` : `$${(p.tvl / 1e3).toFixed(0)}K`;
            const pair = `${p.baseSymbol || '?'}/${p.quoteSymbol || '?'}`.padEnd(20);
            const fee = (p.feeBps || 0).toString().padStart(4);
            const price = p.price > 0 ? p.price.toPrecision(6).padEnd(15) : 'N/A'.padEnd(15);
            console.log(`  ${String(i + 1).padStart(2)} | ${pair} | ${tvl.padEnd(11)} | ${fee} | ${price} | ${p.poolAddress}`);
        });
        console.log();
    }

    // ── Write JSON (BigInts serialised to strings) ────────────────────────────
    fs.writeFileSync(CONFIG.outputFile, JSON.stringify(allPools.map(serialisePool), null, 2));
    console.log(`💾  Saved → ${CONFIG.outputFile}`);
}

main().catch(err => {
    console.error('Fatal:', err.message);
    process.exit(1);
});
