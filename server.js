const express = require('express');
const cors = require('cors');
const app = express();

// Enable CORS so your Wix site is allowed to talk to this server
app.use(cors());

// Variables to hold our saved data
let cachedHistory = [];
let cachedLivePrice = { price: 0, change: 0 };
let cachedWatchlist = [];

// ==========================================
// 1. FETCH HISTORICAL DATA (CryptoCompare)
// ==========================================
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
        await new Promise(r => setTimeout(r, 1500)); 
    }

    if (allData.length > 0) {
        const uniqueMap = new Map();
        allData.forEach(d => uniqueMap.set(d.time, d));
        cachedHistory = Array.from(uniqueMap.values()).sort((a, b) => a.time - b.time);
        console.log(`Historical Data Cached! Loaded ${cachedHistory.length} days of data.`);
    }
}

// ==========================================
// 2. FETCH LIVE PRICE (CoinCap, Kraken, KuCoin)
// ==========================================
async function fetchLive() {
    console.log("Fetching Live Price...");
    const endpoints = [
        { url: 'https://api.coincap.io/v2/assets/bitcoin', parser: async (res) => { const json = await res.json(); return { price: parseFloat(json.data.priceUsd), change: parseFloat(json.data.changePercent24Hr) }; } },
        { url: 'https://api.kraken.com/0/public/Ticker?pair=XBTUSD', parser: async (res) => { const json = await res.json(); const pair = json.result.XXBTZUSD; const currentPrice = parseFloat(pair.c[0]); const openPrice = parseFloat(pair.o); return { price: currentPrice, change: ((currentPrice - openPrice) / openPrice) * 100 }; } },
        { url: 'https://api.kucoin.com/api/v1/market/stats?symbol=BTC-USDT', parser: async (res) => { const json = await res.json(); return { price: parseFloat(json.data.last), change: parseFloat(json.data.changeRate) * 100 }; } }
    ];

    for (const endpoint of endpoints) {
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 4000);
            const res = await fetch(endpoint.url, { signal: controller.signal });
            clearTimeout(timeoutId);

            if (!res.ok) continue;
            
            const data = await endpoint.parser(res);
            if (data && data.price > 0) {
                cachedLivePrice = data;
                console.log("Live Price Cached:", cachedLivePrice.price);
                return;
            }
        } catch (e) {
            console.log(`Live API fallback triggered...`);
        }
    }
}



// ==========================================
// 4. INITIALIZE & SET TIMERS (10 Minutes)
// ==========================================
fetchHistory();
fetchLive();
fetchWatchlist();

// Staggered 10-minute loops to prevent CPU spikes
setInterval(fetchLive, 600000);          // Fires exactly at 10m
setInterval(fetchWatchlist, 601000);     // Fires 1 second later
setInterval(fetchHistory, 605000);       // Fires 5 seconds later

// ==========================================
// 5. API ENDPOINTS FOR FRONTEND
// ==========================================
app.get('/api/history', (req, res) => {
    if (cachedHistory.length === 0) return res.status(503).json({ error: "Building cache, try again." });
    res.json(cachedHistory);
});

app.get('/api/live', (req, res) => {
    res.json(cachedLivePrice);
});

app.get('/api/watchlist', (req, res) => {
    res.json(cachedWatchlist);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Pulse Backend running on port ${PORT}`);
});
