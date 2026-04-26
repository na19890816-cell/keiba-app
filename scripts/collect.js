import fetch from 'node-fetch';
import * as cheerio from 'cheerio';
import fs from 'fs';
import path from 'path';

const sleep = ms => new Promise(r => setTimeout(r, ms));

const VENUE_MAP = {
  '01':'札幌','02':'函館','03':'福島','04':'新潟',
  '05':'東京','06':'中山','07':'中京','08':'京都',
  '09':'阪神','10':'小倉'
};

function generateNextIds(existing) {
  const existingIds = new Set(existing.map(r => r.id));
  const year = new Date().getFullYear();
  const candidates = [];

  // 既存データから「場コード+回次」のセットを抽出
  const activeKeys = new Set(
    existing.map(r => r.id.slice(4, 8)) // 場コード2桁+回次2桁
  );
  console.log('現在開催中の場+回次:', [...activeKeys]);

  const venues = ['03','04','05','06','07','08','09','10'];

  // まず「既存データと同じ場+回次」の次の日次を優先
  for (const key of activeKeys) {
    const venue = key.slice(0, 2);
    const kai   = key.slice(2, 4);
    // この場+回次の既存データの最大日次を取得
    const maxNichi = Math.max(
      ...existing
        .filter(r => r.id.slice(4, 8) === key)
        .map(r => parseInt(r.id.slice(8, 10)))
    );
    console.log(`  ${venue}回${kai}: 最大${maxNichi}日目 → ${maxNichi+1}日目以降を候補化`);

    // 次の日次から最大12日目まで
    for (let nichi = maxNichi + 1; nichi <= 12; nichi++) {
      for (let r = 1; r <= 12; r++) {
        const id = `${year}${venue}${kai}${String(nichi).padStart(2,'0')}${String(r).padStart(2,'0')}`;
        if (!existingIds.has(id)) candidates.push(id);
      }
    }
    // 同じ場の次の回次も候補に
    const nextKai = String(parseInt(kai) + 1).padStart(2,'0');
    for (let nichi = 1; nichi <= 8; nichi++) {
      for (let r = 1; r <= 12; r++) {
        const id = `${year}${venue}${nextKai}${String(nichi).padStart(2,'0')}${String(r).padStart(2,'0')}`;
        if (!existingIds.has(id)) candidates.push(id);
      }
    }
  }

  // 既存データにない場も網羅（後半に追加）
  for (const v of venues) {
    for (let kai = 1; kai <= 6; kai++) {
      for (let nichi = 1; nichi <= 8; nichi++) {
        for (let r = 1; r <= 12; r++) {
          const id = `${year}${v}${String(kai).padStart(2,'0')}${String(nichi).padStart(2,'0')}${String(r).padStart(2,'0')}`;
          if (!existingIds.has(id) && !candidates.includes(id)) {
            candidates.push(id);
          }
        }
      }
    }
  }

  return candidates;
}

