/**
 * math-adapter.js - Bridges raw pool data to math modules
 *
 * FIXES applied:
 *  1. normalizeFee() centralises all fee-field conversions.
 *     Whirlpool / Raydium store feeRate in millionths (e.g. 3000 → 0.3%).
 *     Correct conversion: feeBps = feeRate / 100  (NOT * 10000).
 *  2. Whirlpool pools are now routed to the standalone whirlpool-orca.js
 *     module rather than sharing clmm-raydium.js math.
 */

const clmmMath     = require('../core/clmm-raydium.js');
const dlmmMath     = require('../core/dlmm-meteora.js');
const whirlpoolMath = require('../core/whirlpool-orca.js');   // NEW — standalone

const Q64 = 1n << 64n;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toBigInt(v) {
    if (typeof v === 'bigint') return v;
    if (typeof v === 'number') return BigInt(Math.trunc(v));
    if (typeof v === 'string') {
        const s = v.trim();
        if (s.length === 0) return 0n;
        const [intPart] = s.split('.');
        if (/^-?\d+$/.test(intPart)) return BigInt(intPart);
        return 0n;
    }
    return 0n;
}

function normalizeDecimals(amount, fromDecimals, toDecimals) {
    if (fromDecimals === toDecimals) return amount;
    if (fromDecimals > toDecimals) {
        return amount / (10n ** BigInt(fromDecimals - toDecimals));
    } else {
        return amount * (10n ** BigInt(toDecimals - fromDecimals));
    }
}

function q64FromDecimal(dec) {
    const s = (typeof dec === 'string') ? dec.trim() : String(dec);
    if (s.includes('e') || s.includes('E')) {
        return BigInt(Math.floor(Number(s) * Math.pow(2, 64)));
    }
    const parts = s.split('.');
    const intPart = parts[0] || '0';
    const fracPart = parts[1] || '';
    const scale = BigInt(10 ** fracPart.length);
    const num = BigInt(intPart + fracPart);
    return (num * Q64) / scale;
}

/**
 * Normalise fee from any source field to basis-points (integer 0-10000).
 *
 * Fee field conventions across DEXes:
 *   feeBps    — already in bps (e.g. 25 = 0.25%)          → use directly
 *   feeRate   — millionths   (e.g. 3000 = 0.3%)            → divide by 100
 *   feePct    — decimal frac (e.g. 0.003 = 0.3%)           → multiply by 10000
 *   fee       — ambiguous; sniff by magnitude:
 *                 > 100  → treat as millionths → /100
 *                 1-100  → treat as already bps
 *                 < 1    → treat as decimal fraction → *10000
 *
 * Minimum returned value is 1 bps to avoid divide-by-zero in fee arithmetic.
 */
function normalizeFee(pool) {
    if (pool.feeBps != null) {
        const v = Number(pool.feeBps);
        return (v > 0 && v <= 10000) ? v : 25;
    }
    if (pool.feeRate != null) {
        // feeRate = 3000 → 3000 / 1_000_000 = 0.3% = 30 bps
        const v = Math.round(Number(pool.feeRate) / 100);
        return (v > 0 && v <= 10000) ? v : 25;
    }
    if (pool.feePct != null) {
        // feePct = 0.003 → 0.003 * 10000 = 30 bps
        const v = Math.round(Number(pool.feePct) * 10000);
        return (v > 0 && v <= 10000) ? v : 25;
    }
    if (pool.fee != null) {
        const raw = Number(pool.fee);
        let v;
        if (raw > 100) v = Math.round(raw / 100);      // millionths
        else if (raw >= 1) v = Math.round(raw);         // already bps
        else v = Math.round(raw * 10000);               // decimal fraction
        return (v > 0 && v <= 10000) ? v : 25;
    }
    return 25; // default: 0.25%
}

// ---------------------------------------------------------------------------
// Aux-state builders
// ---------------------------------------------------------------------------

function buildCpmmAux(pool) {
    try {
        const xReserve = pool.xReserve ?? pool.reserveA ?? pool.tokenAAmount ?? pool.x;
        const yReserve = pool.yReserve ?? pool.reserveB ?? pool.tokenBAmount ?? pool.y;
        if (xReserve == null || yReserve == null) return null;

        const xRaw = toBigInt(xReserve);
        const yRaw = toBigInt(yReserve);
        if (xRaw <= 0n || yRaw <= 0n) return null;

        return {
            type: 'cpmm',
            address:    pool.address || pool.poolAddress,
            baseMint:   pool.baseMint  || pool.mintA || pool.tokenA?.mint,
            quoteMint:  pool.quoteMint || pool.mintB || pool.tokenB?.mint,
            xRaw,
            yRaw,
            feeBps: normalizeFee(pool)          // ← FIXED
        };
    } catch { return null; }
}

