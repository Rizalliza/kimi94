"use strict";
/**
 * whirlpool-orca.js
 * Orca Whirlpool swap math — standalone, independent of clmm-raydium.js
 *
 * Key difference vs Raydium CLMM:
 *  - liquidityNet semantics on upward tick-cross: +liquidityNet (Orca) vs
 *    the same sign; on downward cross: -liquidityNet.
 *  - Fee rate is stored in Orca state as feeRate (millionths, e.g. 3000 → 0.3%)
 *    and must already be converted to bps (30) before being passed to these
 *    functions. Conversion: feeBps = feeRate / 100.
 *
 * All amounts are BigInt raw units. No floating-point inside core math.
 */

const Q64 = 1n << 64n;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mulDivFloor(a, b, d) {
    return (a * b) / d;
}

function mulDivCeil(a, b, d) {
    return (a * b + (d - 1n)) / d;
}

/**
 * Derive sqrtPriceX64 from a tick index (float approximation, used for
 * boundary estimation only — prefer on-chain values when available).
 */
function tickToSqrtPriceX64(tick) {
    const sqrtPrice = Math.sqrt(Math.pow(1.0001, tick));
    if (!isFinite(sqrtPrice) || sqrtPrice <= 0) return 0n;
    const raw = Math.floor(sqrtPrice * 18446744073709551616.0); // 2^64
    if (!isFinite(raw) || raw <= 0) return 0n;
    return BigInt(raw);
}

// ---------------------------------------------------------------------------
// Price movement helpers
// ---------------------------------------------------------------------------

/** New sqrtPrice after selling `amount0In` of token0 within a single tick. */
function nextSqrtPriceFromAmount0In(sqrt, L, amount0In) {
    const LQ = L * Q64;
    const numerator = LQ * sqrt;
    const denom = LQ + amount0In * sqrt;
    if (denom === 0n) return 0n;
    return numerator / denom;
}

/** New sqrtPrice after selling `amount1In` of token1 within a single tick. */
function nextSqrtPriceFromAmount1In(sqrt, L, amount1In) {
    const delta = mulDivFloor(amount1In, Q64, L);
    return sqrt + delta;
}

// ---------------------------------------------------------------------------
// Single-tick quote
// ---------------------------------------------------------------------------

/**
 * Quote an exact-in swap that stays within the current tick.
 *
 * @param {object} st - WhirlpoolState
 *   {bigint}  st.sqrtPriceX64
 *   {bigint}  st.liquidity
 *   {number}  st.tickCurrentIndex
 *   {number}  st.tickSpacing
 *   {number}  st.feeBps  — already in bps (NOT millionths)
 *   {bigint}  [st.nextTickSqrtPriceX64]  — optional; derived if absent
 * @param {'A2B'|'B2A'} dir
 * @param {bigint} amountInRaw
 */
function quoteWhirlpoolExactInSingleTick(st, dir, amountInRaw) {
    if (amountInRaw <= 0n) return { success: false, reason: 'amountInRaw<=0' };
    if (st.liquidity <= 0n) return { success: false, reason: 'empty liquidity' };
    if (st.feeBps < 0 || st.feeBps > 10000) return { success: false, reason: 'feeBps out of range' };

    // Resolve next-tick boundary sqrtPrice — use explicit value or derive it
    let nextSqrt = st.nextTickSqrtPriceX64 ?? 0n;
    if (!nextSqrt || nextSqrt <= 0n) {
        const spacing = st.tickSpacing != null ? Number(st.tickSpacing) : 64;
        const current = st.tickCurrentIndex != null ? Number(st.tickCurrentIndex) : 0;
        if (dir === 'A2B') {
            const lowerTick = Math.floor(current / spacing) * spacing;
            nextSqrt = tickToSqrtPriceX64(lowerTick);
        } else {
            const upperTick = (Math.floor(current / spacing) + 1) * spacing;
            nextSqrt = tickToSqrtPriceX64(upperTick);
        }
    }
    if (!nextSqrt || nextSqrt <= 0n) return { success: false, reason: 'cannot derive nextTickSqrtPriceX64' };

    const inAfterFee = (amountInRaw * BigInt(10000 - st.feeBps)) / 10000n;
    if (inAfterFee <= 0n) return { success: false, reason: 'inAfterFee==0' };

    const sqrt0 = st.sqrtPriceX64;
    let sqrt1, amountOutRaw;

    if (dir === 'A2B') {
        sqrt1 = nextSqrtPriceFromAmount0In(sqrt0, st.liquidity, inAfterFee);
        // Clamp to boundary — trade is valid up to the tick boundary
        if (sqrt1 < nextSqrt) sqrt1 = nextSqrt;
        const delta = sqrt0 - sqrt1;
        if (delta <= 0n) return { success: false, reason: 'no price movement (A2B)' };
        amountOutRaw = mulDivFloor(st.liquidity, delta, Q64);
    } else {
        sqrt1 = nextSqrtPriceFromAmount1In(sqrt0, st.liquidity, inAfterFee);
        // Clamp to boundary
        if (sqrt1 > nextSqrt) sqrt1 = nextSqrt;
        const delta = sqrt1 - sqrt0;
        if (delta <= 0n) return { success: false, reason: 'no price movement (B2A)' };
        const num = st.liquidity * Q64 * delta;
        const den = sqrt1 * sqrt0;
        if (den === 0n) return { success: false, reason: 'zero denominator' };
        amountOutRaw = num / den;
    }

    if (amountOutRaw <= 0n) return { success: false, reason: 'out==0' };

    const executionPriceQ64 = (amountOutRaw << 64n) / amountInRaw;
    return { success: true, amountOutRaw, executionPriceQ64 };
}

