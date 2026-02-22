#!/usr/bin/env node
/**
 * Pool Enrichment Module
 * Enriches pool data with on-chain information for simulation
 * Supports: CPMM, CLMM (Raydium), Whirlpool (Orca), DLMM (Meteora)
 * 
 * Uses verified account layouts from core/ modules
 */

require('dotenv').config();
const fs = require('fs');
const { Connection, PublicKey } = require('@solana/web3.js');
const BN = require('bn.js');

// ============================================================================
// SDK IMPORTS
// ============================================================================

// DLMM SDK - v1.9.x uses different exports
let DLMM_SDK;
try {
    DLMM_SDK = require('@meteora-ag/dlmm');
    console.log('✓ DLMM SDK loaded');
} catch (e) {
    console.warn('DLMM SDK not available');
}

// Orca Whirlpools SDK
let WhirlpoolSDK;
try {
    WhirlpoolSDK = require('@orca-so/whirlpools-sdk');
    console.log('✓ Whirlpools SDK loaded');
} catch (e) {
    console.warn('Whirlpools SDK not available');
}

// ============================================================================
// CONFIGURATION
// ============================================================================

const RPC_URL = process.env.RPC_URL;
if (!RPC_URL) {
    console.error('❌ RPC_URL not set in environment');
    process.exit(1);
}

const connection = new Connection(RPC_URL, {
    commitment: 'confirmed',
    maxSupportedTransactionVersion: 0
});

// Program IDs
const RAYDIUM_CLMM_PROGRAM_ID = new PublicKey('CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK');
const ORCA_WHIRLPOOL_PROGRAM_ID = new PublicKey('whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc');
const METEORA_DLMM_PROGRAM_ID = new PublicKey('LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo');
const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');

// Known stable pairs (symbol pairs that should be ~1.0 price)
const STABLE_PAIRS = [
    ['USDC', 'USDT'],
    ['USDT', 'USDC'],
    ['USDC', 'USDY'],
    ['USDY', 'USDC'],
    ['USDT', 'USDY'],
    ['USDY', 'USDT'],
];

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

async function withTimeout(promise, ms, label = 'RPC') {
    let timeout;
    const timeoutPromise = new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`${label} timeout after ${ms}ms`)), ms);
    });
    return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timeout));
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function parseSplTokenAmount(data) {
    if (!data || !Buffer.isBuffer(data) || data.length < 72) return null;
    try {
        return data.readBigUInt64LE(64).toString();
    } catch (e) {
        return null;
    }
}

/**
 * Check if a pair is a known stable pair
 */
function isStablePair(baseSymbol, quoteSymbol) {
    const base = (baseSymbol || '').toUpperCase();
    const quote = (quoteSymbol || '').toUpperCase();
    return STABLE_PAIRS.some(([b, q]) => b === base && q === quote);
}

/**
 * Apply hardblock for stable pairs - forces price to ~1.0
 */
function applyStablePairHardblock(pool, result) {
    if (!isStablePair(pool.baseSymbol, pool.quoteSymbol)) {
        return result;
    }

    console.log(' (stable pair hardblock)');

    // Force sqrtPrice to ~1.0 in Q64 format
    const Q64 = 1n << 64n;
    const stableSqrtPriceX64 = Q64; // sqrt(1.0) = 1.0, in Q64 = 2^64

    // For CLMM
    if (result.sqrtPriceX64) {
        result.sqrtPriceX64 = stableSqrtPriceX64.toString();
    }

    // For DLMM - calculate bin price that gives ~1.0
    if (result.bins && result.bins.length > 0) {
        const binStep = result.binStep || 100;
        // Find bin closest to price 1.0
        // price = (1 + binStep/10000)^binId
        // For price ≈ 1.0, binId should be close to 0
        const targetBinId = 0;
        result.activeBinId = targetBinId;

        // Recalculate bin prices — update BOTH field names used by math layer
        const base = 1 + binStep / 10000;
        result.bins = result.bins.map(bin => {
            const price = Math.pow(base, bin.binId);
            const pxQ64str = BigInt(Math.floor(price * Number(Q64))).toString();
            return {
                ...bin,
                pxAB_Q64: pxQ64str,   // what raw-swap-math.js reads
                priceAB_Q64: pxQ64str    // legacy alias
            };
        });
    }

    return result;
}

