/**
 * 训练指标管理模块
 * 用于存储和查询基金的训练状态（MAE、样本数等）
 */

/**
 * 获取所有训练指标
 */
export async function getAllTrainingMetrics(db) {
  const result = await db.prepare(
    'SELECT code, mae_train, mae_validation, mae_validation_30, mae_validation_30_robust, generated_at FROM training_metrics ORDER BY code'
  ).all();
  
  return (result.results || []).map(row => ({
    code: row.code,
    maeTrain: row.mae_train,
    maeValidation: row.mae_validation,
    maeValidation30: row.mae_validation_30,
    maeValidation30Robust: row.mae_validation_30_robust,
    generatedAt: row.generated_at,
    // 计算训练状态
    status: getTrainingStatus(row),
  }));
}

/**
 * 获取单个基金的训练指标
 */
export async function getTrainingMetricsByCode(db, code) {
  const row = await db.prepare(
    'SELECT code, mae_train, mae_validation, mae_validation_30, mae_validation_30_robust, generated_at FROM training_metrics WHERE code = ?'
  ).bind(code).first();
  
  if (!row) return null;
  
  return {
    code: row.code,
    maeTrain: row.mae_train,
    maeValidation: row.mae_validation,
    maeValidation30: row.mae_validation_30,
    maeValidation30Robust: row.mae_validation_30_robust,
    generatedAt: row.generated_at,
    status: getTrainingStatus(row),
  };
}

/**
 * 判断训练状态
 * @returns {string} 'trained' | 'calibrated' | 'pending'
 */
function getTrainingStatus(row) {
  const maeValidation30 = row.mae_validation_30 || 0;
  const maeValidation = row.mae_validation || 0;
  
  // 如果有 robust MAE 且有效，说明已训练
  if (row.mae_validation_30_robust && row.mae_validation_30_robust > 0) {
    return 'trained';
  }
  
  // 如果有普通 MAE 且有效，说明已校准但未充分训练
  if (maeValidation30 > 0 || maeValidation > 0) {
    return 'calibrated';
  }
  
  // 否则是待校验状态
  return 'pending';
}

/**
 * 批量保存训练指标
 */
export async function saveTrainingMetrics(db, metrics) {
  const syncedAt = new Date().toISOString();
  const statements = [];
  
  for (const metric of metrics) {
    statements.push(
      db.prepare(
        `INSERT OR REPLACE INTO training_metrics 
         (code, mae_train, mae_validation, mae_validation_30, mae_validation_30_robust, generated_at, synced_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        metric.code,
        metric.maeTrain || 0,
        metric.maeValidation || 0,
        metric.maeValidation30 || 0,
        metric.maeValidation30Robust || null,
        metric.generatedAt || syncedAt,
        syncedAt,
        syncedAt
      )
    );
  }
  
  if (statements.length === 0) {
    return { ok: true, count: 0 };
  }
  
  await db.batch(statements);
  
  return {
    ok: true,
    count: statements.length,
    codes: metrics.map(m => m.code),
  };
}

/**
 * 从本地生成的 offline-research.json 文件中提取训练指标
 */
export async function loadTrainingMetricsFromOfflineResearch(code) {
  try {
    // 注意：在 Worker 环境中无法直接访问本地文件
    // 这个函数用于在本地脚本中调用，通过 HTTP 从 GitHub Pages 加载
    const url = `https://987144016.github.io/lof-Premium-Rate-Web/generated/${code}-offline-research.json`;
    const response = await fetch(url);
    if (!response.ok) return null;
    const data = await response.json();
    
    return {
      code,
      maeTrain: data?.segmented?.maeTrain || 0,
      maeValidation: data?.segmented?.maeValidation || 0,
      maeValidation30: data?.segmented?.maeValidation30 || 0,
      maeValidation30Robust: data?.segmented?.maeValidation30Robust,
      generatedAt: data?.generatedAt || new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

/**
 * 同步 GitHub Pages 上的训练指标到 Worker 数据库
 * 这个函数应该在 GitHub Actions 或本地脚本中调用
 */
export async function syncTrainingMetricsFromGitHub(db, codes) {
  const startTime = Date.now();
  console.log('[TrainingSync] Starting sync from GitHub Pages...');
  
  try {
    const metrics = [];
    
    // 批量加载训练指标
    for (const code of codes) {
      const metric = await loadTrainingMetricsFromOfflineResearch(code);
      if (metric && (metric.maeValidation30 > 0 || metric.maeValidation30Robust)) {
        metrics.push(metric);
      }
    }
    
    if (metrics.length === 0) {
      return {
        ok: true,
        count: 0,
        skipped: codes.length,
        reason: 'No valid training metrics found',
      };
    }
    
    // 保存到数据库
    const result = await saveTrainingMetrics(db, metrics);
    
    const duration = Date.now() - startTime;
    console.log(`[TrainingSync] Sync completed: ${result.count}/${codes.length} in ${duration}ms`);
    
    return {
      ...result,
      duration,
      skipped: codes.length - result.count,
    };
  } catch (error) {
    console.error('[TrainingSync] Sync failed:', error);
    return {
      ok: false,
      error: error.message,
      duration: Date.now() - startTime,
    };
  }
}
