/**
 * Dynamic Slippage Calculator
 * 
 * Calculates appropriate slippage based on:
 * - Pool type (CPMM, CLMM, DLMM, Whirlpool)
 * - Liquidity depth
 * - Trade size relative to reserves
 * - Historical volatility (if available)
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

/**
 * Calculate dynamic slippage in basis points
 * 
 * @param {Object} leg - Pool leg with type, reserves, liquidity
 * @param {BigInt} amountIn - Input amount in atomic units
 * @param {Object} options - Additional options
 * @returns {number} Slippage in basis points
 */
function calculateDynamicSlippage(leg, amountIn, options = {}) {
  const {
    baseSlippageBps = 50,  // Base slippage (0.5%)
    maxSlippageBps = 500,  // Max slippage (5%)
    minSlippageBps = 10,   // Min slippage (0.1%)
  } = options;
  
  const type = (leg.type || '').toLowerCase();
  const amountInNum = Number(amountIn);
  
  // DEBUG: Log input data
  console.log(`[DynamicSlippage] ${type} ${leg.address?.slice(0, 8)}... | amountIn: ${amountInNum} | dir: ${leg.direction || leg.dir}`);
  
  // Get pool-specific base slippage
  let poolBaseSlippage = baseSlippageBps;
  
  switch (type) {
    case 'cpmm':
      poolBaseSlippage = calculateCpmmSlippage(leg, amountIn);
      break;
      
    case 'clmm':
    case 'whirlpool':
      poolBaseSlippage = calculateClmmSlippage(leg, amountIn);
      break;
      
    case 'dlmm':
      poolBaseSlippage = calculateDlmmSlippage(leg, amountIn);
      break;
      
    default:
      poolBaseSlippage = baseSlippageBps;
  }
  
  // Apply adjustments
  const sizeAdjustment = calculateSizeAdjustment(leg, amountIn);
  const depthAdjustment = calculateDepthAdjustment(leg, amountIn);
  
  // DEBUG: Log adjustments
  console.log(`[DynamicSlippage]   base: ${poolBaseSlippage.toFixed(1)} | sizeAdj: ${sizeAdjustment.toFixed(2)} | depthAdj: ${depthAdjustment.toFixed(2)}`);
  
  // Combine adjustments
  let finalSlippage = poolBaseSlippage * sizeAdjustment * depthAdjustment;
  
  // Clamp to min/max
  const clampedSlippage = Math.max(minSlippageBps, Math.min(maxSlippageBps, finalSlippage));
  
  // DEBUG: Log final result
  if (clampedSlippage === maxSlippageBps) {
    console.log(`[DynamicSlippage]   ⚠️ HIT MAX: ${clampedSlippage} bps (calculated: ${finalSlippage.toFixed(1)})`);
  } else {
    console.log(`[DynamicSlippage]   result: ${clampedSlippage} bps`);
  }
  
  return Math.floor(clampedSlippage);
}

/**
 * CPMM-specific slippage calculation
 * Uses constant product formula: slippage ≈ amountIn / reserves
 */
function calculateCpmmSlippage(leg, amountIn) {
  const xReserve = safeBigInt(leg.xReserve || leg.state?.baseReserveRaw || leg.pool?.xReserve);
  const yReserve = safeBigInt(leg.yReserve || leg.state?.quoteReserveRaw || leg.pool?.yReserve);
  
  if (xReserve === 0n || yReserve === 0n) return 100; // Conservative default
  
  // Determine input reserve based on direction
  const inputReserve = leg.dir === 'A2B' ? xReserve : yReserve;
  
  // Price impact as percentage of reserve
  const impactRatio = Number(amountIn * 10000n / inputReserve) / 100;
  
  // CPMM formula: actual impact is higher than linear
  // impact ≈ (amountIn / reserve) * (1 + amountIn / (2 * reserve))
  const nonLinearImpact = impactRatio * (1 + impactRatio / 200);
  
  // Base slippage: 2x the impact to account for execution variance
  return Math.max(20, nonLinearImpact * 2);
}

/**
 * CLMM/Whirlpool-specific slippage calculation
 * Depends on liquidity distribution across ticks
 */
