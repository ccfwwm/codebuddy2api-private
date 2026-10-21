import { useEffect, useState } from "react";
import { api, credentialResponse, metric, number, object, text, type RecordValue } from "./api";
import { Badge } from "./components";
import { useT } from "./i18n";
import { eventActionLabel } from "./values";
import { Select } from "./fields";

export const creditChangeTypes = ["income", "consume", "expire", "adjust"] as const;
const tones: Record<string, "good" | "neutral" | "warn"> = {
  income: "good",
  consume: "neutral",
  expire: "warn",
  adjust: "neutral",
};

// Account names for the credit tab, fetched only while it is open; an unknown
// account falls back to the start of its account_key.
export function useAccountNames(enabled: boolean) {
  const [names, setNames] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    void api
      .get<unknown>("/credentials", { signal: controller.signal })
      .then((res) =>
        setNames(
          Object.fromEntries(
            credentialResponse(res.data).map((c) => [
              c.id,
              text(c.name ?? c.nickname ?? c.id.slice(0, 8)),
            ]),
          ),
        ),
      )
      .catch(() => undefined);
    return () => controller.abort();
  }, [enabled]);
  return names;
}

export function accountName(names: Record<string, string>, identity: unknown) {
  return typeof identity === "string" ? (names[identity] ?? identity.slice(0, 8)) : "—";
}

export function CreditFilters({
  credential,
  type,
  names,
  onChange,
}: {
  credential: string;
  type: string;
  names: Record<string, string>;
  onChange: (patch: { credential?: string; type?: string }) => void;
}) {
  const t = useT();
  return (
    <>
      <Select
        aria-label={t("logs.filter.account")}
        value={credential}
        onChange={(value) => onChange({ credential: value })}
      >
        <option value="">{t("logs.allAccounts")}</option>
        {Object.entries(names).map(([id, name]) => (
          <option key={id} value={id}>
            {name}
          </option>
        ))}
      </Select>
      <Select
        aria-label={t("logs.filter.changeType")}
        value={type}
        onChange={(value) => onChange({ type: value })}
      >
        <option value="">{t("logs.allChangeTypes")}</option>
        {creditChangeTypes.map((value) => (
          <option key={value} value={value}>
            {t(eventActionLabel(`credit.${value}`)!)}
          </option>
        ))}
      </Select>
    </>
  );
}

export function CreditRow({ item, names }: { item: RecordValue; names: Record<string, string> }) {
  const t = useT();
  const details = object(item.details ?? {});
  const delta = number(details.delta);
  const expires = number(details.expires_at);
  const label = eventActionLabel(item.action);
  return (
    <>
      <td>
        <strong title={text(item.action)}>{label ? t(label) : text(item.action)}</strong>
        <small title={text(details.credential)}>{accountName(names, details.credential)}</small>
      </td>
      <td>
        <Badge tone={tones[text(item.action).replace("credit.", "")] ?? "neutral"}>
          {delta === null ? "—" : `${delta > 0 ? "+" : ""}${metric(delta)}`}
        </Badge>
        <small>{t("logs.balanceAfter", { n: metric(details.balance) })}</small>
      </td>
      <td>
        {text(details.source ?? details.package_code)}
        {expires !== null && (
          <small>
            {t("logs.expiresOn", { date: new Date(expires * 1000).toLocaleDateString("zh-CN") })}
          </small>
        )}
      </td>
    </>
  );
}
