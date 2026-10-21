import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vite-plus/test";
import { Credentials } from "./pages/Credentials";
import { api, credentialResponse, useResource, type Credential } from "./api";

vi.mock("./api", async (original) => ({
  ...(await original<typeof import("./api")>()),
  useResource: vi.fn(),
}));
beforeEach(() => vi.restoreAllMocks());

function openDetail(credentialName: string) {
  const row = screen
    .getAllByText(credentialName)
    .map((el) => el.closest<HTMLElement>("tr, article"))
    .find(
      (tr) =>
        tr && within(tr).queryByRole("button", { name: new RegExp(`任务配置.*${credentialName}`) }),
    );
  if (!row) throw new Error(`row for ${credentialName} not found`);
  fireEvent.click(
    within(row).getByRole("button", { name: new RegExp(`任务配置.*${credentialName}`) }),
  );
}

function fixture() {
  const rows: Credential[] = credentialResponse({
    credentials: [
      {
        id: "cnwork",
        account_key: "cnwork",
        name: "cn-work.info",
        profile: "cn-work",
        enabled: true,
        health: "ready",
        auto_checkin: true,
        auto_travel: true,
        travel_supported: true,
        growth_supported: true,
        auto_growth: true,
        growth_auto: { chat_5: true },
        checkin: { state: "success", date: "2026-10-19", message: "签到成功" },
      },
      {
        id: "intl",
        account_key: "intl",
        name: "intl-work.info",
        profile: "intl-work",
        enabled: true,
        health: "ready",
        growth_supported: false,
        auto_checkin: false,
        travel_supported: false,
      },
    ],
  });
  const reload = vi.fn();
  vi.mocked(useResource).mockReturnValue({
    data: rows,
    reload,
    loading: false,
    refreshing: false,
    error: null,
  });
  return { rows, reload };
}

function job(overrides: Record<string, unknown>) {
  return {
    key: "growth:cnwork",
    status: "running",
    total: 1,
    completed: 0,
    current: [],
    results: [],
    started_at: 1,
    finished_at: null,
    account: "cnwork",
    kind: "all",
    ...overrides,
  };
}

const growthView = {
  supported: true,
  auto_growth: true,
  growth_auto: { chat_5: true },
  tasks: [
    {
      task_code: "chat_5",
      title: "对话活跃补报",
      description: "",
      credit: 100,
      energy: 0,
      locked: false,
      accept_status: "accepted",
      target: 5,
      current: 5,
      claimable: true,
      claimed: false,
      group: "behavior",
      automatable: true,
    },
    {
      task_code: "Model_chat_GLM5.2",
      title: "GLM-5.2 真实对话",
      description: "",
      credit: 100,
      energy: 5,
      locked: false,
      accept_status: "not_accepted",
      target: 1,
      current: 0,
      claimable: false,
      claimed: false,
      group: "chat",
      automatable: true,
    },
    {
      task_code: "wb_wechat_oa_subscribe_task",
      title: "关注公众号",
      description: "",
      credit: 50,
      energy: 0,
      locked: false,
      accept_status: "not_accepted",
      target: 1,
      current: 0,
      claimable: false,
      claimed: false,
      group: "other",
      automatable: false,
    },
  ],
};

it("shows the growth drawer only for CN personal accounts and lists grouped tasks", async () => {
  fixture();
  const get = vi.spyOn(api, "get").mockImplementation(async (url: string) => {
    expect(url).toBe("/credentials/cnwork/growth-tasks");
    return { data: growthView } as never;
  });
  render(<Credentials />);
  openDetail("cn-work.info");
  await waitFor(() => expect(get).toHaveBeenCalled());
  expect(await screen.findByText("成长计划")).toBeTruthy();
  expect(screen.getByText("行为上报")).toBeTruthy();
  expect(screen.getByText("真实对话")).toBeTruthy();
  expect(screen.getByText("（开启即授权消耗该账号对话额度）")).toBeTruthy();
  expect(screen.getByRole("switch", { name: "自动对话活跃补报 cn-work.info" })).toHaveProperty(
    "checked",
    true,
  );
  expect(screen.getByRole("switch", { name: "自动GLM-5.2 真实对话 cn-work.info" })).toHaveProperty(
    "checked",
    false,
  );
});

