// @vitest-environment jsdom
import { act, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { SearchInput, Select } from "./fields";

function Harness({ onChange }: { onChange: (value: string) => void }) {
  const [value, setValue] = useState("b");
  return (
    <label>
      范围
      <Select
        value={value}
        onChange={(next) => {
          setValue(next);
          onChange(next);
        }}
      >
        <option value="a">甲</option>
        <option value="b">乙</option>
        <option value="c" disabled>
          丙
        </option>
        <option value="d">丁</option>
      </Select>
    </label>
  );
}

describe("Select", () => {
  it("shows the chosen label and picks with the pointer", () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const combobox = screen.getByRole("combobox", { name: "范围" });
    expect(combobox.textContent).toBe("乙");
    fireEvent.click(combobox);
    expect(combobox.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("option", { name: "乙" }).getAttribute("aria-selected")).toBe("true");
    fireEvent.click(screen.getByRole("option", { name: "丙" }));
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("option", { name: "甲" }));
    expect(onChange).toHaveBeenCalledWith("a");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(combobox.textContent).toBe("甲");
  });

  it("moves over enabled options with the keyboard and closes on Escape", () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const combobox = screen.getByRole("combobox", { name: "范围" });
    fireEvent.keyDown(combobox, { key: "ArrowDown" });
    expect(screen.getByRole("listbox")).toBeTruthy();
    fireEvent.keyDown(combobox, { key: "ArrowDown" });
    const active = combobox.getAttribute("aria-activedescendant");
    expect(document.getElementById(active!)?.textContent).toBe("丁");
    fireEvent.keyDown(combobox, { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith("d");
    fireEvent.keyDown(combobox, { key: "ArrowDown" });
    const escape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    act(() => {
      combobox.dispatchEvent(escape);
    });
    expect(escape.defaultPrevented).toBe(true);
    expect(screen.queryByRole("listbox")).toBeNull();
  });
});

describe("SearchInput", () => {
  it("clears its value with the inline button", () => {
    const onChange = vi.fn();
    const { rerender } = render(<SearchInput aria-label="搜索" value="" onChange={onChange} />);
    expect(screen.queryByRole("button", { name: "清除搜索" })).toBeNull();
    fireEvent.change(screen.getByRole("textbox", { name: "搜索" }), { target: { value: "glm" } });
    expect(onChange).toHaveBeenCalledWith("glm");
    rerender(<SearchInput aria-label="搜索" value="glm" onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "清除搜索" }));
    expect(onChange).toHaveBeenLastCalledWith("");
  });
});
