// Q64.0 = 1.0
const Q64 = BigInt(1) << BigInt(64);

/**
 * Get Q64 price for a leg
 * @param {object} leg 
 * @returns {bigint} price in Q64 format
 */
function midQ64ForLeg(leg) {
    // If leg already has Q64 price, use it
    if (leg.priceQ64) return BigInt(leg.priceQ64);
    
    // If leg has float price, convert to Q64
    if (leg.price) {
        // Handle potentially large or small numbers carefully
        try {
            const price = Number(leg.price);
            if (isNaN(price) || !isFinite(price)) return Q64;
            
            // Convert to Q64: price * 2^64
            // Using BigInt for precision if possible, but float is easier
            return BigInt(Math.floor(price * Number(Q64)));
        } catch (e) {
            return Q64;
        }
    }
    
    // Default to 1.0 if no price info
    return Q64;
}

/**
 * Calculate arbitrage factor from legs (product of prices)
 * @param {Array} legs 
 * @returns {bigint} factor in Q64 format
 */
function calculateArbFactorMid(legs) {
    if (!legs || legs.length === 0) return Q64;

    let factor = Q64;
    
    // To avoid overflow with multiple multiplications of Q64,
    // we should treat Q64 as the base unit.
    // result = (factor * nextPrice) / Q64
    
    for (const leg of legs) {
        const mid = midQ64ForLeg(leg);
        factor = (factor * mid) / Q64;
    }
    
    return factor;
}

module.exports = {
    midQ64ForLeg,
    calculateArbFactorMid
};
