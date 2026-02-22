const fs = require('fs');
const path = require('path');

/**
 * Export arbitrage results to multiple formats
 */
function exportResults(simulationResults, options = {}) {
    const {
        outputDir = './results',
        csv = true,
        csvRawOnly = false,
        json = true,
        xlsx = true,
        filenamePrefix = 'arbitrage_results'
    } = options;

    const exportedFiles = {};
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');

    // Ensure output directory exists
    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
    }

    const triangles = simulationResults.triangles || [];

    // Export JSON
    if (json) {
        const jsonPath = path.join(outputDir, `${filenamePrefix}_${timestamp}.json`);
        const exportData = {
            metadata: {
                exportVersion: '1.0.0',
                generatedAt: new Date().toISOString(),
                totalSimulated: triangles.length,
                profitable: triangles.filter(t => t.profitBps > 0).length
            },
            results: triangles
        };
        fs.writeFileSync(jsonPath, JSON.stringify(exportData, (key, value) => {
            if (typeof value === 'bigint') return value.toString();
            return value;
        }, 2));
        exportedFiles.json = jsonPath;
    }

    // Export CSV
    if (csv) {
        const csvPath = path.join(outputDir, `${filenamePrefix}_${timestamp}.csv`);
        const csvContent = formatResultsAsCSV(triangles, csvRawOnly);
        fs.writeFileSync(csvPath, csvContent);
        exportedFiles.csv = csvPath;
    }

    // Export XLSX (as CSV with .xlsx extension for now - Excel can open it)
    if (xlsx) {
        const xlsxPath = path.join(outputDir, `${filenamePrefix}_${timestamp}.xlsx`);
        const csvContent = formatResultsAsCSV(triangles, false);
        fs.writeFileSync(xlsxPath, csvContent);
        exportedFiles.xlsx = xlsxPath;
        
        // Copy to Dashboard for real-time display
        try {
            const dashboardDir = './Dashboard';
            if (!fs.existsSync(dashboardDir)) {
                fs.mkdirSync(dashboardDir, { recursive: true });
            }
            // Copy XLSX with fixed name for dashboard
            fs.copyFileSync(xlsxPath, path.join(dashboardDir, 'arbitrage_analysis.xlsx'));
            // Also create a JSON copy for the dashboard (matching dashboard expected format)
            const profitableRoutes = triangles.filter(t => t.profitBps > 0);
            const bestRoute = triangles.length > 0 ? triangles.reduce((best, t) => t.profitBps > best.profitBps ? t : best, triangles[0]) : null;
            
            const dashboardData = {
                timestamp: new Date().toISOString(),
                totalRoutes: triangles.length,
                profitableRoutes: profitableRoutes.length,
                bestProfitBps: bestRoute ? bestRoute.profitBps : 0,
                bestProfitSol: bestRoute ? Number(bestRoute.profit || 0) / 1e9 : 0,
                inputSol: 1,
                bestRoutes: triangles.map((t, i) => ({
                    rank: i + 1,
                    path: t.path ? t.path.join(' → ') : (t.tokens ? t.tokens.join(' → ') : 'Unknown'),
                    feasible: t.isProfitable || t.feasible || false,
                    netProfitBps: t.profitBps || 0,
                    inputLamports: Number(t.inputAmount || t.inputAmountRaw || 1e9),
                    outputLamports: Number(t.totalOutput || t.totalOutputRaw || 0),
                    totalCostBps: (t.totalFeesBps || 0) + (t.totalImpactBps || 0) + (t.totalSlippageBps || 0),
                    slippageWarning: t.slippageWarning || { level: 'LOW', emoji: '🟢' },
                    legs: (t.swaps || []).map((s, idx) => ({
                        leg: s.leg || idx + 1,
                        from: s.from || 'Unknown',
                        to: s.to || 'Unknown',
                        pool: s.pool || '',
                        dex: s.poolDex || 'unknown',
                        type: s.poolType || 'unknown',
                        direction: s.dir || 'A2B',
                        inAmount: Number(s.amountIn || s.amountInRaw || 0),
                        outAmount: Number(s.amountOut || s.amountOutRaw || 0),
                        feeBps: s.feeBps || 0,
                        slippageBps: s.slippageBps || 0
                    }))
                }))
            };
            fs.writeFileSync(path.join(dashboardDir, 'dashboard_data.json'), JSON.stringify(dashboardData, (key, value) => {
                if (typeof value === 'bigint') return value.toString();
                return value;
            }, 2));
            exportedFiles.dashboard = './Dashboard/arbitrage_analysis.xlsx';
        } catch (e) {
            console.warn('⚠️  Failed to copy to Dashboard:', e.message);
        }
    }

    return { exportedFiles };
}