// ============================================================================
// CLMM (Raydium) Account Layout & Parsing - From core/raydiumClmm.js
// ============================================================================

// Verified offsets from core/raydiumClmm.js
const CLMM_POOL_OFFSETS = {
    bump: 8,
    ammConfig: 9,
    owner: 41,
    tokenMint0: 73,
    tokenMint1: 105,
    tokenVault0: 137,
    tokenVault1: 169,
    observationKey: 201,
    mintDecimals0: 233,
    mintDecimals1: 234,
    tickSpacing: 235,
    liquidity: 237,
    sqrtPriceX64: 253,
    tickCurrent: 269,
    observationIndex: 273,
    observationUpdateDuration: 275,
    feeGrowthGlobalX64: 277,
    protocolFeesToken0: 309,
    protocolFeesToken1: 317,
};

// Tick array offsets
const CLMM_TICK_ARRAY_OFFSETS = {
    poolId: 8,
    startTickIndex: 40,
    ticks: 44,
};

const CLMM_TICK_SIZE = 140; // Size of each tick in bytes

function parseClmmPoolState(data) {
    if (!data || data.length < 300) {
        throw new Error(`Invalid CLMM pool data: length ${data?.length}`);
    }

    try {
        // Verify discriminator
        const discriminator = data.slice(0, 8);
        const expectedDisc = Buffer.from([247, 237, 227, 245, 215, 195, 222, 70]);
        if (!discriminator.equals(expectedDisc)) {
            console.warn('Warning: CLMM discriminator mismatch, continuing anyway');
        }

        const readPubkey = (offset) => {
            return new PublicKey(data.slice(offset, offset + 32)).toString();
        };

        const readU8 = (offset) => data[offset];
        const readU16 = (offset) => data.readUInt16LE(offset);
        const readU128 = (offset) => {
            const low = data.readBigUInt64LE(offset);
            const high = data.readBigUInt64LE(offset + 8);
            return low | (high << 64n);
        };
        const readI32 = (offset) => data.readInt32LE(offset);

        return {
            bump: readU8(CLMM_POOL_OFFSETS.bump),
            ammConfig: readPubkey(CLMM_POOL_OFFSETS.ammConfig),
            owner: readPubkey(CLMM_POOL_OFFSETS.owner),
            tokenMint0: readPubkey(CLMM_POOL_OFFSETS.tokenMint0),
            tokenMint1: readPubkey(CLMM_POOL_OFFSETS.tokenMint1),
            tokenVault0: readPubkey(CLMM_POOL_OFFSETS.tokenVault0),
            tokenVault1: readPubkey(CLMM_POOL_OFFSETS.tokenVault1),
            observationKey: readPubkey(CLMM_POOL_OFFSETS.observationKey),
            mintDecimals0: readU8(CLMM_POOL_OFFSETS.mintDecimals0),
            mintDecimals1: readU8(CLMM_POOL_OFFSETS.mintDecimals1),
            tickSpacing: readU16(CLMM_POOL_OFFSETS.tickSpacing),
            liquidity: readU128(CLMM_POOL_OFFSETS.liquidity),
            sqrtPriceX64: readU128(CLMM_POOL_OFFSETS.sqrtPriceX64),
            tickCurrent: readI32(CLMM_POOL_OFFSETS.tickCurrent),
            observationIndex: readU16(CLMM_POOL_OFFSETS.observationIndex),
            observationUpdateDuration: readU16(CLMM_POOL_OFFSETS.observationUpdateDuration),
        };
    } catch (e) {
        throw new Error(`Failed to parse CLMM pool state: ${e.message}`);
    }
}

