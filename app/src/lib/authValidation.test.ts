import { describe, expect, it } from 'vitest';
import { authErrorMessage, validateAuth } from './authValidation';

const valid = {
  mode: 'register' as const,
  method: 'phone' as const,
  tenantName: '华东销售一部',
  name: '张三',
  phone: '13800138000',
  email: '',
  password: 'secret1',
};

describe('认证表单中文校验', () => {
  it.each([
    [{ ...valid, tenantName: ' ' }, '请输入工作区名称'],
    [{ ...valid, name: '' }, '请输入姓名'],
    [{ ...valid, phone: '123' }, '请输入有效的中国大陆手机号'],
    [{ ...valid, password: '12345' }, '密码至少 6 位'],
    [{ ...valid, method: 'email' as const, phone: '', email: 'bad' }, '请输入有效的邮箱地址'],
  ])('提交前阻止无效注册资料', (input, expected) => {
    expect(validateAuth(input)).toBe(expected);
  });

  it('有效登录和注册不返回错误', () => {
    expect(validateAuth(valid)).toBeNull();
    expect(validateAuth({ ...valid, mode: 'login', tenantName: '', name: '' })).toBeNull();
  });

  it('把网络和未知英文错误收口为中文', () => {
    expect(authErrorMessage({ code: 'network_error', message: 'Failed to fetch' })).toBe('网络连接失败，请检查网络后重试');
    expect(authErrorMessage(new Error('Internal Server Error'))).toBe('操作失败，请重试');
    expect(authErrorMessage(new Error('账号或密码错误'))).toBe('账号或密码错误');
  });
});
