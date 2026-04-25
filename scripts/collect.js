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
  const venues = ['03','04','05','06','07','08','09','10'];

  for (const v of venues) {
    for (let kai = 1; kai <= 6; kai++) {
      for (let nichi = 1; nichi <= 12; nichi++) {
        for (let r = 1; r <= 12; r++) {
          const id =
            `${year}${v}` +
            `${String(kai).padStart(2,'0')}` +
            `${String(nichi).padStart(2,'0')}` +
            `${String(r).padStart(2,'0')}`;
          if (!existingIds.has(id)) candidates.push(id);
        }
      }
    }
  }

  // 既存データと同じ場・回次を優先（現在開催中の可能性が高い）
  const hot = candidates.filter(id =>
    existing.some(r =>
      r.id.slice(4,8) === id.slice(4,8) // 場+回次が一致
    )
  );
  const cold = candidates.filter(id => !hot.includes(id));
  return [...hot, ...cold];
}

async function fetchRaceResult(raceId) {
  const url = `https://db.netkeiba.com/race/${raceId}/`;
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });
    if (!res.ok) return null;

    const buf = await res.arrayBuffer();
    const decoded = new TextDecoder('euc-jp').decode(buf);
    const $ = cheerio.load(decoded);

    const table = $('table.race_table_01');
    if (!table.length) return null;

    // レース情報
    const h1Txt    = $('h1').first().text().replace(/\s+/g,' ').trim();
    const titleTxt = $('title').text().replace(/\s+/g,' ').trim();
    const allTxt   = h1Txt + ' ' + titleTxt;

    const dm  = allTxt.match(/(\d{3,4})m/);
    const tm  = allTxt.match(/(芝|ダート|障害)/);
    const cm  = allTxt.match(/(良|稍重|重|不良)/);
    const dm2 = allTxt.match(/(右|左|直線)/);

    // 列数を確認して列インデックスを決定
    // netkeibaの標準列構成（15列）：
    // [0]着順 [1]枠 [2]馬番 [3]馬名 [4]性齢 [5]斤量 [6]騎手
    // [7]タイム [8]着差 [9]タイム指数 [10]通過順 [11]上がり
    // [12]単勝 [13]人気 [14]馬体重
    const COL = { // 標準的な列インデックス
      finish: 0, gate: 1, number: 2, name: 3,
      ageGender: 4, weight: 5, jockey: 6,
      time: 7, timeDiff: 8, passing: 10, last3F: 11,
      odds: 12, popular: 13, bodyWeight: 14
    };

    const horses = [];
    table.find('tr').each((i, row) => {
      if (i === 0) return; // ヘッダー行スキップ
      const cols = $(row).find('td');
      if (cols.length < 10) return;

      const finish = parseInt($(cols[COL.finish]).text().trim()) || 99;
      const name   = $(cols[COL.name]).find('a').text().trim()
                  || $(cols[COL.name]).text().trim();
      if (!name) return;

      // 馬体重（列数が15未満の場合は正規表現フォールバック）
      let bodyWeight = 0, weightDiff = 0;
      if (cols.length > COL.bodyWeight) {
        const wTxt = $(cols[COL.bodyWeight]).text().trim();
        const wm   = wTxt.match(/(\d+)\(([+-]?\d+)\)/);
        if (wm) { bodyWeight = parseInt(wm[1]); weightDiff = parseInt(wm[2]); }
      } else {
        // フォールバック：全列から馬体重パターンを探す
        cols.each((_, col) => {
          if (bodyWeight) return;
          const wm = $(col).text().trim().match(/^(\d{3})\(([+-]?\d+)\)$/);
          if (wm) { bodyWeight = parseInt(wm[1]); weightDiff = parseInt(wm[2]); }
        });
      }

      // オッズ・人気（列数が足りない場合は正規表現フォールバック）
      let odds = 0, popular = 0;
      if (cols.length > COL.popular) {
        odds    = parseFloat($(cols[COL.odds]).text().trim())   || 0;
        popular = parseInt($(cols[COL.popular]).text().trim())  || 0;
      } else {
        // フォールバック：パターンマッチで取得
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

      horses.push({
        finish,
        gate:       parseInt($(cols[COL.gate]).text().trim())   || 0,
        number:     parseInt($(cols[COL.number]).text().trim()) || 0,
        name:       name.trim(),
        ageGender:  $(cols[COL.ageGender]).text().trim(),
        weight:     $(cols[COL.weight]).text().trim(),
        jockey:     $(cols[COL.jockey]).find('a').text().trim()
                 || $(cols[COL.jockey]).text().trim(),
        time:       $(cols[COL.time]).text().trim(),
        timeDiff:   cols.length > COL.timeDiff
                    ? $(cols[COL.timeDiff]).text().trim() : '',
        passing:    cols.length > COL.passing
                    ? $(cols[COL.passing]).text().trim()  : '',
        last3F:     cols.length > COL.last3F
                    ? $(cols[COL.last3F]).text().trim()   : '',
        odds, popular, bodyWeight, weightDiff,
      });
    });

    if (horses.length === 0) return null;

    // デバッグ：列数と先頭馬のオッズを出力
    const firstRow = table.find('tr').eq(1);
    const colCount = firstRow.find('td').length;
    console.log(`  列数:${colCount} オッズ:${horses[0]?.odds} 人気:${horses[0]?.popular}`);

    return {
      id:       raceId,
      name:     h1Txt.trim(),
      venue:    VENUE_MAP[raceId.slice(4,6)] || raceId.slice(4,6),
      year:     raceId.slice(0,4),
      distance: dm  ? dm[1]  : '',
      track:    tm  ? tm[1]  : '',
      cond:     cm  ? cm[1]  : '',
      dir:      dm2 ? dm2[1] : '',
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

  const candidates = generateNextIds(existing);
  const targetIds  = candidates.slice(0, 20);
  console.log(`候補: ${candidates.length}件 → 取得対象: ${targetIds.length}件`);

  const newRaces = [];
  for (const id of targetIds) {
    console.log(`取得中: ${id}`);
    const result = await fetchRaceResult(id);
    if (result) {
      newRaces.push(result);
      console.log(`✓ ${result.name||id} ${result.horses.length}頭 [${result.track}${result.distance}m ${result.cond}]`);
    } else {
      console.log(`- なし: ${id}`);
    }
    await sleep(5000);
  }

  const all = [...existing, ...newRaces];
  fs.writeFileSync(dataPath, JSON.stringify(all, null, 2), 'utf8');
  console.log(`完了: 新規${newRaces.length}件 / 合計${all.length}件`);
}

main();