function parseClmmTickArray(data) {
    if (!data || data.length < 100) {
        return [];
    }

    try {
        // Verify discriminator
        const discriminator = data.slice(0, 8);
        const expectedDisc = Buffer.from([71, 170, 124, 123, 16, 219, 242, 99]);
        if (!discriminator.equals(expectedDisc)) {
            return []; // Not a tick array
        }

        const poolId = new PublicKey(data.slice(CLMM_TICK_ARRAY_OFFSETS.poolId, CLMM_TICK_ARRAY_OFFSETS.poolId + 32)).toString();
        const startTickIndex = data.readInt32LE(CLMM_TICK_ARRAY_OFFSETS.startTickIndex);
        const ticks = [];

        // Parse ticks (60 ticks per array for Raydium)
        const ticksStart = CLMM_TICK_ARRAY_OFFSETS.ticks;
        for (let i = 0; i < 60; i++) {
            const offset = ticksStart + i * CLMM_TICK_SIZE;

            // Check if tick is initialized (first byte is boolean)
            const initialized = data[offset] === 1;
            if (initialized) {
                const liquidityNet = new BN(data.slice(offset + 8, offset + 24), 'le');
                const liquidityGross = new BN(data.slice(offset + 24, offset + 40), 'le');

                if (!liquidityGross.isZero()) {
                    ticks.push({
                        index: startTickIndex + i,
                        initialized,
                        liquidityNet: liquidityNet.toString(),
                        liquidityGross: liquidityGross.toString(),
                    });
                }
            }
        }

        return { poolId, startTickIndex, ticks };
    } catch (e) {
        console.warn(`Error parsing tick array: ${e.message}`);
        return [];
    }
}

function tickToSqrtPriceX64(tick) {
    // Validate tick
    if (typeof tick !== 'number' || !Number.isFinite(tick) || Number.isNaN(tick)) {
        return 1n << 64n; // Default to price of 1.0
    }

    // Clamp to valid range
    const clampedTick = Math.max(-887272, Math.min(887272, tick));

    try {
        // sqrtPrice = sqrt(1.0001^tick) * 2^64
        const sqrtPrice = Math.sqrt(Math.pow(1.0001, clampedTick));
        if (!isFinite(sqrtPrice) || sqrtPrice <= 0) {
            return 1n << 64n;
        }
        const raw = Math.floor(sqrtPrice * 18446744073709551616.0);
        if (!isFinite(raw)) {
            return 1n << 64n;
        }
        return BigInt(raw);
    } catch (e) {
        return 1n << 64n;
    }
}

// ============================================================================
// DLMM (Meteora) Account Layout & Parsing - From core/meteoraDlmm.js
// ============================================================================

// Verified offsets from core/meteoraDlmm.js
const DLMM_LB_PAIR_OFFSETS = {
    binStep: 80,         // u16
    activeId: 84,        // i32
    tokenXMint: 88,      // Pubkey
    tokenYMint: 120,     // Pubkey
    reserveX: 152,       // Pubkey
    reserveY: 184,       // Pubkey
};

function parseDlmmPoolState(data) {
    if (!data || data.length < 200) {
        throw new Error(`Invalid DLMM pool data: length ${data?.length}`);
    }

    try {
        const readPubkey = (offset) => {
            return new PublicKey(data.slice(offset, offset + 32)).toString();
        };
        const readU16 = (offset) => data.readUInt16LE(offset);
        const readI32 = (offset) => data.readInt32LE(offset);

        return {
            binStep: readU16(DLMM_LB_PAIR_OFFSETS.binStep),
            activeId: readI32(DLMM_LB_PAIR_OFFSETS.activeId),
            tokenXMint: readPubkey(DLMM_LB_PAIR_OFFSETS.tokenXMint),
            tokenYMint: readPubkey(DLMM_LB_PAIR_OFFSETS.tokenYMint),
            reserveX: readPubkey(DLMM_LB_PAIR_OFFSETS.reserveX),
            reserveY: readPubkey(DLMM_LB_PAIR_OFFSETS.reserveY),
        };
    } catch (e) {
        throw new Error(`Failed to parse DLMM pool state: ${e.message}`);
    }
}

// ============================================================================
// ENRICHMENT FUNCTIONS
// ============================================================================

/**
 * Enrich Whirlpool (Orca) pool with on-chain data
 */
