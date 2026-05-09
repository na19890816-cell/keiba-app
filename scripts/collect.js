import fetch from 'node-fetch';
import * as cheerio from 'cheerio';
import fs from 'fs';
import path from 'path';

// ===== 設定 =====
const CONFIG = {
  MAX_RETRIES: 3,
  RETRY_DELAY: 2000,
  REQUEST_DELAY: 1000, // 基本の遅延を短縮
  BATCH_SIZE: 5,       // 並列処理数
  MAX_RACES_PER_DAY: 8,
  DATA_DIR: 'data',
  DATA_FILE: 'races.json',
  USER_AGENT: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  TIMEOUT: 10000
};

const VENUE_MAP = {
  '01': '札幌', '02': '函館', '03': '福島', '04': '新潟',
  '05': '東京', '06': '中山', '07': '中京', '08': '京都',
  '09': '阪神', '10': '小倉'
};

// ===== ユーティリティ =====
const sleep = ms => new Promise(r => setTimeout(r, ms));

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

// ===== ID生成 =====
function generateNextIds(existing) {
  const existingIds = new Set(existing.map(r => r.id));
  const year = new Date().getFullYear();

  // 既存データから場+回次ごとの最大日次を把握
  const maxNichiMap = new Map();
  for (const r of existing) {
    const key = r.id.slice(4, 8);
    const nichi = parseInt(r.id.slice(8, 10));
    if (!maxNichiMap.has(key) || maxNichiMap.get(key) < nichi) {
      maxNichiMap.set(key, nichi);
    }
  }

  console.log('既存開催パターン:');
  maxNichiMap.forEach((n, k) => {
    console.log(`  ${VENUE_MAP[k.slice(0, 2)] || k.slice(0, 2)} ${k.slice(2, 4)}回 → 最大${n}日目`);
  });

  const candidates = new Set();

  // ① 既存の場+回次の「次の日次」（最優先・ただし最大8日まで）
  for (const [key, maxNichi] of maxNichiMap) {
    if (maxNichi >= CONFIG.MAX_RACES_PER_DAY) continue;
    const venue = key.slice(0, 2);
    const kai = key.slice(2, 4);
    
    for (let nichi = maxNichi + 1; nichi <= Math.min(maxNichi + 2, CONFIG.MAX_RACES_PER_DAY); nichi++) {
      for (let r = 1; r <= 12; r++) {
        const id = `${year}${venue}${kai}${String(nichi).padStart(2, '0')}${String(r).padStart(2, '0')}`;
        if (!existingIds.has(id)) candidates.add(id);
      }
    }
  }

  // ② 既存の場の「次の回次」の1〜3日目（第2優先）
  for (const [key, maxNichi] of maxNichiMap) {
    if (maxNichi < CONFIG.MAX_RACES_PER_DAY) continue;
    const venue = key.slice(0, 2);
    const nextKai = String(parseInt(key.slice(2, 4)) + 1).padStart(2, '0');
    
    for (let nichi = 1; nichi <= 3; nichi++) {
      for (let r = 1; r <= 12; r++) {
        const id = `${year}${venue}${nextKai}${String(nichi).padStart(2, '0')}${String(r).padStart(2, '0')}`;
        if (!existingIds.has(id)) candidates.add(id);
      }
    }
  }

  // ③ まだ既存にない場（新規開催対応）
  const knownVenues = new Set([...maxNichiMap.keys()].map(k => k.slice(0, 2)));
  const allVenues = ['03', '04', '05', '06', '07', '08', '09', '10'];
  
  for (const v of allVenues) {
    if (knownVenues.has(v)) continue;
    for (let kai = 1; kai <= 2; kai++) {
      for (let nichi = 1; nichi <= 3; nichi++) {
        for (let r = 1; r <= 12; r++) {
          const id = `${year}${v}${String(kai).padStart(2, '0')}${String(nichi).padStart(2, '0')}${String(r).padStart(2, '0')}`;
          if (!existingIds.has(id)) candidates.add(id);
        }
      }
    }
  }

  return [...candidates];
}