function buildClmmAux(pool) {
    try {
        const sqrtPriceX64 = pool.sqrtPriceX64 ?? pool.sqrt_price_x64;
        if (!sqrtPriceX64) return null;

        const st = {
            type: 'clmm',
            address:      pool.address || pool.poolAddress,
            tokenAMint:   pool.tokenAMint  || pool.tokenMint0 || pool.mintA || pool.tokenA?.mint,
            tokenBMint:   pool.tokenBMint  || pool.tokenMint1 || pool.mintB || pool.tokenB?.mint,
            sqrtPriceX64: toBigInt(sqrtPriceX64),
            liquidity:    toBigInt(pool.liquidity ?? 0),
            tickCurrentIndex: Number(pool.tickCurrent ?? pool.tickCurrentIndex ?? pool.tick_current_index ?? 0),
            tickSpacing:  Number(pool.tickSpacing ?? pool.tick_spacing ?? 64),
            feeBps:       normalizeFee(pool)    // ← FIXED
        };

        const ticks = pool.ticks || pool.tickArrays || pool.tick_arrays || [];
        if (ticks.length > 0) {
            st.ticks = ticks
                .map(t => ({
                    tickIndex:    Number(t.tickIndex ?? t.index ?? t.tick_index),
                    sqrtPriceX64: toBigInt(t.sqrtPriceX64 ?? t.sqrt_price_x64 ?? 0),
                    liquidityNet: toBigInt(t.liquidityNet ?? t.liqNet ?? t.net ?? t.liquidity_net ?? 0)
                }))
                .filter(t => isFinite(t.tickIndex))
                .sort((a, b) => a.tickIndex - b.tickIndex);
        }

        return st;
    } catch { return null; }
}

function buildWhirlpoolAux(pool) {
    try {
        const sqrtPriceX64 = pool.sqrtPriceX64 ?? pool.sqrt_price_x64;
        if (!sqrtPriceX64) return null;

        const st = {
            type: 'whirlpool',
            address:      pool.address || pool.poolAddress,
            tokenAMint:   pool.tokenAMint  || pool.tokenMintA || pool.mintA || pool.tokenA?.mint,
            tokenBMint:   pool.tokenBMint  || pool.tokenMintB || pool.mintB || pool.tokenB?.mint,
            sqrtPriceX64: toBigInt(sqrtPriceX64),
            liquidity:    toBigInt(pool.liquidity ?? 0),
            tickCurrentIndex: Number(pool.tickCurrent ?? pool.tickCurrentIndex ?? pool.tick_current_index ?? 0),
            tickSpacing:  Number(pool.tickSpacing ?? pool.tick_spacing ?? 64),
            feeBps:       normalizeFee(pool)    // ← FIXED (was broken for feeRate=3000 pools)
        };

        const ticks = pool.ticks || pool.tickArrays || pool.tick_arrays || [];
        if (ticks.length > 0) {
            st.ticks = ticks
                .map(t => ({
                    tickIndex:    Number(t.tickIndex ?? t.index ?? t.tick_index),
                    sqrtPriceX64: toBigInt(t.sqrtPriceX64 ?? t.sqrt_price_x64 ?? 0),
                    liquidityNet: toBigInt(t.liquidityNet ?? t.liqNet ?? t.net ?? t.liquidity_net ?? 0)
                }))
                .filter(t => isFinite(t.tickIndex))
                .sort((a, b) => a.tickIndex - b.tickIndex);
        }

        return st;
    } catch { return null; }
}

