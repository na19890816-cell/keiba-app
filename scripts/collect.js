import fetch from 'node-fetch';
import * as cheerio from 'cheerio';
import fs from 'fs';

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
    const mm = String(date.getMonth() + 1).padStart(2, '0');
    const dd = String(date.getDate()).padStart(2, '0');
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
  return [...new Set(ids)].slice(0, 20);
}

async function fetchRaceResult(raceId) {
  const url = `https://db.netkeiba.com/race/${raceId}/`;
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept-Charset': 'EUC-JP,utf-8'
      }
    });
    if (!res.ok) return null;

    // EUC-JP → UTF-8 変換
    const buf = await res.arrayBuffer();
    const decoded = new TextDecoder('euc-jp').decode(buf);
    const $ = cheerio.load(decoded);

    // レース基本情報
    const raceTitle = $('div.RaceList_Item02 h1').text().trim()
                   || $('h1.RaceName').text().trim()
                   || '';
    const raceData1 = $('div.RaceData01').text().replace(/\s+/g,' ').trim();
    const raceData2 = $('div.RaceData02').text().replace(/\s+/g,' ').trim();

    const raceInfo = {
      id: raceId,
      name: raceTitle,
      data1: raceData1,
      data2: raceData2,
      date: '',
      course: '',
      distance: '',
      track: '',
    };

    // data2から距離・馬場を抽出
    const distMatch = raceData2.match(/(\d{3,4})m/);
    if (distMatch) raceInfo.distance = distMatch[1];
    const trackMatch = raceData2.match(/(芝|ダート|障害)/);
    if (trackMatch) raceInfo.track = trackMatch[1];

    // 出走馬結果
    const horses = [];
    $('table.race_table_01 tr, table.nk_tb_common tr').each((i, row) => {
      if (i === 0) return;
      const cols = $(row).find('td');
      if (cols.length < 8) return;

      const finishText = $(cols[0]).text().trim();
      const finish = parseInt(finishText) || 99;

      // 馬名はリンクテキストから取得
      const nameEl = $(cols[3]).find('a').first();
      const name = nameEl.text().trim() || $(cols[3]).text().trim();

      const jockeyEl = $(cols[6]).find('a').first();
      const jockey = jockeyEl.text().trim() || $(cols[6]).text().trim();

      const timeText = $(cols[7]).text().trim();
      const oddsText = $(cols[12]).text().trim();
      const popText  = $(cols[13]).text().trim();

      if (!name) return;

      horses.push({
        finish,
        gate:    parseInt($(cols[1]).text()) || 0,
        number:  parseInt($(cols[2]).text()) || 0,
        name,
        weight:  $(cols[5]).text().trim(),
        jockey,
        time:    timeText,
        odds:    parseFloat(oddsText) || 0,
        popular: parseInt(popText) || 0,
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
  const dataPath = 'data/races.json';
  let existing = [];
  try {
    existing = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
  } catch (_) {}

  const existingIds = new Set(existing.map(r => r.id));
  const raceIds = generateRaceIds();
  const newRaces = [];

  for (const id of raceIds) {
    if (existingIds.has(id)) { console.log(`スキップ: ${id}`); continue; }
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

  fs.writeFileSync(dataPath, JSON.stringify([...existing, ...newRaces], null, 2));
  console.log(`完了: 新規${newRaces.length}件 / 合計${existing.length + newRaces.length}件`);
}

main();
