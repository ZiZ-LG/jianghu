import { buildApp } from './app.js';
import { startJobWorker, startPatrol } from './jobs.js';
import { validateProductionConfig } from './security/productionConfig.js';

// 加载本地 .env（生产环境用真实环境变量，文件不存在则忽略）
try { process.loadEnvFile(); } catch { /* no .env in prod */ }

try {
  validateProductionConfig(process.env);
} catch (error) {
  console.error(error instanceof Error ? error.message : '[安全] 生产配置无效');
  process.exit(1);
}

const app = await buildApp({ logger: true });
const port = Number(process.env.PORT || 3001);
app.listen({ port, host: '0.0.0.0' }).then(() => {
  console.log(`江湖 API listening on http://localhost:${port}`);
  startJobWorker(); // 江湖自算后台 worker（消费 EnrichJob 队列）
  startPatrol(); // 江湖巡检：每日扫活跃商机 → 提醒型提案进收件箱（确定性·零 LLM·铁律②）
}).catch((e) => { console.error(e); process.exit(1); });
