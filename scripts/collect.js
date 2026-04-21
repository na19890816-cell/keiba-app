import fetch from 'node-fetch';
import * as cheerio from 'cheerio';
import fs from 'fs';
import path from 'path';

const sleep = ms => new Promise(r => setTimeout(r, ms));

function generateRaceIds() {
  const ids = [];
  const venues = ['05', '06', '07', '08', '09'];

  for (let d = 1; d <= 60; d++) {
    const date = new Date();
    date.setDate(date.getDate() - d);
    const dow = date.getDay();
    if (dow !== 0 && dow !== 6) continue;

    const y = date.getFullYear();
    venues.forEach(v => {
      for (let kai = 1; kai <= 5; kai++) {
        for (let nichi = 1; nichi <= 8; nichi++) {
          for (let r = 1; r <= 12; r++) {
            ids.push(
              `${y}${v}${String(kai).padStart(2,'0')}` +
              `${String(nichi).padStart(2,'0')}` +
              `${String(r).padStart(2,'0')}`
            );
          }
        }
      }
    });
  }
  return [...new Set(ids)];
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

    // ── レース基本情報 ──
    const raceName = $('h1.RaceName').text().trim()
                  || $('div.RaceList_Item02 h1').text().trim()
                  || '';

    const data1 = $('div.RaceData01').text().replace(/\s+/g, ' ').trim();
    const data2 = $('div.RaceData02').text().replace(/\s+/g, ' ').trim();

    const distMatch  = data2.match(/(\d{3,4})m/);
    const trackMatch = data2.match(/(芝|ダート|障害)/);
    const condMatch  = data2.match(/(良|稍重|重|不良)/);
    const dirMatch   = data2.match(/(右|左|直線)/);

    const venueCode = raceId.slice(4, 6);
    const venueMap = {
      '01':'札幌','02':'函館','03':'福島','04':'新潟',
      '05':'東京','06':'中山','07':'中京','08':'京都',
      '09':'阪神','10':'小倉'
    };

    const raceInfo = {
      id:       raceId,
      name:     raceName,
      venue:    venueMap[venueCode] || venueCode,
      year:     raceId.slice(0, 4),
      distance: distMatch  ? distMatch[1]  : '',
      track:    trackMatch ? trackMatch[1] : '',
      cond:     condMatch  ? condMatch[1]  : '',
      dir:      dirMatch   ? dirMatch[1]   : '',
      data1,
      data2,
    };

    // ── 出走馬データ ──
    const horses = [];
    table.find('tr').each((i, row) => {
      if (i === 0) return;
      const cols = $(row).find('td');
      if (cols.length < 8) return;

      // ── 固定列（位置が変わらない項目）──
      const finish = parseInt($(cols[0]).text().trim()) || 99;
      const gate   = parseInt($(cols[1]).text().trim()) || 0;
      const number = parseInt($(cols[2]).text().trim()) || 0;
      const name   = $(cols[3]).find('a').text().trim()
                  || $(cols[3]).text().trim();
      if (!name) return;

      const ageGender = $(cols[4]).text().trim();
      const weight    = $(cols[5]).text().trim();
      const jockey    = $(cols[6]).find('a').text().trim()
                     || $(cols[6]).text().trim();
      const time      = $(cols[7]).text().trim();

      // ── 可変列（列番号に依存しない方法で取得）──
      let timeDiff = '', passing = '', last3F = '';
      let odds = 0, popular = 0;
      let bodyWeight = 0, weightDiff = 0;

      cols.each((ci, col) => {
        if (ci <= 7) return; // 固定列はスキップ
        const txt = $(col).text().trim();

        // 着差（クビ・ハナ・アタマ・数字.数字形式）
        if (!timeDiff && /^(クビ|ハナ|アタマ|\d+\.\d+\/\d+|\d+)$/.test(txt)) {
          timeDiff = txt;
          return;
        }

        // 通過順（数字-数字形式、例：3-3-4-5）
        if (!passing && /^\d+[-－]\d+/.test(txt)) {
          passing = txt;
          return;
        }

        // 上がり3F（秒数、例：34.5）
        if (!last3F && /^\d{2}\.\d$/.test(txt)) {
          last3F = txt;
          return;
        }

        // 単勝オッズ（小数点1桁、例：3.5 / 12.8）
        if (!odds && /^\d+\.\d$/.test(txt)) {
          odds = parseFloat(txt);
          return;
        }

        // 人気（1〜18の整数のみ）
        if (odds && !popular && /^\d{1,2}$/.test(txt)) {
          const n = parseInt(txt);
          if (n >= 1 && n <= 18) {
            popular = n;
            return;
          }
        }

        // 馬体重（例：482(-4) または 482(+2)）
        if (!bodyWeight && /^\d{3}\([+-]?\d+\)$/.test(txt)) {
          const m = txt.match(/(\d+)\(([+-]?\d+)\)/);
          if (m) {
            bodyWeight = parseInt(m[1]);
            weightDiff = parseInt(m[2]);
          }
        }
      });

      horses.push({
        finish,
        gate,
        number,
        name:       name.trim(),
        ageGender,
        weight,
        jockey:     jockey.trim(),
        time,
        timeDiff,
        passing,
        last3F,
        odds,
        popular,
        bodyWeight,
        weightDiff,
      });
    });

    if (horses.length === 0) return null;
    return { ...raceInfo, horses };

  } catch (e) {
    console.error(`失敗 ${raceId}: ${e.message}`);
    return null;
  }
}

async function main() {
  const dataDir  = path.resolve('data');
  const dataPath = path.resolve('data/races.json');

  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  let existing = [];
  if (fs.existsSync(dataPath)) {
    try {
      existing = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
      console.log(`既存データ: ${existing.length}件`);
    } catch (_) {
      console.log('既存データ読み込み失敗、空配列で開始');
    }
  }

  const existingIds = new Set(existing.map(r => r.id));
  const allIds      = generateRaceIds();
  const targetIds   = allIds.filter(id => !existingIds.has(id)).slice(0, 20);
  console.log(`取得対象: ${targetIds.length}件`);

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
        ` オッズ:${s?.odds} 人気:${s?.popular}` +
        ` 体重:${s?.bodyWeight} 上がり:${s?.last3F}`
      );
    } else {
      console.log(`- データなし: ${id}`);
    }
    await sleep(5000);
  }

  const all = [...existing, ...newRaces];
  fs.writeFileSync(dataPath, JSON.stringify(all, null, 2), 'utf8');
  console.log(`完了: 新規${newRaces.length}件 / 合計${all.length}件`);
}

main();
