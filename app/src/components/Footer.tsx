// 备案号页脚：由构建期环境变量 VITE_ICP_BEIAN 驱动。
// 未配置（备案号还没下来）时整行自动隐藏；配置后展示并链接到工信部备案系统（合规要求）。
// 公安备案号可选：VITE_POLICE_BEIAN（文字）+ VITE_POLICE_BEIAN_URL（链接）。
const ICP = (import.meta as any).env?.VITE_ICP_BEIAN as string | undefined;
const POLICE = (import.meta as any).env?.VITE_POLICE_BEIAN as string | undefined;
const POLICE_URL = (import.meta as any).env?.VITE_POLICE_BEIAN_URL as string | undefined;

export function Footer() {
  if (!ICP && !POLICE) return null;
  return (
    <footer className="beian-footer">
      {ICP && (
        <a href="https://beian.miit.gov.cn/" target="_blank" rel="noreferrer noopener">
          {ICP}
        </a>
      )}
      {POLICE && (
        <a href={POLICE_URL || 'https://www.beian.gov.cn/'} target="_blank" rel="noreferrer noopener">
          {POLICE}
        </a>
      )}
    </footer>
  );
}