// ===== スクレイピング =====
function parseRaceData($) {
  // レース情報の抽出を一元化
  const h1Txt = $('h1').first().text().replace(/\s+/g, ' ').trim();
  const titleTxt = $('title').text().replace(/\s+/g, ' ').trim();
  
  const raceDataSelectors = [
    'div.RaceData01', 'div.RaceData02', 'p.RaceData', 
    'div.race_data', 'dl.racedata', 'div.RaceList_Item02'
  ];
  
  const raceDataTxt = raceDataSelectors
    .map(sel => $(sel).text())
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  
  const tableCaption = $('table.race_table_01').closest('div').prev().text();
  const allTxt = `${h1Txt} ${titleTxt} ${raceDataTxt} ${tableCaption}`;

  const dm = allTxt.match(/(\d{3,4})m/);
  const tm = allTxt.match(/(芝|ダート|障害)/);
  const cm = allTxt.match(/(良|稍重|重|不良)/);
  const dm2 = allTxt.match(/(右|左|直線)/);

  const raceName = h1Txt
    || titleTxt.split('|')[0].trim()
    || $('div.RaceList_Item02 h1').text().trim()
    || '';

  return { raceName, dm, tm, cm, dm2 };
}

function parseHorseData($, table) {
  const firstDataRow = table.find('tr').eq(1);
  const colCount = firstDataRow.find('td').length;
  const oddsCol = colCount >= 15 ? 12 : colCount >= 13 ? colCount - 3 : -1;
  const popCol = oddsCol >= 0 ? oddsCol + 1 : -1;
  const bwCol = popCol >= 0 ? popCol + 1 : -1;

  const horses = [];
  
  table.find('tr').each((i, row) => {
    if (i === 0) return;
    const cols = $(row).find('td');
    if (cols.length < 8) return;

    const finish = parseInt($(cols[0]).text().trim()) || 99;
    const gate = parseInt($(cols[1]).text().trim()) || 0;
    const number = parseInt($(cols[2]).text().trim()) || 0;
    const horseName = $(cols[3]).find('a').text().trim() || $(cols[3]).text().trim();
    if (!horseName) return;

    const ageGender = $(cols[4]).text().trim();
    const weight = $(cols[5]).text().trim();
    const jockey = $(cols[6]).find('a').text().trim() || $(cols[6]).text().trim();
    const time = $(cols[7]).text().trim();
    const timeDiff = cols.length > 8 ? $(cols[8]).text().trim() : '';
    const passing = cols.length > 10 ? $(cols[10]).text().trim() : '';
    const last3F = cols.length > 11 ? $(cols[11]).text().trim() : '';

    // オッズ抽出の最適化
    const { odds, popular } = extractOdds(cols, oddsCol, popCol);

    // 馬体重抽出の最適化
    const { bodyWeight, weightDiff } = extractBodyWeight(cols, bwCol);

    horses.push({
      finish, gate, number,
      name: horseName.trim(), ageGender, weight,
      jockey: jockey.trim(), time, timeDiff,
      passing, last3F, odds, popular, bodyWeight, weightDiff,
    });
  });

  return horses;
}

function extractOdds(cols, oddsCol, popCol) {
  let odds = 0, popular = 0;
  
  if (oddsCol >= 0 && cols.length > popCol) {
    odds = parseFloat($(cols[oddsCol]).text().trim()) || 0;
    popular = parseInt($(cols[popCol]).text().trim()) || 0;
  }
  
  if (!odds) {
    for (let ci = 7; ci < cols.length; ci++) {
      const txt = $(cols[ci]).text().trim();
      if (!odds && /^\d+(\.\d)?$/.test(txt)) {
        const v = parseFloat(txt);
        if (v >= 1.0 && v <= 999) {
          odds = v;
          if (ci + 1 < cols.length) {
            const n = parseInt($(cols[ci + 1]).text().trim());
            if (!isNaN(n) && n >= 1 && n <= 18) popular = n;
          }
          break;
        }
      }
    }
  }
  
  return { odds, popular };
}

