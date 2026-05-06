import fetch from 'node-fetch';
import fs from 'fs';
import path from 'path';

// ===== 設定 =====
const CONFIG = {
  MAX_RETRIES: 3,
  RETRY_DELAY: 2000,
  REQUEST_DELAY: 1000,
  BATCH_SIZE: 3,
  RACE_WINDOW_START: 90,  // 発走前何分から取得開始
  RACE_WINDOW_END: -30,   // 発走後何分まで取得
  USER_AGENT: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  DATA_DIR: 'data',
  SHUTUBA_FILE: 'shutuba.json',
  ODDS_BACKUP_FILE: 'odds_backup.json',
  MAX_CONCURRENT_REQUESTS: 5
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

const withRetry = async (fn, retries = CONFIG.MAX_RETRIES) => {
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i === retries - 1) throw e;
      console.warn(`リトライ ${i + 1}/${retries}: ${e.message}`);
      await sleep(CONFIG.RETRY_DELAY * (i + 1));
    }
  }
};

// ===== オッズ取得 =====
class OddsFetcher {
  constructor(raceId) {
    this.raceId = raceId;
    this.baseHeaders = {
      'User-Agent': CONFIG.USER_AGENT,
      'Referer': `https://race.netkeiba.com/race/shutuba.html?race_id=${raceId}`
    };
  }

  async fetchFromAPI() {
    const urls = [
      `https://race.netkeiba.com/api/api_get_jra_odds.html?race_id=${this.raceId}&type=1&format=json`,
      `https://race.netkeiba.com/api/api_get_jra_odds.html?race_id=${this.raceId}&type=2&format=json`,
    ];

    for (const url of urls) {
      try {
        const res = await fetch(url, { 
          headers: this.baseHeaders,
          timeout: 10000
        });
        
        if (!res.ok) continue;

        const txt = await res.text();
        
        // JSONレスポンスの処理
        if (txt.includes('"status":"ok"') || txt.includes('"WIN_SHOW"')) {
          try {
            const json = JSON.parse(txt);
            const winData = json?.data?.odds?.WIN_SHOW || json?.data?.WIN_SHOW;
            if (winData && Object.keys(winData).length > 0) {
              return { data: winData, source: 'api' };
            }
          } catch (e) {
            console.debug(`JSON解析失敗: ${e.message}`);
          }
        }
      } catch (e) {
        console.debug(`API取得失敗: ${e.message}`);
      }
      await sleep(500);
    }
    return null;
  }

  async fetchFromHTML() {
    const url = `https://race.netkeiba.com/odds/index.html?type=b1&race_id=${this.raceId}&housiki=ct`;
    
    try {
      const res = await fetch(url, { 
        headers: this.baseHeaders,
        timeout: 10000
      });
      
      if (!res.ok) return null;

      const html = await res.text();
      
      if (!html.includes('Odds') && !html.includes('単勝')) {
        return null;
      }

      const odds = {};
      const regex = /umaban['"]\s*:\s*['"](\d+)['"]\s*.*?odds['"]\s*:\s*['"]([0-9.]+)['"]/gs;
      const matches = [...html.matchAll(regex)];

      if (matches.length === 0) {
        // 代替パターンを試行
        const altRegex = /data-umaban="(\d+)".*?data-odds="([0-9.]+)"/gs;
        const altMatches = [...html.matchAll(altRegex)];
        
        for (const m of altMatches) {
          const num = m[1].padStart(2, '0');
          odds[num] = [parseFloat(m[2])];
        }
      } else {
        for (const m of matches) {
          const num = m[1].padStart(2, '0');
          odds[num] = [parseFloat(m[2])];
        }
      }

      if (Object.keys(odds).length > 0) {
        return { data: odds, source: 'html' };
      }
    } catch (e) {
      console.debug(`HTML取得失敗: ${e.message}`);
    }
    
    return null;
  }

  async fetch() {
    return withRetry(async () => {
      // APIを優先的に試行
      const apiResult = await this.fetchFromAPI();
      if (apiResult) {
        console.log(`  ✓ API取得成功: ${this.raceId} (${Object.keys(apiResult.data).length}頭)`);
        return apiResult.data;
      }

      // HTMLからの抽出を試行
      const htmlResult = await this.fetchFromHTML();
      if (htmlResult) {
        console.log(`  ✓ HTML取得成功: ${this.raceId} (${Object.keys(htmlResult.data).length}頭)`);
        return htmlResult.data;
      }

      console.log(`  ✗ オッズ取得失敗: ${this.raceId}`);
      return null;
    });
  }
}

// ===== レースフィルタリング =====
class RaceFilter {
  constructor() {
    this.now = new Date();
    this.nowTotal = (this.now.getUTCHours() + 9) * 60 + this.now.getUTCMinutes();
    this.today = `${this.now.getFullYear()}${String(this.now.getMonth() + 1).padStart(2, '0')}${String(this.now.getDate()).padStart(2, '0')}`;
  }

