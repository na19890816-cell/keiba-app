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

    // レーステーブルの存在確認
    const table = $('table.race_table_01');
    if (!table.length) return null;

    // ── レース基本情報 ──
    // レース名
    const raceName = $('h1.RaceName').text().trim()
                  || $('div.RaceList_Item02 h1').text().trim()
                  || '';

    // RaceData01：発走時刻・天気など
    const data1 = $('div.RaceData01').text().replace(/\s+/g, ' ').trim();

    // RaceData02：距離・馬場・コース情報
    const data2 = $('div.RaceData02').text().replace(/\s+/g, ' ').trim();

    const distMatch  = data2.match(/(\d{3,4})m/);
    const trackMatch = data2.match(/(芝|ダート|障害)/);
    const condMatch  = data2.match(/(良|稍重|重|不良)/);
    const dirMatch   = data2.match(/(右|左|直線)/);

    // 日付：race_idから直接生成（最も確実）
    const y   = raceId.slice(0, 4);
    const mon = raceId.slice(4, 6);
    // 開催場コードから場名を変換
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
      year:     y,
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
      if (i === 0) return; // ヘッダースキップ
      const cols = $(row).find('td');
      if (cols.length < 11) return;

      const finishText = $(cols[0]).text().trim();
      const finish = parseInt(finishText) || 99;

      // 馬名・騎手はリンクテキストから取得
      const name   = $(cols[3]).find('a').text().trim()
                  || $(cols[3]).text().trim();
      const jockey = $(cols[6]).find('a').text().trim()
                  || $(cols[6]).text().trim();
      if (!name) return;

      // 馬体重と増減を分離（例："482(-4)"）
      const weightRaw = $(cols[13]).text().trim();
      const weightMatch = weightRaw.match(/(\d+)\(([+-]?\d+)\)/);
      const bodyWeight  = weightMatch ? parseInt(weightMatch[1]) : 0;
      const weightDiff  = weightMatch ? parseInt(weightMatch[2]) : 0;

      horses.push({
        finish,
        gate:       parseInt($(cols[1]).text().trim()) || 0,
        number:     parseInt($(cols[2]).text().trim()) || 0,
        name:       name.trim(),
        ageGender:  $(cols[4]).text().trim(),   // 性齢（牡5等）
        weight:     $(cols[5]).text().trim(),   // 斤量
        jockey:     jockey.trim(),
        time:       $(cols[7]).text().trim(),
        timeDiff:   $(cols[8]).text().trim(),   // 着差
        passing:    $(cols[9]).text().trim(),   // 通過順
        last3F:     $(cols[10]).text().trim(),  // 上がり3F
        odds:       parseFloat($(cols[11]).text().trim()) || 0,  // 単勝オッズ
        popular:    parseInt($(cols[12]).text().trim())   || 0,  // 人気
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
      // 取得確認ログ（最初の馬のオッズを表示）
      const sample = result.horses[0];
      console.log(
        `✓ ${result.name || id} ` +
        `${result.horses.length}頭 ` +
        `[${result.track}${result.distance}m ${result.cond}] ` +
        `先頭馬オッズ:${sample?.odds} 人気:${sample?.popular}`
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
