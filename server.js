const express = require('express');
const cors = require('cors');
const fs = require('fs'); // <--- Required to read our local 2010-2014 data file
const app = express();
 
// Enable CORS so your Wix site is allowed to talk to this server
app.use(cors());

// ==========================================
// SECURITY: THE SECRET HANDSHAKE
// ==========================================
// This bounces any hacker trying to drain your Railway server
app.use((req, res, next) => {
    const clientKey = req.headers['x-terminal-key'];
    // You must update your Wix fetch calls to send this exact password!
    if (clientKey !== 'PULSE_LABS_SECURE_KEY_998877') {
        return res.status(401).json({ error: 'Unauthorized: Handshake Failed' });
    }
    next(); 
});
 
// Variables to hold our saved data
let cachedHistory = [];
let cachedLivePrice = { price: 0, change: 0 };
let cachedWatchlist = [];
 
// ==========================================
// 1. FETCH HISTORICAL DATA (The "Mother Option" Stitch)
// ==========================================
async function fetchHistory() {
   console.log("Fetching Historical Data...");
   try {
       // A. Load the immutable 2010 - Sept 2014 history from your local file
       let earlyData = [];
       try {
           const fileData = fs.readFileSync('./early-btc.json', 'utf8');
           earlyData = JSON.parse(fileData);
       } catch (err) {
           console.log("Warning: early-btc.json file not found, defaulting to 2014 Yahoo start.");
       }

       // B. Fetch the live Sept 2014 - Present data from Yahoo Finance
       const url = 'https://query1.finance.yahoo.com/v8/finance/chart/BTC-USD?interval=1d&range=max';
       const res = await fetch(url);
       const json = await res.json();
       
       if (json.chart && json.chart.result && json.chart.result.length > 0) {
           const data = json.chart.result[0];
           const timestamps = data.timestamp;
           const quote = data.indicators.quote[0];
           
           const yahooData = [];
           for (let i = 0; i < timestamps.length; i++) {
               // Yahoo sometimes returns nulls for market glitches; skip those
               if (quote.close[i] !== null) {
                   yahooData.push({
                       time: timestamps[i] * 1000, 
                       open: quote.open[i],
                       high: quote.high[i],
                       low: quote.low[i],
                       close: quote.close[i],
                       volume: quote.volume[i]
                   });
               }
           }
           
           // C. STITCH THEM TOGETHER: Early Data first, then Yahoo Data
           cachedHistory = [...earlyData, ...yahooData];
           console.log(`Historical Data Cached! Loaded ${cachedHistory.length} total days of data.`);
       }
   } catch (e) {
       console.error("History fetch error:", e);
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
// 3. FETCH WATCHLIST (CoinCap)
// ==========================================
async function fetchWatchlist() {
   console.log("Fetching Watchlist...");
   try {
       const res = await fetch('https://api.coincap.io/v2/assets?limit=100');
       const json = await res.json();

       if (json.data) {
           cachedWatchlist = json.data.map(item => {
               return {
                   symbol: item.symbol,
                   price: parseFloat(item.priceUsd) || 0,
                   change: parseFloat(item.changePercent24Hr) || 0,
                   marketCap: parseFloat(item.marketCapUsd) || 0,
                   logo: `https://assets.coincap.io/assets/icons/${item.symbol.toLowerCase()}@2x.png`
               };
           }).filter(c => c.price > 0);
           console.log("Watchlist Cached!");
       }
   } catch(e) {
       console.log("Watchlist API failed.", e);
   }
}
 
// ==========================================
// 4. INITIALIZE & SET TIMERS (Optimized to prevent bans)
// ==========================================
fetchHistory();
fetchLive();
fetchWatchlist();
 
// Live price needs to be fast, history only needs to run once a day
setInterval(fetchLive, 60000);           // Live Ticker: Every 1 Minute
setInterval(fetchWatchlist, 300000);     // Watchlist: Every 5 Minutes
setInterval(fetchHistory, 86400000);     // Chart History: Every 24 Hours
 
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
