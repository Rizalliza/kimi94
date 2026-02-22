"use strict";
// @arb/math - Consolidated math exports for DeFi arbitrage simulator
// All calculations use BigInt (RAW philosophy)

const CLMM = require('./clmm-raydium.js');
const DLMM = require('./dlmm-meteora.js');

// Whirlpool uses the same math as CLMM
const WHIRLPOOL = {
    quoteWhirlpoolExactInSingleTick: CLMM.quoteClmmExactInSingleTick,
    quoteWhirlpoolExactInMultiTick: CLMM.quoteClmmExactInMultiTick
};

const Q64 = 1n << 64n;

/**
 * Quote CPMM (Constant Product Market Maker) exact input
 * Uses x * y = k formula
 * @param {Object} st - State with xRaw, yRaw, feeBps
 * @param {string} dir - 'A2B' or 'B2A'
 * @param {bigint} amountInRaw - Input amount in raw lamports
 * @returns {Object} Quote result
 */
function quoteCpmmExactInRaw(st, dir, amountInRaw) {
    if (amountInRaw <= 0n) {
        return { success: false, reason: 'amountInRaw<=0' };
    }
    if (st.xRaw <= 0n || st.yRaw <= 0n) {
        return { success: false, reason: 'empty reserves' };
    }
    
    const x = st.xRaw;
    const y = st.yRaw;
    const feeBps = st.feeBps;
    
    // Apply fee: amount * (10000 - fee) / 10000
    const inAfterFee = (amountInRaw * BigInt(10000 - feeBps)) / 10000n;
    
    if (inAfterFee <= 0n) {
        return { success: false, reason: 'inAfterFee==0' };
    }
    
    let amountOutRaw;
    
    if (dir === 'A2B') {
        // Selling A for B: delta_y = (y * delta_x) / (x + delta_x)
        const numerator = y * inAfterFee;
        const denominator = x + inAfterFee;
        amountOutRaw = numerator / denominator;
    } else {
        // Selling B for A: delta_x = (x * delta_y) / (y + delta_y)
        const numerator = x * inAfterFee;
        const denominator = y + inAfterFee;
        amountOutRaw = numerator / denominator;
    }
    
    if (amountOutRaw <= 0n) {
        return { success: false, reason: 'out==0' };
    }
    
    // Execution price in Q64 format
    const executionPriceQ64 = (amountOutRaw * Q64) / amountInRaw;
    
    return {
        success: true,
        amountOutRaw,
        executionPriceQ64
    };
}

module.exports = {
    quoteCpmmExactInRaw,
    WHIRLPOOL,
    CLMM,
    DLMM,
    Q64
};
