const DEFAULT_JWT_SECRET = 'dev-secret-change-in-production';
const DEFAULT_AI_KEY_SECRET = 'dev-ai-secret-change-in-production';

export function validateProductionConfig(env: NodeJS.ProcessEnv | Record<string, string | undefined>): void {
  if (env.NODE_ENV !== 'production') return;
  const invalid: string[] = [];
  const strong = (value: string | undefined, defaultValue: string) => Boolean(
    value
    && value.length >= 32
    && value !== defaultValue
    && !/change[_ -]?me|改成|placeholder/i.test(value),
  );
  if (!strong(env.JWT_SECRET, DEFAULT_JWT_SECRET)) invalid.push('JWT_SECRET');
  if (!strong(env.AI_KEY_SECRET, DEFAULT_AI_KEY_SECRET)) invalid.push('AI_KEY_SECRET');
  if (invalid.length) {
    throw new Error(`[安全] 生产环境必须设置非默认强随机密钥：${invalid.join('、')}`);
  }
}
