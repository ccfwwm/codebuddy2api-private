// @vitest-environment jsdom
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { Drawer } from "./components";
import { ToastRegion, clearToasts, notify } from "./toast";

afterEach(() => {
  vi.useRealTimers();
});

describe("toasts", () => {
  it("fade on their own, sooner on a click, and hold while hovered", () => {
    vi.useFakeTimers();
    render(<ToastRegion />);
    act(() => notify({ tone: "good", title: "已保存" }));
    act(() => notify({ tone: "warn", title: "部分失败", body: <span>请核验</span> }));
    fireEvent.click(screen.getByText("部分失败"));
    expect(screen.queryByText("部分失败")).toBeNull();
    const saved = screen.getByText("已保存").closest("div")!.parentElement!;
    fireEvent.mouseEnter(saved);
    act(() => {
      vi.advanceTimersByTime(6000);
    });
    expect(screen.getByText("已保存")).toBeTruthy();
    fireEvent.mouseLeave(saved);
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(screen.queryByText("已保存")).toBeNull();
  });

  it("dismisses from the keyboard, replaces by key and clears at once", () => {
    render(<ToastRegion />);
    act(() => notify({ key: "job", tone: "warn", title: "第一次" }));
    act(() => notify({ key: "job", tone: "good", title: "第二次" }));
    expect(screen.queryByText("第一次")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "关闭通知" }));
    expect(screen.queryByText("第二次")).toBeNull();
    act(() => notify({ tone: "good", title: "甲" }));
    act(() => notify({ tone: "good", title: "乙" }));
    act(() => clearToasts());
    expect(screen.queryByText("甲")).toBeNull();
    expect(screen.queryByText("乙")).toBeNull();
  });

  it("render inside an open drawer so they stay above its backdrop", () => {
    vi.useFakeTimers();
    const { rerender } = render(<ToastRegion />);
    act(() => notify({ tone: "good", title: "完成" }));
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    rerender(
      <>
        <ToastRegion />
        <Drawer title="详情" onClose={() => undefined}>
          内容
        </Drawer>
      </>,
    );
    expect(screen.getByRole("dialog").contains(screen.getByText("完成"))).toBe(true);
    rerender(<ToastRegion />);
    expect(screen.getByText("完成")).toBeTruthy();
    // Moving between regions keeps the clock from when the toast was raised.
    act(() => {
      vi.advanceTimersByTime(2100);
    });
    expect(screen.queryByText("完成")).toBeNull();
  });
});