function buildDlmmAux(pool) {
    try {
        const bins = pool.bins || pool.binLadder || [];
        if (bins.length === 0 && pool.activeBinId == null) return null;

        const st = {
            type: 'dlmm',
            address:    pool.address || pool.poolAddress,
            baseMint:   pool.baseMint  || pool.mintA || pool.tokenA?.mint,
            quoteMint:  pool.quoteMint || pool.mintB || pool.tokenB?.mint,
            feeBps:     normalizeFee(pool),     // ← FIXED
            activeBinId: Number(pool.activeBinId ?? pool.activeBin ?? pool.binId ?? 0),
            bins: []
        };

        st.bins = bins.map(b => {
            let pxAB_Q64;
            if      (b.priceAB_Q64 != null) pxAB_Q64 = toBigInt(b.priceAB_Q64);
            else if (b.pxAB_Q64   != null)  pxAB_Q64 = toBigInt(b.pxAB_Q64);
            else if (b.px_q64     != null)  pxAB_Q64 = toBigInt(b.px_q64);
            else if (b.price      != null)  pxAB_Q64 = q64FromDecimal(b.price);
            else                            pxAB_Q64 = Q64;

            const reserveA = toBigInt(b.reserveA ?? b.x ?? b.amountA ?? b.reserve_a ?? 0);
            const reserveB = toBigInt(b.reserveB ?? b.y ?? b.amountB ?? b.reserve_b ?? 0);
            const binFeeRaw = b.feeBps ?? b.fee_bps;

            return {
                binId:    Number(b.binId ?? b.id ?? b.bin_id),
                pxAB_Q64,
                reserveA,
                reserveB,
                feeBps: binFeeRaw != null ? Number(binFeeRaw) : undefined
            };
        });

        return st;
    } catch { return null; }
}

// ---------------------------------------------------------------------------
// Direction resolution
// ---------------------------------------------------------------------------

function resolveDirection(requestedDir, inputBaseMint, inputQuoteMint, poolTokenAMint, poolTokenBMint) {
    if (inputBaseMint === poolTokenAMint && inputQuoteMint === poolTokenBMint) {
        return { dir: requestedDir, reversed: false };
    }
    if (inputBaseMint === poolTokenBMint && inputQuoteMint === poolTokenAMint) {
        return { dir: requestedDir === 'A2B' ? 'B2A' : 'A2B', reversed: true };
    }
    return { dir: requestedDir, reversed: false, error: 'Mint mismatch' };
}

// ---------------------------------------------------------------------------
// Per-type quote entry points
// ---------------------------------------------------------------------------

function quoteCpmmExactInRaw(st, dir, amountInRaw) {
    if (amountInRaw <= 0n) return { success: false, reason: 'amountInRaw<=0' };
    if (st.xRaw <= 0n || st.yRaw <= 0n) return { success: false, reason: 'empty reserves' };

    const inAfterFee = (amountInRaw * BigInt(10000 - st.feeBps)) / 10000n;
    if (inAfterFee <= 0n) return { success: false, reason: 'inAfterFee==0' };

    let amountOutRaw;
    if (dir === 'A2B') {
        amountOutRaw = (st.yRaw * inAfterFee) / (st.xRaw + inAfterFee);
    } else {
        amountOutRaw = (st.xRaw * inAfterFee) / (st.yRaw + inAfterFee);
    }

    if (amountOutRaw <= 0n) return { success: false, reason: 'out==0' };

    return {
        success: true,
        amountOutRaw,
        executionPriceQ64: (amountOutRaw * Q64) / amountInRaw
    };
}

function quoteCpmm(pool, amountInRaw, direction) {
    const aux = buildCpmmAux(pool);
    if (!aux) return { success: false, reason: 'failed to build CPMM aux state' };
    return quoteCpmmExactInRaw(aux, direction, amountInRaw);
}

function quoteClmm(pool, amountInRaw, direction) {
    const aux = buildClmmAux(pool);
    if (!aux) return { success: false, reason: 'failed to build CLMM aux state (missing sqrtPriceX64?)' };

    const inputBaseMint  = pool.baseMint  || pool.mintA || pool.tokenA?.mint;
    const inputQuoteMint = pool.quoteMint || pool.mintB || pool.tokenB?.mint;
    const resolved = resolveDirection(direction, inputBaseMint, inputQuoteMint, aux.tokenAMint, aux.tokenBMint);
    if (resolved.error) return { success: false, reason: resolved.error };

    return aux.ticks?.length > 0
        ? clmmMath.quoteClmmExactInMultiTick(aux, resolved.dir, amountInRaw)
        : clmmMath.quoteClmmExactInSingleTick(aux, resolved.dir, amountInRaw);
}

/**
 * Whirlpool now uses its own standalone module.
 * The Whirlpool protocol is Orca-specific and diverges from Raydium CLMM in:
 *  - fee encoding (millionths vs bps)
 *  - reward structures (unused here)
 *  - potential future protocol upgrades
 * Keeping them separate prevents cross-contamination of bugs.
 */
