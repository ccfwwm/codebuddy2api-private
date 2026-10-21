import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vite-plus/test";
import { Credentials } from "./pages/Credentials";
import { useResource, type Credential } from "./api";
import type * as ApiModule from "./api";
import { BalanceExpiry } from "./CreditsPanel";
import { creditBreakdown, creditCategory, dateLabel } from "./credits";

vi.mock("./api", async (original) => ({
  ...(await original<typeof ApiModule>()),
  useResource: vi.fn(),
}));
beforeEach(() => vi.restoreAllMocks());

const NOW = 1_800_000_000;
const DAY = 86400;
const seg = (
  source: string,
  package_code: string,
  remaining: number,
  expires_at: number | null,
  total = remaining,
) => ({ source, package_code, remaining, total, expires_at });

function renderWith(row: Credential) {
  vi.mocked(useResource).mockReturnValue({
    data: [row],
    reload: vi.fn(),
    loading: false,
    refreshing: false,
    error: null,
  });
  render(<Credentials />);
}

function openCreditsTab() {
  fireEvent.click(screen.getByRole("button", { name: "详情" }));
  fireEvent.click(screen.getByRole("tab", { name: "官方额度" }));
  return screen.getByRole("dialog");
}

it("classifies by name with welcome and activity taking precedence over edition keywords", () => {
  expect(creditCategory("CodeBuddy个人版拉新权益包", false)).toBe("welcome");
  expect(creditCategory("CodeBuddy个人版国内运营裂变包", false)).toBe("activity");
  expect(creditCategory("CodeBuddy个人体验版", false)).toBe("plan");
  expect(creditCategory("Free Plan Subscription", false)).toBe("plan");
  expect(creditCategory("Bonus Pack", false)).toBe("activity");
  expect(creditCategory("Promotion Credits", false)).toBe("other");
  expect(creditCategory("Bonus Pack", true)).toBe("enterprise");
});

it("groups by package code, keeps same-name packages apart and ranks by remaining", () => {
  const b = creditBreakdown(
    {
      segments: [
        seg("Bonus Pack", "TCACA_code_006_x", 100, NOW + 20 * DAY),
        seg("Bonus Pack", "TCACA_code_007_y", 150, NOW + 3 * DAY),
        seg("Bonus Pack", "TCACA_code_007_y", 50, NOW + 10 * DAY),
        seg("Free Plan Subscription", "TCACA_code_035_z", 250, NOW + 3000 * DAY, 300),
      ],
    },
    NOW,
  );
  expect(b.packages.map((p) => [p.label, p.remaining, p.total, p.category])).toEqual([
    ["Free Plan Subscription", 250, 300, "plan"],
    ["Bonus Pack · code_007", 200, 200, "activity"],
    ["Bonus Pack · code_006", 100, 100, "activity"],
  ]);
  expect(b.categories.map((c) => [c.category, c.remaining])).toEqual([
    ["activity", 300],
    ["plan", 250],
  ]);
});

it("measures expiry pressure at the 7-day and long-term boundaries, excluding expired credits", () => {
  const b = creditBreakdown(
    {
      segments: [
        seg("运营裂变包", "a", 30, NOW + 7 * DAY + 1),
        seg("运营裂变包", "a", 20, NOW + 7 * DAY),
        seg("运营裂变包", "a", 5, NOW + 7 * DAY),
        seg("运营裂变包", "a", 10, NOW),
        seg("体验版", "b", 40, NOW + 366 * DAY),
        seg("体验版", "b", 1, null),
        seg("订阅", "c", 7, NOW + 366 * DAY),
        seg("签到", "d", 3, NOW - DAY),
      ],
    },
    NOW,
  );
  const byKey = Object.fromEntries(b.packages.map((p) => [p.key, p]));
  expect(b.total).toBe(116);
  expect(b.expired).toEqual({ remaining: 13, count: 2 });
  expect(b.soon).toEqual({ remaining: 25, count: 2 });
  expect(b.soonest).toEqual({ at: NOW + 7 * DAY, remaining: 25 });
  expect(byKey.a?.segments.map((s) => s.state)).toEqual(["expired", "soon", "soon", "normal"]);
  expect(byKey.a?.soonest).toBe(NOW + 7 * DAY);
  // 无到期信息的段和只剩过期段都不能被标成长期有效。
  expect([byKey.b?.longTerm, byKey.c?.longTerm, byKey.d?.longTerm]).toEqual([false, true, false]);
});