// ---------------------------------------------------------------------------
// Multi-tick quote
// ---------------------------------------------------------------------------

/**
 * Quote an exact-in swap that may cross multiple tick boundaries.
 *
 * Tick-cross liquidity update for Orca Whirlpool:
 *   Moving A→B (price ↓, left): L -= boundary.liquidityNet
 *   Moving B→A (price ↑, right): L += boundary.liquidityNet
 *
 * @param {object} st - WhirlpoolState with st.ticks[]
 * @param {'A2B'|'B2A'} dir
 * @param {bigint} amountInRaw
 */
function quoteWhirlpoolExactInMultiTick(st, dir, amountInRaw) {
    if (amountInRaw <= 0n) return { success: false, reason: 'amountInRaw<=0' };
    if (st.liquidity <= 0n) return { success: false, reason: 'empty liquidity' };
    if (!st.ticks || st.ticks.length === 0) return { success: false, reason: 'missing-ticks' };
    if (st.feeBps < 0 || st.feeBps > 10000) return { success: false, reason: 'feeBps out of range' };

    let remain = (amountInRaw * BigInt(10000 - st.feeBps)) / 10000n;
    if (remain <= 0n) return { success: false, reason: 'inAfterFee==0' };

    let sqrt = st.sqrtPriceX64;
    let L = st.liquidity;
    let outAcc = 0n;

    // Sort ticks ascending; find insertion point for current tick
    const ticks = st.ticks.slice().sort((a, b) => a.tickIndex - b.tickIndex);
    let idx = ticks.findIndex(t => t.tickIndex > st.tickCurrentIndex);
    if (idx === -1) idx = ticks.length;

    if (dir === 'A2B') {
        // Selling token0 → price decreases → traverse ticks downward (left)
        let i = idx - 1;
        while (remain > 0n) {
            if (i < 0) break;
            const boundary = ticks[i];
            const sqrtB = (boundary.sqrtPriceX64 && boundary.sqrtPriceX64 > 0n)
                ? boundary.sqrtPriceX64
                : tickToSqrtPriceX64(boundary.tickIndex);

            if (sqrtB <= 0n || sqrtB >= sqrt) break; // degenerate

            // Amount of token0 needed to reach this boundary from current sqrt
            const num = L * (sqrt - sqrtB) * Q64;
            const den = sqrt * sqrtB;
            if (den === 0n) break;
            const amtToBoundary = mulDivCeil(num, 1n, den);

            if (remain < amtToBoundary) {
                // Trade ends before reaching boundary
                const sqrt1 = nextSqrtPriceFromAmount0In(sqrt, L, remain);
                const delta = sqrt - sqrt1;
                outAcc += mulDivFloor(L, delta, Q64);
                remain = 0n;
                break;
            } else {
                // Cross the boundary
                outAcc += mulDivFloor(L, sqrt - sqrtB, Q64);
                remain -= amtToBoundary;
                sqrt = sqrtB;
                L = L - boundary.liquidityNet; // downward cross: subtract
                i -= 1;
            }
        }
    } else {
        // Selling token1 → price increases → traverse ticks upward (right)
        let i = idx;
        while (remain > 0n) {
            if (i >= ticks.length) break;
            const boundary = ticks[i];
            const sqrtB = (boundary.sqrtPriceX64 && boundary.sqrtPriceX64 > 0n)
                ? boundary.sqrtPriceX64
                : tickToSqrtPriceX64(boundary.tickIndex);

            if (sqrtB <= 0n || sqrtB <= sqrt) break; // degenerate

            const amtToBoundary = mulDivCeil(L * (sqrtB - sqrt), 1n, Q64);

            if (remain < amtToBoundary) {
                const sqrt1 = nextSqrtPriceFromAmount1In(sqrt, L, remain);
                const delta = sqrt1 - sqrt;
                const num = L * Q64 * delta;
                const den = sqrt1 * sqrt;
                if (den === 0n) break;
                outAcc += num / den;
                remain = 0n;
                break;
            } else {
                const num = L * Q64 * (sqrtB - sqrt);
                const den = sqrtB * sqrt;
                if (den === 0n) break;
                outAcc += num / den;
                remain -= amtToBoundary;
                sqrt = sqrtB;
                L = L + boundary.liquidityNet; // upward cross: add
                i += 1;
            }
        }
    }

    if (outAcc <= 0n) return { success: false, reason: 'out==0' };

    const executionPriceQ64 = (outAcc << 64n) / amountInRaw;
    return { success: true, amountOutRaw: outAcc, executionPriceQ64 };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
    quoteWhirlpoolExactInSingleTick,
    quoteWhirlpoolExactInMultiTick,
    tickToSqrtPriceX64,
    Q64
};
