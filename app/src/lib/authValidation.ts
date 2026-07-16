export interface AuthValidationInput {
  mode: 'login' | 'register';
  method: 'phone' | 'email';
  tenantName: string;
  name: string;
  phone: string;
  email: string;
  password: string;
}

const MAINLAND_PHONE = /^1[3-9]\d{9}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validateAuth(input: AuthValidationInput): string | null {
  if (input.mode === 'register' && !input.tenantName.trim()) return '请输入工作区名称';
  if (input.mode === 'register' && !input.name.trim()) return '请输入姓名';
  if (input.method === 'phone' && !MAINLAND_PHONE.test(input.phone.trim())) return '请输入有效的中国大陆手机号';
  if (input.method === 'email' && !EMAIL.test(input.email.trim())) return '请输入有效的邮箱地址';
  if (input.password.length < 6) return '密码至少 6 位';
  return null;
}

export function authErrorMessage(cause: unknown): string {
  const value = typeof cause === 'object' && cause !== null ? cause as { code?: unknown; message?: unknown } : null;
  const code = typeof value?.code === 'string' ? value.code : '';
  const message = typeof value?.message === 'string' ? value.message.trim() : '';
  if (code === 'network_error') return '网络连接失败，请检查网络后重试';
  if (code === 'timeout') return '请求超时，请重试';
  if (message && /[\u3400-\u9fff]/.test(message)) return message;
  return '操作失败，请重试';
}