async function enrichWhirlpool(pool) {
    const address = pool.poolAddress || pool.address;
    try {
        const pubkey = new PublicKey(address);
        const account = await withTimeout(
            connection.getAccountInfo(pubkey),
            10000,
            `Whirlpool ${address}`
        );

        if (!account) throw new Error('Account not found');

        if (!WhirlpoolSDK) {
            throw new Error('Whirlpools SDK not available');
        }

        const { ParsableWhirlpool, ParsableTickArray, TickUtil, PDAUtil } = WhirlpoolSDK;

        // Use SDK parser
        const state = ParsableWhirlpool.parse(pubkey, account);

        // Fetch vaults for reserves
        let xReserve = '0', yReserve = '0';
        try {
            const [vaultA, vaultB] = await connection.getMultipleAccountsInfo([
                state.tokenVaultA,
                state.tokenVaultB
            ]);
            xReserve = vaultA ? parseSplTokenAmount(vaultA.data) || '0' : '0';
            yReserve = vaultB ? parseSplTokenAmount(vaultB.data) || '0' : '0';
        } catch (e) {
            xReserve = pool.xReserve || '0';
            yReserve = pool.yReserve || '0';
        }

        // Fetch ticks around current index
        const tickArrays = [];
        const tickCurrent = state.tickCurrentIndex;
        const tickSpacing = state.tickSpacing;

        for (let offset = -2; offset <= 2; offset++) {
            const startIndex = TickUtil.getStartTickIndex(tickCurrent, tickSpacing, offset);
            const pda = PDAUtil.getTickArray(ORCA_WHIRLPOOL_PROGRAM_ID, pubkey, startIndex);
            try {
                const taAccount = await connection.getAccountInfo(pda.publicKey);
                if (!taAccount) continue;
                const tickArray = ParsableTickArray.parse(pda.publicKey, taAccount);
                tickArray.ticks.forEach((tick, idx) => {
                    if (tick.initialized && tick.liquidityGross.gt(new BN(0))) {
                        tickArrays.push({
                            index: startIndex + idx * tickSpacing,
                            liquidityNet: tick.liquidityNet.toString(),
                            liquidityGross: tick.liquidityGross.toString(),
                            sqrtPriceX64: tickToSqrtPriceX64(startIndex + idx * tickSpacing).toString()
                        });
                    }
                });
            } catch (e) { /* tick array missing */ }
        }

        let result = {
            sqrtPriceX64: state.sqrtPrice.toString(),
            tickCurrent: state.tickCurrentIndex,
            liquidity: state.liquidity.toString(),
            feeBps: Math.round(state.feeRate / 100),
            tickSpacing: state.tickSpacing,
            tickArrays: tickArrays.slice(0, 100),
            tickCount: tickArrays.length,
            hasRealTicks: tickArrays.length > 0,
            xReserve,
            yReserve,
            hasReserves: xReserve !== '0' && yReserve !== '0',
            enriched: true
        };

        // Apply stable pair hardblock
        result = applyStablePairHardblock(pool, result);
        return result;

    } catch (error) {
        console.error(`❌ Whirlpool ${address.slice(0, 8)}: ${error.message}`);
        return { enriched: false, error: error.message };
    }
}

/**
 * Enrich DLMM (Meteora) pool with on-chain data
 */
