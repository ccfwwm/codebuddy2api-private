import type { ReactNode } from "react";
import s from "./ui.module.scss";

// Release notes are third-party Markdown; render the small subset they use as React
// elements, so nothing in them is ever interpreted as HTML.
const INLINE =
  /`([^`]+)`|\*\*([^*]+)\*\*|\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|(https?:\/\/[^\s<>)]+)/g;
const HEADING = /^(#{1,6})\s+(.*)$/;
const ITEM = /^\s*(?:[-*+]|\d+\.)\s+(.*)$/;

function inline(source: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let last = 0;
  for (const match of source.matchAll(INLINE)) {
    const index = match.index;
    if (index > last) nodes.push(source.slice(last, index));
    const [whole, code, bold, label, href, bare] = match;
    if (code !== undefined) nodes.push(<code key={index}>{code}</code>);
    else if (bold !== undefined) nodes.push(<strong key={index}>{inline(bold)}</strong>);
    else {
      const url = href ?? bare ?? "";
      nodes.push(
        <a key={index} href={url} target="_blank" rel="noreferrer">
          {label ?? url}
        </a>,
      );
    }
    last = index + whole.length;
  }
  if (last < source.length) nodes.push(source.slice(last));
  return nodes;
}

export function Markdown({ source }: { source: string }) {
  const blocks: ReactNode[] = [];
  let paragraph: string[] = [];
  let items: string[] = [];
  const flush = () => {
    if (paragraph.length) blocks.push(<p key={blocks.length}>{inline(paragraph.join(" "))}</p>);
    if (items.length)
      blocks.push(
        <ul key={blocks.length}>
          {items.map((item, index) => (
            <li key={index}>{inline(item)}</li>
          ))}
        </ul>,
      );
    paragraph = [];
    items = [];
  };
  for (const raw of source.replace(/\r\n?/g, "\n").split("\n")) {
    const line = raw.trim();
    const heading = HEADING.exec(line);
    const item = ITEM.exec(raw);
    if (!line) flush();
    else if (heading) {
      flush();
      const Tag = heading[1]!.length <= 2 ? "h3" : "h4";
      blocks.push(<Tag key={blocks.length}>{inline(heading[2]!)}</Tag>);
    } else if (item) {
      if (paragraph.length) flush();
      items.push(item[1]!);
    } else if (items.length && /^\s/.test(raw)) items[items.length - 1] += ` ${line}`;
    else {
      if (items.length) flush();
      paragraph.push(line);
    }
  }
  flush();
  return <div className={s.markdown}>{blocks}</div>;
}
