#!/usr/bin/env node
/**
 * CSV to Human-Readable Converter
 * Converts arbitrage results CSV to formatted text/markdown
 */

const fs = require('fs');
const path = require('path');

function formatSol(lamports) {
    return (Number(lamports) / 1e9).toFixed(9);
}

function formatProfit(bps) {
    const pct = (Number(bps) / 100).toFixed(2);
    return bps > 0 ? `+${pct}%` : `${pct}%`;
}

function getEmoji(profitBps) {
    if (profitBps > 100) return '🟢🟢🟢';
    if (profitBps > 0) return '🟢';
    if (profitBps > -100) return '🟡';
    if (profitBps > -500) return '🟠';
    return '🔴';
}

function parseCSVLine(line) {
    // Handle quoted fields and commas within fields
    const result = [];
    let current = '';
    let inQuotes = false;
    
    for (let i = 0; i < line.length; i++) {
        const char = line[i];
        if (char === '"') {
            inQuotes = !inQuotes;
        } else if (char === ',' && !inQuotes) {
            result.push(current.trim());
            current = '';
        } else {
            current += char;
        }
    }
    result.push(current.trim());
    return result;
}

function parseCSV(csvContent) {
    const lines = csvContent.split('\n');
    const triangles = [];
    const swaps = [];
    let section = null;
    let headers = null;

    for (const line of lines) {
        if (line.startsWith('# Total Simulated:')) {
            const match = line.match(/# Total Simulated: (\d+)/);
            if (match) triangles.total = parseInt(match[1]);
        }
        if (line.startsWith('# Profitable:')) {
            const match = line.match(/# Profitable: (\d+)/);
            if (match) triangles.profitable = parseInt(match[1]);
        }
        if (line.startsWith('## Triangle Summary')) {
            section = 'triangles';
            continue;
        }
        if (line.startsWith('## Detailed Swaps')) {
            section = 'swaps';
            continue;
        }
        if (line.startsWith('Index,')) {
            headers = parseCSVLine(line);
            continue;
        }
        if (line.startsWith('Triangle Index,')) {
            headers = parseCSVLine(line);
            continue;
        }
        if (!line.trim() || line.startsWith('#')) continue;

        if (section === 'triangles' && headers) {
            const cols = parseCSVLine(line);
            if (cols.length >= 10) {
                triangles.push({
                    index: cols[0],
                    path: cols.slice(1, cols.length - 11).join(',') || cols[1],
                    inputRaw: cols[cols.length - 11],
                    inputHuman: cols[cols.length - 10],
                    outputRaw: cols[cols.length - 9],
                    outputHuman: cols[cols.length - 8],
                    profitRaw: cols[cols.length - 7],
                    profitHuman: cols[cols.length - 6],
                    profitBps: parseInt(cols[cols.length - 5]) || 0,
                    profitPct: cols[cols.length - 4],
                    isProfitable: cols[cols.length - 3],
                    swapCount: cols[cols.length - 2],
                    timestamp: cols[cols.length - 1]
                });
            }
        }
        if (section === 'swaps' && headers) {
            const cols = parseCSVLine(line);
            if (cols.length >= 12) {
                swaps.push({
                    triangleIndex: cols[0],
                    path: cols.slice(1, cols.length - 11).join(',') || cols[1],
                    leg: cols[cols.length - 11],
                    pool: cols[cols.length - 10],
                    poolType: cols[cols.length - 9],
                    poolDex: cols[cols.length - 8],
                    amountInRaw: cols[cols.length - 7],
                    amountInHuman: cols[cols.length - 6],
                    amountOutRaw: cols[cols.length - 5],
                    amountOutHuman: cols[cols.length - 4],
                    feeBps: cols[cols.length - 3],
                    impactBps: cols[cols.length - 2],
                    slippageBps: cols[cols.length - 1]
                });
            }
        }
    }

    return { triangles, swaps };
}

function convertToReadable(csvFile) {
    const csvContent = fs.readFileSync(csvFile, 'utf8');
    const { triangles, swaps } = parseCSV(csvContent);

    const result = [];
    
    // Header
    result.push('╔══════════════════════════════════════════════════════════════════════════════╗');
    result.push('║              SOLANA ARBITRAGE BOT - HUMAN READABLE REPORT                    ║');
    result.push('╚══════════════════════════════════════════════════════════════════════════════╝');
    result.push('');
    result.push(`📊 Summary: ${triangles.length} triangles simulated, ${triangles.filter(t => t.profitBps > 0).length} profitable`);
    result.push(`📁 Source: ${path.basename(csvFile)}`);
    result.push('');

    // Top performers
    const sorted = [...triangles].sort((a, b) => b.profitBps - a.profitBps);
    const profitable = sorted.filter(t => t.profitBps > 0);
    
    if (profitable.length > 0) {
        result.push('═══════════════════════════════════════════════════════════════════════════════');
        result.push('💰 PROFITABLE ROUTES (Ranked by Profit)');
        result.push('═══════════════════════════════════════════════════════════════════════════════');
        result.push('');

        profitable.forEach((t, i) => {
            result.push(`${getEmoji(t.profitBps)} #${t.index}: ${t.path}`);
            result.push(`   Input: ${formatSol(t.inputRaw)} SOL → Output: ${formatSol(t.outputRaw)} SOL`);
            result.push(`   Profit: ${formatProfit(t.profitBps)} (${formatSol(t.profitRaw)} SOL)`);
            result.push('');
        });
    }

    // Worst performers
    const worst = sorted.slice(-5).reverse();
    result.push('═══════════════════════════════════════════════════════════════════════════════');
    result.push('🔴 WORST PERFORMERS (Highest Losses)');
    result.push('═══════════════════════════════════════════════════════════════════════════════');
    result.push('');

    worst.forEach(t => {
        result.push(`${getEmoji(t.profitBps)} #${t.index}: ${t.path}`);
        result.push(`   Input: ${formatSol(t.inputRaw)} SOL → Output: ${formatSol(t.outputRaw)} SOL`);
        result.push(`   Loss: ${formatProfit(t.profitBps)} (${formatSol(t.profitRaw)} SOL)`);
        result.push('');
    });

    // All routes table
    result.push('═══════════════════════════════════════════════════════════════════════════════');
    result.push('📋 ALL ROUTES (Sorted by Profit)');
    result.push('═══════════════════════════════════════════════════════════════════════════════');
    result.push('');
    result.push('Rank │ Route                    │ Input      │ Output     │ Profit     │ Status');
    result.push('─────┼──────────────────────────┼────────────┼────────────┼────────────┼────────');

    sorted.forEach((t, i) => {
        const rank = (i + 1).toString().padStart(3);
        const route = t.path.substring(0, 24).padEnd(24);
        const input = formatSol(t.inputRaw).substring(0, 10).padStart(10);
        const output = formatSol(t.outputRaw).substring(0, 10).padStart(10);
        const profit = formatProfit(t.profitBps).padStart(10);
        const status = t.profitBps > 0 ? '✅ PROFIT' : '❌ LOSS';
        result.push(`${rank} │ ${route} │ ${input} │ ${output} │ ${profit} │ ${status}`);
    });

    result.push('');

    // Detailed swaps for top 3
    result.push('═══════════════════════════════════════════════════════════════════════════════');
    result.push('🔍 DETAILED SWAP ANALYSIS (Top 3 by Profit)');
    result.push('═══════════════════════════════════════════════════════════════════════════════');
    result.push('');

    sorted.slice(0, 3).forEach(t => {
        const tSwaps = swaps.filter(s => s.triangleIndex === t.index);
        result.push(`\n${getEmoji(t.profitBps)} Triangle #${t.index}: ${t.path}`);
        result.push(`   Net Result: ${formatProfit(t.profitBps)} (${formatSol(t.profitRaw)} SOL)`);
        result.push('');
        
        tSwaps.forEach(s => {
            result.push(`   Leg ${s.leg}: ${s.poolType} (${s.poolDex})`);
            result.push(`     Pool: ${s.pool.substring(0, 20)}...`);
            result.push(`     ${formatSol(s.amountInRaw)} → ${formatSol(s.amountOutRaw)}`);
            result.push(`     Fee: ${s.feeBps} bps | Impact: ${s.impactBps} bps | Slippage: ${s.slippageBps} bps`);
            result.push('');
        });
    });

    result.push('═══════════════════════════════════════════════════════════════════════════════');
    result.push('📊 STATISTICS');
    result.push('═══════════════════════════════════════════════════════════════════════════════');
    result.push('');
    
    const profits = triangles.map(t => t.profitBps);
    const avgProfit = (profits.reduce((a, b) => a + b, 0) / profits.length).toFixed(2);
    const best = Math.max(...profits);
    const worstBps = Math.min(...profits);
    
    result.push(`   Total Triangles:    ${triangles.length}`);
    result.push(`   Profitable:         ${triangles.filter(t => t.profitBps > 0).length} (${((triangles.filter(t => t.profitBps > 0).length / triangles.length) * 100).toFixed(1)}%)`);
    result.push(`   Average Profit:     ${avgProfit} bps`);
    result.push(`   Best Route:         +${best} bps`);
    result.push(`   Worst Route:        ${worstBps} bps`);
    result.push(`   Break-even Routes:  ${triangles.filter(t => t.profitBps === 0).length}`);
    result.push('');
    result.push('═══════════════════════════════════════════════════════════════════════════════');

    return result.join('\n');
}

// Main
const csvFile = process.argv[2];
if (!csvFile) {
    console.log('Usage: node convert-csv.js <csv-file>');
    console.log('Example: node convert-csv.js results/arbitrage_results_2026-02-22T08-20-56-675Z.csv');
    process.exit(1);
}

if (!fs.existsSync(csvFile)) {
    console.error(`File not found: ${csvFile}`);
    process.exit(1);
}

const readable = convertToReadable(csvFile);
console.log(readable);

// Also save to file
const outputFile = csvFile.replace('.csv', '_readable.txt');
fs.writeFileSync(outputFile, readable);
console.log(`\n✅ Saved to: ${outputFile}`);
