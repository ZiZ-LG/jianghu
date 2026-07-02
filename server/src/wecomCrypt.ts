// 企业微信回调消息加解密（WXBizMsgCrypt 协议，纯函数零依赖）。
// 协议：SHA1 签名(token/timestamp/nonce/密文 四串字典序拼接) + AES-256-CBC（key=Base64Decode(EncodingAESKey+'=')，IV=key 前 16 字节）。
// 明文帧 = random(16B) + msgLen(4B 网络序) + msg + receiveId(corpId)，PKCS7 填充到 32 字节块。
// 线上只用 签名校验+解密（事件响应直接回明文 "success"）；加密方向仅测试脚本模拟企微推送时用。
import { createHash, createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/** 回调签名：sha1(sort(token, timestamp, nonce, cipherText).join(''))。 */
export function wecomSignature(token: string, timestamp: string, nonce: string, cipherText: string): string {
  return createHash('sha1').update([token, timestamp, nonce, cipherText].sort().join('')).digest('hex');
}

function aesKey(encodingAesKey: string): Buffer {
  const key = Buffer.from(encodingAesKey + '=', 'base64');
  if (key.length !== 32) throw new Error('EncodingAESKey 无效（应为 43 位 Base64 字符）');
  return key;
}

/** 解密回调密文 → { msg: 明文(echostr 或事件 XML), receiveId: 企业 corpId(用于双重校验) }。 */
export function decryptWecomMsg(encodingAesKey: string, cipherText: string): { msg: string; receiveId: string } {
  const key = aesKey(encodingAesKey);
  const de = createDecipheriv('aes-256-cbc', key, key.subarray(0, 16));
  de.setAutoPadding(false); // 企微是 32 字节块 PKCS7，自己去填充
  const plain = Buffer.concat([de.update(Buffer.from(cipherText, 'base64')), de.final()]);
  const pad = plain[plain.length - 1];
  if (!pad || pad > 32) throw new Error('回调解密失败：填充无效');
  const body = plain.subarray(0, plain.length - pad);
  const msgLen = body.readUInt32BE(16);
  return { msg: body.subarray(20, 20 + msgLen).toString('utf8'), receiveId: body.subarray(20 + msgLen).toString('utf8') };
}

/** 加密（测试脚本模拟企微推送用；线上被动响应不需要）。 */
export function encryptWecomMsg(encodingAesKey: string, msg: string, receiveId: string): string {
  const key = aesKey(encodingAesKey);
  const msgBuf = Buffer.from(msg, 'utf8');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(msgBuf.length, 0);
  let frame = Buffer.concat([randomBytes(16), len, msgBuf, Buffer.from(receiveId, 'utf8')]);
  const padLen = 32 - (frame.length % 32) || 32;
  frame = Buffer.concat([frame, Buffer.alloc(padLen, padLen)]);
  const en = createCipheriv('aes-256-cbc', key, key.subarray(0, 16));
  en.setAutoPadding(false);
  return Buffer.concat([en.update(frame), en.final()]).toString('base64');
}

/** 从事件 XML 提取标签文本（支持 CDATA；企微事件结构扁平，正则足够，不引 XML 解析依赖）。 */
export function xmlTag(xml: string, tag: string): string {
  const m = xml.match(new RegExp(`<${tag}>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</${tag}>`));
  return m?.[1] ?? '';
}
