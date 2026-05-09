import fetch from 'node-fetch';
import * as cheerio from 'cheerio';
import fs from 'fs';
import path from 'path';

// ===== 設定 =====
const CONFIG = {
  MAX_RETRIES: 3,
  RETRY_DELAY: 2000,
  REQUEST_DELAY: 1000,
  BATCH_SIZE: 3,
  MAX_CONCURRENT: 5,
  CACHE_DURATION: 3600000, // 1時間
  USER_AGENT: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  DATA_DIR: 'data',
  SHUTUBA_FILE: 'shutuba.json',
  ODDS_CACHE_FILE: 'odds_cache.json',
  TIMEOUT: 15000
};

const VENUE_MAP = {
  '01': '札幌', '02': '函館', '03': '福島', '04': '新潟',
  '05': '東京', '06': '中山', '07': '中京', '08': '京都',
  '09': '阪神', '10': '小倉'
};

// ===== ユーティリティ =====
const sleep = ms => new Promise(r => setTimeout(r, ms));

class RateLimiter {
  constructor(maxConcurrent, delayMs) {
    this.maxConcurrent = maxConcurrent;
    this.delayMs = delayMs;
    this.running = 0;
    this.queue = [];
  }

  async execute(fn) {
    while (this.running >= this.maxConcurrent) {
      await new Promise(r => this.queue.push(r));
    }
    
    this.running++;
    try {
      const result = await fn();
      await sleep(this.delayMs);
      return result;
    } finally {
      this.running--;
      const next = this.queue.shift();
      if (next) next();
    }
  }
}

const withRetry = async (fn, retries = CONFIG.MAX_RETRIES, context = '') => {
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i === retries - 1) throw e;
      console.warn(`リトライ ${i + 1}/${retries} [${context}]: ${e.message}`);
      await sleep(CONFIG.RETRY_DELAY * (i + 1));
    }
  }
};

