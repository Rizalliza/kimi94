/**
 * orca-swap-builder.js
 * Builds Orca Whirlpool swap instructions from pool state.
 *
 * Swap instruction layout (Orca Whirlpool IDL):
 *   discriminator          : 8 bytes  [248,198,158,145,225,117,135,200]
 *   amount                 : u64 (8)
 *   otherAmountThreshold   : u64 (8)  – minimum out (slippage guard)
 *   sqrtPriceLimit         : u128 (16) – 0 means "no limit"
 *   amountSpecifiedIsInput : bool (1)  – true = exact-in
 *   aToB                   : bool (1)  – swap direction
 *
 * Tick array PDAs:
 *   seed: ["tick_array", whirlpool, Buffer.from(startTickIndex.toString())]
 *   A swap needs 3 tick arrays (current + 2 in direction of travel).
 *
 * Oracle PDA:
 *   seed: ["oracle", whirlpool]
 */

import { PublicKey, TransactionInstruction } from '@solana/web3.js';
import { PROGRAM_IDS, MINTS } from './config.js';

const ORCA_PROGRAM = PROGRAM_IDS.ORCA_WHIRLPOOL;

// Instruction discriminator: sha256("global:swap")[0:8]
const DISC_SWAP = Buffer.from([248, 198, 158, 145, 225, 117, 135, 200]);

// Ticks per tick array
const TICK_ARRAY_SIZE = 88;

// ── PDA helpers ───────────────────────────────────────────────────────────────

export function deriveTickArrayPda(whirlpool, startTickIndex) {
    const [pda] = PublicKey.findProgramAddressSync(
        [
            Buffer.from('tick_array'),
            new PublicKey(whirlpool).toBuffer(),
            Buffer.from(startTickIndex.toString()),
        ],
        ORCA_PROGRAM
    );
    return pda;
}

export function deriveOraclePda(whirlpool) {
    const [pda] = PublicKey.findProgramAddressSync(
        [Buffer.from('oracle'), new PublicKey(whirlpool).toBuffer()],
        ORCA_PROGRAM
    );
    return pda;
}

/**
 * Calculate the start index of the tick array that contains `tickIndex`.
 * Orca tick arrays each cover (tickSpacing * TICK_ARRAY_SIZE) ticks.
 */
export function tickIndexToArrayStartIndex(tickIndex, tickSpacing) {
    const arrSize = tickSpacing * TICK_ARRAY_SIZE;
    return Math.floor(tickIndex / arrSize) * arrSize;
}

/**
 * Derive the 3 tick array PDAs needed for a swap.
 * For A→B (price goes down): current, current-1, current-2
 * For B→A (price goes up):   current, current+1, current+2
 */
export function deriveSwapTickArrays(whirlpoolPubkey, tickCurrentIndex, tickSpacing, aToB) {
    const startIdx = tickIndexToArrayStartIndex(tickCurrentIndex, tickSpacing);
    const step = tickSpacing * TICK_ARRAY_SIZE;

    let indices;
    if (aToB) {
        // Traversing downward
        indices = [startIdx, startIdx - step, startIdx - 2 * step];
    } else {
        // Traversing upward
        indices = [startIdx, startIdx + step, startIdx + 2 * step];
    }

    return indices.map(idx => deriveTickArrayPda(whirlpoolPubkey, idx));
}

// ── Slippage guard ────────────────────────────────────────────────────────────

/**
 * Calculate minimum acceptable output after slippage.
 * @param {bigint} expectedOut
 * @param {number} slippageBps – e.g. 50 for 0.5%
 */
export function applySlippage(expectedOut, slippageBps = 50) {
    return (BigInt(expectedOut) * BigInt(10_000 - slippageBps)) / 10_000n;
}

// ── Instruction builder ───────────────────────────────────────────────────────

/**
 * Build a single Orca Whirlpool swap instruction.
 *
 * @param {object} opts
 * @param {string|PublicKey} opts.whirlpool         – pool address
 * @param {string|PublicKey} opts.tokenOwnerAccountA – caller's token A ATA
 * @param {string|PublicKey} opts.tokenOwnerAccountB – caller's token B ATA
 * @param {string|PublicKey} opts.tokenVaultA        – pool's token A vault (from on-chain state)
 * @param {string|PublicKey} opts.tokenVaultB        – pool's token B vault
 * @param {string|PublicKey} opts.tokenAuthority     – caller's wallet (signer)
 * @param {bigint}           opts.amount             – input amount (lamports/atoms)
 * @param {bigint}           opts.otherAmountThreshold – min output (slippage guard)
 * @param {boolean}          opts.aToB               – true if selling tokenA for tokenB
 * @param {number}           opts.tickCurrentIndex   – current tick from enriched pool state
 * @param {number}           opts.tickSpacing        – pool's tickSpacing
 * @returns {TransactionInstruction}
 */
