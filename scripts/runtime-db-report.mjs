import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const projectRoot = process.cwd();
const runtimeDbPath = path.join(projectRoot, '.cache', 'fund-sync', 'runtime.db');

function main() {
  const db = new DatabaseSync(runtimeDbPath);

  try {
    const latestRun = db.prepare('SELECT synced_at, fund_count FROM runtime_runs ORDER BY id DESC LIMIT 1').get();
    const totalRuns = db.prepare('SELECT COUNT(*) AS count FROM runtime_runs').get();
    const totalFunds = db.prepare('SELECT COUNT(*) AS count FROM latest_fund_runtime').get();
    const sampleOil = db.prepare("SELECT code, market_price, market_date, market_time, synced_at FROM latest_fund_runtime WHERE code IN ('160723', '501018', '161129') ORDER BY code").all();

    console.log('runtime.db report');
    console.log('================');
    console.log('dbPath:', runtimeDbPath);
    console.log('totalRuns:', Number(totalRuns?.count || 0));
    console.log('latestSyncedAt:', latestRun?.synced_at || '');
    console.log('latestFundCount:', Number(latestRun?.fund_count || 0));
    console.log('latestFundRows:', Number(totalFunds?.count || 0));
    console.log('oilFunds:');
    for (const row of sampleOil) {
      console.log(`  ${row.code} price=${row.market_price} market=${row.market_date} ${row.market_time} synced=${row.synced_at}`);
    }
  } finally {
    db.close();
  }
}

main();
