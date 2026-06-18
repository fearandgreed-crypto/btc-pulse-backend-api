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
// 1. FETCH HISTORICAL DATA (Binance API)
// ==========================================
async function fetchHistory() {
    console.log("Fetching Historical Data from Binance...");
    let allData = [];
    
    // Binance uses milliseconds for its timestamps
    let currentEndTime = Date.now();
    const targetStartTs = new Date('2013-01-01').getTime();
    let reachedEnd = false;

    while (!reachedEnd) {
        // New API Address: Binance klines
        const url = `https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1d&limit=1000&endTime=${currentEndTime}`;
        
        try {
            const res = await fetch(url);
            const candles = await res.json();

            if (Array.isArray(candles) && candles.length > 0) {
                const cleaned = candles.map(c => {
                    // Binance returns an array: [time, open, high, low, close, volume, ...]
                    let time = c[0]; 
                    let open = parseFloat(c[1]);
                    let high = parseFloat(c[2]);
                    let low = parseFloat(c[3]);
                    let close = parseFloat(c[4]);
                    let volume = parseFloat(c[5]);

                    let safeLow = low;
                    let safeHigh = high;
                    
                    // Your existing spike/flash-crash protection logic
                    if (close > 10 && safeLow < close * 0.2) safeLow = open > close ? close * 0.9 : open * 0.9;
                    if (close > 10 && safeHigh > close * 3) safeHigh = open > close ? open * 1.1 : close * 1.1;

                    return { time, open, high: safeHigh, low: safeLow, close, volume };
                });

                allData.push(...cleaned);
                
                // The earliest candle in this batch (index 0)
                const earliestInBatch = candles[0][0];

                if (earliestInBatch <= targetStartTs || candles.length < 1000) {
                    reachedEnd = true;
                } else {
                    // Step back 1 millisecond from the earliest candle for the next batch
                    currentEndTime = earliestInBatch - 1; 
                }
            } else {
                reachedEnd = true;
            }
        } catch (e) {
            console.error("History fetch error:", e);
            reachedEnd = true;
        }
        
        // Wait 500ms between requests to avoid rate limits
        await new Promise(r => setTimeout(r, 500)); 
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
// 3. FETCH WATCHLIST (CryptoCompare)
// ==========================================
async function fetchWatchlist() {
    console.log("Fetching Watchlist...");
    try {
        // THE FIX: Pull 100 coins so we have plenty left over after filtering
        const res = await fetch('https://min-api.cryptocompare.com/data/top/mktcapfull?limit=100&tsym=USD');
        const json = await res.json();

        if (json.Data) {
            cachedWatchlist = json.Data.map(item => {
                return {
                    symbol: item.CoinInfo?.Name || "UNK",
                    price: item.RAW?.USD?.PRICE || 0,
                    change: item.RAW?.USD?.CHANGEPCT24HOUR || 0,
                    marketCap: item.RAW?.USD?.MKTCAP || 0,
                    logo: item.CoinInfo?.ImageUrl ? `https://www.cryptocompare.com${item.CoinInfo.ImageUrl}` : ''
                };
            }).filter(c => c.price > 0);
            console.log("Watchlist Cached!");
        }
    } catch(e) {
        console.log("Watchlist API failed.");
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
