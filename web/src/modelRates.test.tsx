import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { api, type ModelRule } from "./api";
import { type Job } from "./jobs";
import {
  OutputProbeNote,
  formatEstimate,
  rateDetails,
  rateSource,
  type RateProbeControl,
} from "./modelRates";
import { ModelEditor, Models } from "./pages/Models";

afterEach(() => vi.restoreAllMocks());

const measured: ModelRule = {
  id: "hy4-preview-f",
  public_id: "hy4-preview-f",
  upstream_id: "hy4-preview-f",
  enabled: true,
  keep_original: false,
  region: "",
  profile: "",
  credential_ids: [],
  credits: 0.037,
  credits_by_profile: { "intl-work": 0.037 },
  rate_details: {
    "intl-work": {
      manual: null,
      declared: 0,
      measured: {
        billed: true,
        rate: 0.037,
        samples: 507,
        charged: 507,
        avg_credit: 0.63,
        last_charged_at: 1,
        rated_at: 1,
      },
    },
  },
};

function page(models: ModelRule[], extra: Record<string, unknown> = {}) {
  return vi.spyOn(api, "get").mockImplementation(
    async (path) =>
      ({
        data:
          path === "/models"
            ? { revision: 1, models }
            : path in extra
              ? extra[path]
              : { credentials: [] },
      }) as never,
  );
}

describe("rate provenance", () => {
  it("keeps two significant digits for small estimates", () => {
    expect(formatEstimate(0.037)).toBe("0.037x");
    expect(formatEstimate(1.234)).toBe("1.23x");
  });

  it("derives the source of each product rate", () => {
    const details = rateDetails(measured);
    expect(rateSource(details["intl-work"])).toBe("measured");
    expect(rateSource({ manual: 0.5, declared: 0 })).toBe("manual");
    expect(rateSource({ manual: null })).toBe("declared");
  });

  it("labels a declared-free model that upstream charges as measured billing", async () => {
    page([measured]);
    render(<Models />);
    const chip = await screen.findByText("≈0.037x · 实测计费");
    expect(chip.getAttribute("title")).toContain("507/507 次计费");
    expect(screen.queryByText("限时免费 0x")).toBeNull();
  });

  it("shows a manual rate as manual", async () => {
    page([
      {
        ...measured,
        credits: 0.05,
        credits_by_profile: { "intl-work": 0.05 },
        rate_details: { "intl-work": { manual: 0.05, declared: 0 } },
      },
    ]);
    render(<Models />);
    expect(await screen.findByText("0.05x · 手填")).toBeTruthy();
  });
});

describe("output limit probes", () => {
  it("marks silent clamping with the claimed/real ratio", () => {
    render(
      <OutputProbeNote
        probe={{
          claimed: 1048576,
          measured: 32000,
          verdict: "clamped",
          note: "",
          tested_at: "2026-10-19",
        }}
      />,
    );
    expect(screen.getByText("32K ⚠")).toBeTruthy();
    expect(screen.getByText("钳制 33×")).toBeTruthy();
  });

  it("confirms a measured limit that meets the claim and flags unknowns", () => {
    const { rerender } = render(
      <OutputProbeNote
        probe={{ claimed: 48000, measured: 48000, verdict: "at_least", note: "", tested_at: "" }}
      />,
    );
    expect(screen.getByText("48K ✓")).toBeTruthy();
    rerender(
      <OutputProbeNote
        probe={{ claimed: null, measured: null, verdict: "inconclusive", note: "", tested_at: "" }}
      />,
    );
    expect(screen.getByText("未测出")).toBeTruthy();
  });

  it("overlays the probe file on the max output column", async () => {
    page([measured], {
      "/models/output-probes": {
        probes: {
          "hy4-preview-f": { claimed: 131072, measured: 32000, verdict: "clamped", note: "" },
        },
      },
    });
    render(<Models />);
    expect(await screen.findByText("32K ⚠")).toBeTruthy();
  });
});

