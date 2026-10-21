import { number, type RecordValue } from "./api";

export type CreditCategory = "plan" | "activity" | "welcome" | "enterprise" | "other";
export type SegmentState = "expired" | "soon" | "normal" | "long" | "unknown";

export const CATEGORY_LABELS: Record<CreditCategory, string> = {
  plan: "套餐额度",
  activity: "活动奖励",
  welcome: "新人权益",
  enterprise: "企业配额",
  other: "其他额度",
};

// 上游不提供类别字段，只能按名称提示；顺序即优先级，"个人版拉新权益包"须先命中新人权益而非套餐。
const CATEGORY_RULES: [CreditCategory, RegExp][] = [
  ["welcome", /拉新|新人|新用户|邀请|welcome|invite|referral/i],
  ["activity", /裂变|活动|奖励|签到|旅行|打卡|bonus|reward|check-?in/i],
  ["plan", /体验版|订阅|套餐|专业版|个人版|plan|subscription|\bpro\b/i],
];

const DAY = 86400;
const SOON_WINDOW = 7 * DAY;
const LONG_TERM = 365 * DAY;
const STALE_AFTER = DAY;

export interface CreditSegment {
  remaining: number;
  total: number;
  expiresAt: number | null;
  state: SegmentState;
}

export interface CreditPackage {
  key: string;
  label: string;
  code: string;
  category: CreditCategory;
  remaining: number;
  total: number;
  soonRemaining: number;
  expiredRemaining: number;
  soonest: number | null;
  longTerm: boolean;
  segments: CreditSegment[];
}

export interface CreditBreakdown {
  total: number | null;
  unlimited: boolean;
  partial: boolean;
  fetchedAt: number | null;
  stale: boolean;
  segmentCount: number;
  soon: { remaining: number; count: number };
  expired: { remaining: number; count: number };
  soonest: { at: number; remaining: number } | null;
  categories: { category: CreditCategory; remaining: number; share: number }[];
  packages: CreditPackage[];
}

function timestamp(value: unknown): number | null {
  const n = number(value);
  return n !== null && n > 0 ? n : null;
}

export function creditCategory(name: string, enterprise: boolean): CreditCategory {
  if (enterprise) return "enterprise";
  return CATEGORY_RULES.find(([, pattern]) => pattern.test(name))?.[0] ?? "other";
}

function segmentState(at: number | null, now: number): SegmentState {
  if (at === null) return "unknown";
  if (at <= now) return "expired";
  if (at - now <= SOON_WINDOW) return "soon";
  return at - now > LONG_TERM ? "long" : "normal";
}

