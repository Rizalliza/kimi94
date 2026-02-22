/**
 * Production Route Guard Layer
 * Hard structural + economic validation before ranking
 * 
 * Protects against:
 * - Decimal/price calculation bugs
 * - Stale pool data
 * - Illiquid memecoin traps
 * - MEV sandwich exposure
 * - Stable pair deviations
 */

// Helper to safely convert values to BigInt
function safeBigInt(val) {
    if (typeof val === 'bigint') return val;
    if (typeof val === 'string') {
        if (!val || val === 'null' || val === 'undefined') return 0n;
        try { return BigInt(val); } catch { return 0n; }
    }
    if (typeof val === 'number') {
        if (!isFinite(val) || isNaN(val)) return 0n;
        return BigInt(Math.floor(val));
    }
    if (typeof val === 'object' && val !== null) {
        if (val.liquidity) return safeBigInt(val.liquidity);
        if (val.amount) return safeBigInt(val.amount);
        if (val.value) return safeBigInt(val.value);
        return 0n;
    }
    return 0n;
}

const GUARD_CONFIG = {
    MAX_IMPACT_BPS: 120,           // Max 1.2% price impact
    MAX_TOTAL_SLIPPAGE_BPS: 180,   // Max 1.8% total slippage
    MAX_PRICE_RATIO: 5,            // Reject if price ratio > 5x
    MIN_PRICE_RATIO: 0.2,          // Reject if price ratio < 0.2x
    STABLE_DEVIATION: 0.01,        // Max 1% deviation for stable pairs
    MAX_ROUTE_PROFIT_BPS: 2000,    // Reject absurd >20% profit (likely bug)
    MIN_DEPTH_SCORE: 0.3,          // Minimum liquidity depth
    ALLOW_LOSS: false              // Allow non-positive profit (for testing)
};

// Stable token symbols
const STABLE_SYMBOLS = ['USDC', 'USDT', 'USD1', 'USDX', 'USDH', 'DAI', 'USDS'];

function isStable(symbol) {
    if (!symbol) return false;
    const upper = symbol.toUpperCase();
    return STABLE_SYMBOLS.some(s => upper.includes(s));
}

function impliedPrice(leg) {
    if (!leg.amountInHuman || !leg.amountOutHuman) return 1;
    const amountIn = parseFloat(leg.amountInHuman);
    const amountOut = parseFloat(leg.amountOutHuman);
    if (amountIn === 0) return 1;
    return amountOut / amountIn;
}

function priceRatioRaw(leg) {
    if (!leg.amountIn || !leg.amountOut) return 1;
    const amountIn = Number(leg.amountIn);
    const amountOut = Number(leg.amountOut);
    if (amountIn === 0) return 1;
    return amountOut / amountIn;
}

/**
 * Calculate MEV sandwich risk score (0-1)
 */
function sandwichRiskScore(route) {
    let risk = 0;

    for (const leg of route.swaps || []) {
        // Higher impact = higher MEV risk
        if (leg.impactBps) {
            risk += leg.impactBps / 300; // 90 bps impact = 0.3 risk
        }

        // Low TVL pools are more vulnerable
        if (leg.tvlUsd && leg.tvlUsd < 2000000) {
            risk += 0.1;
        }

        // CPMM is more sandwichable than CLMM
        if (leg.type === 'cpmm') {
            risk += 0.15;
        }
    }

    return Math.min(risk, 1);
}

/**
 * Main guard function - validates route before ranking
 * 
 * @param {Object} route - Route object from simulation
 * @param {Object} cfg - Guard configuration (optional)
 * @returns {Object} { ok: boolean, reason: string, riskScore: number }
 */
