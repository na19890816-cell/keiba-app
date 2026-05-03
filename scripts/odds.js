import fetch from 'node-fetch';
import fs from 'fs';
import path from 'path';

const sleep = ms => new Promise(r => setTimeout(r, ms));

// shutuba.jsonを読み込んでオッズを更新
async function fetchOdds(raceId) {
  // JRA公式オッズページのAPIを使用
  const urls = [
    // パターン1: netkeibaオッズAPI
    `https://race.netkeiba.com/api/api_get_jra_odds.html?race_id=${raceId}&type=1&format=json`,
    // パターン2: 別エンドポイント
    `https://race.netkeiba.com/odds/index.html?type=b1&race_id=${raceId}&housiki=ct`,
  ];

  for (const url of urls) {
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Referer': `https://race.netkeiba.com/race/shutuba.html?race_id=${raceId}`
        }
      });
      if (!res.ok) continue;

      const txt = await res.text();
      // ← この行の直後に追加
      console.log(`  APIレスポンス(先頭100文字): ${txt.slice(0,100)}`);

      // JSONレスポンスの処理
      if (txt.includes('"status":"ok"') || txt.includes('"WIN_SHOW"')) {
        try {
          const json = JSON.parse(txt);
          const winData = json?.data?.odds?.WIN_SHOW
                       || json?.data?.WIN_SHOW
                       || null;
          if (winData && Object.keys(winData).length > 0) {
            console.log(`  ✓ オッズAPI成功: ${raceId}`);
            return winData;
          }
        } catch (_) {}
      }

      // HTMLレスポンスの処理（oddstableから抽出）
      if (txt.includes('Odds') || txt.includes('単勝')) {
        const odds = {};
        const matches = [...txt.matchAll(/umaban['"]\s*:\s*['"](\d+)['"]\s*.*?odds['"]\s*:\s*['"]([0-9.]+)['"]/gs)];
        for (const m of matches) {
          const num = m[1].padStart(2, '0');
          odds[num] = [m[2]];
        }
        if (Object.keys(odds).length > 0) {
          console.log(`  ✓ HTMLパース成功: ${raceId} ${Object.keys(odds).length}頭分`);
          return odds;
        }
      }

    } catch (e) {
      console.log(`  URL失敗 ${url.slice(0,50)}: ${e.message}`);
    }
    await sleep(1000);
  }
  return null;
}

async function main() {
  const dataPath = path.resolve('data/shutuba.json');
  if (!fs.existsSync(dataPath)) {
    console.log('shutuba.jsonなし → スキップ');
    return;
  }

  let races = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
  console.log(`対象レース: ${races.length}件`);

  // 今日のレースのみを対象
  const today = new Date();
  const y  = today.getFullYear();
  const m  = String(today.getMonth() + 1).padStart(2, '0');
  const d  = String(today.getDate()).padStart(2, '0');
  const todayStr = `${y}${m}${d}`;

  // 発走時刻が現在時刻より後のレースを対象
  const nowHour = today.getUTCHours() + 9; // JST
  const nowMin  = today.getUTCMinutes();
  const nowTotal = nowHour * 60 + nowMin;

  let updatedCount = 0;

  for (const race of races) {
    // 今日のレースのみ
    // race_idの日付と今日を比較
    // race.idから日付を取得（shutuba.jsonのfetchedAtを使用）
    const fetchedDate = race.fetchedAt
      ? race.fetchedAt.slice(0, 10).replace(/-/g, '')
      : '';

    // 今週のレースを対象（日付チェック）
    if (!race.startTime) continue;

    const [h, min] = race.startTime.split(':').map(Number);
    const raceTotal = h * 60 + min;

    // 発走60分前〜発走済み（30分後まで）を対象
    const diff = raceTotal - nowTotal;
    if (diff > 90 || diff < -30) {
      console.log(`  スキップ(時間外) ${race.name} ${race.startTime} diff:${diff}分`);
      continue;
    }

    console.log(`オッズ取得中: ${race.id} ${race.name} ${race.startTime}`);
    const winData = await fetchOdds(race.id);

    if (winData) {
      for (const h of race.horses) {
        const key = String(h.number).padStart(2, '0');
        if (winData[key]) {
          h.odds = parseFloat(winData[key][0] || winData[key]) || h.odds;
        }
      }
      race.oddsUpdatedAt = new Date().toISOString();
      updatedCount++;
    }

    await sleep(3000);
  }

  fs.writeFileSync(dataPath, JSON.stringify(races, null, 2), 'utf8');
  console.log(`完了: ${updatedCount}件更新`);
}

main();