async function enrichDLMM(pool) {
    const address = pool.poolAddress || pool.address;

    try {
        const pubkey = new PublicKey(address);

        // Fetch pool state
        let poolState;
        try {
            const account = await withTimeout(
                connection.getAccountInfo(pubkey),
                10000,
                `DLMM ${address}`
            );
            if (!account) {
                throw new Error('Pool account not found');
            }
            poolState = parseDlmmPoolState(account.data);
        } catch (e) {
            // Fallback to API data
            poolState = {
                binStep: pool.binStep || 100,
                activeId: pool.activeBinId || 0,
                reserveX: pool.vaultA || '',
                reserveY: pool.vaultB || '',
            };
        }

        const binStep = poolState.binStep;
        const activeId = poolState.activeId;

        // Calculate active price from bin ID
        const base = 1 + binStep / 10000;
        const activePrice = Math.pow(base, activeId);

        // Get vault reserves
        let xReserve = pool.xReserve || '0';
        let yReserve = pool.yReserve || '0';

        try {
            if (poolState.reserveX && poolState.reserveY) {
                const [vaultA, vaultB] = await connection.getMultipleAccountsInfo([
                    new PublicKey(poolState.reserveX),
                    new PublicKey(poolState.reserveY)
                ]);
                if (vaultA) xReserve = parseSplTokenAmount(vaultA.data) || xReserve;
                if (vaultB) yReserve = parseSplTokenAmount(vaultB.data) || yReserve;
            }
        } catch (e) {
            // Use API reserves as fallback
        }

        // Build bins from API data or create synthetic bins
        const bins = [];
        if (pool.bins && Array.isArray(pool.bins) && pool.bins.length > 0) {
            for (const bin of pool.bins) {
                const binId = bin.binId ?? bin.id ?? 0;
                const amountX = bin.reserveA ?? bin.x ?? bin.amountX ?? '0';
                const amountY = bin.reserveB ?? bin.y ?? bin.amountY ?? '0';
                const price = Math.pow(base, binId);
                // FIX: raw-swap-math.js reads pxAB_Q64, NOT priceAB_Q64
                // Store BOTH names so both old and new code works
                const pxQ64str = BigInt(Math.floor(price * 2 ** 64)).toString();

                bins.push({
                    binId,
                    pxAB_Q64: pxQ64str,   // ← what raw-swap-math.js reads
                    priceAB_Q64: pxQ64str,   // ← legacy alias
                    reserveA: String(amountX),
                    reserveB: String(amountY),
                    liquidity: String(BigInt(amountX || 0) + BigInt(amountY || 0))
                });
            }
        }

        // Synthetic fallback: if fetcher gave no bins (old pools.json or API gap),
        // build a single active-bin from the pool's on-chain reserves and activePrice.
        // This ensures quoteDlmmRaw always has something to work with.
        if (bins.length === 0) {
            const xR = BigInt(xReserve || '0');
            const yR = BigInt(yReserve || '0');
            if ((xR > 0n || yR > 0n) && activePrice > 0) {
                const pxQ64 = BigInt(Math.floor(activePrice * 2 ** 64));
                const pxQ64str = pxQ64.toString();
                bins.push({
                    binId: activeId,
                    pxAB_Q64: pxQ64str,
                    priceAB_Q64: pxQ64str,
                    reserveA: xR.toString(),
                    reserveB: yR.toString(),
                    liquidity: (xR + yR).toString()
                });
            }
        }

        let result = {
            bins: bins.sort((a, b) => a.binId - b.binId),
            binCount: bins.length,
            hasRealBins: bins.length > 0,
            activeBinId: activeId,
            binStep,
            activePrice: activePrice.toString(),
            xReserve,
            yReserve,
            hasReserves: xReserve !== '0' && yReserve !== '0',
            enriched: true
        };

        // Apply stable pair hardblock
        result = applyStablePairHardblock(pool, result);
        return result;

    } catch (error) {
        console.error(`❌ DLMM ${address.slice(0, 8)}: ${error.message}`);
        return { enriched: false, error: error.message };
    }
}

/**
 * Enrich CLMM (Raydium) pool with on-chain data
 */