function productionGuard(route, cfg = GUARD_CONFIG) {
    // 1️⃣ Raw sanity - must have positive profit
    // Handle both profit (BigInt) and profitRaw (string)
    let profitValue;
    if (typeof route.profit === 'bigint') {
        profitValue = route.profit;
    } else if (route.profitRaw) {
        profitValue = safeBigInt(route.profitRaw);
    } else {
        return { ok: false, reason: 'no profit data', riskScore: 1 };
    }
    
    if (!cfg.ALLOW_LOSS && profitValue <= 0n) {
        return { ok: false, reason: 'non-positive profit', riskScore: 1 };
    }

    // 2️⃣ Cap absurd profit (decimal bugs / stale pools)
    if (route.profitBps && route.profitBps > cfg.MAX_ROUTE_PROFIT_BPS) {
        return { ok: false, reason: 'absurd profit (>20%) - likely bug', riskScore: 1 };
    }

    // 3️⃣ Liquidity impact filter
    if (route.totalImpactBps && route.totalImpactBps > cfg.MAX_IMPACT_BPS) {
        return { 
            ok: false, 
            reason: `excessive impact (${route.totalImpactBps} bps > ${cfg.MAX_IMPACT_BPS})`,
            riskScore: 0.8
        };
    }

    // 4️⃣ Slippage filter
    if (route.totalSlippageBps && route.totalSlippageBps > cfg.MAX_TOTAL_SLIPPAGE_BPS) {
        return { 
            ok: false, 
            reason: `excessive slippage (${route.totalSlippageBps} bps > ${cfg.MAX_TOTAL_SLIPPAGE_BPS})`,
            riskScore: 0.7
        };
    }

    // 5️⃣ Depth quality
    if (route.depthScore !== undefined && route.depthScore < cfg.MIN_DEPTH_SCORE) {
        return { 
            ok: false, 
            reason: `low liquidity depth (${route.depthScore.toFixed(2)} < ${cfg.MIN_DEPTH_SCORE})`,
            riskScore: 0.6
        };
    }

    // 6️⃣ Per-leg structural validation
    for (const leg of route.swaps || []) {
        // 6a️⃣ Raw ratio explosion (decimal corruption guard)
        const ratio = priceRatioRaw(leg);
        if (ratio > cfg.MAX_PRICE_RATIO || ratio < cfg.MIN_PRICE_RATIO) {
            return { 
                ok: false, 
                reason: `price ratio explosion (leg ${leg.leg}: ${ratio.toFixed(2)})`,
                riskScore: 0.9
            };
        }

        // 6b️⃣ Stable pair sanity
        if (isStable(leg.from) && isStable(leg.to)) {
            const px = impliedPrice(leg);
            if (Math.abs(px - 1) > cfg.STABLE_DEVIATION) {
                return { 
                    ok: false, 
                    reason: `stable pair deviation (leg ${leg.leg}: ${(Math.abs(px-1)*100).toFixed(2)}%)`,
                    riskScore: 0.85
                };
            }
        }

        // 6c️⃣ Single leg extreme impact
        if (leg.impactBps && leg.impactBps > 150) {
            return { 
                ok: false, 
                reason: `leg impact too high (leg ${leg.leg}: ${leg.impactBps} bps)`,
                riskScore: 0.75
            };
        }
    }

    // 7️⃣ Sandwich exposure check
    const mevRisk = sandwichRiskScore(route);
    if (mevRisk > 0.85) {
        return { 
            ok: false, 
            reason: `high MEV exposure (risk: ${(mevRisk * 100).toFixed(1)}%)`,
            riskScore: mevRisk
        };
    }

    return { 
        ok: true, 
        reason: 'passed all guards',
        riskScore: mevRisk
    };
}

/**
 * Batch guard validation for multiple routes
 * 
 * @param {Array} routes - Array of route objects
 * @param {Object} cfg - Guard configuration
 * @returns {Array} Filtered routes with guard results attached
 */
function guardRoutes(routes, cfg = GUARD_CONFIG) {
    return routes.map(route => {
        const guard = productionGuard(route, cfg);
        return { ...route, guard };
    }).filter(route => route.guard.ok);
}

/**
 * Get guard statistics for rejected routes
 */
function getGuardStats(allRoutes, cfg = GUARD_CONFIG) {
    const results = allRoutes.map(route => ({
        route,
        guard: productionGuard(route, cfg)
    }));

    const passed = results.filter(r => r.guard.ok);
    const rejected = results.filter(r => !r.guard.ok);

    const rejectionReasons = rejected.reduce((acc, r) => {
        const reason = r.guard.reason.split('(')[0].trim();
        acc[reason] = (acc[reason] || 0) + 1;
        return acc;
    }, {});

    return {
        total: allRoutes.length,
        passed: passed.length,
        rejected: rejected.length,
        passRate: allRoutes.length > 0 ? (passed.length / allRoutes.length * 100).toFixed(1) : 0,
        rejectionReasons
    };
}

module.exports = {
    productionGuard,
    guardRoutes,
    getGuardStats,
    GUARD_CONFIG,
    sandwichRiskScore
};
