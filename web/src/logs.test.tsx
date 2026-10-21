import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { api, useResource } from "./api";
import { Logs } from "./pages/Logs";
import { choose } from "./test-utils";

vi.mock("./api", async (original) => ({
  ...(await original<typeof import("./api")>()),
  useResource: vi.fn(),
}));

function pending() {
  let resolve!: (value: { data: unknown }) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<{ data: unknown }>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.mocked(useResource).mockReturnValue({
    data: {
      items: [
        { id: "request-a", model: "model-a", outcome: "success", client_ip: "198.51.100.9" },
        { id: "request-b", model: "model-b", outcome: "success" },
      ],
      has_more: false,
      next_cursor: null,
    },
    loading: false,
    refreshing: false,
    error: null,
    reload: vi.fn(),
  });
});

function open(index = 0) {
  fireEvent.click(screen.getAllByRole("button", { name: "查看详情" })[index]!);
}

function close() {
  fireEvent.click(screen.getByRole("button", { name: "关闭抽屉" }));
}

describe("runtime event labels", () => {
  it("renders kind, action and outcome in Chinese with raw values on hover", () => {
    vi.mocked(useResource).mockReturnValue({
      data: {
        items: [
          { id: "event-1", kind: "runtime", action: "credential.sync", started_at: 1 },
          {
            id: "event-2",
            kind: "admin",
            action: "mystery.action",
            details: { outcome: "success" },
          },
        ],
        has_more: false,
        next_cursor: null,
      },
      loading: false,
      refreshing: false,
      error: null,
      reload: vi.fn(),
    });
    render(<Logs />);
    fireEvent.click(screen.getByRole("tab", { name: "运行事件" }));
    expect(screen.getByTitle("credential.sync").textContent).toBe("凭证同步");
    expect(screen.getByTitle("runtime").textContent).toBe("运行事件");
    expect(screen.getByText("mystery.action")).toBeTruthy();
    expect(screen.getByText("成功")).toBeTruthy();
  });
});

describe("request client metadata", () => {
  it("shows the client IP and filters requests by it", () => {
    render(<Logs />);
    expect(screen.getByText("198.51.100.9")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("筛选客户端 IP"), {
      target: { value: "198.51.100.9" },
    });
    fireEvent.click(screen.getByRole("button", { name: "应用筛选" }));
    const call = vi.mocked(useResource).mock.calls.at(-1)![0] as string;
    expect(call).toContain("client_ip=198.51.100.9");
  });
});

describe("credit changes tab", () => {
  it("shows signed changes per account and filters by account and type", async () => {
    const account = "a".repeat(64);
    const get = vi.spyOn(api, "get").mockResolvedValue({
      data: { credentials: [{ account_key: account, name: "主账号.info" }] },
    });
    vi.mocked(useResource).mockReturnValue({
      data: {
        items: [
          {
            id: "credit-1",
            kind: "credit",
            action: "credit.income",
            started_at: 1,
            details: {
              credential: account,
              delta: 500,
              balance: 530,
              source: "体验积分",
              expires_at: 2e9,
            },
          },
          {
            id: "credit-2",
            kind: "credit",
            action: "credit.consume",
            started_at: 2,
            details: { credential: "b".repeat(64), delta: -70.5, balance: 30 },
          },
        ],
        has_more: false,
        next_cursor: null,
      },
      loading: false,
      refreshing: false,
      error: null,
      reload: vi.fn(),
    });
    render(<Logs />);
    await act(async () => fireEvent.click(screen.getByRole("tab", { name: "积分变动" })));
    expect(get).toHaveBeenCalledWith("/credentials", expect.anything());
    expect(screen.getByTitle("credit.income").textContent).toBe("积分入账");
    expect(screen.getByTitle(account).textContent).toBe("主账号.info");
    expect(screen.getByTitle("b".repeat(64)).textContent).toBe("bbbbbbbb");
    expect(screen.getByText("+500")).toBeTruthy();
    expect(screen.getByText("-70.5")).toBeTruthy();
    expect(screen.getByText("体验积分")).toBeTruthy();
    choose(screen.getByLabelText("筛选账号"), account);
    choose(screen.getByLabelText("筛选变动类型"), "income");
    fireEvent.click(screen.getByRole("button", { name: "应用筛选" }));
    const call = vi.mocked(useResource).mock.calls.at(-1)![0] as string;
    expect(call).toContain("kind=credit");
    expect(call).toContain(`credential=${account}`);
    expect(call).toContain("type=income");
  });
});

describe("log detail request lifetime", () => {
  it("does not reopen a closed drawer when its response arrives", async () => {
    const request = pending();
    const get = vi.spyOn(api, "get").mockReturnValue(request.promise);
    render(<Logs />);
    open();
    expect(screen.getByRole("status").textContent).toContain("正在加载详情");
    close();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(get.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    await act(async () => request.resolve({ data: { id: "late-a" } }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it.each(["success", "failure"])(
    "ignores stale %s without changing the next request's loading state",
    async (outcome) => {
      const first = pending();
      const second = pending();
      vi.spyOn(api, "get").mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
      render(<Logs />);
      open();
      close();
      expect(screen.getAllByRole("button", { name: "查看详情" })[1]).toHaveProperty(
        "disabled",
        false,
      );
      open(1);
      await act(async () => {
        if (outcome === "success") first.resolve({ data: { id: "stale-a" } });
        else first.reject(new Error("stale failure"));
      });
      expect(screen.getByRole("status").textContent).toContain("正在加载详情");
      expect(screen.queryByText("stale-a")).toBeNull();
      expect(screen.queryByText("stale failure")).toBeNull();
      await act(async () => second.resolve({ data: { id: "current-b", attempts: [] } }));
      expect(within(screen.getByRole("dialog")).getByText("current-b")).toBeTruthy();
      expect(screen.queryByRole("status")).toBeNull();
    },
  );

  it("aborts on unmount and ignores a late rejection", async () => {
    const request = pending();
    const get = vi.spyOn(api, "get").mockReturnValue(request.promise);
    const view = render(<Logs />);
    open();
    view.unmount();
    expect(get.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    await act(async () => request.reject(new Error("late failure")));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("cancels detail loading when switching log kind", async () => {
    const request = pending();
    const get = vi.spyOn(api, "get").mockReturnValue(request.promise);
    render(<Logs />);
    open();
    fireEvent.click(screen.getByRole("tab", { name: "运行事件" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(get.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    open();
    expect(get).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("status")).toBeNull();
    await act(async () => request.resolve({ data: { id: "stale-request" } }));
    expect(screen.queryByText("stale-request")).toBeNull();
  });

  it("keeps current request failures visible", async () => {
    const request = pending();
    vi.spyOn(api, "get").mockReturnValue(request.promise);
    render(<Logs />);
    open();
    await act(async () => request.reject(new Error("current failure")));
    expect(screen.getByRole("alert").textContent).toBe("current failure");
    expect(screen.queryByRole("status")).toBeNull();
  });
});

it("shows the persisted daily Buddy warning from event details", () => {
  vi.mocked(useResource).mockReturnValue({
    data: {
      items: [
        {
          id: "buddy-warning",
          action: "buddy.attention_required",
          kind: "runtime",
          details: { outcome: "warning", stage: "buddy_tasks" },
        },
      ],
      has_more: false,
      next_cursor: null,
    },
    loading: false,
    refreshing: false,
    error: null,
    reload: vi.fn(),
  });
  render(<Logs />);
  fireEvent.click(screen.getByRole("tab", { name: "运行事件" }));
  expect(screen.getByText("警告")).toBeTruthy();
});
