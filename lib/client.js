/**
 * Browser bundle for dsh-lossless-context.
 *
 * Contributes a Plugin-configuration card for the host-owned lossless-context
 * settings section. Plain React keeps the client bundle independent of private
 * DSH UI primitives.
 */
"use strict";

window.__ModuleLoader__.load({
  id: "dsh-lossless-context",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    const React = require("react");
    const e = React.createElement;

    const SETTINGS_NAMESPACE = "lossless-context";
    const LOCALE_NAMESPACE = "settings.lossless-context";

    const DEFAULTS = Object.freeze({
      summarizationProvider: "",
      summarizationModel: "",
      foldTiming: "background",
      tailCount: 24,
      minRetainTokens: 32000,
      pressureFoldTokens: 20000,
      foldBatchTokens: 64000,
      softActiveTokens: 160000,
      hardActiveTokens: 220000,
      cacheTtlSeconds: 1800,
      thresholdRatio: 0.6,
      retainRatio: 0.16,
    });

    const SUMMARIZER_FIELDS = [
      { key: "summarizationProvider", kind: "text", placeholder: "openai" },
      { key: "summarizationModel", kind: "text", placeholder: "gpt-5.6-sol" },
    ];

    const POLICY_FIELDS = [
      { key: "foldTiming", kind: "select", options: ["background", "sync"] },
      { key: "tailCount", kind: "int", min: 1, step: 1 },
      { key: "minRetainTokens", kind: "int", min: 0, step: 1000 },
      { key: "pressureFoldTokens", kind: "int", min: 1, step: 1000 },
      { key: "foldBatchTokens", kind: "int", min: 1, step: 1000 },
      { key: "softActiveTokens", kind: "int", min: 1, step: 1000 },
      { key: "hardActiveTokens", kind: "int", min: 1, step: 1000 },
      { key: "cacheTtlSeconds", kind: "int", min: 0, step: 60 },
      { key: "thresholdRatio", kind: "ratio", min: 0, max: 1, step: 0.01 },
      { key: "retainRatio", kind: "ratio", min: 0, max: 1, step: 0.01 },
    ];
    const FIELDS = [...SUMMARIZER_FIELDS, ...POLICY_FIELDS];

    const zh = {
      title: "无损上下文 (Lossless Context)",
      intro: "压缩模型、缓存感知滚动策略与溢出保护",
      expand: "展开",
      collapse: "折叠",
      summarizerHeading: "压缩模型",
      summarizerHint: "Provider 和 Model 都留空时跟随当前主 Agent；要指定独立压缩模型必须两项同时填写。使用 DSH adapter 的真实 ID，不限制模型名单。",
      summarizationProvider: "压缩 Provider",
      summarizationProviderHint: "例如 openai、anthropic；留空表示跟随当前 Agent。",
      summarizationModel: "压缩 Model",
      summarizationModelHint: "例如 gpt-5.6-sol；必须与 Provider 同时填写或同时留空。",
      policyHeading: "滚动与缓存策略",
      foldTiming: "折叠时机",
      foldTimingHint: "background 仅让 cold-batch 机会折叠异步；soft/hard 压力折叠仍同步落地。",
      "foldTiming.background": "后台异步",
      "foldTiming.sync": "同步",
      tailCount: "保留尾部消息数",
      tailCountHint: "正常情况下至少逐字保留的最近 surface node 数。",
      minRetainTokens: "尾部最少 Token",
      minRetainTokensHint: "与消息数同时生效，避免 24 条很短消息留下过小工作集。",
      pressureFoldTokens: "压力折叠最小 Token",
      pressureFoldTokensHint: "达到 soft cap 后一次折叠至少应释放的 token。",
      foldBatchTokens: "常规折叠批次 Token",
      foldBatchTokensHint: "缓存冷时才允许的常规 surface 改写颗粒度；默认 64k。",
      softActiveTokens: "Active Soft Cap",
      softActiveTokensHint: "达到该活动上下文规模后，context 质量优先于热缓存。",
      hardActiveTokens: "Active Hard Cap",
      hardActiveTokensHint: "达到该规模后强制任何安全且有意义的缩减。",
      cacheTtlSeconds: "缓存热度 TTL（秒）",
      cacheTtlSecondsHint: "基于 step 间隔的启发式；0 表示禁用缓存延迟。",
      thresholdRatio: "溢出压缩阈值",
      thresholdRatioHint: "DSH basic compaction 的后备/溢出阈值比例。",
      retainRatio: "溢出保留比例",
      retainRatioHint: "后备压缩后保留的历史比例，必须小于阈值。",
      save: "保存",
      saving: "保存中…",
      discard: "放弃更改",
      saved: "已保存，后续压缩立即使用新配置。",
      saveError: "保存失败，已恢复当前生效值。",
      invalid: "参数无效：压缩 Provider/Model 必须同时填写或同时留空；pressureFoldTokens ≤ foldBatchTokens；hard cap > soft cap；retainRatio < thresholdRatio。",
      loading: "配置加载中…",
      unavailable: "设置服务不可用，暂时无法编辑。",
      readonly: "当前为只读模式。",
      modeNote: "mode 仍由宿主配置控制，切换 rolling/threshold 需要重载插件；本页其他字段可热更新。",
    };

    const en = {
      title: "Lossless Context",
      intro: "Summarizer routing, cache-aware rolling policy, and overflow protection",
      expand: "Expand",
      collapse: "Collapse",
      summarizerHeading: "Summarizer model",
      summarizerHint: "Leave both Provider and Model empty to follow the current Agent. To use a dedicated summarizer, set both to real DSH adapter IDs; the plugin does not hard-code a model list.",
      summarizationProvider: "Summarizer Provider",
      summarizationProviderHint: "For example openai or anthropic; blank follows the current Agent.",
      summarizationModel: "Summarizer Model",
      summarizationModelHint: "For example gpt-5.6-sol; set together with Provider or leave both blank.",
      policyHeading: "Rolling and cache policy",
      foldTiming: "Fold timing",
      foldTimingHint: "background only makes cold-batch folds opportunistic; soft/hard pressure folds remain synchronous.",
      "foldTiming.background": "Background",
      "foldTiming.sync": "Synchronous",
      tailCount: "Fresh tail nodes",
      tailCountHint: "Minimum recent surface nodes kept verbatim during normal maintenance.",
      minRetainTokens: "Fresh tail minimum tokens",
      minRetainTokensHint: "Independent token floor so many short messages do not leave an undersized working set.",
      pressureFoldTokens: "Pressure fold minimum tokens",
      pressureFoldTokensHint: "Minimum useful reduction once the soft cap is reached.",
      foldBatchTokens: "Routine fold batch tokens",
      foldBatchTokensHint: "Routine cold-cache surface mutation granularity; default 64k.",
      softActiveTokens: "Active soft cap",
      softActiveTokensHint: "Above this active-context size, context quality takes priority over preserving a warm prefix.",
      hardActiveTokens: "Active hard cap",
      hardActiveTokensHint: "Above this boundary, any safe useful reduction is forced.",
      cacheTtlSeconds: "Cache heat TTL (seconds)",
      cacheTtlSecondsHint: "Inter-step timing heuristic; set 0 to disable cache deferral.",
      thresholdRatio: "Overflow threshold ratio",
      thresholdRatioHint: "Fallback DSH basic-compaction threshold.",
      retainRatio: "Overflow retention ratio",
      retainRatioHint: "Fallback retained-history ratio; must be below the threshold.",
      save: "Save",
      saving: "Saving…",
      discard: "Discard changes",
      saved: "Saved; subsequent compactions use the new settings.",
      saveError: "Save failed; values restored to the current effective settings.",
      invalid: "Invalid settings: summarizer Provider/Model must both be set or both blank; pressureFoldTokens ≤ foldBatchTokens; hard cap > soft cap; retainRatio < thresholdRatio.",
      loading: "Loading configuration…",
      unavailable: "Settings service unavailable; editing is disabled.",
      readonly: "Read-only mode.",
      modeNote: "mode remains host-config-only because switching rolling/threshold requires plugin reload; all fields above apply live.",
    };

    const cardStyle = { overflow: "hidden", border: "1px solid var(--dsw-alias-border-l2)", borderRadius: 10 };
    const headerStyle = {
      boxSizing: "border-box", width: "100%", display: "flex", alignItems: "center",
      justifyContent: "space-between", gap: 16, border: 0, padding: "13px 14px",
      background: "transparent", color: "var(--dsw-alias-label-primary)", font: "inherit",
      textAlign: "left", cursor: "pointer",
    };
    const headTextStyle = { display: "flex", minWidth: 0, flexDirection: "column", gap: 3 };
    const nameStyle = { fontSize: 14, lineHeight: "20px", fontWeight: 600 };
    const descriptionStyle = { fontSize: 13, lineHeight: "18px", color: "var(--dsw-alias-label-tertiary)" };
    const cardBodyStyle = {
      borderTop: "1px solid var(--dsw-alias-border-l2)", padding: "16px 14px 18px",
      display: "flex", flexDirection: "column", gap: 16,
    };
    const sectionStyle = { display: "flex", flexDirection: "column", gap: 12 };
    const rowStyle = { display: "flex", flexDirection: "column", gap: 4 };
    const labelStyle = { fontSize: 13, lineHeight: "18px", fontWeight: 600, color: "var(--dsw-alias-label-primary)" };
    const hintStyle = { fontSize: 12, lineHeight: "16px", color: "var(--dsw-alias-label-tertiary)" };
    const inputStyle = {
      boxSizing: "border-box", width: "100%", padding: "6px 8px", fontSize: 13,
      lineHeight: "18px", color: "var(--dsw-alias-label-primary)", background: "transparent",
      border: "1px solid var(--dsw-alias-border-l2)", borderRadius: 6, font: "inherit",
    };
    const controlsRowStyle = { display: "flex", alignItems: "center", gap: 10, marginTop: 2, flexWrap: "wrap" };
    const buttonStyle = {
      padding: "6px 14px", fontSize: 13, lineHeight: "18px", borderRadius: 8,
      border: "1px solid var(--dsw-alias-border-l2)", background: "transparent",
      color: "var(--dsw-alias-label-primary)", cursor: "pointer", font: "inherit",
    };
    const disabledStyle = { opacity: 0.5, cursor: "default" };
    const noteStyle = { fontSize: 12, lineHeight: "16px", color: "var(--dsw-alias-label-tertiary)" };
    const errorStyle = { ...noteStyle, color: "#e5484d" };

    const UNAVAILABLE_SNAPSHOT = Object.freeze({ status: "unavailable", value: undefined, revision: 0, writable: false });

    function chevron(open) {
      return e("span", { "aria-hidden": "true", style: { color: "var(--dsw-alias-label-tertiary)", transform: open ? "rotate(180deg)" : "none" } }, "⌄");
    }

    function normalizeText(value) {
      return value === undefined || value === null ? "" : String(value).trim();
    }

    function isNumericField(field) {
      return field.kind === "int" || field.kind === "ratio";
    }

    function sameField(field, left, right) {
      if (field.kind === "text") return normalizeText(left) === normalizeText(right);
      if (isNumericField(field)) return Number(left) === Number(right);
      return left === right;
    }

    function validateDraft(draft) {
      if (draft === undefined) return "loading";
      const provider = normalizeText(draft.summarizationProvider);
      const model = normalizeText(draft.summarizationModel);
      if ((provider.length === 0) !== (model.length === 0)) return "invalid";

      const integerKeys = ["tailCount", "minRetainTokens", "pressureFoldTokens", "foldBatchTokens", "softActiveTokens", "hardActiveTokens", "cacheTtlSeconds"];
      for (const key of integerKeys) {
        const value = Number(draft[key]);
        if (!Number.isInteger(value)) return "invalid";
        if (key === "minRetainTokens" || key === "cacheTtlSeconds") {
          if (value < 0) return "invalid";
        } else if (value < 1) return "invalid";
      }
      if (Number(draft.pressureFoldTokens) > Number(draft.foldBatchTokens)) return "invalid";
      if (Number(draft.hardActiveTokens) <= Number(draft.softActiveTokens)) return "invalid";

      const thresholdRatio = Number(draft.thresholdRatio);
      const retainRatio = Number(draft.retainRatio);
      if (!Number.isFinite(thresholdRatio) || thresholdRatio < 0 || thresholdRatio > 1) return "invalid";
      if (!Number.isFinite(retainRatio) || retainRatio < 0 || retainRatio > 1) return "invalid";
      if (retainRatio >= thresholdRatio) return "invalid";
      if (draft.foldTiming !== "background" && draft.foldTiming !== "sync") return "invalid";
      return null;
    }

    function SettingsForm({ t, configScope }) {
      const scope = configScope;
      const subscribe = React.useCallback(
        (listener) => (scope && typeof scope.subscribe === "function" ? scope.subscribe(listener) : () => undefined),
        [scope],
      );
      const getSnapshot = React.useCallback(
        () => (scope && typeof scope.getSnapshot === "function" ? scope.getSnapshot() : UNAVAILABLE_SNAPSHOT),
        [scope],
      );
      const snapshot = React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
      const [draft, setDraft] = React.useState(snapshot.value);
      const [dirty, setDirty] = React.useState(false);
      const [busy, setBusy] = React.useState(false);
      const [feedback, setFeedback] = React.useState("idle");

      React.useEffect(() => {
        if (!dirty && !busy) setDraft(snapshot.value);
      }, [busy, dirty, snapshot.revision, snapshot.value]);

      const update = (field, value) => {
        setDraft((current) => ({ ...DEFAULTS, ...(current ?? {}), [field]: value }));
        setDirty(true);
        setFeedback("idle");
      };

      const discard = () => {
        setDraft(scope && typeof scope.getSnapshot === "function" ? scope.getSnapshot().value : undefined);
        setDirty(false);
        setFeedback("idle");
      };

      const resolved = { ...DEFAULTS, ...(draft ?? {}) };
      const invalid = validateDraft(draft === undefined ? undefined : resolved);
      const loading = snapshot.status === "loading";
      const unavailable = snapshot.status === "unavailable" || snapshot.status === undefined;
      const editable = snapshot.status === "ready" && snapshot.writable && !busy && !invalid;

      const save = async () => {
        if (!scope || !snapshot.writable || draft === undefined || busy || invalid) return;
        const desired = {};
        for (const field of FIELDS) {
          const raw = resolved[field.key];
          desired[field.key] = field.kind === "text" ? normalizeText(raw)
            : field.kind === "select" ? raw
            : Number(raw);
        }
        setBusy(true);
        setFeedback("idle");
        try {
          for (const field of FIELDS) {
            const accepted = scope.getSnapshot().value ?? {};
            if (sameField(field, accepted[field.key], desired[field.key])) continue;
            await scope.set(field.key, desired[field.key]);
            const committed = scope.getSnapshot().value ?? {};
            if (!sameField(field, committed[field.key], desired[field.key])) throw new Error("Host refused " + field.key);
          }
          setDraft(scope.getSnapshot().value ?? {});
          setDirty(false);
          setFeedback("saved");
        } catch (_) {
          setDraft(scope.getSnapshot().value);
          setDirty(false);
          setFeedback("error");
        } finally {
          setBusy(false);
        }
      };

      if (unavailable) return e("div", { style: noteStyle }, t("unavailable"));
      if (loading && draft === undefined) return e("div", { style: noteStyle }, t("loading"));

      const renderField = (field) => {
        const label = t(field.key);
        const hint = t(field.key + "Hint");
        if (field.kind === "select") {
          return e("div", { key: field.key, style: rowStyle },
            e("label", { style: labelStyle }, label),
            e("span", { style: hintStyle }, hint),
            e("select", {
              style: inputStyle,
              value: String(resolved[field.key]),
              disabled: !snapshot.writable || busy,
              onChange: (event) => update(field.key, event.target.value),
            }, field.options.map((option) => e("option", { key: option, value: option }, t(field.key + "." + option)))));
        }
        if (field.kind === "text") {
          return e("div", { key: field.key, style: rowStyle },
            e("label", { style: labelStyle }, label),
            e("span", { style: hintStyle }, hint),
            e("input", {
              type: "text",
              spellCheck: false,
              autoCapitalize: "none",
              autoCorrect: "off",
              placeholder: field.placeholder,
              style: inputStyle,
              value: String(resolved[field.key] ?? ""),
              disabled: !snapshot.writable || busy,
              onChange: (event) => update(field.key, event.target.value),
            }));
        }
        return e("div", { key: field.key, style: rowStyle },
          e("label", { style: labelStyle }, label),
          e("span", { style: hintStyle }, hint),
          e("input", {
            type: "number",
            inputMode: field.kind === "int" ? "numeric" : "decimal",
            style: inputStyle,
            value: String(resolved[field.key]),
            min: field.min,
            max: field.max,
            step: field.step,
            disabled: !snapshot.writable || busy,
            onChange: (event) => {
              const text = event.target.value;
              if (text === "") return update(field.key, "");
              const parsed = field.kind === "int" ? Number.parseInt(text, 10) : Number.parseFloat(text);
              if (Number.isFinite(parsed)) update(field.key, parsed);
            },
          }));
      };

      return e("section", { style: { display: "flex", flexDirection: "column", gap: 16 } },
        e("div", { style: sectionStyle },
          e("div", { style: labelStyle }, t("summarizerHeading")),
          e("div", { style: noteStyle }, t("summarizerHint")),
          SUMMARIZER_FIELDS.map(renderField)),
        e("div", { style: sectionStyle },
          e("div", { style: labelStyle }, t("policyHeading")),
          POLICY_FIELDS.map(renderField)),
        invalid === "invalid" ? e("div", { style: errorStyle }, t("invalid")) : null,
        snapshot.status === "ready" && !snapshot.writable ? e("div", { style: noteStyle }, t("readonly")) : null,
        e("div", { style: controlsRowStyle },
          e("button", {
            type: "button",
            style: !editable ? { ...buttonStyle, ...disabledStyle } : buttonStyle,
            disabled: !editable,
            onClick: save,
          }, busy ? t("saving") : t("save")),
          dirty && !busy ? e("button", { type: "button", style: buttonStyle, onClick: discard }, t("discard")) : null,
          feedback === "saved" ? e("span", { style: noteStyle }, t("saved")) : null,
          feedback === "error" ? e("span", { style: errorStyle }, t("saveError")) : null),
        e("div", { style: noteStyle }, t("modeNote")));
    }

    function LosslessContextPluginCard({ t, configScope }) {
      if (t === undefined) throw new Error("Lossless Context plugin card requires its translation function");
      const [open, setOpen] = React.useState(false);
      const title = t("title");
      return e("li", { style: { ...cardStyle, background: "var(--dsw-alias-bg-layer-" + (open ? "2" : "3") + ")" } },
        e("button", {
          type: "button",
          style: headerStyle,
          "aria-expanded": open,
          "aria-label": (open ? t("collapse") : t("expand")) + ": " + title,
          onClick: () => setOpen(!open),
        },
          e("span", { style: headTextStyle },
            e("span", { style: nameStyle }, title),
            e("span", { style: descriptionStyle }, t("intro"))),
          chevron(open)),
        open ? e("div", { style: cardBodyStyle }, e(SettingsForm, { t, configScope })) : null);
    }

    const name = "dsh-lossless-context-client";
    const inject = ["slots", "locale", "settingsScope"];

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(LOCALE_NAMESPACE, { zh, en }), "dsh-lossless-context: settings copy");
      const t = ctx.locale.bind(LOCALE_NAMESPACE);
      const configScope = ctx.settingsScope.bind({ namespace: SETTINGS_NAMESPACE });
      ctx.slots.inject("settings.plugin.item", () => ctx.slots.register({
        name: "settings.plugin.item",
        key: SETTINGS_NAMESPACE,
        inject: () => ({ t, configScope }),
      }, LosslessContextPluginCard));
    }

    exports.apply = apply;
    exports.inject = inject;
    exports.name = name;
    return module.exports;
  },
});