// ===== 日付ユーティリティ =====
class DateUtils {
  static getThisWeekend() {
    const dates = [];
    const today = new Date();
    const dow = today.getDay();

    // 直近の土曜日を計算
    const sat = new Date(today);
    const daysUntilSat = (6 - dow + 7) % 7;
    sat.setDate(today.getDate() + daysUntilSat);

    // 日曜日
    const sun = new Date(sat);
    sun.setDate(sat.getDate() + 1);

    for (const d of [sat, sun]) {
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, '0');
      const dd = String(d.getDate()).padStart(2, '0');
      dates.push(`${y}${m}${dd}`);
    }
    return dates;
  }

  static formatDate(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}${m}${d}`;
  }
}

// ===== データ管理 =====
class DataManager {
  constructor() {
    this.dataDir = path.resolve(CONFIG.DATA_DIR);
    this.shutubaPath = path.resolve(this.dataDir, CONFIG.SHUTUBA_FILE);
    this.cachePath = path.resolve(this.dataDir, CONFIG.ODDS_CACHE_FILE);
    
    if (!fs.existsSync(this.dataDir)) {
      fs.mkdirSync(this.dataDir, { recursive: true });
    }
  }

  loadShutuba() {
    if (!fs.existsSync(this.shutubaPath)) {
      console.log(`${CONFIG.SHUTUBA_FILE}なし → 新規作成`);
      return [];
    }

    try {
      const data = JSON.parse(fs.readFileSync(this.shutubaPath, 'utf8'));
      console.log(`既存出馬表: ${data.length}件`);
      return data;
    } catch (e) {
      console.error(`データ読み込みエラー: ${e.message}`);
      return [];
    }
  }

  loadOddsCache() {
    if (!fs.existsSync(this.cachePath)) return {};
    
    try {
      const cache = JSON.parse(fs.readFileSync(this.cachePath, 'utf8'));
      // 期限切れのキャッシュを削除
      const now = Date.now();
      for (const [key, value] of Object.entries(cache)) {
        if (now - value.timestamp > CONFIG.CACHE_DURATION) {
          delete cache[key];
        }
      }
      return cache;
    } catch {
      return {};
    }
  }

  saveOddsCache(cache) {
    try {
      fs.writeFileSync(this.cachePath, JSON.stringify(cache, null, 2), 'utf8');
    } catch (e) {
      console.error(`キャッシュ保存エラー: ${e.message}`);
    }
  }

  saveShutuba(races) {
    try {
      fs.writeFileSync(this.shutubaPath, JSON.stringify(races, null, 2), 'utf8');
      return true;
    } catch (e) {
      console.error(`保存エラー: ${e.message}`);
      return false;
    }
  }

  mergeAndSave(existing, newRaces, weekendDates) {
    const thisWeekPrefix = weekendDates[0].slice(0, 6);
    const existingIds = new Set(existing.map(r => r.id));
    
    // 新規レースのみを追加
    const uniqueNewRaces = newRaces.filter(r => !existingIds.has(r.id));
    
    // 今週の既存データを保持
    const filtered = existing.filter(r => r.id.startsWith(thisWeekPrefix));
    
    // マージ
    const all = [...filtered, ...uniqueNewRaces];
    
    this.saveShutuba(all);
    return all;
  }
}

// ===== スクレイピング =====
class RaceScraper {
  constructor(rateLimiter) {
    this.rateLimiter = rateLimiter;
  }

  async fetchRaceIdsByDate(dateStr) {
    return withRetry(async () => {
      const url = `https://race.netkeiba.com/top/race_list_sub.html?kaisai_date=${dateStr}`;
      
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), CONFIG.TIMEOUT);

      try {
        const res = await fetch(url, {
          headers: { 'User-Agent': CONFIG.USER_AGENT },
          signal: controller.signal
        });
        
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }

        const buf = await res.arrayBuffer();
        const html = new TextDecoder('euc-jp').decode(buf);
        const $ = cheerio.load(html);

        const ids = new Set();

        // 複数のパターンでrace_idを抽出
        const patterns = [
          'a[href*="race_id="]',
          'a[href*="/race/"]',
          'a[href*="shutuba.html"]'
        ];

        for (const pattern of patterns) {
          $(pattern).each((_, el) => {
            const href = $(el).attr('href') || '';
            // 修正: 正規表現の重複を削除
            const match = href.match(/(?:race_id=|\/race\/)(\d{12})/);
            if (match) ids.add(match[1]);
          });
        }

        const result = [...ids];
        console.log(`  ${dateStr}: ${result.length}件のレースID`);
        return result;
      } finally {
        clearTimeout(timeoutId);
      }
    }, CONFIG.MAX_RETRIES, `日程取得:${dateStr}`);
  }

  async fetchOddsFromAPI(raceId, oddsCache) {
    // キャッシュチェック
    if (oddsCache[raceId]) {
      const cached = oddsCache[raceId];
      if (Date.now() - cached.timestamp < CONFIG.CACHE_DURATION) {
        return cached.data;
      }
    }

    const urls = [
      `https://race.netkeiba.com/api/api_get_jra_odds.html?race_id=${raceId}&type=1&format=json`,
      `https://race.netkeiba.com/api/api_get_jra_odds.html?race_id=${raceId}&type=2&format=json`
    ];

    for (const url of urls) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), CONFIG.TIMEOUT);

        try {
          const res = await fetch(url, {
            headers: {
              'User-Agent': CONFIG.USER_AGENT,
              'Referer': `https://race.netkeiba.com/race/shutuba.html?race_id=${raceId}`
            },
            signal: controller.signal
          });

          if (!res.ok) continue;

          const txt = await res.text();
          const clean = txt.trim();

          if (!clean.startsWith('{') && !clean.startsWith('[')) continue;

          const json = JSON.parse(clean);
          const winData = json?.data?.odds?.WIN_SHOW
                       || json?.data?.WIN_SHOW
                       || json?.odds?.WIN;

          if (winData && Object.keys(winData).length > 0) {
            // キャッシュに保存
            oddsCache[raceId] = {
              data: winData,
              timestamp: Date.now()
            };
            return winData;
          }
        } finally {
          clearTimeout(timeoutId);
        }
      } catch (e) {
        console.debug(`  オッズAPI試行失敗: ${e.message}`);
      }
      await sleep(500);
    }

    return null;
  }

  async fetchShutuba(raceId, oddsCache) {
    return withRetry(async () => {
      const url = `https://race.netkeiba.com/race/shutuba.html?race_id=${raceId}`;
      
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), CONFIG.TIMEOUT);

      try {
        const res = await fetch(url, {
          headers: { 'User-Agent': CONFIG.USER_AGENT },
          signal: controller.signal
        });

        if (!res.ok) return null;

        const buf = await res.arrayBuffer();
        const decoded = new TextDecoder('euc-jp').decode(buf);
        const $ = cheerio.load(decoded);

        // レース基本情報の抽出
        const raceInfo = this.extractRaceInfo($, raceId);
        if (!raceInfo) return null;

        // 出走馬情報の抽出
        const horses = this.extractHorses($);
        if (horses.length === 0) return null;

        // オッズ情報の取得
        const winData = await this.fetchOddsFromAPI(raceId, oddsCache);
        if (winData) {
          this.applyOdds(horses, winData);
          const sample = horses.find(h => h.odds > 0);
          if (sample) {
            console.log(`  オッズ取得成功: ${sample.name} ${sample.odds}倍`);
          }
        }

        return {
          ...raceInfo,
          horses,
          fetchedAt: new Date().toISOString(),
        };
      } finally {
        clearTimeout(timeoutId);
      }
    }, CONFIG.MAX_RETRIES, `出馬表:${raceId}`);
  }

  extractRaceInfo($, raceId) {
    const raceName = $('h1.RaceName').text().trim()
                  || $('div.RaceName').text().trim()
                  || '';

    const raceData1 = $('div.RaceData01').text().replace(/\s+/g, ' ').trim();
    const raceData2 = $('div.RaceData02').text().replace(/\s+/g, ' ').trim();
    const allTxt = `${raceName} ${raceData1} ${raceData2}`;

    const venueCode = raceId.slice(4, 6);

    return {
      id: raceId,
      name: raceName,
      venue: VENUE_MAP[venueCode] || venueCode,
      year: raceId.slice(0, 4),
      distance: (allTxt.match(/(\d{3,4})m/) || [])[1] || '',
      track: (allTxt.match(/(芝|ダート|障害)/) || [])[1] || '',
      dir: (allTxt.match(/(右|左|直線)/) || [])[1] || '',
      grade: (allTxt.match(/(G1|G2|G3|OP|L|3勝|2勝|1勝|未勝利|新馬)/) || [])[1] || '',
      startTime: (raceData1.match(/(\d{2}:\d{2})/) || [])[1] || '',
      raceData1,
      raceData2,
    };
  }

  extractHorses($) {
    const horses = [];
    const tables = [
      'table.Shutuba_Table tr',
      'table.shutuba_table tr',
      'table.RaceTable_Shutuba tr'
    ];

    for (const selector of tables) {
      $(selector).each((i, row) => {
        if (i === 0) return; // ヘッダー行をスキップ
        const cols = $(row).find('td');
        if (cols.length < 6) return;

        const horse = this.parseHorseRow(cols, $);
        if (horse) horses.push(horse);
      });

      if (horses.length > 0) break;
    }

    return horses;
  }

  parseHorseRow(cols, $) {
    // 馬名
    const nameEl = $(cols[3]).find('a').first();
    const name = nameEl.text().trim() || $(cols[3]).text().trim();
    if (!name || name.length < 2) return null;

    // 枠番・馬番
    let gate = 0, number = 0;
    for (let ci = 0; ci < Math.min(cols.length, 5); ci++) {
      const txt = $(cols[ci]).text().trim();
      const n = parseInt(txt);
      if (!isNaN(n)) {
        if (n >= 1 && n <= 8 && gate === 0) gate = n;
        else if (n >= 1 && n <= 18 && number === 0) number = n;
      }
    }

    // 騎手
    const jockeyEl = $(cols[6]).find('a').first();
    const jockey = jockeyEl.text().trim() || $(cols[6]).text().trim();

    // 斤量
    const weight = $(cols[5]).text().trim();

    // 馬体重 - 修正: オプショナルチェーンを正しく使用
    const bwTxt = cols[8] ? $(cols[8]).text().trim() : '';
    const bwm = bwTxt.match(/(\d{3})/);
    const bodyWeight = bwm ? parseInt(bwm[1]) : 0;

    // 予想オッズ（HTMLから初期値として取得）
    const oddsEl = cols[9] ? $(cols[9]).text().trim() : cols[10] ? $(cols[10]).text().trim() : '';
    const odds = parseFloat(oddsEl) || 0;

    return {
      gate, number,
      name: name.trim(),
      jockey: jockey.trim(),
      weight,
      bodyWeight,
      odds,
    };
  }

  applyOdds(horses, winData) {
    for (const horse of horses) {
      const key = String(horse.number).padStart(2, '0');
      if (winData[key]) {
        const odds = Array.isArray(winData[key]) 
          ? parseFloat(winData[key][0]) 
          : parseFloat(winData[key]);
        
        if (!isNaN(odds) && odds > 0) {
          horse.odds = odds;
        }
      }
    }
  }
}

