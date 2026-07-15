import { describe, expect, it } from 'vitest';
import { buildVoiceExtractPayload } from './IntelCapture';

describe('IntelCapture voice payload', () => {
  it('keeps the explicit visit person in the final API payload', () => {
    expect(buildVoiceExtractPayload({
      text: '虚构拜访记录',
      accountId: 'acc-test',
      opportunityId: 'opp-test',
      personId: 'person-test',
      priorText: '[本次拜访对象] 测试联系人',
    })).toEqual({
      text: '虚构拜访记录',
      accountId: 'acc-test',
      opportunityId: 'opp-test',
      personId: 'person-test',
      priorText: '[本次拜访对象] 测试联系人',
    });
  });
});
