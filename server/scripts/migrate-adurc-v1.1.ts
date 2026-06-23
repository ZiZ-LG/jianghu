// 数据迁移 · G64111 v1.1：ADURC 角色重命名 + 客户四分类
// ───────────────────────────────────────────────────────────────────────
// 背景：v1.0→v1.1 把角色 TB→R、R→C 重命名，客户分类由 3 类扩为 4 类。
// 计分逻辑不变，仅符号/分类口径变化。本脚本迁移【存量真实数据】（prod）。
// dev/SQLite 一般用 seed-demo 重建，无需跑本脚本。
//
// 跑法：cd server && npx tsx scripts/migrate-adurc-v1.1.ts
//
// ⚠️ 顺序铁律：角色必须【先 R→C，再 TB→R】，反了会把原 TB 和原 R 一起错并成 C。
// ⚠️ 客户类型旧③(地方/民营)数值仍为 3，但语义已改为「分布式头部民企」；
//    若某客户实为「地方能源国企」，迁移后请人工把其 customerType 改为 2。
import { prisma } from '../src/prisma.js';

async function main() {
  // 1) 角色重命名（顺序关键，防链式撞车）
  const r2c = await prisma.oppRole.updateMany({ where: { role: 'R' }, data: { role: 'C' } });
  const tb2r = await prisma.oppRole.updateMany({ where: { role: 'TB' }, data: { role: 'R' } });
  // 候选层 PersonSuggestion.suggestedRole 同步（同样按序）
  const sr2c = await prisma.personSuggestion.updateMany({ where: { suggestedRole: 'R' }, data: { suggestedRole: 'C' } });
  const stb2r = await prisma.personSuggestion.updateMany({ where: { suggestedRole: 'TB' }, data: { suggestedRole: 'R' } });

  // 2) 客户类型：旧②(央国企电力建设集团)→新④(EPC总承包商)。旧①不变；旧③数值不变(语义见顶部注释)
  const acc2to4 = await prisma.account.updateMany({ where: { customerType: 2 }, data: { customerType: 4 } });
  const opp2to4 = await prisma.opportunity.updateMany({ where: { customerType: 2 }, data: { customerType: 4 } });

  console.log('角色 OppRole  R→C:', r2c.count, '| TB→R:', tb2r.count);
  console.log('候选 suggest R→C:', sr2c.count, '| TB→R:', stb2r.count);
  console.log('客户类型 2→4  account:', acc2to4.count, '| opportunity:', opp2to4.count);
  console.log('✅ 迁移完成。请人工复核：原“地方/民营”(customerType=3) 中属“地方能源国企”的客户，改为 customerType=2。');
}

main().then(() => process.exit(0)).catch((e) => { console.error('❌ 迁移失败：', e); process.exit(1); });