async function enrichCLMM(pool) {
    const address = pool.poolAddress || pool.address;

    try {
        const pubkey = new PublicKey(address);

        // Fetch pool state account
        const account = await withTimeout(
            connection.getAccountInfo(pubkey),
            10000,
            `CLMM ${address}`
        );

        if (!account) {
            throw new Error('Pool account not found');
        }

        // Parse pool state using verified layout
        const state = parseClmmPoolState(account.data);

        // Validate parsed state
        if (typeof state.tickCurrent !== 'number' || !Number.isFinite(state.tickCurrent)) {
            throw new Error(`Invalid tickCurrent from pool: ${state.tickCurrent}`);
        }
        if (typeof state.tickSpacing !== 'number' || state.tickSpacing <= 0) {
            throw new Error(`Invalid tickSpacing from pool: ${state.tickSpacing}`);
        }

        // Fetch vault reserves
        let xReserve = '0', yReserve = '0';
        try {
            const [vaultA, vaultB] = await connection.getMultipleAccountsInfo([
                new PublicKey(state.tokenVault0),
                new PublicKey(state.tokenVault1)
            ]);
            xReserve = vaultA ? parseSplTokenAmount(vaultA.data) || '0' : '0';
            yReserve = vaultB ? parseSplTokenAmount(vaultB.data) || '0' : '0';
        } catch (e) {
            xReserve = pool.xReserve || '0';
            yReserve = pool.yReserve || '0';
        }

        // Fetch tick arrays using program accounts query
        const tickArrays = [];
        try {
            // Calculate tick array range to fetch
            const ticksInArray = 60 * state.tickSpacing;
            const currentArrayStart = Math.floor(state.tickCurrent / ticksInArray) * ticksInArray;

            // Fetch tick arrays around current
            for (let offset of [-2, -1, 0, 1, 2]) {
                const startTick = currentArrayStart + (offset * ticksInArray);

                // Find PDA for tick array
                const [tickArrayPda] = PublicKey.findProgramAddressSync(
                    [
                        Buffer.from('TickArray'),
                        pubkey.toBuffer(),
                        Buffer.from(new Int32Array([startTick]).buffer)
                    ],
                    RAYDIUM_CLMM_PROGRAM_ID
                );

                try {
                    const taAccount = await connection.getAccountInfo(tickArrayPda);
                    if (!taAccount) continue;

                    const tickArrayData = parseClmmTickArray(taAccount.data);
                    if (tickArrayData.ticks) {
                        tickArrays.push(...tickArrayData.ticks.map(t => ({
                            index: t.index,
                            liquidityNet: t.liquidityNet,
                            liquidityGross: t.liquidityGross,
                            sqrtPriceX64: tickToSqrtPriceX64(t.index).toString()
                        })));
                    }
                } catch (e) {
                    // Tick array not found or error
                }
            }
        } catch (e) {
            console.warn(`Tick array fetch warning for ${address.slice(0, 8)}: ${e.message}`);
        }

        // Fetch fee rate from amm config
        let feeBps = pool.feeBps || 0;
        if (!feeBps && state.ammConfig) {
            try {
                const configAccount = await connection.getAccountInfo(new PublicKey(state.ammConfig));
                if (configAccount) {
                    // Trade fee rate is at offset 8 + 32 (discriminator + owner) in config
                    const tradeFeeRate = configAccount.data.readUInt32LE(40);
                    feeBps = Math.round(tradeFeeRate / 100);
                }
            } catch (e) { /* use pool fee as fallback */ }
        }

        let result = {
            sqrtPriceX64: state.sqrtPriceX64.toString(),
            tickCurrent: state.tickCurrent,
            liquidity: state.liquidity.toString(),
            feeBps: feeBps || pool.feeBps || 25,
            tickSpacing: state.tickSpacing,
            tickArrays: tickArrays.slice(0, 100),
            tickCount: tickArrays.length,
            hasRealTicks: tickArrays.length > 0,
            xReserve,
            yReserve,
            hasReserves: xReserve !== '0' && yReserve !== '0',
            enriched: true,
            tokenVault0: state.tokenVault0,
            tokenVault1: state.tokenVault1,
            ammConfig: state.ammConfig
        };

        // Apply stable pair hardblock
        result = applyStablePairHardblock(pool, result);
        return result;

    } catch (error) {
        console.error(`❌ CLMM ${address.slice(0, 8)}: ${error.message}`);
        return { enriched: false, error: error.message };
    }
}

/**
 * Enrich CPMM pool - ensure reserves are present
 */
function enrichCPMM(pool) {
    const xReserve = pool.xReserve || pool.baseReserve || '0';
    const yReserve = pool.yReserve || pool.quoteReserve || '0';

    let result = {
        xReserve,
        yReserve,
        hasReserves: xReserve !== '0' && yReserve !== '0',
        enriched: true
    };

    // Apply stable pair hardblock
    result = applyStablePairHardblock(pool, result);
    return result;
}

// ============================================================================
// MAIN ENRICHMENT LOOP
// ============================================================================

