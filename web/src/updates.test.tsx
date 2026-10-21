// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { AppRoutes } from "./App";
import { api, useSession } from "./api";
import { Markdown } from "./markdown";
import { Storage } from "./pages/Storage";
import { Updates } from "./pages/Updates";
import { ToastRegion } from "./toast";

afterEach(() => {
  vi.restoreAllMocks();
  useSession.setState({ status: "checking", csrf: null });
});

const releases = [
  {
    tag: "v1.5.0",
    version: "1.5.0",
    name: "v1.5.0",
    notes:
      "## Highlights\n\n- One-click **updates** with `backups`\n- See [PR](https://github.com/x/y/pull/1)",
    published_at: "2026-10-20T00:00:00Z",
    url: "https://github.com/maiphucgiang/codebuddy2api/releases/tag/v1.5.0",
    installable: true,
  },
  {
    tag: "v1.4.0",
    version: "1.4.0",
    name: "v1.4.0",
    notes: "Older notes",
    published_at: "2026-10-19T00:00:00Z",
    url: "https://github.com/maiphucgiang/codebuddy2api/releases/tag/v1.4.0",
    installable: true,
  },
];
function payload(overrides: Record<string, unknown> = {}) {
  return {
    current: "1.4.0",
    repository: "https://github.com/maiphucgiang/codebuddy2api",
    deployment: "archive",
    self_update: { available: true, reason: null },
    checked_at: 1792497600,
    error: null,
    latest: "1.5.0",
    update_available: true,
    releases,
    job: { status: "idle" },
    ...overrides,
  };
}
function mount(path = "/dashboard/updates") {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/dashboard/updates" element={<Updates />} />
        <Route path="/dashboard/updates/:tag" element={<Updates />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("release notes markdown", () => {
  it("renders headings, lists, code and https links without interpreting HTML", () => {
    const { container } = render(
      <Markdown
        source={
          "## Title\n- item with `code` and **bold**\n  continued\n\n<img src=x onerror=alert(1)> [bad](javascript:alert(1)) https://example.com/a"
        }
      />,
    );
    expect(container.querySelector("h3")?.textContent).toBe("Title");
    expect(container.querySelector("li")?.textContent).toBe("item with code and bold continued");
    expect(container.querySelector("code")?.textContent).toBe("code");
    expect(container.querySelector("img")).toBeNull();
    const links = Array.from(container.querySelectorAll("a"));
    expect(links.map((link) => link.getAttribute("href"))).toEqual(["https://example.com/a"]);
    expect(links[0]!.getAttribute("rel")).toBe("noreferrer");
    expect(container.textContent).toContain("<img src=x onerror=alert(1)>");
  });
});

describe("updates page", () => {
  it("shows the repository, latest notes and switches releases by route", async () => {
    vi.spyOn(api, "get").mockResolvedValue({ data: payload() });
    mount();
    expect(await screen.findByText("Highlights")).toBeTruthy();
    expect(screen.getByRole("link", { name: "GitHub 仓库" }).getAttribute("href")).toBe(
      "https://github.com/maiphucgiang/codebuddy2api",
    );
    expect(screen.getByText("updates")).toBeTruthy();
    expect(screen.getByRole("link", { name: "在 GitHub 查看" }).getAttribute("href")).toBe(
      releases[0]!.url,
    );
    fireEvent.click(screen.getByRole("link", { name: /v1\.4\.0/ }));
    expect(await screen.findByText("Older notes")).toBeTruthy();
    expect(screen.getAllByText("当前").length).toBeGreaterThan(0);
  });

  it("answers every update check with a toast, also when nothing changed or it failed", async () => {
    vi.spyOn(api, "get").mockResolvedValue({
      data: payload({ latest: "1.4.0", update_available: false, releases: releases.slice(1) }),
    });
    const post = vi.spyOn(api, "post").mockResolvedValue({
      data: payload({ latest: "1.4.0", update_available: false, releases: releases.slice(1) }),
    });
    render(
      <>
        <MemoryRouter initialEntries={["/dashboard/updates"]}>
          <Routes>
            <Route path="/dashboard/updates" element={<Updates />} />
          </Routes>
        </MemoryRouter>
        <ToastRegion />
      </>,
    );
    const button = await screen.findByRole("button", { name: "检查更新" });
    fireEvent.click(button);
    const body = await screen.findByText("当前 v1.4.0 就是最新的稳定版本，无需更新。");
    expect(body.previousElementSibling?.textContent).toBe("已是最新版本");

    post.mockResolvedValueOnce({ data: payload() });
    // The toast lands before the request settles; the button re-enables right after.
    await waitFor(() => expect(button).toHaveProperty("disabled", false));
    fireEvent.click(button);
    expect(await screen.findByText("发现新版本 v1.5.0")).toBeTruthy();

    post.mockResolvedValueOnce({
      data: payload({ error: "无法连接 GitHub，请检查网络或代理设置（HTTPS_PROXY）" }),
    });
    await waitFor(() => expect(button).toHaveProperty("disabled", false));
    fireEvent.click(button);
    expect(await screen.findByText("检查更新失败")).toBeTruthy();
    expect(screen.getAllByText(/无法连接 GitHub/).length).toBeGreaterThan(0);

    post.mockRejectedValueOnce(new Error("网络中断"));
    await waitFor(() => expect(button).toHaveProperty("disabled", false));
    fireEvent.click(button);
    expect(await screen.findByText("网络中断")).toBeTruthy();
  });

  it("warns when the running code may not be the release its version names", async () => {
    const get = vi.spyOn(api, "get").mockResolvedValue({
      data: payload({
        deployment: "git",
        build: { commit: "05a7d74dbf6c", tag_commit: "aca8db58d53a", dirty: true, exact: false },
      }),
    });
    const { unmount } = mount();
    const warning = await screen.findByText(
      /当前提交 05a7d74dbf6c 不是 v1\.4\.0 标签的提交 aca8db58d53a，且有未提交的修改/,
    );
    expect(warning.closest("[role=status]")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /更新到 v1\.5\.0/ }));
    expect(screen.getAllByText(/运行的代码可能不是 v1\.4\.0/)).toHaveLength(2);
    unmount();

    get.mockResolvedValue({
      data: payload({ deployment: "docker", build: { channel: "edge", commit: "0123456789ab" } }),
    });
    const edge = mount();
    expect(await screen.findByText(/当前是 edge 镜像（main 分支提交 0123456789ab）/)).toBeTruthy();
    edge.unmount();

    for (const build of [
      { commit: "aca8db58d53a", tag_commit: "aca8db58d53a", dirty: false, exact: true },
      { channel: "stable", commit: "aca8db58d53a" },
    ]) {
      get.mockResolvedValue({ data: payload({ deployment: "git", build }) });
      const clean = mount();
      expect(await screen.findByText("Highlights")).toBeTruthy();
      expect(screen.queryByText(/可能不是|edge 镜像/)).toBeNull();
      clean.unmount();
    }
  });

  it("confirms before installing and polls the running job", async () => {
    const get = vi.spyOn(api, "get").mockResolvedValue({ data: payload() });
    const post = vi.spyOn(api, "post").mockResolvedValue({ data: {} });
    mount();
    fireEvent.click(await screen.findByRole("button", { name: /更新到 v1\.5\.0/ }));
    expect(screen.getByText(/按原启动参数重启/)).toBeTruthy();
    get.mockResolvedValue({
      data: payload({
        job: { status: "running", step: "backup", target: "1.5.0", message: null, backup: null },
      }),
    });
    fireEvent.click(screen.getByRole("button", { name: "确认" }));
    await waitFor(() => expect(post).toHaveBeenCalledWith("/update/install", { tag: "v1.5.0" }));
    expect(await screen.findByRole("status")).toBeTruthy();
    expect(screen.getByText("正在备份配置…")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /更新到 v1\.5\.0/ })).toBeNull();
  });

  it("animates the download with received bytes and percent", async () => {
    vi.spyOn(api, "get").mockResolvedValue({
      data: payload({
        job: {
          status: "running",
          step: "download",
          target: "1.5.0",
          received: 524288,
          total: 1048576,
        },
      }),
    });
    mount();
    expect(await screen.findByText("已下载 0.5 / 1.0 MB")).toBeTruthy();
    expect(screen.getByText("正在下载发布包…")).toBeTruthy();
    expect(screen.getByText("35%")).toBeTruthy();
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("35");
  });

  it("tells the user the page is about to reload once the new version answers", async () => {
    const get = vi.spyOn(api, "get").mockResolvedValue({
      data: payload({
        job: { status: "restarting", step: "restart", target: "1.5.0", backup: "update-x.tar.gz" },
      }),
    });
    mount();
    expect(await screen.findByText("已替换为 v1.5.0，正在按原启动参数重启…")).toBeTruthy();
    get.mockResolvedValue({ data: payload({ current: "1.5.0" }) });
    expect(
      await screen.findByText("已更新到 v1.5.0，即将刷新页面…", undefined, { timeout: 4000 }),
    ).toBeTruthy();
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("100");
  });

  it("rolls back to an older release with a git-specific note", async () => {
    vi.spyOn(api, "get").mockResolvedValue({
      data: payload({ current: "1.5.0", deployment: "git", update_available: false }),
    });
    mount("/dashboard/updates/v1.4.0");
    fireEvent.click(await screen.findByRole("button", { name: "回滚到 v1.4.0" }));
    expect(screen.getByText(/无法读取当前数据库时会自动中止/)).toBeTruthy();
    expect(screen.getByText(/未跟踪与已忽略的文件保留/)).toBeTruthy();
  });

  it("falls back to deployment guidance when self-update is unavailable", async () => {
    vi.spyOn(api, "get").mockResolvedValue({
      data: payload({
        deployment: "docker",
        self_update: { available: false, reason: "程序目录不可写，无法自动更新" },
      }),
    });
    mount("/dashboard/updates/v1.4.0");
    expect(await screen.findByText(/程序目录不可写/)).toBeTruthy();
    expect(screen.getByText(/docker compose pull/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /更新到|回滚到/ })).toBeNull();
    expect(screen.getByText("Older notes")).toBeTruthy();
  });

  it("tests every source or one in the drawer and switches the download source", async () => {
    vi.spyOn(api, "get").mockResolvedValue({
      data: payload({ mirrors: ["https://ghfast.top/", "https://gh-proxy.com/"], mirror: "" }),
    });
    const all = [
      { mirror: "https://ghfast.top/", ok: true, latency_ms: 120, speed: 1536 },
      { mirror: "", ok: true, latency_ms: 900, speed: 80 },
      { mirror: "https://gh-proxy.com/", ok: false, error: "返回的不是发布包" },
    ];
    // Answers every source even for a single test, like a server from before single tests.
    const post = vi
      .spyOn(api, "post")
      .mockImplementation(async (path) =>
        path === "/update/mirrors/test" ? { data: { results: all } } : { data: {} },
      );
    mount();
    fireEvent.click(await screen.findByRole("button", { name: /^下载源/ }));
    const rows = within(await screen.findByRole("list", { name: "下载源列表" })).getAllByRole(
      "listitem",
    );
    expect(rows).toHaveLength(4);
    expect(within(rows[1]!).getByText("未测速")).toBeTruthy();
    expect(within(rows[3]!).getByRole("button", { name: "测速 自定义下载源" })).toHaveProperty(
      "disabled",
      true,
    );
    fireEvent.click(within(rows[2]!).getByRole("button", { name: "测速 gh-proxy.com" }));
    expect(await within(rows[2]!).findByText("返回的不是发布包")).toBeTruthy();
    expect(post).toHaveBeenCalledWith(
      "/update/mirrors/test",
      { mirror: "https://gh-proxy.com/" },
      { timeout: 60000 },
    );
    expect(within(rows[1]!).getByText("未测速")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "全部测速" }));
    expect(await within(rows[1]!).findByText("120 ms · 1.5 MB/s")).toBeTruthy();
    expect(within(rows[1]!).getByText("最快")).toBeTruthy();
    expect(within(rows[0]!).getAllByText("使用中")).toHaveLength(2);
    expect(within(rows[2]!).getByText("返回的不是发布包")).toBeTruthy();
    expect(within(rows[2]!).getByRole("button", { name: "使用 gh-proxy.com" })).toHaveProperty(
      "disabled",
      true,
    );
    fireEvent.click(within(rows[1]!).getByRole("button", { name: "使用 ghfast.top" }));
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith("/update/mirror", { mirror: "https://ghfast.top/" }),
    );
  });

  it("fills, uses and remembers the custom download source", async () => {
    vi.spyOn(api, "get").mockResolvedValue({
      data: payload({
        mirrors: ["https://ghfast.top/"],
        mirror: "",
        mirror_custom: "https://saved.example/",
      }),
    });
    const post = vi.spyOn(api, "post").mockResolvedValue({ data: {} });
    mount();
    fireEvent.click(await screen.findByRole("button", { name: /^下载源/ }));
    const slot = await screen.findByRole("textbox", { name: "自定义下载源" });
    expect(slot).toHaveProperty("value", "https://saved.example/");
    fireEvent.change(slot, { target: { value: "https://my.example" } });
    fireEvent.click(screen.getByRole("button", { name: "使用 自定义下载源" }));
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith("/update/mirror", {
        mirror: "https://my.example",
        custom: "https://my.example",
      }),
    );
  });

  it("shows the failure reason from the job", async () => {
    vi.spyOn(api, "get").mockResolvedValue({
      data: payload({
        job: {
          status: "failed",
          step: "verify",
          target: "1.5.0",
          message: "发布包校验失败，已放弃更新",
        },
      }),
    });
    mount();
    expect(await screen.findByText("更新未完成：发布包校验失败，已放弃更新")).toBeTruthy();
  });
});