export function buildOrcaSwapIx(opts) {
    const whirlpool = new PublicKey(opts.whirlpool);

    // Tick arrays for this direction
    const [ta0, ta1, ta2] = deriveSwapTickArrays(
        whirlpool,
        opts.tickCurrentIndex,
        opts.tickSpacing,
        opts.aToB
    );

    const oracle = deriveOraclePda(whirlpool);

    // Instruction data: 42 bytes total
    const data = Buffer.alloc(42);
    let offset = 0;
    DISC_SWAP.copy(data, offset);           offset += 8;
    data.writeBigUInt64LE(opts.amount, offset);            offset += 8;
    data.writeBigUInt64LE(opts.otherAmountThreshold, offset); offset += 8;
    // sqrtPriceLimit = 0 (no limit) — 16 bytes, already zeroed
    offset += 16;
    data.writeUInt8(1, offset);             offset += 1; // amountSpecifiedIsInput = true
    data.writeUInt8(opts.aToB ? 1 : 0, offset);         // aToB

    return new TransactionInstruction({
        programId: ORCA_PROGRAM,
        keys: [
            { pubkey: PROGRAM_IDS.TOKEN_PROGRAM,         isSigner: false, isWritable: false },
            { pubkey: new PublicKey(opts.tokenAuthority), isSigner: true,  isWritable: false },
            { pubkey: whirlpool,                          isSigner: false, isWritable: true  },
            { pubkey: new PublicKey(opts.tokenOwnerAccountA), isSigner: false, isWritable: true  },
            { pubkey: new PublicKey(opts.tokenVaultA),    isSigner: false, isWritable: true  },
            { pubkey: new PublicKey(opts.tokenOwnerAccountB), isSigner: false, isWritable: true  },
            { pubkey: new PublicKey(opts.tokenVaultB),    isSigner: false, isWritable: true  },
            { pubkey: ta0, isSigner: false, isWritable: true  },
            { pubkey: ta1, isSigner: false, isWritable: true  },
            { pubkey: ta2, isSigner: false, isWritable: true  },
            { pubkey: oracle, isSigner: false, isWritable: false },
        ],
        data,
    });
}

// ── Route builder ─────────────────────────────────────────────────────────────

/**
 * Resolve the swap direction for a pool leg.
 * Pipeline format: dir is 'A2B' or 'B2A'.
 */
function resolveAToB(dir) {
    return dir === 'A2B';
}

/**
 * Build all 3 swap instructions for a triangle route.
 *
 * @param {object}   route            – a single entry from bot-routes.json
 * @param {object[]} enrichedPools    – pools_enriched.json keyed by poolAddress
 * @param {object}   userTokenAccounts – map of mint → user ATA pubkey string
 * @param {PublicKey} userWallet
 * @param {number}   slippageBps
 * @returns {TransactionInstruction[]}
 */
export function buildTriangleSwapIxs(route, enrichedPools, userTokenAccounts, userWallet, slippageBps = 50) {
    // Build a lookup map from poolAddress → enriched pool data
    const poolMap = {};
    for (const pool of enrichedPools) {
        poolMap[pool.poolAddress || pool.address] = pool;
    }

    const ixs = [];

    for (const swap of route.swaps) {
        const pool = poolMap[swap.pool];
        if (!pool) throw new Error(`Enriched pool not found for address: ${swap.pool}`);
        if ((pool.type || '').toLowerCase() !== 'whirlpool') {
            throw new Error(`Only Orca Whirlpool supported here; got type=${pool.type} for ${swap.pool}`);
        }

        const aToB = resolveAToB(swap.dir);
        const amountIn = BigInt(swap.amountIn);
        const amountOut = BigInt(swap.amountOut);
        const minOut = applySlippage(amountOut, slippageBps);

        // Determine which mint is A and which is B for this pool
        const mintA = pool.tokenAMint || pool.mintA || pool.tokenMint0;
        const mintB = pool.tokenBMint || pool.mintB || pool.tokenMint1;

        const userAtaA = userTokenAccounts[mintA];
        const userAtaB = userTokenAccounts[mintB];
        if (!userAtaA) throw new Error(`No ATA found for mint A (${mintA}) in pool ${swap.pool}`);
        if (!userAtaB) throw new Error(`No ATA found for mint B (${mintB}) in pool ${swap.pool}`);

        const vaultA = pool.tokenVaultA || pool.vaultA;
        const vaultB = pool.tokenVaultB || pool.vaultB;
        if (!vaultA || !vaultB) {
            throw new Error(`Missing vault addresses in enriched pool ${swap.pool} — re-run enricher.`);
        }

        ixs.push(buildOrcaSwapIx({
            whirlpool:             swap.pool,
            tokenOwnerAccountA:    userAtaA,
            tokenOwnerAccountB:    userAtaB,
            tokenVaultA:           vaultA,
            tokenVaultB:           vaultB,
            tokenAuthority:        userWallet,
            amount:                amountIn,
            otherAmountThreshold:  minOut,
            aToB,
            tickCurrentIndex:      Number(pool.tickCurrentIndex ?? pool.tickCurrent ?? pool.tick_current_index ?? 0),
            tickSpacing:           Number(pool.tickSpacing ?? pool.tick_spacing ?? 64),
        }));
    }

    return ixs;
}

// ── ATA resolver ──────────────────────────────────────────────────────────────

/**
 * Derive associated token account address for a given wallet + mint.
 * Does NOT create it on-chain — caller must ensure it exists.
 */
export function deriveAta(walletPubkey, mintPubkey) {
    const [ata] = PublicKey.findProgramAddressSync(
        [
            new PublicKey(walletPubkey).toBuffer(),
            PROGRAM_IDS.TOKEN_PROGRAM.toBuffer(),
            new PublicKey(mintPubkey).toBuffer(),
        ],
        PROGRAM_IDS.ASSOC_TOKEN
    );
    return ata;
}

/**
 * Build userTokenAccounts map for all mints in a route.
 * @param {object} route – from bot-routes.json (has route.tokens[])
 * @param {PublicKey} walletPubkey
 * @returns {Record<string, PublicKey>}
 */
export function buildUserAtaMap(route, walletPubkey) {
    const map = {};
    const allMints = new Set(route.tokens || []);

    // Also collect mints from each pool's A/B side (not always in route.tokens)
    for (const swap of route.swaps || []) {
        if (swap.fromMint) allMints.add(swap.fromMint);
        if (swap.toMint)   allMints.add(swap.toMint);
    }

    // Always include wSOL (for flashloan)
    allMints.add(MINTS.SOL);

    for (const mint of allMints) {
        map[mint] = deriveAta(walletPubkey, mint);
    }
    return map;
}
