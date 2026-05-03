// ========================================================
// PULSE LABS WEB WORKER (BACKGROUND THREAD)
// ========================================================

// --- MATH HELPERS ---
function calculateRSI(data, period = 14) {
    let rsiData = [];
    if (!data || data.length <= period) return [];
    let gains = 0, losses = 0;
    
    for (let i = 1; i <= period; i++) {
        let change = data[i].y[3] - data[i-1].y[3];
        if (change > 0) gains += change;
        else losses += Math.abs(change);
    }

    let avgGain = gains / period;
    let avgLoss = losses / period;
    let rs = avgLoss === 0 ? 0 : avgGain / avgLoss;
    let rsi = 50; 
    if (avgLoss === 0 && avgGain > 0) rsi = 100;
    else if (avgLoss > 0) rsi = 100 - (100 / (1 + rs));

    rsiData.push({ x: data[period].x, y: rsi });
    for (let i = period + 1; i < data.length; i++) {
        let change = data[i].y[3] - data[i-1].y[3];
        let gain = change > 0 ? change : 0;
        let loss = change < 0 ? Math.abs(change) : 0;
        avgGain = (avgGain * (period - 1) + gain) / period;
        avgLoss = (avgLoss * (period - 1) + loss) / period;
        if (avgLoss === 0 && avgGain === 0) rsi = 50;
        else if (avgLoss === 0) rsi = 100;
        else {
            rs = avgGain / avgLoss;
            rsi = 100 - (100 / (1 + rs));
        }
        if (isNaN(rsi)) rsi = 50;
        rsiData.push({ x: data[i].x, y: rsi });
    }
    return rsiData;
}

function calculateEMA(data, period) {
    const k = 2 / (period + 1);
    let emaArray = [data[0]];
    for (let i = 1; i < data.length; i++) {
        emaArray.push(data[i] * k + emaArray[i - 1] * (1 - k));
    }
    return emaArray;
}

function calculateMACD(data) {
    const closePrices = data.map(d => d.y[3]); 
    const dates = data.map(d => d.x);
    const ema12 = calculateEMA(closePrices, 12);
    const ema26 = calculateEMA(closePrices, 26);
    const macdLine = [];
    const signalLine = [];
    const histSeries = [];
    const macdSeries = [];
    const signalSeries = [];

    for (let i = 0; i < closePrices.length; i++) {
        const val = ema12[i] - ema26[i];
        macdLine.push(val);
        macdSeries.push({ x: dates[i], y: val });
    }
    const signalRaw = calculateEMA(macdLine, 9);
    for (let i = 0; i < closePrices.length; i++) {
        signalSeries.push({ x: dates[i], y: signalRaw[i] });
        const histVal = macdLine[i] - signalRaw[i];
        const prevHist = i > 0 ? (macdLine[i-1] - signalRaw[i-1]) : 0;
        let barColor;
        if (histVal >= 0) barColor = histVal >= prevHist ? '#26a69a' : 'rgba(38, 166, 154, 0.4)';
        else barColor = histVal < prevHist ? '#f23645' : 'rgba(242, 54, 69, 0.4)';
        histSeries.push({ x: dates[i], y: histVal, fillColor: barColor });
    }
    return { macd: macdSeries, signal: signalSeries, histogram: histSeries };
}

// --- THE LISTENER ---
self.addEventListener('message', function(e) {
    const { action, payload } = e.data;

    if (action === 'PROCESS_TIMEFRAME') {
        const sortedBtcData = payload.sortedBtcData;
        
        // 1. Run the heavy math
        const newRsi = calculateRSI(sortedBtcData);
        // We aren't fully wiring up MACD yet, but we'll calculate it to show how the worker handles multi-tasking
        const newMacd = calculateMACD(sortedBtcData); 
        
        // 2. Send it back to the main file
        self.postMessage({
            action: 'TIMEFRAME_COMPLETE',
            result: {
                rsiSeries: newRsi
            }
        });
    }
});
