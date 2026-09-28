// 脱敏总线（P5·E6）：所有送云端 LLM 的载荷必经此处——新增任何云端调用只允许挂进
// 这条总线、禁止旁路。本地 claude CLI 通道不出网，不经过本总线。
// 规则替换为 ⟨占位符⟩：保语义不保值（模型仍能理解"配置了密钥"这类事实）。

export interface ScrubResult {
  text: string;
  count: number; // 本段替换处数
}

export interface ScrubTotals {
  /** 累计替换处数（进程内），按月持久化由调用方负责 */
  total: number;
}

const totals: ScrubTotals = { total: 0 };

// ---------- 硬规则（常开，顺序敏感：先长后短防部分吞吃） ----------

// 私钥块（含证书请求）：-----BEGIN ... KEY----- 到 -----END ...-----
const PRIVATE_KEY = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g;
const CERT_BLOCK = /-----BEGIN CERTIFICATE-----[\s\S]*?-----CERTIFICATE-----/g;

// Bearer 头
const BEARER = /\bBearer\s+[A-Za-z0-9\-_.~+/]+=*/gi;

// api key/token/password 赋值形（yaml/ini/env/js/ts/json 通吃）
const KEY_ASSIGN =
  /\b(api[_-]?key|apikey|access[_-]?token|secret|token|password|passwd|pwd|authorization|auth)\b["'\s:=]{1,4}["']?([A-Za-z0-9\-_.]{16,})["']?/gi;

// 连接串
const CONN_STRING = /\b((?:postgres|postgresql|mysql|mongodb(\+srv)?|redis|rediss|amqp|ftp|jdbc:[a-z0-9]+):\/\/[^\s'"`]+)/gi;

// 内网 IP（10./172.16-31./192.168.）与常见内网域名前缀（跳过版本号样式的 x.y）
const INTRANET_IP = /\b(10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3})\b(?!\.\d)/g;

// 疑似密钥长 base64/hex（≥40 连续字符、无空格）——保守：只打非常高熵段
const LONG_SECRET = /(?<![A-Za-z0-9_-])[A-Za-z0-9+/_-]{44,}={0,2}(?![A-Za-z0-9_-])/g;

interface Rule {
  name: string;
  re: RegExp;
  placeholder: string;
}

const HARD_RULES: Rule[] = [
  { name: 'private_key', re: PRIVATE_KEY, placeholder: '⟨PRIVATE_KEY⟩' },
  { name: 'cert', re: CERT_BLOCK, placeholder: '⟨CERTIFICATE⟩' },
  { name: 'bearer', re: BEARER, placeholder: 'Bearer ⟨TOKEN⟩' },
  { name: 'conn', re: CONN_STRING, placeholder: '⟨CONN_STRING⟩' },
  { name: 'key_assign', re: KEY_ASSIGN, placeholder: '$1=⟨SECRET⟩' },
  { name: 'intranet_ip', re: INTRANET_IP, placeholder: '⟨INTRANET_IP⟩' },
  { name: 'long_secret', re: LONG_SECRET, placeholder: '⟨SECRET_BLOB⟩' },
];

// ---------- 可选档（默认关；开启时叠加） ----------

const PHONE = /(?<!\d)1[3-9]\d{9}(?!\d)/g;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

export interface ScrubOptions {
  /** 可选档：手机号/邮箱脱敏（collect 设置里暂无开关，预留给设置页） */
  pii?: boolean;
  /** 代码片段裁剪（``` 围栏内容截 200 字） */
  trimCode?: boolean;
}

/** 单段文本脱敏（幂等：⟨占位符⟩ 不会被二次改写） */
export function scrubText(text: string, opts: ScrubOptions = {}): ScrubResult {
  if (!text) return { text, count: 0 };
  let out = text;
  let count = 0;
  for (const rule of HARD_RULES) {
    out = out.replace(rule.re, (_m, ...groups) => {
      count++;
      // key_assign 保留左值语义：api_key=⟨SECRET⟩
      if (rule.name === 'key_assign') return `${groups[0]}=⟨SECRET⟩`;
      return rule.placeholder;
    });
  }
  if (opts.pii) {
    out = out.replace(PHONE, () => { count++; return '⟨PHONE⟩'; });
    out = out.replace(EMAIL, () => { count++; return '⟨EMAIL⟩'; });
  }
  if (opts.trimCode) {
    out = out.replace(/```[a-zA-Z]*\n([\s\S]{0,600}?)```/g, (m, body: string) => {
      if (body.length <= 200) return m;
      count++;
      return m.replace(body, `${body.slice(0, 200)}\n…⟨代码已裁剪⟩\n`);
    });
  }
  totals.total += count;
  return { text: out, count };
}

/** 脱敏一个对象载荷（序列化→脱敏→回传文本与计数）；调用方拿文本送 LLM */
export function scrubPayload(payload: unknown, opts: ScrubOptions = {}): ScrubResult {
  return scrubText(JSON.stringify(payload), opts);
}

/** 进程内累计计数（采集中心"本月已脱敏 N 处"读这里 + 月度持久化） */
export function scrubTotals(): ScrubTotals {
  return totals;
}