async function fetchRaceResult(raceId) {
  const url = `https://db.netkeiba.com/race/${raceId}/`;
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
    });
    if (!res.ok) return null;

    const buf = await res.arrayBuffer();
    if (!buf || buf.byteLength === 0) return null;

    const decoded = new TextDecoder('euc-jp').decode(buf);
    const $ = cheerio.load(decoded);

    const table = $('table.race_table_01');
    if (!table.length) return null;

    const h1Txt    = $('h1').first().text().replace(/\s+/g,' ').trim();
    const titleTxt = $('title').text().replace(/\s+/g,' ').trim();
    const allTxt   = h1Txt + ' ' + titleTxt;

    const dm  = allTxt.match(/(\d{3,4})m/);
    const tm  = allTxt.match(/(芝|ダート|障害)/);
    const cm  = allTxt.match(/(良|稍重|重|不良)/);
    const dm2 = allTxt.match(/(右|左|直線)/);

    // 実際の列数を確認してCOLを動的に決定
    const firstDataRow = table.find('tr').eq(1);
    const colCount = firstDataRow.find('td').length;

    // netkeibaの列構成（15列が標準、少ない場合は調整）
    // [0]着 [1]枠 [2]馬番 [3]馬名 [4]性齢 [5]斤量 [6]騎手
    // [7]タイム [8]着差 [9]ﾀｲﾑ指数 [10]通過 [11]上り [12]単勝 [13]人気 [14]馬体重
    const oddsCol   = colCount >= 15 ? 12 : colCount >= 13 ? colCount - 3 : -1;
    const popCol    = oddsCol >= 0 ? oddsCol + 1 : -1;
    const bweightCol = popCol >= 0 ? popCol + 1 : -1;

    console.log(`  列数:${colCount} odsCol:${oddsCol}`);

    const horses = [];
    table.find('tr').each((i, row) => {
      if (i === 0) return;
      const cols = $(row).find('td');
      if (cols.length < 8) return;

      const finish    = parseInt($(cols[0]).text().trim()) || 99;
      const gate      = parseInt($(cols[1]).text().trim()) || 0;
      const number    = parseInt($(cols[2]).text().trim()) || 0;
      const horseName = $(cols[3]).find('a').text().trim() || $(cols[3]).text().trim();
      if (!horseName) return;

      const ageGender = $(cols[4]).text().trim();
      const weight    = $(cols[5]).text().trim();
      const jockey    = $(cols[6]).find('a').text().trim() || $(cols[6]).text().trim();
      const time      = $(cols[7]).text().trim();
      const timeDiff  = cols.length > 8  ? $(cols[8]).text().trim()  : '';
      const passing   = cols.length > 10 ? $(cols[10]).text().trim() : '';
      const last3F    = cols.length > 11 ? $(cols[11]).text().trim() : '';

      // オッズ・人気（列インデックス優先、フォールバックあり）
      let odds = 0, popular = 0;
      if (oddsCol >= 0 && cols.length > popCol) {
        odds    = parseFloat($(cols[oddsCol]).text().trim()) || 0;
        popular = parseInt($(cols[popCol]).text().trim())    || 0;
      }
      // フォールバック：パターンマッチ
      if (!odds) {
        let oddsIdx = -1;
        cols.each((ci, col) => {
          if (ci <= 7) return;
          const txt = $(col).text().trim();
          if (!odds && /^\d+(\.\d)?$/.test(txt)) {
            const v = parseFloat(txt);
            if (v >= 1.0 && v <= 999) { odds = v; oddsIdx = ci; return; }
          }
          if (odds && !popular && ci === oddsIdx + 1) {
            const n = parseInt(txt);
            if (!isNaN(n) && n >= 1 && n <= 18) popular = n;
          }
        });
      }

      // 馬体重
      let bodyWeight = 0, weightDiff = 0;
      const bwTxt = bweightCol >= 0 && cols.length > bweightCol
        ? $(cols[bweightCol]).text().trim() : '';
      const wm = bwTxt.match(/(\d+)\(([+-]?\d+)\)/) ||
        // フォールバック：計不・発表なし対応
        (() => {
          let found = null;
          cols.each((_, col) => {
            if (found) return;
            const m = $(col).text().trim().match(/^(\d{3})\(([+-]?\d+)\)$/);
            if (m) found = m;
          });
          return found;
        })();
      if (wm) { bodyWeight = parseInt(wm[1]); weightDiff = parseInt(wm[2]); }

      horses.push({
        finish, gate, number,
        name: horseName.trim(), ageGender, weight,
        jockey: jockey.trim(), time, timeDiff,
        passing, last3F, odds, popular, bodyWeight, weightDiff,
      });
    });

    if (horses.length === 0) return null;
    return {
      id: raceId, name: h1Txt.trim(),
      venue: VENUE_MAP[raceId.slice(4,6)] || raceId.slice(4,6),
      year: raceId.slice(0,4),
      distance: dm ? dm[1] : '', track: tm ? tm[1] : '',
      cond: cm ? cm[1] : '', dir: dm2 ? dm2[1] : '',
      horses,
    };
  } catch (e) {
    console.error(`失敗 ${raceId}: ${e.message}`);
    return null;
  }
}

async function main() {
  const dataDir  = path.resolve('data');
  const dataPath = path.resolve('data/races.json');
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

  let existing = [];
  if (fs.existsSync(dataPath)) {
    try {
      existing = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
      console.log(`既存データ: ${existing.length}件`);
    } catch (_) { console.log('既存データ読み込み失敗'); }
  }

  // ── 動作確認用：今週の実在IDを直接指定 ──
  // 東京2回1日目（4/26土曜）
  const targetIds = [
    // 4/25（土）東京2回1日目
    '202605020101','202605020102','202605020103',
    '202605020104','202605020105','202605020106',
    '202605020107','202605020108','202605020109',
    '202605020110','202605020111','202605020112',
    // 4/26（日）東京2回2日目
    '202605020201','202605020202','202605020203',
    '202605020204','202605020205','202605020206',
    '202605020207','202605020208','202605020209',
    '202605020210','202605020211','202605020212',
  ];
  console.log(`固定IDテスト: ${targetIds.length}件`);

  let savedCount = 0;
  for (const id of targetIds) {
    if (existing.some(r => r.id === id)) {
      console.log(`スキップ(既存): ${id}`);
      continue;
    }
    console.log(`取得中: ${id}`);
    const result = await fetchRaceResult(id);
    if (result) {
      existing.push(result);
      fs.writeFileSync(dataPath, JSON.stringify(existing, null, 2), 'utf8');
      savedCount++;
      console.log(`✓ 保存(${savedCount}件目): ${result.name||id} ${result.horses.length}頭 [${result.track}${result.distance}m] オッズ:${result.horses[0]?.odds}`);
    } else {
      console.log(`- なし: ${id}`);
    }
    await sleep(5000);
  }
  console.log(`完了: 新規${savedCount}件 / 合計${existing.length}件`);
}

main();
