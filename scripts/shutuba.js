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

// 今週の土日の日付を取得
function getThisWeekend() {
  const dates = [];
  const today = new Date();
  const dow   = today.getDay(); // 0=日,1=月...6=土

  // 直近の土曜
  const sat = new Date(today);
  sat.setDate(today.getDate() + (6 - dow + 7) % 7);
  if ((6 - dow + 7) % 7 === 0) sat.setDate(sat.getDate()); // 今日が土曜

  // 日曜
  const sun = new Date(sat);
  sun.setDate(sat.getDate() + 1);

  for (const d of [sat, sun]) {
    const y  = d.getFullYear();
    const m  = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    dates.push(`${y}${m}${dd}`);
  }
  return dates;
}

// 開催日のレースID一覧を取得
async function fetchRaceIdsByDate(dateStr) {
  // netkeibaの開催日別ページ（静的HTML）
  const url = `https://race.netkeiba.com/top/race_list_sub.html?kaisai_date=${dateStr}`;
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });
    if (!res.ok) return [];
    const buf  = await res.arrayBuffer();
    const html = new TextDecoder('euc-jp').decode(buf);
    const $    = cheerio.load(html);

    const ids = [];
    // race_idを含むリンクを全て抽出
    $('a[href*="race_id="]').each((_, el) => {
      const href = $(el).attr('href') || '';
      const m    = href.match(/race_id=(\d{12})/);
      if (m && !ids.includes(m[1])) ids.push(m[1]);
    });

    // 別パターンのURLも探す
    $('a[href*="/race/"]').each((_, el) => {
      const href = $(el).attr('href') || '';
      const m    = href.match(/\/race\/(\d{12})/);
      if (m && !ids.includes(m[1])) ids.push(m[1]);
    });

    console.log(`  ${dateStr}: ${ids.length}件のレースID`);
    return ids;
  } catch (e) {
    console.error(`日程取得失敗 ${dateStr}: ${e.message}`);
    return [];
  }
}

// 出馬表を取得（レース前なのでresultではなくshutubaページ）
async function fetchShutuba(raceId) {
  const url = `https://race.netkeiba.com/race/shutuba.html?race_id=${raceId}`;
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });
    if (!res.ok) return null;
    const buf     = await res.arrayBuffer();
    const decoded = new TextDecoder('euc-jp').decode(buf);
    const $       = cheerio.load(decoded);

    // レース名・条件
    const raceName  = $('h1.RaceName').text().trim()
                   || $('div.RaceName').text().trim()
                   || '';
    const raceData1 = $('div.RaceData01').text().replace(/\s+/g,' ').trim();
    const raceData2 = $('div.RaceData02').text().replace(/\s+/g,' ').trim();
    const allTxt    = raceName + ' ' + raceData1 + ' ' + raceData2;

    const dm  = allTxt.match(/(\d{3,4})m/);
    const tm  = allTxt.match(/(芝|ダート|障害)/);
    const dm2 = allTxt.match(/(右|左|直線)/);
    const grm = allTxt.match(/(G1|G2|G3|OP|L|3勝|2勝|1勝|未勝利|新馬)/);
    const tim = raceData1.match(/(\d{2}:\d{2})/); // 発走時刻

    const venueCode = raceId.slice(4, 6);

    // 出走馬
    const horses = [];
    $('table.Shutuba_Table tr, table.shutuba_table tr').each((i, row) => {
      if (i === 0) return;
      const cols = $(row).find('td');
      if (cols.length < 6) return;

      // 馬名
      const nameEl = $(cols[3]).find('a').first();
      const name   = nameEl.text().trim() || $(cols[3]).text().trim();
      if (!name || name.length < 2) return;

      // 馬番・枠番
      const gate   = parseInt($(cols[0]).text().trim()) || 0;
      const number = parseInt($(cols[1]).text().trim()) || 0;

      // 騎手
      const jockeyEl = $(cols[6]).find('a').first();
      const jockey   = jockeyEl.text().trim() || $(cols[6]).text().trim();

      // 斤量
      const weight = $(cols[5]).text().trim();

      // 馬体重（出馬表では前走体重が掲載されることがある）
      const bwTxt = $(cols[8])?.text().trim() || '';
      const bwm   = bwTxt.match(/(\d{3})/);
      const bodyWeight = bwm ? parseInt(bwm[1]) : 0;

      // 予想オッズ（出馬表に掲載されている場合）
      const oddsEl = $(cols[9])?.text().trim() || $(cols[10])?.text().trim() || '';
      const odds   = parseFloat(oddsEl) || 0;

      if (!name) return;
      horses.push({
        gate, number, name: name.trim(),
        jockey: jockey.trim(),
        weight, bodyWeight, odds,
      });
    });

    if (horses.length === 0) return null;