describe("manual rates and probes", () => {
  const job = (overrides: Partial<Job>): Job => ({
    key: "rate-probe",
    status: "running",
    total: 1,
    completed: 0,
    current: [],
    results: [],
    started_at: 1,
    finished_at: null,
    meta: { scope: "hy4-preview-f" },
    ...overrides,
  });
  function editor(control: RateProbeControl) {
    return render(
      <ModelEditor
        model={measured}
        models={[measured]}
        credentials={[]}
        revision={4}
        onSaved={vi.fn()}
        onClose={vi.fn()}
        rateProbe={control}
      />,
    );
  }

  it("saves a per-product manual rate with the rule", async () => {
    const put = vi.spyOn(api, "put").mockResolvedValue({ data: { revision: 5 } });
    editor({ job: null, error: null, start: vi.fn() });
    fireEvent.change(screen.getByLabelText("手填倍率 国际 · WorkBuddy"), {
      target: { value: "0.04" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存规则" }));
    await waitFor(() =>
      expect(put).toHaveBeenCalledWith(
        "/models/hy4-preview-f",
        expect.objectContaining({ credits_override: { "intl-work": 0.04 } }),
        expect.anything(),
      ),
    );
  });

  it("starts a background probe and shows its results whenever the drawer is open", () => {
    const start = vi.fn();
    const { rerender } = editor({ job: null, error: null, start });
    fireEvent.click(screen.getByRole("button", { name: "一键探测倍率" }));
    expect(start).toHaveBeenCalledWith("hy4-preview-f");
    const props = {
      model: measured,
      models: [measured],
      credentials: [],
      revision: 4,
      onSaved: vi.fn(),
      onClose: vi.fn(),
    };
    rerender(<ModelEditor {...props} rateProbe={{ job: job({}), error: null, start }} />);
    expect(screen.getByRole("button", { name: "探测中…" })).toHaveProperty("disabled", true);
    const done = job({
      status: "completed",
      completed: 1,
      results: [
        {
          model: "hy4-preview-f",
          profile: "intl-work",
          ok: true,
          billed: true,
          rate: 0.95,
          message: "已扣费 0.59 积分，对照 glm-5.3-flash（0.06x，扣 0.04）估算 ≈0.95x",
        },
        { model: "other", profile: "intl-work", ok: true, billed: false, message: "别的模型" },
      ],
    });
    rerender(<ModelEditor {...props} rateProbe={{ job: done, error: null, start }} />);
    expect(screen.getByText(/对照 glm-5.3-flash/)).toBeTruthy();
    expect(screen.queryByText(/别的模型/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "填入 0.95x" }));
    expect(screen.getByLabelText("手填倍率 国际 · WorkBuddy")).toHaveProperty("value", "0.95");
  });

  it("names the model and step being probed in the page banner", async () => {
    page([measured], {
      "/models/rate-probe": {
        key: "rate-probe",
        status: "running",
        total: 10,
        completed: 3,
        scope: "all",
        current: [
          {
            item: { model: "hy4-preview-f", profile: "intl-work" },
            step: "对照 glm-5.3-flash（0.06x）",
          },
        ],
        results: [],
      },
    });
    render(<Models />);
    expect(await screen.findByText("3/10")).toBeTruthy();
    expect(
      screen.getByText("正在探测 hy4-preview-f（国际 · WorkBuddy） · 对照 glm-5.3-flash（0.06x）"),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "检测中 3/10" })).toHaveProperty("disabled", true);
  });

  it("starts the catalog-wide rate check from the page header", async () => {
    page([measured]);
    const post = vi.spyOn(api, "post").mockResolvedValue({
      data: {
        key: "rate-probe",
        status: "completed",
        total: 2,
        completed: 2,
        billed: 1,
        free: 1,
        failed: 0,
        scope: "all",
        results: [],
      },
    });
    render(<Models />);
    const button = await screen.findByRole("button", { name: "一键检测倍率" });
    await act(async () => fireEvent.click(button));
    expect(post).toHaveBeenCalledWith("/models/rate-probe", {});
    expect(await screen.findByText(/实测计费 1 · 确认免费 1 · 失败 0/)).toBeTruthy();
  });
  it("toasts a scan this page watched finish, but not one that ended before it opened", async () => {
    const scan = (status: string) => ({
      status,
      total: 2,
      completed: status === "running" ? 1 : 2,
      success: status === "running" ? 1 : 2,
      failed: 0,
      differences: 0,
      started_at: null,
      finished_at: null,
      error: null,
      profiles: {},
      accounts: [],
    });
    page([measured], { "/models/scan": scan("completed") });
    const { unmount } = render(<Models />);
    expect(await screen.findByRole("button", { name: "扫描全部账号模型" })).toBeTruthy();
    expect(screen.queryByText("全量扫描已完成")).toBeNull();
    unmount();

    vi.useFakeTimers();
    try {
      const extra: Record<string, unknown> = { "/models/scan": scan("running") };
      page([measured], extra);
      render(<Models />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(screen.getByText("扫描全部账号模型")).toBeTruthy();
      extra["/models/scan"] = scan("completed");
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000);
      });
      expect(screen.getByText("全量扫描已完成")).toBeTruthy();
      expect(screen.getByText("成功 2 · 失败 0 · 目录差异 0")).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });
});
