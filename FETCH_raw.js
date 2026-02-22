const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { PublicKey } = require('@solana/web3.js');
const { getAssociatedTokenAddressSync } = require('@solana/spl-token'); // Attempt to use spl-token if available, else manual

// Fallback for ATA derivation if spl-token not available
function getAta(mint, owner) {
    try {
        const [ata] = PublicKey.findProgramAddressSync(
            [
                new PublicKey(owner).toBuffer(),
                new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA').toBuffer(),
                new PublicKey(mint).toBuffer()
            ],
            new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL')
        );
        return ata.toString();
    } catch (e) {
        return '';
    }
}

// Configuration
const CONFIG = {
    raydium: {
        urls: [
            'https://api-v3.raydium.io/pools/info/list-v2?poolType=Concentrated&hasReward=false&sortField=liquidity&sortType=desc&size=50',
            'https://api-v3.raydium.io/pools/info/list-v2?poolType=Standard&sortField=liquidity&sortType=desc&size=50'
        ]
    },
    orca: {
        url: 'https://api.mainnet.orca.so/v1/whirlpool/list',
        limit: 50
    },
    meteora: {
        url: 'https://dlmm-api.meteora.ag/pair/all',
        limit: 50
    },
    outputFile: './FETCH_raw.json'
};

async function fetchWithRetry(url, retries = 3) {
    for (let i = 0; i < retries; i++) {
        try {
            console.log(`Fetching ${url} (Attempt ${i + 1})...`);
            const response = await axios.get(url, { timeout: 10000 });
            return response.data;
        } catch (error) {
            console.warn(`Attempt ${i + 1} failed: ${error.message}`);
            if (i === retries - 1) throw error;
            await new Promise(r => setTimeout(r, 1000));
        }
    }
}


function mapRaydiumCPMM(pool) {
    const minLiquidity = parseFloat(pool.tvl || pool.liquidity || pool.minimumLiquidity || '0');
    if (minLiquidity <= 1000) {
        return null; // Skip this pool
    }
    // CPMM Enriched Pool Shape
    // {
    //   "poolAddress": "cpmmPoolPubkey",
    //   "dex": "raydium",
    //   "type": "cpmm",
    //   "baseMint": "mintX",
    //   "quoteMint": "mintY",
    //   "baseDecimals": 9,
    //   "quoteDecimals": 6,
    //   "fee": 0.0025,
    //   "vaults": { "xVault": "vaultXPubkey", "yVault": "vaultYPubkey" },
    //   "xReserve": "123456789000",
    //   "yReserve": "987654321000",
    //   "reserveSource": "rpc",
    //   "isMathReady": true
    // }

    try {
        const programId = pool.programId;
        // Identify if it's really CPMM (Standard)
        // Raydium Standard pools usually don't have 'config' object with 'tickSpacing'
        // But the API might label them.

        return {
            poolAddress: pool.id,
            dex: 'raydium',
            type: 'cpmm', // Assumed from context, needs verification if mixed

            baseMint: pool.mintA.address,
            quoteMint: pool.mintB.address,
            baseDecimals: pool.mintA.decimals,
            quoteDecimals: pool.mintB.decimals,

            liquidity: pool.minimumLiquidity ? String(pool.minimumLiquidity) : '0',
            fee: pool.feeRate, // Fallback if missing

            vaults: {
                xVault: pool.vaultA || '', // Need to verify API field names
                yVault: pool.vaultB || ''
            },

            xReserve: pool.mintAmountA ? String(Math.floor(pool.mintAmountA * (10 ** pool.mintA.decimals))) : '0',
            yReserve: pool.mintAmountB ? String(Math.floor(pool.mintAmountB * (10 ** pool.mintB.decimals))) : '0',

            reserveSource: 'api', // Marking as API since we fetched it
            isMathReady: true,

            _raw: pool // Keep raw for debugging
        };
    } catch (e) {
        console.error('Error mapping CPMM:', e.message);
        return null;
    }
}