it("hides the growth drawer for non-CN accounts", async () => {
  fixture();
  const get = vi.spyOn(api, "get");
  render(<Credentials />);
  openDetail("intl-work.info");
  await act(async () => {});
  expect(screen.queryByText("成长计划")).toBeNull();
  // Only the page-wide job poll runs; the task list is never fetched for this account.
  expect(get.mock.calls.map(([url]) => url)).toEqual(["/growth-jobs"]);
});

it("patches the per-task switch by merging the current mapping", async () => {
  fixture();
  vi.spyOn(api, "get").mockResolvedValue({ data: growthView } as never);
  const patch = vi.spyOn(api, "patch").mockResolvedValue({
    data: { id: "cnwork", revision: 7 },
  } as never);
  render(<Credentials />);
  openDetail("cn-work.info");
  const taskSwitch = await screen.findByRole("switch", {
    name: "自动GLM-5.2 真实对话 cn-work.info",
  });
  await act(async () => fireEvent.click(taskSwitch));
  await waitFor(() => expect(patch).toHaveBeenCalled());
  expect(patch).toHaveBeenCalledWith("/credentials/cnwork", {
    growth_auto: { chat_5: true, "Model_chat_GLM5.2": true },
  });
});

it("runs one task manually and surfaces the claim result", async () => {
  fixture();
  vi.spyOn(api, "get").mockResolvedValue({ data: growthView } as never);
  const post = vi.spyOn(api, "post").mockResolvedValue({
    data: job({
      status: "completed",
      kind: "single",
      completed: 1,
      total: 1,
      finished_at: 2,
      results: [
        {
          task_code: "chat_5",
          title: "对话活跃补报",
          ok: true,
          claimed: true,
          message: "已补报 2 条对话活跃事件；已自动领奖 +100c +0e",
        },
      ],
    }),
  } as never);
  render(<Credentials />);
  openDetail("cn-work.info");
  const button = await screen.findByRole("button", { name: "一键完成对话活跃补报 cn-work.info" });
  await act(async () => fireEvent.click(button));
  await waitFor(() => expect(post).toHaveBeenCalled());
  expect(post).toHaveBeenCalledWith("/credentials/cnwork/growth-tasks/auto", {
    task_code: "chat_5",
  });
  expect(await screen.findByText(/已自动领奖 \+100c \+0e/)).toBeTruthy();
});

it("syncs the account's task switches to every other selected account", async () => {
  fixture();
  vi.spyOn(api, "get").mockResolvedValue({ data: growthView } as never);
  const post = vi.spyOn(api, "post").mockResolvedValue({ data: { updated: 1 } } as never);
  render(<Credentials />);
  // 勾选另一个账号后，抽屉里的「同步开关」才出现。
  const intlRow = screen
    .getAllByText("intl-work.info")
    .map((el) => el.closest<HTMLElement>("tr, article"))
    .find((tr) => tr && within(tr).queryByRole("checkbox"));
  if (!intlRow) throw new Error("intl row not found");
  await act(async () => fireEvent.click(within(intlRow).getByRole("checkbox")));
  openDetail("cn-work.info");
  const sync = await screen.findByRole("button", { name: "同步开关到已选账号 cn-work.info" });
  await act(async () => fireEvent.click(sync));
  await waitFor(() => expect(post).toHaveBeenCalled());
  expect(post).toHaveBeenCalledWith("/credentials/growth-batch", {
    ids: ["intl"],
    task_codes: ["chat_5"],
    enabled: true,
  });
});

it("reflects the master switch from the reloaded credential row", async () => {
  const { rows } = fixture();
  vi.spyOn(api, "get").mockResolvedValue({ data: growthView } as never);
  const { rerender } = render(<Credentials />);
  openDetail("cn-work.info");
  const master = await screen.findByRole("switch", { name: "自动成长补领 cn-work.info" });
  expect(master).toHaveProperty("checked", true);
  rows[0] = { ...rows[0], auto_growth: false };
  vi.mocked(useResource).mockReturnValue({
    data: [...rows],
    reload: vi.fn(),
    loading: false,
    refreshing: false,
    error: null,
  });
  rerender(<Credentials />);
  expect(screen.getByRole("switch", { name: "自动成长补领 cn-work.info" })).toHaveProperty(
    "checked",
    false,
  );
});

