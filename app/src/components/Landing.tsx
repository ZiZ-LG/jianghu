import { Footer } from './Footer';

// 备案审核期对外展示的「中性静态介绍页」。
// 关键：不含登录/注册入口、不调用任何后端 API、措辞中性（避免"销售/CRM/SaaS/平台/企业服务"等像经营的词），
// 以降低个人 ICP 备案被通信管理局打回的概率。备案号下来后把 VITE_BEIAN_MODE 设回 0 即恢复完整应用。
export function Landing() {
  return (
    <div className="landing">
      <main className="landing-main">
        <div className="landing-logo">江</div>
        <h1 className="landing-title">江湖</h1>
        <p className="landing-sub">个人效率工具 · 信息整理与可视化</p>
        <p className="landing-desc">
          一个用于整理与可视化复杂信息关系的个人工具，帮助梳理思路、记录要点。
          本站为个人学习与实践项目，正在建设中。
        </p>
        <div className="landing-tag">网站建设中，敬请期待</div>
      </main>
      <Footer />
    </div>
  );
}