function calculateClmmSlippage(leg, amountIn) {
  // Get liquidity from leg or state
  const liquidity = safeBigInt(leg.liquidity || leg.state?.liquidity);
  
  // DEBUG
  console.log(`[ClmmSlippage] liquidity: ${liquidity.toString().slice(0, 20)}...`);
  
  if (liquidity === 0n) {
    console.log(`[ClmmSlippage] ⚠️ ZERO LIQUIDITY - returning 100 bps`);
    return 100; // Conservative default if no data
  }
  
  // Get tick arrays from leg or state
  const ticks = leg.tickArrays || leg.state?.tickArrays || leg.state?.ticks || [];
  
  // If we have tick data, calculate based on liquidity traversal
  if (ticks.length > 0) {
    const tickSlippage = calculateTickTraversalSlippage(ticks, amountIn, liquidity);
    console.log(`[ClmmSlippage] tick-based: ${tickSlippage.toFixed(1)} bps (${ticks.length} ticks)`);
    return tickSlippage;
  }
  
  // Fallback: Use current liquidity
  const impactRatio = Number(amountIn * 10000n / liquidity) / 100;
  const fallbackSlippage = Math.max(15, impactRatio * 1.5);
  console.log(`[ClmmSlippage] fallback: ${fallbackSlippage.toFixed(1)} bps (ratio: ${impactRatio.toFixed(4)})`);
  
  return fallbackSlippage;
}

/**
 * Calculate slippage based on tick traversal
 */
function calculateTickTraversalSlippage(ticks, amountIn, currentLiquidity) {
  // Estimate how many ticks we'll cross
  let remainingAmount = amountIn;
  let ticksCrossed = 0;
  let totalImpact = 0;
  
  for (const tick of ticks) {
    if (remainingAmount <= 0n) break;
    
    const tickLiquidity = safeBigInt(tick.liquidityGross || tick.liquidity);
    if (tickLiquidity === 0n) continue;
    
    // Estimate amount that can be swapped in this tick
    const tickCapacity = tickLiquidity / 100n; // Rough estimate
    
    if (remainingAmount <= tickCapacity) {
      // Trade completes in this tick
      const impact = Number(remainingAmount * 10000n / tickLiquidity) / 100;
      totalImpact += impact;
      break;
    } else {
      // Cross this tick
      remainingAmount -= tickCapacity;
      ticksCrossed++;
      totalImpact += 0.5; // 0.5% per tick crossed
    }
  }
  
  // Add penalty for crossing multiple ticks
  const crossingPenalty = ticksCrossed * 5; // 5 bps per tick
  
  return Math.max(15, totalImpact + crossingPenalty);
}

/**
 * DLMM-specific slippage calculation
 * Discrete bins mean higher execution variance
 */
function calculateDlmmSlippage(leg, amountIn) {
  // Get bins from leg, state, or pool
  const bins = leg.bins || leg.state?.bins || leg.pool?.bins || [];
  
  if (bins.length === 0) return 150; // Conservative default for DLMM
  
  const activeId = leg.activeBinId || leg.state?.activeBinId || leg.pool?.activeBinId;
  const activeBin = bins.find(b => b.binId === activeId) || bins[0];
  
  if (!activeBin) return 150;
  
  const binLiquidity = safeBigInt(activeBin.liquidity || activeBin.reserveA || activeBin.reserveB);
  
  if (binLiquidity === 0n) return 150;
  
  // Estimate how many bins we'll traverse
  let remainingAmount = amountIn;
  let binsCrossed = 0;
  
  for (const bin of bins) {
    if (remainingAmount <= 0n) break;
    
    const liq = safeBigInt(bin.liquidity || bin.reserveA || bin.reserveB);
    if (liq === 0n) continue;
    
    const binCapacity = liq / 50n; // Rough estimate
    
    if (remainingAmount <= binCapacity) {
      break;
    } else {
      remainingAmount -= binCapacity;
      binsCrossed++;
    }
  }
  
  // DLMM has higher slippage due to discrete jumps
  const baseImpact = Number(amountIn * 10000n / binLiquidity) / 100;
  const binPenalty = binsCrossed * 10; // 10 bps per bin
  
  return Math.max(30, (baseImpact * 2) + binPenalty);
}

/**
 * Size-based adjustment factor
 * Larger trades relative to pool size get higher slippage
 */
