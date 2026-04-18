// scripts/collect.js
import fetch from 'node-fetch';
import * as cheerio from 'cheerio';
import fs from 'fs';

// 規約準拠：リクエスト間隔を確保する
const sleep = ms => new Promise(r => setTimeout(r, ms));

// 今日から遡って取得するレースIDを生成
function generateRaceIds(daysBack = 7) {
  const ids = [];
  const venues = ['05','06']; // 東京・中山（最初は2場に絞る）
  
  for (let d = 1; d <= daysBack; d++) {
    const date = new Date();
    date.setDate(date.getDate() - d);
    // 土日のみ（競馬開催日）
    if (date.getDay() === 0 || date.getDay() === 6) {
      const y = date.getFullYear();
      const m = String(date.getMonth()+1).padStart(2,'0');
      const day = String(date.getDate()).padStart(2,'0');
      venues.forEach(v => {
        for (let r = 1; r <= 12; r++) {
          ids.push(`${y}${v}01${String(d).padStart(2,'0')}${String(r).padStart(2,'0')}`);
        }
      });
    }
  }
  return ids.slice(0, 15); // 1日最大15レース
}

async function fetchRaceResult(raceId) {
  const url = `https://db.netkeiba.com/race/${raceId}/`;
  
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; personal-research-bot/1.0)'
      }
    });
    
    if (!res.ok) return null;
    
    const html = await res.text();
    const $ = cheerio.load(html);
    
    // レース基本情報
    const raceInfo = {
      id: raceId,
      date: $('.RaceData01').text().trim(),
      course: $('.RaceData02 span').eq(0).text().trim(),
      distance: $('.RaceData02 span').eq(2).text().trim(),
      track: $('.RaceData02 span').eq(3).text().trim(),
    };
    
    // 出走馬結果
    const horses = [];
    $('table.race_table_01 tr').each((i, row) => {
      if (i === 0) return; // ヘッダースキップ
      const cols = $(row).find('td');
      if (cols.length < 10) return;
      
      horses.push({
        finish:   parseInt($(cols[0]).text()) || 99,
        gate:     parseInt($(cols[1]).text()) || 0,
        number:   parseInt($(cols[2]).text()) || 0,
        name:     $(cols[3]).text().trim(),
        weight:   $(cols[5]).text().trim(),
        jockey:   $(cols[6]).text().trim(),
        time:     $(cols[7]).text().trim(),
        odds:     parseFloat($(cols[12]).text()) || 0,
        popular:  parseInt($(cols[13]).text()) || 0,
      });
    });
    
    return { ...raceInfo, horses };
    
  } catch (e) {
    console.error(`取得失敗 ${raceId}: ${e.message}`);
    return null;
  }
}

async function main() {
  // 既存データ読み込み
  const dataPath = 'data/races.json';
  let existing = [];
  if (fs.existsSync(dataPath)) {
    existing = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
  }
  
  const existingIds = new Set(existing.map(r => r.id));
  const raceIds = generateRaceIds(14); // 過去2週分
  
  const newRaces = [];
  for (const id of raceIds) {
    if (existingIds.has(id)) continue; // 重複スキップ
    
    console.log(`取得中: ${id}`);
    const result = await fetchRaceResult(id);
    
    if (result && result.horses.length > 0) {
      newRaces.push(result);
      console.log(`✓ ${result.horses.length}頭`);
    }
    
    // 規約準拠：5秒待機
    await sleep(5000);
  }
  
  // データを追記保存
  const all = [...existing, ...newRaces];
  fs.mkdirSync('data', { recursive: true });
  fs.writeFileSync(dataPath, JSON.stringify(all, null, 2));
  
  console.log(`完了: 新規${newRaces.length}件 / 合計${all.length}件`);
}

main();