async function enrichAllPools(pools) {
    console.log(`\n🔄 Enriching ${pools.length} pools...\n`);

    const stats = {
        whirlpool: { total: 0, success: 0 },
        dlmm: { total: 0, success: 0 },
        clmm: { total: 0, success: 0 },
        cpmm: { total: 0, success: 0 }
    };

    for (let i = 0; i < pools.length; i++) {
        const pool = pools[i];
        const type = (pool.type || '').toLowerCase();
        const addr = pool.poolAddress || pool.address || 'unknown';
        const isStable = isStablePair(pool.baseSymbol, pool.quoteSymbol);

        process.stdout.write(`[${i + 1}/${pools.length}] ${pool.dex}/${type}: ${addr.slice(0, 8)}...`);
        if (isStable) {
            process.stdout.write(' [STABLE]');
        }

        let result;
        try {
            switch (type) {
                case 'whirlpool':
                    stats.whirlpool.total++;
                    result = await enrichWhirlpool(pool);
                    if (result.enriched) {
                        stats.whirlpool.success++;
                        console.log(` ✓ ticks:${result.tickCount} reserves:${result.hasReserves ? 'OK' : 'MISS'}`);
                    } else {
                        console.log(` ✗ ${result.error}`);
                    }
                    await sleep(100);
                    break;

                case 'dlmm':
                    stats.dlmm.total++;
                    result = await enrichDLMM(pool);
                    if (result.enriched) {
                        stats.dlmm.success++;
                        console.log(` ✓ bins:${result.binCount} reserves:${result.hasReserves ? 'OK' : 'MISS'}`);
                    } else {
                        console.log(` ✗ ${result.error}`);
                    }
                    await sleep(100);
                    break;

                case 'clmm':
                    stats.clmm.total++;
                    result = await enrichCLMM(pool);
                    if (result.enriched) {
                        stats.clmm.success++;
                        console.log(` ✓ ticks:${result.tickCount} reserves:${result.hasReserves ? 'OK' : 'MISS'}`);
                    } else {
                        console.log(` ✗ ${result.error}`);
                    }
                    await sleep(100);
                    break;

                case 'cpmm':
                    stats.cpmm.total++;
                    result = enrichCPMM(pool);
                    stats.cpmm.success++;
                    console.log(` ✓ reserves:${result.hasReserves ? 'OK' : 'MISS'}`);
                    break;

                default:
                    console.log(` ⚠ Unknown type: ${type}`);
                    continue;
            }

            // Merge enrichment result into pool object
            Object.assign(pool, result);

        } catch (error) {
            console.log(` ✗ Error: ${error.message}`);
            pool.error = error.message;
            pool.enriched = false;
        }
    }

    console.log('\n═══════════════════════════════════════════════════════════════');
    console.log('ENRICHMENT SUMMARY');
    console.log('═══════════════════════════════════════════════════════════════');
    console.log(`Whirlpool: ${stats.whirlpool.success}/${stats.whirlpool.total}`);
    console.log(`DLMM:      ${stats.dlmm.success}/${stats.dlmm.total}`);
    console.log(`CLMM:      ${stats.clmm.success}/${stats.clmm.total}`);
    console.log(`CPMM:      ${stats.cpmm.success}/${stats.cpmm.total}`);
    console.log('═══════════════════════════════════════════════════════════════');

    return pools;
}

// ============================================================================
// CLI ENTRY POINT
// ============================================================================

async function main() {
    const inputPath = process.argv[2] || 'poolsAll.json';
    const outputPath = process.argv[3] || 'poolsAll_enriched.json';

    console.log(`Loading pools from: ${inputPath}`);
    if (!fs.existsSync(inputPath)) {
        console.error(`❌ Input file not found: ${inputPath}`);
        process.exit(1);
    }

    const pools = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
    console.log(`Loaded ${pools.length} pools`);

    // Show stable pairs
    const stablePairs = pools.filter(p => isStablePair(p.baseSymbol, p.quoteSymbol));
    console.log(`\nFound ${stablePairs.length} stable pairs:`);
    stablePairs.forEach(p => console.log(`  - ${p.pairSymbol} (${p.dex}/${p.type})`));

    await enrichAllPools(pools);

    console.log(`\nSaving enriched pools to: ${outputPath}`);
    fs.writeFileSync(outputPath, JSON.stringify(pools, null, 2));
    console.log('✅ Done');
}

if (require.main === module) {
    main().catch(err => {
        console.error('Fatal error:', err);
        process.exit(1);
    });
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
    enrichAllPools,
    enrichWhirlpool,
    enrichDLMM,
    enrichCLMM,
    enrichCPMM,
    parseClmmPoolState,
    parseDlmmPoolState,
    tickToSqrtPriceX64,
    isStablePair,
    applyStablePairHardblock
};

/*

# Example usage with your existing scripts
node fetcher/fetch-pools.js pools_routes_only.json
node enricher/enriched-fixed.js pools_routes_only.json


//. node enricher/enriched-fixed.js pools.json pools.json

*/