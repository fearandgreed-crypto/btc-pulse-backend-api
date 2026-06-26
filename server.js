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
// 0. LOAD PRE-2013 DATA FROM CSV (CONVERTED TO WEEKLY)
// ==========================================
function loadEarlyData() {
    console.log("Loading and converting early historical CSV to WEEKLY candles...");
    const weeklyMap = {};
    try {
        const csv = fs.readFileSync('./data set 2013-03-31.csv', 'utf8');
        const lines = csv.split('\n').slice(1); 
        
        const cutoffDate = new Date('2013-04-01T00:00:00Z').getTime();
        
        for (let line of lines) {
            const cleanLine = line.replace('\r', '').trim();
            
            if (!cleanLine || cleanLine.startsWith(',,,')) continue; 
            
            const [startStr, endStr, open, high, low, close, volume] = cleanLine.split(',');
            if (!startStr) continue;
            
            // Parse "M/D/YYYY" into strict UTC midnight
            const [month, day, year] = startStr.split('/');
            const rowTime = Date.UTC(parseInt(year), parseInt(month) - 1, parseInt(day));
            
            if (isNaN(rowTime) || rowTime >= cutoffDate) continue;

            // Find the exact Monday of this week to align with Bitfinex 1W candles
            const dateObj = new Date(rowTime);
            const dayOfWeek = dateObj.getUTCDay(); // 0 = Sunday, 1 = Monday...
            const daysToSubtract = dayOfWeek === 0 ? 6 : dayOfWeek - 1; // Shift to Monday
            const mondayTime = rowTime - (daysToSubtract * 24 * 60 * 60 * 1000);
            
            const o = parseFloat(open);
            const h = parseFloat(high);
            const l = parseFloat(low);
            const c = parseFloat(close);
            let v = parseFloat(volume);
            if (isNaN(v) || v <= 0) v = 0.01; 
            
            if (!isNaN(o) && !isNaN(c)) {
                if (!weeklyMap[mondayTime]) {
                    // Start a new week
                    weeklyMap[mondayTime] = {
                        time: mondayTime,
                        open: o, 
                        high: h,
                        low: l,
                        close: c, 
                        volume: v,
                        minDayTime: rowTime, // To track the first day of the week
                        maxDayTime: rowTime  // To track the last day of the week
                    };
                } else {
                    // Update existing week with daily data
                    const week = weeklyMap[mondayTime];
                    week.high = Math.max(week.high, h); // Highest high of the week
                    week.low = Math.min(week.low, l);   // Lowest low of the week
                    week.volume += v;                   // Add up total volume
                    
                    // If this row is earlier in the week, it becomes the Open price
                    if (rowTime < week.minDayTime) {
                        week.minDayTime = rowTime;
                        week.open = o;
                    }
                    // If this row is later in the week, it becomes the Close price
                    if (rowTime > week.maxDayTime) {
                        week.maxDayTime = rowTime;
                        week.close = c;
                    }
                }
            }
        }
        
        // Convert map back to an array, clean up temp variables, and sort chronologically
        const earlyData = Object.values(weeklyMap)
            .map(w => ({
                time: w.time,
                open: w.open,
                high: w.high,
                low: w.low,
                close: w.close,
                volume: w.volume
            }))
            .sort((a, b) => a.time - b.time);
            
        console.log(`✅ Successfully loaded ${earlyData.length} WEEKS of early history.`);
        return earlyData;
    } catch (e) {
        console.error("❌ CSV Error:", e.message);
        return []; 
    }
}

// Store it in memory once on server startup
const manualEarlyData = loadEarlyData();
// Store it in memory once on server startup
const manualEarlyData = loadEarlyData();

// ==========================================
// 1. FETCH HISTORICAL DATA (Bitfinex + CSV Stitching)
// ==========================================
async function fetchHistory() {
   console.log("Fetching Historical Data...");
   try {
      const url = 'https://api-pub.bitfinex.com/v2/candles/trade:1W:tBTCUSD/hist?limit=10000&sort=1';
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
           // STITCHING EARLY DATA WITH LIVE BITFINEX DATA
           // ==========================================
           const combinedData = [...manualEarlyData, ...bitfinexData];
           combinedData.sort((a, b) => a.time - b.time);
           cachedHistory = combinedData;

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
   // Force the browser/Wix to never cache this request
   res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
   res.setHeader('Pragma', 'no-cache');
   res.setHeader('Expires', '0');
   res.setHeader('Surrogate-Control', 'no-store');

   if (cachedHistory.length === 0) return res.status(503).json({ error: "Building cache, try again." });
   res.json(cachedHistory);
});
 
app.get('/api/live', (req, res) => {
   res.json(cachedLivePrice);
});
 
app.get('/api/watchlist', (req, res) => {
   res.json(cachedWatchlist);
});

// ==========================================
// 6. START THE SERVER (This was missing!)
// ==========================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
   console.log(`Pulse Backend running on port ${PORT}`);
});