it("grants unlimited only to enterprise results and flags day-old snapshots", () => {
  expect(creditBreakdown({ unlimited: true, enterprise: true, segments: [] }, NOW)).toMatchObject({
    unlimited: true,
    total: null,
  });
  expect(
    creditBreakdown({ unlimited: true, enterprise: false, credits: 12, segments: [] }, NOW),
  ).toMatchObject({ unlimited: false, total: 12 });
  const caption = render(
    <BalanceExpiry credits={{ unlimited: true, enterprise: false }} now={NOW} />,
  );
  expect(caption.container.textContent).toBe("无到期信息");
  caption.rerender(<BalanceExpiry credits={{ unlimited: true, enterprise: true }} now={NOW} />);
  expect(caption.container.textContent).toBe("企业无限额度");
  caption.rerender(
    <BalanceExpiry credits={{ segments: [seg("签到", "a", 5, NOW - DAY)] }} now={NOW} />,
  );
  expect(caption.container.textContent).toBe("已全部过期，待同步");
  expect(creditBreakdown({ fetched_at: NOW - DAY }, NOW).stale).toBe(false);
  expect(creditBreakdown({ fetched_at: NOW - DAY - 1 }, NOW).stale).toBe(true);
});

it("shows credit expiry on the card and package composition in the official credits tab", () => {
  const now = Date.now() / 1000;
  renderWith({
    id: "cn",
    name: "cn.info",
    profile: "cn-cli",
    enabled: true,
    health: "ready",
    token_expires_at: (now + 5 * 3600) * 1000,
    sync_error: "credits: 积分查询失败",
    credits: {
      credits: 1250,
      fetched_at: now - 3 * DAY,
      // 快照时最早的一段尚未过期；卡片必须跳过它，显示下一段仍有效的到期时间。
      soonest_expiry: now - DAY,
      segments: [
        seg("CodeBuddy个人版国内运营裂变包", "TCACA_code_007_a", 150, now + 2 * DAY),
        seg("CodeBuddy个人版国内运营裂变包", "TCACA_code_007_a", 100, now - DAY),
        seg("CodeBuddy个人体验版", "TCACA_code_008_b", 1000, now + 3000 * DAY),
      ],
    },
  });
  const cardDate = screen.getByText(dateLabel(now + 2 * DAY, now));
  expect(cardDate.parentElement?.textContent).toBe(`最近到期 ${dateLabel(now + 2 * DAY, now)}`);
  expect(screen.getByText(`Token 至 ${dateLabel(now + 5 * 3600, now)}`)).toBeTruthy();

  const dialog = openCreditsTab();
  expect(
    within(dialog).getByText("最近同步失败：credits: 积分查询失败；以下为 3 天前的快照"),
  ).toBeTruthy();
  expect(within(dialog).getByText("快照中有 1 段共 100 积分已过期，下次同步后移除")).toBeTruthy();
  const activity = within(dialog).getByText("CodeBuddy个人版国内运营裂变包").closest("summary")!;
  expect(within(activity).getByText("7 天内到期 150")).toBeTruthy();
  expect(within(activity).getByText("已过期 100")).toBeTruthy();
  const plan = within(dialog).getByText("CodeBuddy个人体验版").closest("summary")!;
  expect(within(plan).getByText("长期有效")).toBeTruthy();
  expect(within(plan).queryByText(/7 天内到期/)).toBeNull();
  expect(
    within(dialog).getByRole("img", { name: /额度构成：套餐额度 1,000，活动奖励 250/ }),
  ).toBeTruthy();
});

it("shows an empty credits tab and card caption before the first balance sync", () => {
  renderWith({ id: "new", name: "new.info", profile: "intl-work", enabled: true, health: "ready" });
  expect(screen.getByText("尚未同步")).toBeTruthy();
  const dialog = openCreditsTab();
  expect(within(dialog).getByText("尚未同步官方额度")).toBeTruthy();
});
