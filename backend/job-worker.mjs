import { parentPort, workerData } from 'node:worker_threads';

try {
  let result;
  if (workerData.kind === 'upload') {
    const { validateWorkbook } = await import('./validate-workbook.mjs');
    result = await validateWorkbook(workerData.file, workerData.moduleId);
  } else if (workerData.kind === 'inspect') {
    const { inspectWorkbook } = await import('./review-engine.mjs');
    result = await inspectWorkbook(workerData);
  } else if (workerData.kind === 'generate') {
    const { generateDashboard } = await import('./real-data/generate-dashboard.mjs');
    result = await generateDashboard({ ...workerData, onStage: stage => parentPort.postMessage({ stage }) });
  } else if (['aggregate', 'analyze', 'compose', 'coverage'].includes(workerData.kind)) {
    const { runFlowJob } = await import('./incremental/jobs.mjs');
    result = await runFlowJob(workerData);
  } else throw new Error('Unknown worker operation');
  parentPort.postMessage({ result });
} catch (error) {
  const safe = typeof error.message === 'string' && /[\u4e00-\u9fff]/.test(error.message) && !/ENOENT|EACCES|\/Users\/|[A-Z]:\\/i.test(error.message);
  parentPort.postMessage({ error: workerData.kind === 'upload' ? '文件无法读取，请检查是否为完整、未加密的 Excel 工作簿。' : safe ? error.message : '真实数据生成失败，请检查来源、已确认规则及本机依赖后重试。', detail: error.stack });
}