function extractBodyWeight(cols, bwCol) {
  let bodyWeight = 0, weightDiff = 0;
  const bwTxt = bwCol >= 0 && cols.length > bwCol ? $(cols[bwCol]).text().trim() : '';
  let wm = bwTxt.match(/(\d+)\(([+-]?\d+)\)/);
  
  if (!wm) {
    for (const col of cols) {
      const m = $(col).text().trim().match(/^(\d{3})\(([+-]?\d+)\)$/);
      if (m) { wm = m; break; }
    }
  }
  
  if (wm) {
    bodyWeight = parseInt(wm[1]);
    weightDiff = parseInt(wm[2]);
  }
  
  return { bodyWeight, weightDiff };
}

async function fetchRaceResult(raceId) {
  const url = `https://db.netkeiba.com/race/${raceId}/`;
  
  return withRetry(async () => {
    // 修正: タイムアウト制御を AbortController で実装
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), CONFIG.TIMEOUT);

    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': CONFIG.USER_AGENT },
        signal: controller.signal
      });
      
      if (!res.ok) return null;

      const buf = await res.arrayBuffer();
      if (!buf || buf.byteLength === 0) return null;

      const decoded = new TextDecoder('euc-jp').decode(buf);
      const $ = cheerio.load(decoded);

      const table = $('table.race_table_01');
      if (!table.length) return null;

      const { raceName, dm, tm, cm, dm2 } = parseRaceData($);
      const horses = parseHorseData($, table);
      
      if (horses.length === 0) return null;

      return {
        id: raceId,
        name: raceName,
        venue: VENUE_MAP[raceId.slice(4, 6)] || raceId.slice(4, 6),
        year: raceId.slice(0, 4),
        distance: dm ? dm[1] : '',
        track: tm ? tm[1] : '',
        cond: cm ? cm[1] : '',
        dir: dm2 ? dm2[1] : '',
        horses,
      };
    } finally {
      clearTimeout(timeoutId);
    }
  });
}

// ===== メイン処理 =====
async function processBatch(ids, existing, dataPath) {
  const results = await Promise.allSettled(
    ids.map(id => fetchRaceResult(id))
  );
  
  let savedCount = 0;
  
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    const result = results[i];
    
    if (result.status === 'fulfilled' && result.value) {
      existing.push(result.value);
      savedCount++;
      
      const horse = result.value.horses[0];
      console.log(
        `✓ 保存(${existing.length}件): ${result.value.name || id}` +
        ` ${result.value.horses.length}頭` +
        ` [${result.value.track}${result.value.distance}m ${result.value.cond}]` +
        ` オッズ:${horse?.odds} 人気:${horse?.popular}`
      );
    } else {
      console.log(`- なし: ${id}`);
    }
  }
  
  if (savedCount > 0) {
    fs.writeFileSync(dataPath, JSON.stringify(existing, null, 2), 'utf8');
  }
  
  return savedCount;
}

async function main() {
  const dataDir = path.resolve(CONFIG.DATA_DIR);
  const dataPath = path.resolve(dataDir, CONFIG.DATA_FILE);
  
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  let existing = [];
  if (fs.existsSync(dataPath)) {
    try {
      existing = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
      console.log(`既存データ: ${existing.length}件`);
    } catch {
      console.log('既存データ読み込み失敗');
    }
  }

  const candidates = generateNextIds(existing);
  const targetIds = candidates.slice(0, 20);
  
  console.log(`候補: ${candidates.length}件 → 取得対象: ${targetIds.length}件`);
  console.log('先頭5件:', targetIds.slice(0, 5));

  let totalSaved = 0;
  
  // バッチ処理
  for (let i = 0; i < targetIds.length; i += CONFIG.BATCH_SIZE) {
    const batch = targetIds.slice(i, i + CONFIG.BATCH_SIZE);
    console.log(`\nバッチ処理中: ${i + 1}-${Math.min(i + CONFIG.BATCH_SIZE, targetIds.length)}/${targetIds.length}`);
    
    const saved = await processBatch(batch, existing, dataPath);
    totalSaved += saved;
    
    // バッチ間の遅延
    if (i + CONFIG.BATCH_SIZE < targetIds.length) {
      await sleep(CONFIG.REQUEST_DELAY);
    }
  }
  
  console.log(`\n完了: 新規${totalSaved}件 / 合計${existing.length}件`);
}

// ===== 実行 =====
main().catch(console.error);
