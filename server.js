const express = require('express');
const cors = require('cors');
const app = express();

// Enable CORS so your Wix site is allowed to talk to this server
app.use(cors());

// Variables to hold our saved data
let cachedHistory = [];
let cachedLivePrice = { price: 0, change: 0 };

// 1. Function to fetch Historical Data
async function fetchHistory() {
    console.log("Fetching Historical Data...");
    let allData = [];
    let currentToTs = Math.floor(Date.now() / 1000);
    const targetStartTs = Math.floor(new Date('2013-01-01').getTime() / 1000);
    let reachedEnd = false;

    while (!reachedEnd) {
        const url = `https://min-api.cryptocompare.com/data/v2/histoday?fsym=BTC&tsym=USD&limit=2000&toTs=${currentToTs}`;
        try {
            const res = await fetch(url);
            const json = await res.json();

            if (json.Response === 'Success' && json.Data && json.Data.Data.length > 0) {
                const candles = json.Data.Data;
                
                // Clean the data exactly like your frontend did
                const cleaned = candles.map(c => {
                    let safeLow = c.low;
                    let safeHigh = c.high;
                    if (c.close > 10 && safeLow < c.close * 0.2) safeLow = c.open > c.close ? c.close * 0.9 : c.open * 0.9;
                    if (c.close > 10 && safeHigh > c.close * 3) safeHigh = c.open > c.close ? c.open * 1.1 : c.close * 1.1;
                    return { time: c.time * 1000, open: c.open, high: safeHigh, low: safeLow, close: c.close, volume: c.volumeto };
                });

                allData.push(...cleaned);
                const earliestInBatch = candles[0].time;

                if (earliestInBatch <= targetStartTs || candles.length < 2000) {
                    reachedEnd = true;
                } else {
                    currentToTs = earliestInBatch - 86400;
                }
            } else {
                reachedEnd = true;
            }
        } catch (e) {
            console.error("History fetch error:", e);
            reachedEnd = true;
        }
        // Small pause to be nice to the API
        await new Promise(r => setTimeout(r, 200)); 
    }

    // Sort and save to cache
    const uniqueMap = new Map();
    allData.forEach(d => uniqueMap.set(d.time, d));
    cachedHistory = Array.from(uniqueMap.values()).sort((a, b) => a.time - b.time);
    console.log("Historical Data Cached!");
}

// 2. Function to fetch Live Price
async function fetchLive() {
    console.log("Fetching Live Price...");
    const endpoints = [
        { url: 'https://api.binance.com/api/v3/ticker/24hr?symbol=BTCUSDT', parser: d => ({ price: parseFloat(d.lastPrice), change: parseFloat(d.priceChangePercent) }) },
        { url: 'https://api.coincap.io/v2/assets/bitcoin', parser: d => ({ price: parseFloat(d.data.priceUsd), change: parseFloat(d.data.changePercent24Hr) }) },
        { url: 'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd&include_24hr_change=true', parser: d => ({ price: d.bitcoin.usd, change: d.bitcoin.usd_24h_change }) }
    ];

    for (const endpoint of endpoints) {
        try {
            const res = await fetch(endpoint.url);
            if (!res.ok) continue;
            const data = await res.json();
            cachedLivePrice = endpoint.parser(data);
            console.log("Live Price Cached:", cachedLivePrice.price);
            return; // Success, exit the loop
        } catch (e) {
            console.log("Endpoint failed, trying next...");
        }
    }
}

// 3. Run fetches immediately, then set interval for every 30 minutes (1800000 milliseconds)
fetchHistory();
fetchLive();
setInterval(fetchHistory, 1800000);
setInterval(fetchLive, 1800000);

// 4. Create the API endpoints for your Wix site to call
app.get('/api/history', (req, res) => {
    res.json(cachedHistory);
});

app.get('/api/live', (req, res) => {
    res.json(cachedLivePrice);
});

// Start the server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