describe("update badge", () => {
  it("flags the navigation entry when a newer release exists", async () => {
    useSession.setState({ status: "authenticated", csrf: "synthetic" });
    vi.spyOn(api, "get").mockImplementation(async (path) => ({
      data: path === "/update" ? payload() : { degraded: false, archives: [], backups: [] },
    }));
    render(
      <MemoryRouter initialEntries={["/dashboard/storage"]}>
        <AppRoutes />
      </MemoryRouter>,
    );
    expect(await screen.findByRole("link", { name: "版本更新 · 有可用更新" })).toBeTruthy();
  });
});

describe("update backups on the storage page", () => {
  it("lists backups with a download link and deletes after confirmation", async () => {
    const name = "update-1.4.0-to-1.5.0-20261020-120000.tar.gz";
    vi.spyOn(api, "get").mockResolvedValue({
      data: {
        degraded: false,
        archives: [],
        backups: [{ name, from: "1.4.0", to: "1.5.0", created_at: 1792497600, size: 2048 }],
      },
    });
    const remove = vi.spyOn(api, "delete").mockResolvedValue({ data: { deleted: name } });
    render(<Storage />);
    const item = (await screen.findByTitle(name)).closest("li")!;
    expect(within(item).getByText(/v1\.4\.0 → v1\.5\.0/)).toBeTruthy();
    expect(within(item).getByRole("link", { name: "下载" }).getAttribute("href")).toBe(
      `/admin/storage/backups/${name}`,
    );
    fireEvent.click(within(item).getByRole("button", { name: "删除" }));
    expect(remove).not.toHaveBeenCalled();
    fireEvent.click(within(item).getByRole("button", { name: "确认删除" }));
    await waitFor(() => expect(remove).toHaveBeenCalledWith(`/storage/backups/${name}`));
  });
});