// 予想オッズをAPIから取得
    try {
      await sleep(2000);
      const oddsUrl = `https://race.netkeiba.com/api/api_get_jra_odds.html?race_id=${raceId}&type=1&format=json`;
      const oddsRes = await fetch(oddsUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Referer': `https://race.netkeiba.com/race/shutuba.html?race_id=${raceId}`
        }
      });
      if (oddsRes.ok) {
        const txt = await oddsRes.text();
        // レスポンスの形式を確認してパース
        const clean = txt.trim();
        if (clean.startsWith('{') || clean.startsWith('[')) {
          const json = JSON.parse(clean);
          // WIN_SHOWまたはWinOddsの形式に対応
          const winData = json?.data?.odds?.WIN_SHOW
                       || json?.data?.WIN_SHOW
                       || json?.odds?.WIN
                       || null;
          if (winData) {
            for (const h of horses) {
              const key = String(h.number).padStart(2, '0');
              if (winData[key]) {
                h.odds = parseFloat(winData[key][0] || winData[key]) || 0;
              }
            }
            const sample = horses.find(h => h.odds > 0);
            console.log(`  オッズ取得: ${sample?.name} ${sample?.odds}倍`);
          } else {
            console.log(`  オッズ形式未対応: ${clean.slice(0,80)}`);
          }
        }
      }
    } catch (e) {
      console.log(`  オッズ取得失敗: ${e.message}`);
    }
    
    return {
      id:        raceId,
      name:      raceName,
      venue:     VENUE_MAP[venueCode] || venueCode,
      year:      raceId.slice(0, 4),
      distance:  dm  ? dm[1]  : '',
      track:     tm  ? tm[1]  : '',
      dir:       dm2 ? dm2[1] : '',
      grade:     grm ? grm[1] : '',
      startTime: tim ? tim[1] : '',
      raceData1,
      raceData2,
      horses,
      fetchedAt: new Date().toISOString(),
    };
  } catch (e) {
    console.error(`出馬表取得失敗 ${raceId}: ${e.message}`);
    return null;
  }
}

async function main() {
  const dataDir  = path.resolve('data');
  const dataPath = path.resolve('data/shutuba.json');
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

  // 今週末の日付
  const weekends = getThisWeekend();
  console.log(`対象日程: ${weekends.join(', ')}`);

  // 既存データ読み込み（上書きではなくマージ）
  let existing = [];
  if (fs.existsSync(dataPath)) {
    try {
      existing = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
      console.log(`既存出馬表: ${existing.length}件`);
    } catch (_) {}
  }
  const existingIds = new Set(existing.map(r => r.id));

  // 全race_idを収集
  const allIds = [];
  for (const dateStr of weekends) {
    const ids = await fetchRaceIdsByDate(dateStr);
    allIds.push(...ids);
    await sleep(3000);
  }

  // 重複除去・新規のみ
  const newIds = [...new Set(allIds)].filter(id => !existingIds.has(id));
  console.log(`新規取得対象: ${newIds.length}件`);

  const newRaces = [];
  for (const id of newIds) {
    console.log(`出馬表取得中: ${id}`);
    const result = await fetchShutuba(id);
    if (result) {
      newRaces.push(result);
      console.log(
        `✓ ${result.name||id} ${result.horses.length}頭` +
        ` [${result.track}${result.distance}m ${result.grade}]` +
        ` ${result.startTime}`
      );
    } else {
      console.log(`- データなし: ${id}`);
    }
    await sleep(4000);
  }

  // 保存（今週分のみ保持・古いデータは削除）
  const thisWeekPrefix = weekends[0].slice(0, 6); // 例: "202605"
  const filtered = existing.filter(r => r.id.startsWith(thisWeekPrefix));
  const all = [...filtered, ...newRaces];

  fs.writeFileSync(dataPath, JSON.stringify(all, null, 2), 'utf8');
  console.log(`完了: 新規${newRaces.length}件 / 合計${all.length}件`);
}

main();