function calculateSizeAdjustment(leg, amountIn) {
  // Get total pool liquidity (rough estimate)
  const xReserve = safeBigInt(leg.xReserve || leg.state?.baseReserveRaw || leg.pool?.xReserve) || 1n;
  const yReserve = safeBigInt(leg.yReserve || leg.state?.quoteReserveRaw || leg.pool?.yReserve) || 1n;
  const liquidity = safeBigInt(leg.liquidity || leg.state?.liquidity || leg.pool?.liquidity);
  
  // Use reserves or liquidity
  const totalLiq = liquidity > 0n ? liquidity : (xReserve + yReserve) / 2n;
  
  if (totalLiq === 0n) {
    console.log(`[SizeAdj] ⚠️ NO LIQUIDITY - returning 2.0x`);
    return 2.0;
  }
  
  // Size ratio
  const sizeRatio = Number(amountIn * 1000n / totalLiq) / 1000;
  
  // Adjustment curve
  let adjustment;
  if (sizeRatio < 0.01) adjustment = 1.0;
  else if (sizeRatio < 0.05) adjustment = 1.2;
  else if (sizeRatio < 0.10) adjustment = 1.5;
  else if (sizeRatio < 0.20) adjustment = 2.0;
  else adjustment = 3.0;
  
  console.log(`[SizeAdj] liq: ${totalLiq.toString().slice(0, 15)}... | ratio: ${sizeRatio.toExponential(2)} | adj: ${adjustment}x`);
  
  return adjustment;
}

/**
 * Liquidity depth adjustment
 * Shallower liquidity = higher slippage
 */
function calculateDepthAdjustment(leg, amountIn) {
  const type = (leg.type || '').toLowerCase();
  
  // Get liquidity metrics (as BigInt for precision)
  let liquidity = 0n;
  
  switch (type) {
    case 'cpmm':
      const xReserve = safeBigInt(leg.xReserve || leg.state?.baseReserveRaw);
      const yReserve = safeBigInt(leg.yReserve || leg.state?.quoteReserveRaw);
      // Use geometric mean of reserves as liquidity proxy
      const product = Number(xReserve) * Number(yReserve);
      liquidity = product > 0 ? BigInt(Math.floor(Math.sqrt(product))) : 0n;
      break;
      
    case 'clmm':
    case 'whirlpool':
      liquidity = BigInt(leg.liquidity || leg.state?.liquidity || 0);
      break;
      
    case 'dlmm':
      const bins = leg.bins || leg.state?.bins || [];
      liquidity = bins.reduce((sum, b) => sum + safeBigInt(b.liquidity), 0n);
      break;
  }
  
  // DEBUG
  const liqStr = liquidity > 0n ? liquidity.toString().slice(0, 15) + '...' : '0';
  
  // If no liquidity data, return conservative multiplier
  if (liquidity === 0n) {
    console.log(`[DepthAdj] ⚠️ NO LIQUIDITY - returning 2.0x`);
    return 2.0;
  }
  
  // Calculate size ratio: amountIn / liquidity
  const sizeRatio = Number(amountIn) / Number(liquidity);
  
  // Adjustment based on how large the trade is relative to liquidity
  let adjustment;
  if (sizeRatio < 0.001) adjustment = 0.8;
  else if (sizeRatio < 0.01) adjustment = 0.9;
  else if (sizeRatio < 0.05) adjustment = 1.0;
  else if (sizeRatio < 0.10) adjustment = 1.2;
  else if (sizeRatio < 0.20) adjustment = 1.5;
  else adjustment = 2.0;
  
  console.log(`[DepthAdj] liquidity: ${liqStr} | ratio: ${sizeRatio.toExponential(2)} | adj: ${adjustment}x`);
  
  return adjustment;
}

/**
 * Calculate minimum output with slippage
 */
function calculateMinOut(expectedOut, slippageBps) {
  const slippageFactor = BigInt(10000 - slippageBps);
  return (expectedOut * slippageFactor) / 10000n;
}

/**
 * Multi-leg slippage aggregation
 * Slippage compounds across multiple hops
 */
function calculateRouteSlippage(legs, amountsIn) {
  let totalSlippageBps = 0;
  
  for (let i = 0; i < legs.length; i++) {
    const leg = legs[i];
    const amountIn = amountsIn[i];
    
    const legSlippage = calculateDynamicSlippage(leg, amountIn);
    
    // Slippage compounds multiplicatively
    totalSlippageBps += legSlippage;
  }
  
  // Add compounding penalty (10% of sum)
  return Math.floor(totalSlippageBps * 1.1);
}

/**
 * Get slippage warning level
 */
function getSlippageWarning(slippageBps) {
  if (slippageBps < 50) return { level: 'LOW', emoji: '🟢' };
  if (slippageBps < 100) return { level: 'MEDIUM', emoji: '🟡' };
  if (slippageBps < 200) return { level: 'HIGH', emoji: '🟠' };
  return { level: 'CRITICAL', emoji: '🔴' };
}

module.exports = {
  calculateDynamicSlippage,
  calculateMinOut,
  calculateRouteSlippage,
  getSlippageWarning,
  
  // Pool-specific calculators
  calculateCpmmSlippage,
  calculateClmmSlippage,
  calculateDlmmSlippage,
};