// ===== メイン処理 =====
async function main() {
  console.log('🏇 出馬表収集システム 起動');
  
  const dataManager = new DataManager();
  const rateLimiter = new RateLimiter(CONFIG.MAX_CONCURRENT, CONFIG.REQUEST_DELAY);
  const scraper = new RaceScraper(rateLimiter);

  // データ読み込み
  const existing = dataManager.loadShutuba();
  const oddsCache = dataManager.loadOddsCache();

  // 今週末の日付を取得
  const weekends = DateUtils.getThisWeekend();
  console.log(`対象日程: ${weekends.join(', ')}`);

  // レースIDの収集（並列処理）
  console.log('\n📅 レースID収集中...');
  const idPromises = weekends.map(dateStr => 
    rateLimiter.execute(() => scraper.fetchRaceIdsByDate(dateStr))
  );
  
  const idResults = await Promise.allSettled(idPromises);
  const allIds = [];
  
  for (const result of idResults) {
    if (result.status === 'fulfilled') {
      allIds.push(...result.value);
    }
  }

  // 重複除去・新規のみ抽出
  const existingIds = new Set(existing.map(r => r.id));
  const uniqueNewIds = [...new Set(allIds)].filter(id => !existingIds.has(id));
  
  console.log(`\n📊 収集結果:`);
  console.log(`  総レースID: ${allIds.length}件`);
  console.log(`  新規取得対象: ${uniqueNewIds.length}件`);

  if (uniqueNewIds.length === 0) {
    console.log('新規レースなし → 終了');
    return;
  }

  // 出馬表の取得（並列処理）
  console.log('\n🏇 出馬表取得中...');
  const newRaces = [];
  
  const batchPromises = uniqueNewIds.map(id => 
    rateLimiter.execute(async () => {
      console.log(`  取得中: ${id}`);
      const result = await scraper.fetchShutuba(id, oddsCache);
      
      if (result) {
        newRaces.push(result);
        console.log(
          `  ✓ ${result.name || id} ${result.horses.length}頭` +
          ` [${result.track}${result.distance}m ${result.grade}]` +
          ` ${result.startTime}`
        );
      } else {
        console.log(`  - データなし: ${id}`);
      }
    })
  );

  await Promise.allSettled(batchPromises);

  // データ保存
  console.log('\n💾 データ保存中...');
  const allRaces = dataManager.mergeAndSave(existing, newRaces, weekends);
  dataManager.saveOddsCache(oddsCache);

  console.log(`\n✅ 完了:`);
  console.log(`  新規取得: ${newRaces.length}件`);
  console.log(`  合計: ${allRaces.length}件`);
  console.log(`  キャッシュ: ${Object.keys(oddsCache).length}件`);
}

// ===== 実行 =====
main().catch(e => {
  console.error('🚨 致命的エラー:', e);
  process.exit(1);
});
