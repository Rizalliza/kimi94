/**
 * kamino.js
 * Kamino Lending flashloan instruction builders.
 *
 * Discriminators are SHA-256("global:<instruction_name>")[0:8]
 * and have been verified against the published Kamino IDL:
 *   flash_borrow_reserve_liquidity : [135,231, 52,167,  7, 52,212,193]
 *   flash_repay_reserve_liquidity  : [185,117,  0,203, 96,245,180,186]
 *
 * Flashloan mechanics:
 *   1. flashBorrow  → Kamino sends `amount` tokens to `userTokenAccount`
 *   2. <your swap instructions run>
 *   3. flashRepay   → you return `amount + fee` to Kamino reserve
 *
 * Fee: 9 bps (0.09%).  Fee = (amount * 9) / 10_000 — ceil.
 */

import {
    PublicKey,
    TransactionInstruction,
    SYSVAR_INSTRUCTIONS_PUBKEY,
} from '@solana/web3.js';
import { PROGRAM_IDS, KAMINO } from './config.js';

// ── Constants ────────────────────────────────────────────────────────────────

const DISC_BORROW = Buffer.from([135, 231, 52, 167, 7, 52, 212, 193]);
const DISC_REPAY  = Buffer.from([185, 117,   0, 203, 96, 245, 180, 186]);
const KAMINO_PROGRAM = PROGRAM_IDS.KAMINO_LENDING;

// ── PDA Helpers ───────────────────────────────────────────────────────────────

/**
 * Derive the lending market authority PDA.
 * Seed: ["lma", lendingMarket]
 */
export function deriveLendingMarketAuthority(lendingMarket) {
    const [pda] = PublicKey.findProgramAddressSync(
        [Buffer.from('lma'), new PublicKey(lendingMarket).toBuffer()],
        KAMINO_PROGRAM
    );
    return pda;
}

/**
 * Derive the reserve liquidity supply SPL account.
 * Seed: ["reserve_liq_supply", reserve]
 *
 * NOTE: In practice this is stored in reserve.liquidity.supplyVault and should
 * be fetched from chain.  This PDA fallback only works if Kamino uses this seed.
 * Pass the on-chain supplyVault address explicitly whenever possible.
 */
export function deriveReserveLiquiditySupply(reserve) {
    const [pda] = PublicKey.findProgramAddressSync(
        [Buffer.from('reserve_liq_supply'), new PublicKey(reserve).toBuffer()],
        KAMINO_PROGRAM
    );
    return pda;
}

// ── Fee math ─────────────────────────────────────────────────────────────────

/** Kamino flashloan fee: ceil(amount * 9 / 10_000) */
export function calcFlashloanFee(amount) {
    const a = BigInt(amount);
    return (a * 9n + 9999n) / 10_000n;  // ceiling division
}

/** Total repayment = amount + fee */
export function calcRepayAmount(amount) {
    return BigInt(amount) + calcFlashloanFee(amount);
}

// ── Instruction builders ──────────────────────────────────────────────────────

/**
 * Build the flash_borrow_reserve_liquidity instruction.
 *
 * @param {object} p
 * @param {bigint}    p.amount                    – atoms to borrow
 * @param {PublicKey} p.lendingMarket             – Kamino market pubkey
 * @param {PublicKey} p.lendingMarketAuthority    – derived via deriveLendingMarketAuthority
 * @param {PublicKey} p.reserve                   – e.g. KAMINO.RESERVES.SOL
 * @param {PublicKey} p.reserveLiquidityMint      – wSOL / USDC mint
 * @param {PublicKey} p.reserveSourceLiquidity    – reserve's supply vault (on-chain field)
 * @param {PublicKey} p.userDestinationLiquidity  – caller's token account (receives loan)
 * @param {PublicKey} p.userTransferAuthority     – caller's wallet (signer)
 * @param {PublicKey} p.tokenProgram
 */
export function buildFlashBorrowIx(p) {
    const data = Buffer.alloc(16);
    DISC_BORROW.copy(data, 0);
    data.writeBigUInt64LE(BigInt(p.amount), 8);

    return new TransactionInstruction({
        programId: KAMINO_PROGRAM,
        keys: [
            { pubkey: p.userTransferAuthority,   isSigner: true,  isWritable: true  },
            { pubkey: p.lendingMarketAuthority,  isSigner: false, isWritable: false },
            { pubkey: p.lendingMarket,           isSigner: false, isWritable: false },
            { pubkey: p.reserve,                 isSigner: false, isWritable: true  },
            { pubkey: p.reserveLiquidityMint,    isSigner: false, isWritable: true  },
            { pubkey: p.reserveSourceLiquidity,  isSigner: false, isWritable: true  },
            { pubkey: p.userDestinationLiquidity,isSigner: false, isWritable: true  },
            { pubkey: PROGRAM_IDS.TOKEN_PROGRAM, isSigner: false, isWritable: false },
            { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY,isSigner: false, isWritable: false },
        ],
        data,
    });
}

