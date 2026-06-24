const express = require('express');
const cors = require('cors');
const fs = require('fs'); // Built-in Node module for reading files
const app = express();
 
// Enable CORS so your Wix site is allowed to talk to this server
app.use(cors());
 
// Variables to hold our saved data
let cachedHistory = [];
let cachedLivePrice = { price: 0, change: 0 };
let cachedWatchlist = [];
 
// ==========================================
// 0. LOAD PRE-2013 DATA FROM CSV (Mt. Gox Era)
// ==========================================
function loadEarlyData() {
    console.log("Loading early historical data from CSV...");
    const earlyData = [];
    try {
        // Read the CSV file from your local folder
        const csv = fs.readFileSync('./early_btc.csv', 'utf8');
        
        // Split the file into rows and skip the first row (the header)
        const lines = csv.split('\n').slice(1); 
        
        // Bitfinex data starts April 1, 2013. We ignore any CSV rows after March 31, 2013.
        const cutoffDate = new Date('2013-04-01').getTime();
        
        for (let line of lines) {
            if (!line.trim()) continue; // Skip empty lines
            
            const [startStr, endStr, open, high, low, close, volume] = line.split(',');
            const rowTime = new Date(startStr).getTime();
            
            // Automatically ignore CSV data that overlaps with Bitfinex
            if (rowTime >= cutoffDate) continue;
            
            earlyData.push({
                time: rowTime, 
                open: parseFloat(open),
                high: parseFloat(high),
                low: parseFloat(low),
                close: parseFloat(close),
                volume: parseFloat(volume) || 0
            });
        }
        console.log(`Successfully loaded ${earlyData.length} days of early history.`);
        return earlyData;
    } catch (e) {
        console.error("Could not find or parse CSV! Ensure it is in the same folder.", e.message);
        return []; 
    }
}

// Store it in memory once on server startup
const manualEarlyData = loadEarlyData();

// ==========================================
// 1. FETCH HISTORICAL DATA (Bitfinex + CSV Stitching)
// ==========================================
async function fetchHistory() {
   console.log("Fetching Historical Data...");
   try {
       const url = 'https://api-pub.bitfinex.com/v2/candles/trade:1D:tBTCUSD/hist?limit=10000&sort=1';
       const res = await fetch(url);
       const json = await res.json();
       
       if (Array.isArray(json) && json.length > 0) {
           const bitfinexData = json.map(candle => {
               return {
                   time: candle[0],     // MTS
                   open: candle[1],
                   high: candle[3],
                   low: candle[4],
                   close: candle[2],
                   volume: candle[5]
               };
           });
           
          // ==========================================
           // 👉 PLACE THE 3 LINES RIGHT HERE 👈
           // ==========================================
           const combinedData = [...manualEarlyData, ...bitfinexData];
           combinedData.sort((a, b) => a.time - b.time);
           cachedHistory = combinedData;
           // ==========================================

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
// 3. FETCH WATCHLIST (CoinCap - Free, No API Key needed)
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
// 4. INITIALIZE & CLOCK-SYNCHRONIZED TIMERS
// ==========================================
// Run immediately on startup
fetchHistory();
fetchLive();
fetchWatchlist();
 
// Dynamically synchronizes intervals with the real-world clock
function scheduleClockSyncUpdates() {
   const now = new Date();
   
   // Determine exactly how many milliseconds have elapsed during the current hour
   const msPastHour = (now.getMinutes() * 60 * 1000) + (now.getSeconds() * 1000) + now.getMilliseconds();
   const tenMinutesMs = 10 * 60 * 1000;
   
   // Compute time remaining until the clock hits the next 10-minute marker (:00, :10, :20, etc.)
   const msToNextTick = tenMinutesMs - (msPastHour % tenMinutesMs);
   
   setTimeout(() => {
       console.log(`--- Executing Clock-Aligned Sync at ${new Date().toLocaleTimeString()} ---`);
       
       fetchLive();
       setTimeout(fetchWatchlist, 1000);     // Fires 1 second later
       setTimeout(fetchHistory, 5000);       // Fires 5 seconds later
       
       // Re-run setup for the next interval
       scheduleClockSyncUpdates();
   }, msToNextTick);
}

// Kick off the wall-clock schedule loop
scheduleClockSyncUpdates();
 
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
