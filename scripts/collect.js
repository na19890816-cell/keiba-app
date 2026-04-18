import fetch from 'node-fetch';
import * as cheerio from 'cheerio';
import fs from 'fs';
import path from 'path';

const sleep = ms => new Promise(r => setTimeout(r, ms));

function generateRaceIds() {
  const ids = [];
  const venues = ['05', '06', '07', '08'];
  
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
              `${y}${v}${String(kai).padStart(2,'0')}${String(nichi).padStart(2,'0')}${String(r).padStart(2,'0')}`
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

    // ページにレーステーブルがなければスキップ
    const table = $('table.race_table_01');
    if (!table.length) return null;

    const raceData2 = $('div.RaceData02').text().replace(/\s+/g,' ').trim();
    const distMatch = raceData2.match(/(\d{3,4})m/);
    const trackMatch = raceData2.match(/(芝|ダート|障害)/);
    const dateMatch = $('dd.RaceList_Item02').text().trim()
                   || $('p.Race_Date').text().trim()
                   || '';

    const raceInfo = {
      id: raceId,
      name: $('h1.RaceName').text().trim() || $('div.RaceList_Item02 h1').text().trim() || '',
      date: dateMatch,
      distance: distMatch ? distMatch[1] : '',
      track: trackMatch ? trackMatch[1] : '',
      data2: raceData2,
    };

    const horses = [];
    table.find('tr').each((i, row) => {
      if (i === 0) return;
      const cols = $(row).find('td');
      if (cols.length < 8) return;

      const finish = parseInt($(cols[0]).text().trim()) || 99;
      const name = $(cols[3]).find('a').text().trim() || $(cols[3]).text().trim();
      const jockey = $(cols[6]).find('a').text().trim() || $(cols[6]).text().trim();
      if (!name) return;

      horses.push({
        finish,
        gate:    parseInt($(cols[1]).text()) || 0,
        number:  parseInt($(cols[2]).text()) || 0,
        name:    name.trim(),
        weight:  $(cols[5]).text().trim(),
        jockey:  jockey.trim(),
        time:    $(cols[7]).text().trim(),
        odds:    parseFloat($(cols[12]).text()) || 0,
        popular: parseInt($(cols[13]).text()) || 0,
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
  // dataフォルダを確実に作成
  const dataDir = path.resolve('data');
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
    console.log('dataフォルダを作成しました');
  }

  const dataPath = path.resolve('data/races.json');
  
  // 既存データ読み込み（ファイルがなければ空配列）
  let existing = [];
  if (fs.existsSync(dataPath)) {
    try {
      const raw = fs.readFileSync(dataPath, 'utf8');
      existing = JSON.parse(raw);
      console.log(`既存データ: ${existing.length}件`);
    } catch (e) {
      console.log('既存データの読み込み失敗、空配列で開始');
      existing = [];
    }
  } else {
    console.log('races.jsonが存在しないため新規作成します');
  }

  const existingIds = new Set(existing.map(r => r.id));
  const allIds = generateRaceIds();
  
  // 未取得IDだけ抽出して最大20件
  const targetIds = allIds.filter(id => !existingIds.has(id)).slice(0, 20);
  console.log(`取得対象: ${targetIds.length}件`);

  const newRaces = [];
  for (const id of targetIds) {
    console.log(`取得中: ${id}`);
    const result = await fetchRaceResult(id);
    if (result) {
      newRaces.push(result);
      console.log(`✓ ${result.name || id} ${result.horses.length}頭`);
    } else {
      console.log(`- データなし: ${id}`);
    }
    await sleep(5000);
  }

  // 既存データに追記して保存
  const all = [...existing, ...newRaces];
  fs.writeFileSync(dataPath, JSON.stringify(all, null, 2), 'utf8');
  console.log(`完了: 新規${newRaces.length}件 / 合計${all.length}件`);
}

main();