function mapRaydiumCLMM(pool) {
    const minLiquidity = parseFloat(pool.tvl || pool.liquidity || pool.minimumLiquidity || '0');
    if (minLiquidity <= 1000) {
        return null; // Skip this pool
    }
    // CLMM Enriched Pool Shape
    // {
    //   "poolAddress": "clmmPoolStatePubkey",
    //   "dex": "raydium",
    //   "type": "clmm",
    //   "baseMint": "mintA",
    //   "quoteMint": "mintB",
    //   "baseDecimals": 9,
    //   "quoteDecimals": 6,
    //   "feeRate": 0.0005,
    //   "tickSpacing": 64,
    //   "vaults": { "aVault": "vaultAPubkey", "bVault": "vaultBPubkey" },
    //   "clmm": { ... },
    //   "reserveSource": "rpc",
    //   "isMathReady": true
    // }

    try {
        return {
            poolAddress: pool.id,
            dex: 'raydium',
            type: 'clmm',

            baseMint: pool.mintA.address,
            quoteMint: pool.mintB.address,
            baseDecimals: pool.mintA.decimals,
            quoteDecimals: pool.mintB.decimals,
            liquidity: pool.minimumLiquidity ? String(pool.minimumLiquidity) : '0',

            feeRate: pool.config?.protocolFeeRate ? pool.config.protocolFeeRate / 1000000 : 0, // Need to check units
            // Raydium API v3 structure for CLMM might differ

            tickSpacing: pool.config?.tickSpacing || 0,

            vaults: {
                aVault: pool.vaultA || '',
                bVault: pool.vaultB || ''
            },

            // For CLMM, reserves are less critical than currentTick/liquidity
            xReserve: pool.mintAmountA ? String(Math.floor(pool.mintAmountA * (10 ** pool.mintA.decimals))) : '0',
            yReserve: pool.mintAmountB ? String(Math.floor(pool.mintAmountB * (10 ** pool.mintB.decimals))) : '0',

            clmm: {
                sqrtPriceX64: pool.price ? String(pool.price) : '0', // Placeholder
                liquidity: pool.liquidity ? String(pool.liquidity) : '0',
                currentTickIndex: 0 // API might not give this directly
            },

            reserveSource: 'api',
            isMathReady: false, // CLMM needs RPC enrichment for tick arrays usually

            _raw: pool
        };
    } catch (e) {
        console.error('Error mapping CLMM:', e.message);
        return null;
    }
}

function mapOrcaWhirlpool(pool) {
    // ORCA CLMM ENRICHED POOLS Shape
    const minLiquidity = parseFloat(pool.tvl || pool.liquidity || pool.minimumLiquidity || '0');
    if (minLiquidity <= 1000) {
        return null; // Skip this pool
    }
    try {
        const baseMint = pool.tokenA.mint;
        const quoteMint = pool.tokenB.mint;
        const poolAddress = pool.address;

        // Derive Vaults (Assuming ATA)
        const aVault = getAta(baseMint, poolAddress);
        const bVault = getAta(quoteMint, poolAddress);


        return {
            id: pool.id,
            poolAddress: poolAddress,
            dex: 'orca',
            type: 'whirlpool',
            symboll: pool.symbol,

            baseMint: baseMint,
            quoteMint: quoteMint,
            baseDecimals: pool.tokenA.decimals,
            quoteDecimals: pool.tokenB.decimals,
            liquidity: pool.minimumLiquidity ? String(pool.minimumLiquidity) : '0',

            feeRate: pool.lpFeeRate, // Use LP fee as base
            tickSpacing: pool.tickSpacing,

            vaults: {
                aVault: aVault,
                bVault: bVault
            },

            whirlpool: {
                sqrtPriceX64: '0', // Not available in summary
                liquidity: '0',    // Not available in summary
                currentTickIndex: 0,
                feeRate: pool.feeRate || 0,
                tickSpacing: pool.tickSpacing || 60,
                sqrtPrice: pool.sqrtPrice || 0,
                liquidityNet: pool.liquidityNet || 0,
                liquidityGross: pool.liquidityGross || 0,
                tickCurrentIndex: pool.tickCurrentIndex || 0,
                tickLowerIndex: pool.tickLowerIndex || 0,
                tickUpperIndex: pool.tickUpperIndex || 0,
                tickLower: pool.tickLower || {},
                tickUpper: pool.tickUpper || {}
            },

            // API doesn't provide raw reserves, leaving as 0
            xReserve: pool.mintAmountA ? String(Math.floor(pool.mintAmountA * (10 ** pool.mintA.decimals))) : '0',
            yReserve: pool.mintAmountB ? String(Math.floor(pool.mintAmountB * (10 ** pool.mintB.decimals))) : '0',

            reserveSource: 'api', // Marking as API since we fetched it
            isMathReady: true,

            _raw: pool // Keep raw for debugging
        };
    } catch (e) {
        console.error('Error mapping Orca:', e.message);
        return null;
    }
}

