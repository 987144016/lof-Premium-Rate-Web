#!/usr/bin/env node
/**
 * 同步训练指标到 Cloudflare Worker D1 数据库
 * 用法：node scripts/sync-training-to-worker.js
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = promisify(exec);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(__dirname, '..');
const generatedDir = path.join(projectRoot, 'public', 'generated');
const workerDir = path.join(projectRoot, 'cloudflare', 'worker');

// 需要训练状态的基金代码（与 App.tsx 中的 OFFLINE_RESEARCH_CODES 对齐）
const OFFLINE_RESEARCH_CODES = [
  '160216', '160723', '161725', '501018', '161129', '160719', '161116', '164701',
  '501225', '513310', '161130', '160416', '162719', '162411', '161125', '161126',
  '161127', '162415', '159329', '513080', '520830', '513730', '164824', '160644',
  '159100', '520870', '160620', '161217', '161124', '501300', '160140', '520580',
  '159509', '501312', '501011', '501050', '160221', '165520', '167301', '161226',
  '161128', '513800', '513880', '513520', '513100', '513500', '159502', '513290',
  '159561', '513030', '513850', '513300', '159518', '163208', '159577', '513400',
  '159985', '168204', '501036', '501043', '160807', '161607', '161039'
];

/**
 * 从 offline-research.json 文件中提取训练指标
 */
async function loadTrainingMetrics(code) {
  try {
    const filePath = path.join(generatedDir, `${code}-offline-research.json`);
    const content = await fs.readFile(filePath, 'utf-8');
    const data = JSON.parse(content);
    
    return {
      code,
      maeTrain: data?.segmented?.maeTrain || 0,
      maeValidation: data?.segmented?.maeValidation || 0,
      maeValidation30: data?.segmented?.maeValidation30 || 0,
      maeValidation30Robust: data?.segmented?.maeValidation30Robust,
      generatedAt: data?.generatedAt || new Date().toISOString(),
    };
  } catch (error) {
    // 文件不存在或解析失败
    return null;
  }
}

/**
 * 生成 SQL 插入语句
 */
function generateInsertSQL(metrics) {
  const syncedAt = new Date().toISOString();
  const values = [];
  
  for (const metric of metrics) {
    const maeValidation30Robust = metric.maeValidation30Robust !== undefined && metric.maeValidation30Robust !== null
      ? metric.maeValidation30Robust
      : 'NULL';
    
    values.push(
      `('${metric.code}', ${metric.maeTrain || 0}, ${metric.maeValidation || 0}, ${metric.maeValidation30 || 0}, ${maeValidation30Robust}, '${metric.generatedAt}', '${syncedAt}')`
    );
  }
  
  return `
INSERT OR REPLACE INTO training_metrics 
(code, mae_train, mae_validation, mae_validation_30, mae_validation_30_robust, generated_at, synced_at)
VALUES ${values.join(',\n')};
`;
}

/**
 * 使用 wrangler 执行 SQL
 */
async function executeSQL(sql) {
  try {
    // 将 SQL 写入临时文件
    const tempFile = path.join(workerDir, '.temp-sync-training.sql');
    await fs.writeFile(tempFile, sql);
    
    // 使用 wrangler d1 execute 执行
    const { stdout, stderr } = await execAsync(
      `cd "${workerDir}" && npx wrangler d1 execute premium-runtime-db --remote --file="${tempFile}"`,
      { maxBuffer: 10 * 1024 * 1024 }
    );
    
    // 清理临时文件
    await fs.unlink(tempFile).catch(() => {});
    
    return { success: true, stdout, stderr };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

/**
 * 主函数
 */
async function main() {
  console.log('========================================');
  console.log('  同步训练指标到 Cloudflare Worker D1');
  console.log('========================================');
  console.log('');
  
  // 1. 加载所有训练指标
  console.log('[1/4] 加载本地训练指标...');
  const metrics = [];
  let loadedCount = 0;
  let skippedCount = 0;
  
  for (const code of OFFLINE_RESEARCH_CODES) {
    const metric = await loadTrainingMetrics(code);
    if (metric && (metric.maeValidation30 > 0 || metric.maeValidation30Robust)) {
      metrics.push(metric);
      loadedCount++;
    } else {
      skippedCount++;
    }
  }
  
  console.log(`    已加载：${loadedCount}/${OFFLINE_RESEARCH_CODES.length}`);
  console.log(`    跳过：${skippedCount}（无有效数据）`);
  
  if (metrics.length === 0) {
    console.log('');
    console.log('❌ 没有可用的训练指标');
    console.log('   请先运行：npm run sync:research');
    console.log('');
    return;
  }
  
  // 2. 生成 SQL
  console.log('');
  console.log('[2/4] 生成 SQL 语句...');
  const sql = generateInsertSQL(metrics);
  console.log(`    生成 ${metrics.length} 条记录`);
  
  // 3. 执行 SQL
  console.log('');
  console.log('[3/4] 执行 SQL 到 D1 数据库...');
  const result = await executeSQL(sql);
  
  if (!result.success) {
    console.log('');
    console.log('❌ 执行失败:', result.error);
    console.log('');
    console.log('提示：请确保已登录 Cloudflare 并配置了 D1 数据库');
    console.log('      运行：npx wrangler login');
    console.log('');
    return;
  }
  
  // 4. 验证结果
  console.log('');
  console.log('[4/4] 验证同步结果...');
  console.log('    ✅ 同步成功！');
  console.log('');
  console.log('同步详情：');
  console.log(`  - 总计：${metrics.length} 个基金`);
  console.log(`  - 已训练：${metrics.filter(m => m.maeValidation30Robust).length}`);
  console.log(`  - 已校准：${metrics.filter(m => m.maeValidation30 && !m.maeValidation30Robust).length}`);
  console.log('');
  
  // 显示部分示例
  console.log('示例数据：');
  metrics.slice(0, 5).forEach(m => {
    const status = m.maeValidation30Robust ? '已训练' : m.maeValidation30 ? '已校准' : '待校验';
    console.log(`  ${m.code}: MAE=${m.maeValidation30?.toFixed(4) || '-'} ${status}`);
  });
  
  console.log('');
  console.log('========================================');
  console.log('  同步完成！');
  console.log('========================================');
  console.log('');
  console.log('下一步：');
  console.log('  1. 访问 Worker 健康检查端点验证数据');
  console.log('     https://your-worker.workers.dev/health');
  console.log('');
  console.log('  2. 查询训练指标 API');
  console.log('     https://your-worker.workers.dev/api/training/metrics');
  console.log('');
}

// 运行主函数
main().catch(error => {
  console.error('❌ 错误:', error);
  process.exit(1);
});