/**
 * Format results as CSV
 */
function formatResultsAsCSV(triangles, rawOnly = false) {
    const lines = [];
    
    // Header
    lines.push('# Arbitrage Results Export');
    lines.push(`# Generated: ${new Date().toISOString()}`);
    lines.push(`# Total Simulated: ${triangles.length}`);
    lines.push(`# Profitable: ${triangles.filter(t => t.profitBps > 0).length}`);
    lines.push('');

    // Triangle summary
    lines.push('## Triangle Summary');
    lines.push('Index,Path,Input Amount (Raw),Input Amount (Human),Total Output (Raw),Total Output (Human),Profit (Raw),Profit (Human),Profit (Bps),Profit (%),Is Profitable,Swap Count,Timestamp');
    
    triangles.forEach((t, i) => {
        const path = t.path || (t.tokens ? t.tokens.join(' → ') : 'Unknown');
        lines.push([
            i + 1,
            path,
            t.inputAmountRaw || t.inputAmount || 0,
            t.inputAmountHuman || (t.inputAmount ? Number(t.inputAmount) / 1e9 : 0),
            t.totalOutputRaw || t.totalOutput || 0,
            t.totalOutputHuman || (t.totalOutput ? Number(t.totalOutput) / 1e9 : 0),
            t.profitRaw || t.profit || 0,
            t.profitHuman || (t.profit ? Number(t.profit) / 1e9 : 0),
            t.profitBps || 0,
            ((t.profitBps || 0) / 100).toFixed(2),
            t.isProfitable ? 'Yes' : 'No',
            t.swaps ? t.swaps.length : 0,
            t.timestamp || new Date().toISOString()
        ].join(','));
    });

    if (!rawOnly) {
        lines.push('');
        lines.push('## Detailed Swaps');
        lines.push('Triangle Index,Triangle Path,Leg,Pool,Pool Type,Pool DEX,Amount In (Raw),Amount In (Human),Amount Out (Raw),Amount Out (Human),Fee (Bps),Impact (Bps),Slippage (Bps),Price');
        
        triangles.forEach((t, ti) => {
            const path = t.path || (t.tokens ? t.tokens.join(' → ') : 'Unknown');
            (t.swaps || []).forEach((swap, si) => {
                lines.push([
                    ti + 1,
                    path,
                    si + 1,
                    swap.pool || '',
                    swap.poolType || 'unknown',
                    swap.poolDex || 'unknown',
                    swap.amountInRaw || swap.amountIn || 0,
                    swap.amountInHuman || (swap.amountIn ? Number(swap.amountIn) / 1e9 : 0),
                    swap.amountOutRaw || swap.amountOut || 0,
                    swap.amountOutHuman || (swap.amountOut ? Number(swap.amountOut) / 1e9 : 0),
                    swap.feeBps || 0,
                    swap.impactBps || 0,
                    swap.slippageBps || 0,
                    swap.price || 0
                ].join(','));
            });
        });
    }

    return lines.join('\n');
}

module.exports = {
    exportResults,
    formatResultsAsCSV
};
