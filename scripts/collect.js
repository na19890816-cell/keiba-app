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

// 既存IDから「現在開催中の場・回次・日次」を把握して次のIDを生成
function generateNextIds(existing) {
function generateNextIds(existing) {
  const existingIds = new Set(existing.map(r => r.id));
  const year = new Date().getFullYear();
  const candidates = [];

  // 全場 × 全回次 × 全日次を網羅（重複排除）
  const venues = ['03','04','05','06','07','08','09','10'];
  for (const v of venues) {
    for (let kai = 1; kai <= 6; kai++) {
      for (let nichi = 1; nichi <= 12; nichi++) {
        for (let r = 1; r <= 12; r++) {
          const id = `${year}${v}` +
            `${String(kai).padStart(2,'0')}` +
            `${String(nichi).padStart(2,'0')}` +
            `${String(r).padStart(2,'0')}`;
          if (!existingIds.has(id)) candidates.push(id);
        }
      }
    }
  }

  // 既存データがある回次・日次の「近く」を優先（先頭に持ってくる）
  const hotIds = candidates.filter(id => {
    const venue = id.slice(4,6);
    const kai   = id.slice(6,8);
    // 既存データに同じ場・同じ回次があれば優先
    return existing.some(r =>
      r.id.slice(4,6) === venue &&
      r.id.slice(6,8) === kai
    );
  });
  const coldIds = candidates.filter(id => !hotIds.includes(id));

  return [...hotIds, ...coldIds];
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

    const titleTxt = $('title').text().replace(/\s+/g,' ').trim();
    const h1Txt    = $('h1').first().text().replace(/\s+/g,' ').trim();
    const allTxt   = titleTxt + ' ' + h1Txt;

    const dm  = allTxt.match(/(\d{3,4})m/);
    const tm  = allTxt.match(/(芝|ダート|障害)/);
    const cm  = allTxt.match(/(良|稍重|重|不良)/);
    const dm2 = allTxt.match(/(右|左|直線)/);

    const horses = [];
    table.find('tr').each((i, row) => {
      if (i === 0) return;
      const cols = $(row).find('td');
      if (cols.length < 8) return;

      const finish = parseInt($(cols[0]).text().trim()) || 99;
      const gate   = parseInt($(cols[1]).text().trim()) || 0;
      const number = parseInt($(cols[2]).text().trim()) || 0;
      const horseName = $(cols[3]).find('a').text().trim()
                     || $(cols[3]).text().trim();
      if (!horseName) return;

      const ageGender = $(cols[4]).text().trim();
      const weight    = $(cols[5]).text().trim();
      const jockey    = $(cols[6]).find('a').text().trim()
                     || $(cols[6]).text().trim();
      const time      = $(cols[7]).text().trim();

      let timeDiff='', passing='', last3F='';
      let odds=0, popular=0, bodyWeight=0, weightDiff=0;
      let oddsColIndex = -1;

      cols.each((ci, col) => {
        if (ci <= 7) return;
        const txt = $(col).text().trim();
        if (!timeDiff && /^(クビ|ハナ|アタマ|\d+(\.\d+)?(\/\d+)?)$/.test(txt) && txt) {
          timeDiff = txt; return;
        }
        if (!passing && /^\d+[-－]\d+/.test(txt)) {
          passing = txt; return;
        }
        if (!last3F && /^\d{2}\.\d$/.test(txt)) {
          last3F = txt; return;
        }
        if (!odds && /^\d+(\.\d)?$/.test(txt)) {
          const v = parseFloat(txt);
          if (v >= 1.0 && v <= 999) {
            odds = v; oddsColIndex = ci; return;
          }
        }
        if (odds && !popular && ci === oddsColIndex + 1) {
          const n = parseInt(txt);
          if (!isNaN(n) && n >= 1 && n <= 18) {
            popular = n; return;
          }
        }
        if (!bodyWeight && /^\d{3}\([+-]?\d+\)$/.test(txt)) {
          const m = txt.match(/(\d+)\(([+-]?\d+)\)/);
          if (m) { bodyWeight=parseInt(m[1]); weightDiff=parseInt(m[2]); }
        }
      });

      horses.push({
        finish, gate, number,
        name: horseName.trim(), ageGender, weight,
        jockey: jockey.trim(), time, timeDiff,
        passing, last3F, odds, popular, bodyWeight, weightDiff,
      });
    });

    if (horses.length === 0) return null;

    return {
      id: raceId,
      name: h1Txt.trim(),
      venue: VENUE_MAP[raceId.slice(4,6)] || raceId.slice(4,6),
      year: raceId.slice(0,4),
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

  const existingIds  = new Set(existing.map(r => r.id));
  const candidates   = generateNextIds(existing);
  // 候補をシャッフルして取得対象を選ぶ（偏りを防ぐ）
  const targetIds    = candidates.slice(0, 20);
  console.log(`候補: ${candidates.length}件 → 取得対象: ${targetIds.length}件`);

  const newRaces = [];
  for (const id of targetIds) {
    console.log(`取得中: ${id}`);
    const result = await fetchRaceResult(id);
    if (result) {
      newRaces.push(result);
      const s = result.horses[0];
      console.log(
        `✓ ${result.name||id} ${result.horses.length}頭` +
        ` [${result.track}${result.distance}m ${result.cond}]` +
        ` オッズ:${s?.odds} 人気:${s?.popular}`
      );
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