it("selects every automatable task and hides chainless tasks", async () => {
  fixture();
  vi.spyOn(api, "get").mockResolvedValue({ data: growthView } as never);
  const patch = vi.spyOn(api, "patch").mockResolvedValue({ data: { id: "cnwork" } } as never);
  render(<Credentials />);
  openDetail("cn-work.info");
  const selectAll = await screen.findByRole("button", { name: "全选任务开关 cn-work.info" });
  expect(screen.queryByText("关注公众号")).toBeNull();
  await act(async () => fireEvent.click(selectAll));
  expect(patch).toHaveBeenCalledWith("/credentials/cnwork", {
    growth_auto: { chat_5: true, "Model_chat_GLM5.2": true },
  });
  expect(await screen.findByRole("button", { name: "全不选任务开关 cn-work.info" })).toBeTruthy();
});

it("explains an empty run-all instead of reporting zero tasks", async () => {
  fixture();
  vi.spyOn(api, "get").mockResolvedValue({ data: growthView } as never);
  vi.spyOn(api, "post").mockResolvedValue({
    data: job({ status: "completed", kind: "all", total: 0, finished_at: 2 }),
  } as never);
  render(<Credentials />);
  openDetail("cn-work.info");
  const runAll = await screen.findByRole("button", { name: "全部执行 cn-work.info" });
  await act(async () => fireEvent.click(runAll));
  expect(await screen.findByText("没有可执行的任务（均已领取或未解锁）")).toBeTruthy();
});

it("shows the running task in a banner that survives closing the drawer", async () => {
  fixture();
  const running = job({
    total: 3,
    completed: 1,
    current: [{ item: { task_code: "chat_5", title: "对话活跃补报" }, step: null }],
  });
  vi.spyOn(api, "get").mockImplementation(
    async (url: string) =>
      ({ data: url === "/growth-jobs" ? { jobs: [running] } : growthView }) as never,
  );
  render(<Credentials />);
  // The page banner shows without opening the drawer.
  expect(await screen.findByText("成长计划 · cn-work.info")).toBeTruthy();
  expect(screen.getByText("正在执行 对话活跃补报")).toBeTruthy();
  openDetail("cn-work.info");
  expect(await screen.findByRole("button", { name: "全部执行 cn-work.info" })).toHaveProperty(
    "textContent",
    "执行中 1/3",
  );
  expect(
    screen.getByRole("button", { name: "一键完成对话活跃补报 cn-work.info" }).textContent,
  ).toBe("执行中…");
});

it("marks claimed tasks on the button and locks their switch", async () => {
  fixture();
  const claimedView = {
    ...growthView,
    tasks: growthView.tasks.map((task) =>
      task.task_code === "chat_5" ? { ...task, claimed: true, claimable: false } : task,
    ),
  };
  vi.spyOn(api, "get").mockResolvedValue({ data: claimedView } as never);
  const patch = vi.spyOn(api, "patch").mockResolvedValue({ data: { id: "cnwork" } } as never);
  render(<Credentials />);
  openDetail("cn-work.info");
  const button = await screen.findByRole("button", { name: "一键完成对话活跃补报 cn-work.info" });
  expect(button.textContent).toBe("已领取");
  expect(button).toHaveProperty("disabled", true);
  expect(screen.getByRole("switch", { name: "自动对话活跃补报 cn-work.info" })).toHaveProperty(
    "disabled",
    true,
  );
  await act(async () =>
    fireEvent.click(screen.getByRole("button", { name: "全选任务开关 cn-work.info" })),
  );
  expect(patch).toHaveBeenCalledWith("/credentials/cnwork", {
    growth_auto: { chat_5: true, "Model_chat_GLM5.2": true },
  });
});

it("shows locked tasks as a disabled button with the unlock hint on hover", async () => {
  fixture();
  const lockedView = {
    ...growthView,
    tasks: growthView.tasks.map((task) =>
      task.task_code === "Model_chat_GLM5.2" ? { ...task, locked: true } : task,
    ),
  };
  vi.spyOn(api, "get").mockResolvedValue({ data: lockedView } as never);
  render(<Credentials />);
  openDetail("cn-work.info");
  const button = await screen.findByRole("button", {
    name: "一键完成GLM-5.2 真实对话 cn-work.info",
  });
  expect(button.textContent).toBe("未解锁");
  expect(button).toHaveProperty("disabled", true);
  expect(button.parentElement?.getAttribute("title")).toBe("按官方节奏逐日开放");
  expect(screen.queryByText(/未解锁（/)).toBeNull();
});