/** Group one account's official credit snapshot by package with expiry pressure. */
export function creditBreakdown(credits: RecordValue, now: number): CreditBreakdown {
  const enterprise = credits.enterprise === true;
  const packages = new Map<string, CreditPackage>();
  const soon = { remaining: 0, count: 0 };
  const expired = { remaining: 0, count: 0 };
  let soonest: CreditBreakdown["soonest"] = null;
  let segmentCount = 0;
  for (const raw of Array.isArray(credits.segments) ? credits.segments : []) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) continue;
    const item = raw as RecordValue;
    const remaining = number(item.remaining);
    if (remaining === null) continue;
    const total = Math.max(number(item.total) ?? remaining, remaining);
    const expiresAt = timestamp(item.expires_at);
    const name = typeof item.source === "string" && item.source ? item.source : "积分";
    const code = typeof item.package_code === "string" ? item.package_code : "";
    // 同名套餐可能对应不同编号（国际 Bonus Pack），只按名称会把两个套餐合并。
    const key = code || name;
    let pkg = packages.get(key);
    if (!pkg) {
      pkg = {
        key,
        label: name,
        code,
        category: creditCategory(name, enterprise),
        remaining: 0,
        total: 0,
        soonRemaining: 0,
        expiredRemaining: 0,
        soonest: null,
        longTerm: false,
        segments: [],
      };
      packages.set(key, pkg);
    }
    const state = segmentState(expiresAt, now);
    pkg.segments.push({ remaining, total, expiresAt, state });
    pkg.remaining += remaining;
    pkg.total += total;
    segmentCount += 1;
    if (state === "expired") {
      pkg.expiredRemaining += remaining;
      expired.remaining += remaining;
      expired.count += 1;
      continue;
    }
    if (state === "soon") {
      pkg.soonRemaining += remaining;
      soon.remaining += remaining;
      soon.count += 1;
    }
    if (expiresAt === null) continue;
    pkg.soonest = pkg.soonest === null ? expiresAt : Math.min(pkg.soonest, expiresAt);
    if (soonest === null || expiresAt < soonest.at) soonest = { at: expiresAt, remaining };
    else if (expiresAt === soonest.at) soonest.remaining += remaining;
  }
  const rows = [...packages.values()];
  const nameCounts = new Map<string, number>();
  for (const pkg of rows) nameCounts.set(pkg.label, (nameCounts.get(pkg.label) ?? 0) + 1);
  for (const pkg of rows) {
    if ((nameCounts.get(pkg.label) ?? 0) > 1 && pkg.code)
      pkg.label += ` · ${/code_\d+/i.exec(pkg.code)?.[0] ?? pkg.code.slice(-6)}`;
    pkg.segments.sort((a, b) => (a.expiresAt ?? Infinity) - (b.expiresAt ?? Infinity));
    const live = pkg.segments.filter((segment) => segment.state !== "expired");
    pkg.longTerm = live.length > 0 && live.every((segment) => segment.state === "long");
  }
  rows.sort((a, b) => b.remaining - a.remaining);
  const byCategory = new Map<CreditCategory, number>();
  for (const pkg of rows)
    byCategory.set(pkg.category, (byCategory.get(pkg.category) ?? 0) + pkg.remaining);
  const sum = rows.reduce((acc, pkg) => acc + pkg.remaining, 0);
  const fetchedAt = timestamp(credits.fetched_at);
  // 无限额度只存在于企业账号；个人结果即使带 unlimited 也不能被当作无限。
  const unlimited = enterprise && credits.unlimited === true;
  return {
    total: unlimited
      ? null
      : (number(credits.credits) ?? number(credits.remaining) ?? (segmentCount ? sum : null)),
    unlimited,
    partial: credits.partial === true,
    fetchedAt,
    stale: fetchedAt !== null && now - fetchedAt > STALE_AFTER,
    segmentCount,
    soon,
    expired,
    soonest,
    categories: [...byCategory.entries()]
      .filter(([, remaining]) => remaining > 0)
      .sort((a, b) => b[1] - a[1])
      .map(([category, remaining]) => ({ category, remaining, share: remaining / sum })),
    packages: rows,
  };
}

const pad = (n: number) => String(n).padStart(2, "0");

export function dateLabel(at: number, now: number): string {
  const date = new Date(at * 1000);
  if (date.getFullYear() !== new Date(now * 1000).getFullYear())
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function untilLabel(at: number, now: number): string {
  const diff = at - now;
  if (diff <= 0) return "已过期";
  if (diff < 3600) return "1 小时内";
  if (diff < DAY) return `${Math.floor(diff / 3600)} 小时后`;
  if (diff > LONG_TERM) return "长期有效";
  return `${Math.floor(diff / DAY)} 天后`;
}

export function agoLabel(at: number, now: number): string {
  const diff = Math.max(0, now - at);
  if (diff < 60) return "1 分钟内";
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
  if (diff < DAY) return `${Math.floor(diff / 3600)} 小时前`;
  return `${Math.floor(diff / DAY)} 天前`;
}

/** Token expiry in seconds; inventory reports milliseconds, legacy rows seconds. */
export function tokenExpiry(row: RecordValue): number | null {
  const ms = timestamp(row.token_expires_at) ?? timestamp(row.expiresAt);
  return ms !== null ? ms / 1000 : timestamp(row.expires_at);
}