function quoteWhirlpool(pool, amountInRaw, direction) {
    const aux = buildWhirlpoolAux(pool);
    if (!aux) return { success: false, reason: 'failed to build Whirlpool aux state (missing sqrtPriceX64?)' };

    const inputBaseMint  = pool.baseMint  || pool.mintA || pool.tokenA?.mint;
    const inputQuoteMint = pool.quoteMint || pool.mintB || pool.tokenB?.mint;
    const resolved = resolveDirection(direction, inputBaseMint, inputQuoteMint, aux.tokenAMint, aux.tokenBMint);
    if (resolved.error) return { success: false, reason: resolved.error };

    // ← CHANGED: route through standalone whirlpool module
    return aux.ticks?.length > 0
        ? whirlpoolMath.quoteWhirlpoolExactInMultiTick(aux, resolved.dir, amountInRaw)
        : whirlpoolMath.quoteWhirlpoolExactInSingleTick(aux, resolved.dir, amountInRaw);
}

function quoteDlmm(pool, amountInRaw, direction) {
    const aux = buildDlmmAux(pool);
    if (!aux) return { success: false, reason: 'failed to build DLMM aux state (missing bins?)' };

    const inputBaseMint  = pool.baseMint  || pool.mintA || pool.tokenA?.mint;
    const inputQuoteMint = pool.quoteMint || pool.mintB || pool.tokenB?.mint;

    if (inputBaseMint !== aux.baseMint || inputQuoteMint !== aux.quoteMint) {
        if (inputBaseMint === aux.quoteMint && inputQuoteMint === aux.baseMint) {
            direction = direction === 'A2B' ? 'B2A' : 'A2B';
        } else {
            return { success: false, reason: 'DLMM mint mismatch' };
        }
    }

    return dlmmMath.quoteDlmmExactInMultiBin(aux, direction, amountInRaw);
}

// ---------------------------------------------------------------------------
// Universal entry point
// ---------------------------------------------------------------------------

function quotePoolSwap(pool, amountInRaw, direction) {
    if (!pool)              return { success: false, reason: 'missing pool' };
    if (amountInRaw <= 0n)  return { success: false, reason: 'amountInRaw<=0' };
    if (direction !== 'A2B' && direction !== 'B2A') {
        return { success: false, reason: 'invalid direction (use A2B or B2A)' };
    }

    switch ((pool.type || '').toLowerCase()) {
        case 'cpmm':       return quoteCpmm(pool, amountInRaw, direction);
        case 'clmm':       return quoteClmm(pool, amountInRaw, direction);
        case 'whirlpool':  return quoteWhirlpool(pool, amountInRaw, direction);
        case 'dlmm':       return quoteDlmm(pool, amountInRaw, direction);
        default:           return { success: false, reason: `unsupported pool type: ${pool.type}` };
    }
}

// ---------------------------------------------------------------------------
// PoolMath class (unchanged API)
// ---------------------------------------------------------------------------

class PoolMath {
    constructor(rawPool) {
        this.raw          = rawPool;
        this.type         = (rawPool.type || '').toLowerCase();
        this.address      = rawPool.poolAddress || rawPool.address;
        this.baseMint     = rawPool.baseMint  || rawPool.mintA || rawPool.tokenA?.mint;
        this.quoteMint    = rawPool.quoteMint || rawPool.mintB || rawPool.tokenB?.mint;
        this.baseDecimals  = rawPool.baseDecimals  || 9;
        this.quoteDecimals = rawPool.quoteDecimals || 6;
        this.aux          = this._buildAux();
    }

    _buildAux() {
        switch (this.type) {
            case 'cpmm':      return buildCpmmAux(this.raw);
            case 'clmm':      return buildClmmAux(this.raw);
            case 'whirlpool': return buildWhirlpoolAux(this.raw);
            case 'dlmm':      return buildDlmmAux(this.raw);
            default:          return null;
        }
    }

    isValid()        { return this.aux !== null; }
    getQuote(a, d)   { return quotePoolSwap(this.raw, a, d); }
    getAuxState()    { return this.aux; }
    getType()        { return this.type; }
    getAddress()     { return this.address; }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
    PoolMath,
    quotePoolSwap,
    normalizeFee,                               // exported for testing
    buildCpmmAux,
    buildClmmAux,
    buildWhirlpoolAux,
    buildDlmmAux,
    resolveDirection,
    quoteCpmmExactInRaw,
    quoteWhirlpoolExactInSingleTick: whirlpoolMath.quoteWhirlpoolExactInSingleTick,
    quoteWhirlpoolExactInMultiTick:  whirlpoolMath.quoteWhirlpoolExactInMultiTick,
    quoteDlmmExactInMultiBin:        dlmmMath.quoteDlmmExactInMultiBin,
    toBigInt,
    q64FromDecimal,
    Q64
};
