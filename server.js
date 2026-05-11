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
// 4. INITIALIZE & CLOCK-SYNCED TIMERS
// ==========================================
fetchHistory();
fetchLive();
fetchWatchlist();

function startClockAlignedInterval() {
    const now = new Date();
    
    // Calculate milliseconds until the next 10-minute boundary (e.g., XX:00, XX:10, XX:20)
    // This guarantees it will fire EXACTLY on the hour (XX:00:00) when the crypto day resets
    const msUntilNext10Min = (10 - (now.getMinutes() % 10)) * 60000 - (now.getSeconds() * 1000) - now.getMilliseconds();
    
    console.log(`⏳ Syncing to real-world clock... First automated loop will fire in ${Math.round(msUntilNext10Min / 1000)} seconds.`);

    setTimeout(() => {
        // 1. Fire immediately at the synchronized time
        fetchLive();
        setTimeout(fetchWatchlist, 1000); // 1 second stagger
        setTimeout(fetchHistory, 5000);   // 5 second stagger

        // 2. Now that we are perfectly synced to the clock, start the permanent 10-minute loop
        setInterval(() => {
            fetchLive();
            setTimeout(fetchWatchlist, 1000);
            setTimeout(fetchHistory, 5000);
        }, 600000); // 600,000 ms = 10 minutes
        
    }, msUntilNext10Min);
}

// Start the synchronized engine
startClockAlignedInterval();