function mapMeteoraDLMM(pool, tokenMap) {
    // METEORA DLMM ENRICHED POOLS Shape
    const minLiquidity = parseFloat(pool.liquidity || pool.minimumLiquidity || '0');
    if (minLiquidity <= 1000) {
        return null; // Skip this pool
    }

    // 2. Pool structure validation
    if (!pool.bin_step && !pool.bin_step_size || !pool.reserve_x || !pool.reserve_y) {
        return null; // Skip invalid pool
    }
    try {
        const baseMint = pool.mint_x;
        const quoteMint = pool.mint_y;

        // Try to find decimals from map
        const baseDecimals = tokenMap.get(baseMint) || 0;
        const quoteDecimals = tokenMap.get(quoteMint) || 0;

        return {
            poolAddress: pool.address,
            dex: 'meteora',
            type: 'dlmm',

            baseMint: baseMint,
            quoteMint: quoteMint,
            baseDecimals: baseDecimals,
            quoteDecimals: quoteDecimals,
            liquidity: pool.minimumLiquidity ? String(pool.minimumLiquidity) : (pool.liquidity || '0'),

            fee: pool.base_fee_percentage ? parseFloat(pool.base_fee_percentage) / 100 : 0, // % to ratio

            xVault: pool.reserve_x, // Add to root for diagnose compatibility
            yVault: pool.reserve_y, // Add to root for diagnose compatibility

            vaults: {
                xVault: pool.reserve_x,
                yVault: pool.reserve_y,
                binStep: pool.bin_step || pool.bin_step_size,
                binSize: pool.bin_size,
                binCount: pool.bin_count || 0,
                binStart: pool.bin_start_index || 0,
                binEnd: pool.bin_end_index || 0,
            },
            xReserve: pool.reserve_x_amount ? String(pool.reserve_x_amount) : '0',
            yReserve: pool.reserve_y_amount ? String(pool.reserve_y_amount) : '0',


            reserveSource: 'api',
            isMathReady: true, // We have reserves!

            _raw: pool
        };
    } catch (e) {
        console.error('Error mapping Meteora:', e.message);
        return null;
    }
}

async function main() {
    const allPools = [];
    const tokenDecimalsMap = new Map();

    // Helper to add decimals
    const addDecimals = (mint, decimals) => {
        if (mint && typeof decimals === 'number') {
            tokenDecimalsMap.set(mint, decimals);
        }
    };

    // 1. Fetch Raydium
    for (const url of CONFIG.raydium.urls) {
        try {
            const data = await fetchWithRetry(url);
            const rawList = data.data?.data || data.data || [];
            console.log(`Fetched ${rawList.length} pools from ${url}`);

            const isConcentrated = url.includes('Concentrated');

            for (const pool of rawList) {
                let mapped;
                if (isConcentrated) {
                    mapped = mapRaydiumCLMM(pool);
                } else {
                    mapped = mapRaydiumCPMM(pool);
                }

                if (mapped) {
                    if (!mapped.poolAddress || !mapped.baseMint || !mapped.quoteMint) continue;

                    addDecimals(mapped.baseMint, mapped.baseDecimals);
                    addDecimals(mapped.quoteMint, mapped.quoteDecimals);

                    allPools.push(mapped);
                }
            }
        } catch (e) {
            console.error('Failed to process Raydium URL:', url, e.message);
        }
    }

    // 2. Fetch Orca
    try {
        const data = await fetchWithRetry(CONFIG.orca.url);
        const rawList = data.whirlpools || data || [];
        console.log(`Fetched ${rawList.length} pools from Orca`);

        // Sort by TVL desc
        rawList.sort((a, b) => (b.tvl || 0) - (a.tvl || 0));
        const topOrca = rawList.slice(0, CONFIG.orca.limit);

        for (const pool of topOrca) {
            const mapped = mapOrcaWhirlpool(pool);
            if (mapped) {
                addDecimals(mapped.baseMint, mapped.baseDecimals);
                addDecimals(mapped.quoteMint, mapped.quoteDecimals);
                allPools.push(mapped);
            }

        }
    } catch (e) {
        console.error('Failed to process Orca:', e.message);
    }

    // 3. Fetch Meteora
    try {
        const data = await fetchWithRetry(CONFIG.meteora.url);
        const rawList = data || []; // Meteora returns array directly usually
        console.log(`Fetched ${rawList.length} pools from Meteora`);

        // Sort by liquidity? field name is 'liquidity' (string) or 'trade_volume_24h'
        // Meteora API 'liquidity' field seems to be string USD value.
        rawList.sort((a, b) => parseFloat(b.liquidity || '0') - parseFloat(a.liquidity || '0'));
        const topMeteora = rawList.slice(0, CONFIG.meteora.limit);

        for (const pool of topMeteora) {
            const mapped = mapMeteoraDLMM(pool, tokenDecimalsMap);
            if (mapped) {
                allPools.push(mapped);
            }
        }
    } catch (e) {
        console.error('Failed to process Meteora:', e.message);
    }

    console.log(`\nTotal processed pools: ${allPools.length}`);

    // Count per type
    const counts = allPools.reduce((acc, p) => {
        const key = p.type || 'unknown';
        acc[key] = (acc[key] || 0) + 1;
        return acc;
    }, {});
    console.log('Counts:', counts);

    fs.writeFileSync(CONFIG.outputFile, JSON.stringify(allPools, null, 2));
    console.log(`Saved to ${CONFIG.outputFile}`);
}

main();

//. node fetch_pools_custom.js /mintHouse_Meta.json /mintHouse_GotShapePool.json

//. //. node fetcher/FETCH_raw.js