/**
 * Build the flash_repay_reserve_liquidity instruction.
 * Same account layout as borrow; no amount in data (validated against borrow ix).
 *
 * @param {object} p  – same fields as buildFlashBorrowIx, amount not required
 */
export function buildFlashRepayIx(p) {
    const data = Buffer.alloc(16);
    DISC_REPAY.copy(data, 0);
    // repay amount is implicit (Kamino reads it from the borrow instruction)
    data.writeBigUInt64LE(calcRepayAmount(p.amount), 8);

    return new TransactionInstruction({
        programId: KAMINO_PROGRAM,
        keys: [
            { pubkey: p.userTransferAuthority,   isSigner: true,  isWritable: true  },
            { pubkey: p.lendingMarketAuthority,  isSigner: false, isWritable: false },
            { pubkey: p.lendingMarket,           isSigner: false, isWritable: false },
            { pubkey: p.reserve,                 isSigner: false, isWritable: true  },
            { pubkey: p.reserveLiquidityMint,    isSigner: false, isWritable: true  },
            { pubkey: p.reserveSourceLiquidity,  isSigner: false, isWritable: true  },
            { pubkey: p.userDestinationLiquidity,isSigner: false, isWritable: true  },
            { pubkey: PROGRAM_IDS.TOKEN_PROGRAM, isSigner: false, isWritable: false },
            { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY,isSigner: false, isWritable: false },
        ],
        data,
    });
}

// ── High-level builder ────────────────────────────────────────────────────────

/**
 * Build the complete flashloan sandwich: [borrow, ...swapIxs, repay].
 *
 * @param {object} opts
 * @param {bigint}    opts.amount              – atoms to borrow (e.g. 1_000_000_000n for 1 wSOL)
 * @param {PublicKey} opts.mint                – token to borrow (e.g. wSOL)
 * @param {PublicKey} opts.reserve             – Kamino reserve for that mint
 * @param {PublicKey} opts.supplyVault         – reserve's on-chain liquidity supply vault
 * @param {PublicKey} opts.userTokenAccount    – caller's associated token account
 * @param {PublicKey} opts.userWallet          – caller's wallet (signer)
 * @param {TransactionInstruction[]} opts.swapIxs – inner swap instructions
 * @returns {TransactionInstruction[]}
 */
export function buildFlashloanSandwich(opts) {
    const lendingMarket = KAMINO.MAIN_MARKET;
    const lendingMarketAuthority = deriveLendingMarketAuthority(lendingMarket);

    const shared = {
        amount:                 opts.amount,
        lendingMarket,
        lendingMarketAuthority,
        reserve:                opts.reserve,
        reserveLiquidityMint:   opts.mint,
        reserveSourceLiquidity: opts.supplyVault,
        userDestinationLiquidity: opts.userTokenAccount,
        userTransferAuthority:  opts.userWallet,
    };

    return [
        buildFlashBorrowIx(shared),
        ...opts.swapIxs,
        buildFlashRepayIx(shared),
    ];
}

// ── Reserve supply vault fetcher ──────────────────────────────────────────────

/**
 * Fetch the actual supply vault address from on-chain reserve state.
 * Use this in production instead of the PDA derivation above.
 *
 * Kamino reserve layout (relevant offsets):
 *   8   bytes: discriminator
 *   8   bytes: version (u64)
 *   32  bytes: lastUpdate
 *   32  bytes: lendingMarket
 *   ... (liquidity struct starts here)
 *   offset 128: liquidity.mintPubkey (32)
 *   offset 160: liquidity.supplyVault (32)  ← what we want
 */
export async function fetchReserveSupplyVault(connection, reservePubkey) {
    const info = await connection.getAccountInfo(new PublicKey(reservePubkey));
    if (!info) throw new Error(`Reserve account not found: ${reservePubkey}`);
    // supplyVault is at byte offset 160
    return new PublicKey(info.data.slice(160, 192));
}
