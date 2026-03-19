const express = require('express');
const cors = require('cors');
const app = express();

// Enable CORS so your Wix site is allowed to talk to this server
app.use(cors());

// Variables to hold our saved data
let cachedHistory = [];
let cachedLivePrice = { price: 0, change: 0 };

// 1. Function to fetch Historical Data
// We stick to CryptoCompare for history because it's the only reliable free API 
// that goes all the way back to 2013 for OHLC data. We added a delay to avoid rate limits.
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
                
                // Clean the data to fix wick anomalies
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
            console.error("History fetch error, retrying next cycle:", e);
            reachedEnd = true;
        }
        // Increased pause to 1.5 seconds to bypass strict API rate limits
        await new Promise(r => setTimeout(r, 1500)); 
    }

    if (allData.length > 0) {
        const uniqueMap = new Map();
        allData.forEach(d => uniqueMap.set(d.time, d));
        cachedHistory = Array.from(uniqueMap.values()).sort((a, b) => a.time - b.time);
        console.log(`Historical Data Cached! Loaded ${cachedHistory.length} days of data.`);
    }
}

// 2. Function to fetch Live Price
// Removed Binance (blocks US IPs). Replaced with CoinCap, Kraken, and KuCoin.
async function fetchLive() {
    const endpoints = [
        { 
            // Primary: CoinCap
            url: 'https://api.coincap.io/v2/assets/bitcoin', 
            parser: async (res) => {
                const json = await res.json();
                return { price: parseFloat(json.data.priceUsd), change: parseFloat(json.data.changePercent24Hr) };
            }
        },
        { 
            // Secondary: Kraken
            url: 'https://api.kraken.com/0/public/Ticker?pair=XBTUSD', 
            parser: async (res) => {
                const json = await res.json();
                const pair = json.result.XXBTZUSD;
                const currentPrice = parseFloat(pair.c[0]);
                const openPrice = parseFloat(pair.o);
                const change = ((currentPrice - openPrice) / openPrice) * 100;
                return { price: currentPrice, change: change };
            }
        },
        { 
            // Tertiary: KuCoin
            url: 'https://api.kucoin.com/api/v1/market/stats?symbol=BTC-USDT', 
            parser: async (res) => {
                const json = await res.json();
                return { price: parseFloat(json.data.last), change: parseFloat(json.data.changeRate) * 100 };
            }
        }
    ];

    for (const endpoint of endpoints) {
        try {
            // Added a 4-second timeout so a hanging API doesn't freeze your backend
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 4000);
            
            const res = await fetch(endpoint.url, { signal: controller.signal });
            clearTimeout(timeoutId);

            if (!res.ok) continue;
            
            const data = await endpoint.parser(res);
            if (data && data.price > 0) {
                cachedLivePrice = data;
                return; // Success, exit the loop
            }
        } catch (e) {
            console.log(`Live API fallback triggered... moving to next source.`);
        }
    }
}

// 3. Initialize & Set Timers
fetchHistory();
fetchLive();

// Daily historical data only changes once a day. Updating it every 12 hours saves API limits.
setInterval(fetchHistory, 43200000);

// The live price updates every 10 seconds so the frontend stays real-time
setInterval(fetchLive, 1000000);

// 4. Create the API endpoints for your Wix site to call
app.get('/api/history', (req, res) => {
    if (cachedHistory.length === 0) {
        return res.status(503).json({ error: "Historical data is still building cache, try again in a few seconds." });
    }
    res.json(cachedHistory);
});

app.get('/api/live', (req, res) => {
    res.json(cachedLivePrice);
});

// Start the server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Pulse Backend running on port ${PORT}`);
});