  shouldFetch(race) {
    // 発走時間チェック
    if (!race.startTime) return false;

    const [h, min] = race.startTime.split(':').map(Number);
    if (isNaN(h) || isNaN(min)) return false;

    const raceTotal = h * 60 + min;
    const diff = raceTotal - this.nowTotal;

    // ウィンドウ外はスキップ
    if (diff > CONFIG.RACE_WINDOW_START || diff < CONFIG.RACE_WINDOW_END) {
      console.log(`  スキップ(時間外) ${race.name} ${race.startTime} diff:${diff}分`);
      return false;
    }

    return true;
  }

  getPriority(race) {
    const [h, min] = race.startTime.split(':').map(Number);
    const raceTotal = h * 60 + min;
    const diff = raceTotal - this.nowTotal;
    
    // 発走が近いレースを優先
    if (diff <= 0) return 0; // 発走済み（最優先）
    if (diff <= 15) return 1; // 15分以内
    if (diff <= 30) return 2; // 30分以内
    return 3; // それ以外
  }
}

// ===== データ保存 =====
class DataManager {
  constructor() {
    this.dataPath = path.resolve(CONFIG.DATA_DIR, CONFIG.SHUTUBA_FILE);
    this.backupPath = path.resolve(CONFIG.DATA_DIR, CONFIG.ODDS_BACKUP_FILE);
    
    if (!fs.existsSync(CONFIG.DATA_DIR)) {
      fs.mkdirSync(CONFIG.DATA_DIR, { recursive: true });
    }
  }

  loadRaces() {
    if (!fs.existsSync(this.dataPath)) {
      console.log(`${CONFIG.SHUTUBA_FILE}なし → スキップ`);
      return null;
    }

    try {
      const races = JSON.parse(fs.readFileSync(this.dataPath, 'utf8'));
      console.log(`対象レース: ${races.length}件`);
      return races;
    } catch (e) {
      console.error(`データ読み込みエラー: ${e.message}`);
      return null;
    }
  }

  updateHorseOdds(race, winData) {
    let updated = false;
    
    for (const horse of race.horses) {
      const key = String(horse.number).padStart(2, '0');
      if (winData[key]) {
        const odds = Array.isArray(winData[key]) 
          ? parseFloat(winData[key][0]) 
          : parseFloat(winData[key]);
        
        if (!isNaN(odds) && odds > 0) {
          horse.odds = odds;
          updated = true;
        }
      }
    }

    if (updated) {
      race.oddsUpdatedAt = new Date().toISOString();
    }
    
    return updated;
  }

  saveRaces(races) {
    try {
      // バックアップ作成
      if (fs.existsSync(this.dataPath)) {
        fs.copyFileSync(this.dataPath, this.backupPath);
      }
      
      fs.writeFileSync(this.dataPath, JSON.stringify(races, null, 2), 'utf8');
      return true;
    } catch (e) {
      console.error(`保存エラー: ${e.message}`);
      return false;
    }
  }
}

// ===== メイン処理 =====
async function processBatch(races, dataManager, filter, rateLimiter) {
  const targetRaces = races.filter(r => filter.shouldFetch(r));
  
  if (targetRaces.length === 0) {
    console.log('対象レースなし');
    return 0;
  }

  // 優先度でソート
  targetRaces.sort((a, b) => filter.getPriority(a) - filter.getPriority(b));
  
  console.log(`\nオッズ取得対象: ${targetRaces.length}件`);
  
  let updatedCount = 0;
  
  // 並列処理
  const promises = targetRaces.map(race => 
    rateLimiter.execute(async () => {
      console.log(`\n取得中: ${race.id} ${race.name} ${race.startTime}`);
      
      const fetcher = new OddsFetcher(race.id);
      const winData = await fetcher.fetch();
      
      if (winData) {
        const updated = dataManager.updateHorseOdds(race, winData);
        if (updated) updatedCount++;
      }
    })
  );

  await Promise.allSettled(promises);
  
  return updatedCount;
}

async function main() {
  const dataManager = new DataManager();
  const races = dataManager.loadRaces();
  
  if (!races) return;

  const filter = new RaceFilter();
  const rateLimiter = new RateLimiter(
    CONFIG.MAX_CONCURRENT_REQUESTS, 
    CONFIG.REQUEST_DELAY
  );

  // 処理実行
  const updatedCount = await processBatch(races, dataManager, filter, rateLimiter);

  // 保存
  if (updatedCount > 0) {
    const saved = dataManager.saveRaces(races);
    console.log(`\n完了: ${updatedCount}件更新${saved ? '' : '(保存失敗)'}`);
  } else {
    console.log('\n更新なし');
  }
}

// ===== 実行 =====
main().catch(e => {
  console.error('致命的エラー:', e);
  process.exit(1);
});
