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

function generateRaceIds() {
  const ids = [];
  const venues = ['05','06','07','08','09'];
  for (let d = 1; d <= 60; d++) {
    const date = new Date();
    date.setDate(date.getDate() - d);
    const dow = date.getDay();
    if (dow !== 0 && dow !== 6) continue;
    const y = date.getFullYear();
    venues.forEach(v => {
      for (let kai = 1; kai <= 5; kai++)
        for (let nichi = 1; nichi <= 8; nichi++)
          for (let r = 1; r <= 12; r++)
            ids.push(`${y}${v}${String(kai).padStart(2,'0')}${String(nichi).padStart(2,'0')}${String(r).padStart(2,'0')}`);
    });
  }
  return [...new Set(ids)];
}

async function fetchPage(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
  });
  if (!res.ok) return null;
  const buf = await res.arrayBuffer();
  return new TextDecoder('euc-jp').decode(buf);
}

async function fetchRaceResult(raceId) {
  try {
    // ── Step1: db.netkeiba で馬ごとの結果を取得 ──
    const dbHtml = await fetchPage(`https://db.netkeiba.com/race/${raceId}/`);
    if (!dbHtml) return null;
    const $db = cheerio.load(dbHtml);
    const table = $db('table.race_table_01');
    if (!table.length) return null;

    // ── Step2: race.netkeiba でレース情報を取得 ──
    const spHtml = await fetchPage(`https://race.netkeiba.com/race/result.html?race_id=${raceId}`);
    let name = '', distance = '', track = '', cond = '', dir = '';

    if (spHtml) {
      const $sp = cheerio.load(spHtml);

      // レース名
      name = $sp('h1.RaceName').text().trim()
          || $sp('.RaceList_Item02 h1').text().trim()
          || $sp('.race_name').text().trim()
          || '';

      // レース条件テキスト（例：芝1600m（左）良）
      const condTxt = $sp('.RaceData01').text().replace(/\s+/g,' ').trim()
                   + ' ' + $sp('.RaceData02').text().replace(/\s+/g,' ').trim();

      const dm = condTxt.match(/(\d{3,4})m/);
      const tm = condTxt.match(/(芝|ダート|障害)/);
      const cm = condTxt.match(/(良|稍重|重|不良)/);
      const dm2 = condTxt.match(/(右|左|直線)/);

      distance = dm  ? dm[1]  : '';
      track    = tm  ? tm[1]  : '';
      cond     = cm  ? cm[1]  : '';
      dir      = dm2 ? dm2[1] : '';

      console.log(`  レース情報: ${name} ${track}${distance}m ${cond}`);
    }

    // ── Step3: 馬ごとのデータ解析 ──
    const horses = [];
    table.find('tr').each((i, row) => {
      if (i === 0) return;
      const cols = $db(row).find('td');
      if (cols.length < 8) return;

      const finish = parseInt($db(cols[0]).text().trim()) || 99;
      const gate   = parseInt($db(cols[1]).text().trim()) || 0;
      const number = parseInt($db(cols[2]).text().trim()) || 0;
      const name_h = $db(cols[3]).find('a').text().trim() || $db(cols[3]).text().trim();
      if (!name_h) return;

      const ageGender = $db(cols[4]).text().trim();
      const weight    = $db(cols[5]).text().trim();
      const jockey    = $db(cols[6]).find('a').text().trim() || $db(cols[6]).text().trim();
      const time      = $db(cols[7]).text().trim();

      // oddsの位置を特定してからpopularを次の列で取る
      let timeDiff='', passing='', last3F='';
      let odds=0, popular=0, bodyWeight=0, weightDiff=0;
      let oddsColIndex = -1;

      cols.each((ci, col) => {
        if (ci <= 7) return;
        const txt = $db(col).text().trim();

        if (!timeDiff && /^(クビ|ハナ|アタマ|\d+(\.\d+)?(\/\d+)?)$/.test(txt) && txt !== '') {
          timeDiff = txt; return;
        }
        if (!passing && /^\d+[-－]\d+/.test(txt)) {
          passing = txt; return;
        }
        if (!last3F && /^\d{2}\.\d$/.test(txt)) {
          last3F = txt; return;
        }
        if (!odds && /^\d+\.\d$/.test(txt)) {
          odds = parseFloat(txt);
          oddsColIndex = ci;
          return;
        }
        // popular: oddsの直後の列
        if (odds && !popular && ci === oddsColIndex + 1) {
          const n = parseInt(txt);
          if (!isNaN(n) && n >= 1 && n <= 18) popular = n;
          return;
        }
        if (!bodyWeight && /^\d{3}\([+-]?\d+\)$/.test(txt)) {
          const m = txt.match(/(\d+)\(([+-]?\d+)\)/);
          if (m) { bodyWeight = parseInt(m[1]); weightDiff = parseInt(m[2]); }
        }
      });

      horses.push({
        finish, gate, number,
        name: name_h.trim(), ageGender, weight,
        jockey: jockey.trim(), time, timeDiff,
        passing, last3F, odds, popular,
        bodyWeight, weightDiff,
      });
    });

    if (horses.length === 0) return null;

    return {
      id: raceId, name, venue: VENUE_MAP[raceId.slice(4,6)] || raceId.slice(4,6),
      year: raceId.slice(0,4), distance, track, cond, dir, horses
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

  const existingIds = new Set(existing.map(r => r.id));
  const targetIds   = generateRaceIds().filter(id => !existingIds.has(id)).slice(0, 15);
  console.log(`取得対象: ${targetIds.length}件`);

  const newRaces = [];
  for (const id of targetIds) {
    console.log(`取得中: ${id}`);
    const result = await fetchRaceResult(id);
    if (result) {
      newRaces.push(result);
      const s = result.horses[0];
      console.log(`✓ ${result.name||id} ${result.horses.length}頭 オッズ:${s?.odds} 人気:${s?.popular}`);
    } else {
      console.log(`- データなし: ${id}`);
    }
    await sleep(6000); // 2サイト取得のため少し長めに待機
  }

  const all = [...existing, ...newRaces];
  fs.writeFileSync(dataPath, JSON.stringify(all, null, 2), 'utf8');
  console.log(`完了: 新規${newRaces.length}件 / 合計${all.length}件`);
}

main();
