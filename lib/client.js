/**
 * Browser bundle for dsh-lossless-context.
 *
 * Contributes a Plugin-configuration card that edits the host-owned
 * `lossless-context` settings section (rolling-compaction tunables).
 * Primitives-free: plain React.createElement against the same CSS variable
 * aliases DSH's native cards use. Externals: react only.
 */
"use strict";

window.__ModuleLoader__.load({
  id: "dsh-lossless-context",
  factory: (require) => {
    const React = require("react");
    const e = React.createElement;

    /** Settings namespace — must match the engine's installSection key. */
    const SETTINGS_NAMESPACE = "lossless-context";
    /** Locale namespace for this card's copy. */
    const LOCALE_NAMESPACE = "settings.lossless-context";

    /** Fallbacks when the host snapshot omits a key (fresh install). */
    const DEFAULTS = Object.freeze({
      tailCount: 24,
      foldBatchTokens: 20000,
      foldTiming: "background",
      thresholdRatio: 0.6,
      retainRatio: 0.16,
    });

    const FIELDS = [
      { key: "foldTiming", kind: "select", options: ["background", "sync"] },
      { key: "tailCount", kind: "int", min: 1, max: null, step: 1 },
      { key: "foldBatchTokens", kind: "int", min: 1, max: null, step: 1 },
      { key: "thresholdRatio", kind: "ratio", min: 0, max: 1, step: 0.01 },
      { key: "retainRatio", kind: "ratio", min: 0, max: 1, step: 0.01 },
    ];

    const zh = {
      title: "无损上下文 (Lossless Context)",
      intro: "滚动折叠与压缩阈值参数调节",
      expand: "展开",
      collapse: "折叠",
      heading: "压缩参数",
      tailCount: "保留尾部消息数",
      tailCountHint: "折叠时保留的最近消息条数（≥1）",
      foldBatchTokens: "折叠批次令牌数",
      foldBatchTokensHint: "单次折叠的最小令牌规模（≥1 的整数）",
      foldTiming: "折叠时机",
      foldTimingHint: "background 在会话空闲时后台折叠，sync 在同步阶段折叠",
      "foldTiming.background": "后台异步",
      "foldTiming.sync": "同步",
      thresholdRatio: "压缩阈值",
      thresholdRatioHint: "上下文占用达到该比例时触发压缩（0–1）",
      retainRatio: "保留比例",
      retainRatioHint: "压缩后保留的历史比例，必须小于压缩阈值（0–1）",
      save: "保存",
      saving: "保存中…",
      discard: "放弃更改",
      saved: "已保存。",
      saveError: "保存失败，已恢复为当前生效值。",
      invalid: "参数无效：保留比例必须小于压缩阈值，比例需在 0–1 之间，计数需为 ≥1 的整数。",
      loading: "配置加载中…",
      unavailable: "设置服务不可用，暂时无法编辑。",
      readonly: "当前为只读模式，修改将无法保存。",
      modeNote: "模式（mode）仅能在宿主配置中修改，重启插件后生效。",
      overridden: "当前值来自用户覆盖层；恢复默认会回到宿主基础值。",
    };
    const en = {
      title: "Lossless Context",
      intro: "Tune rolling folding and compaction thresholds",
      expand: "Expand",
      collapse: "Collapse",
      heading: "Compaction parameters",
      tailCount: "Tail message count",
      tailCountHint: "Number of recent messages kept un-folded (≥ 1)",
      foldBatchTokens: "Fold batch tokens",
      foldBatchTokensHint: "Minimum token budget folded per batch (integer ≥ 1)",
      foldTiming: "Fold timing",
      foldTimingHint: "background folds while idle; sync folds inline",
      "foldTiming.background": "Background",
      "foldTiming.sync": "Synchronous",
      thresholdRatio: "Threshold ratio",
      thresholdRatioHint: "Compact when context usage reaches this fraction (0–1)",
      retainRatio: "Retention ratio",
      retainRatioHint: "Fraction of history kept after folding, must be below the threshold (0–1)",
      save: "Save",
      saving: "Saving…",
      discard: "Discard changes",
      saved: "Saved.",
      saveError: "Save failed; values restored to the currently effective ones.",
      invalid: "Invalid values: retention ratio must be below the threshold, ratios within 0–1, counts integer ≥ 1.",
      loading: "Loading configuration…",
      unavailable: "Settings service unavailable; editing is disabled.",
      readonly: "Read-only mode; changes cannot be saved.",
      modeNote: "Mode is set in host configuration only and applies after a plugin reload.",
      overridden: "Values come from a user override layer; reverting falls back to the host base.",
    };

    const cardStyle = {
      overflow: "hidden",
      border: "1px solid var(--dsw-alias-border-l2)",
      borderRadius: 10,
    };
    const headerStyle = {
      boxSizing: "border-box",
      width: "100%",
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      gap: 16,
      border: 0,
      padding: "13px 14px",
      background: "transparent",
      color: "var(--dsw-alias-label-primary)",
      font: "inherit",
      textAlign: "left",
      cursor: "pointer",
    };
    const headTextStyle = {
      display: "flex",
      minWidth: 0,
      flexDirection: "column",
      gap: 3,
    };
    const nameStyle = { fontSize: 14, lineHeight: "20px", fontWeight: 600 };
    const descriptionStyle = {
      fontSize: 13,
      lineHeight: "18px",
      color: "var(--dsw-alias-label-tertiary)",
    };
    const chevronStyle = {
      flex: "0 0 auto",
      color: "var(--dsw-alias-label-tertiary)",
      transition: "transform 160ms ease",
    };
    const cardBodyStyle = {
      borderTop: "1px solid var(--dsw-alias-border-l2)",
      padding: "16px 14px 18px",
      display: "flex",
      flexDirection: "column",
      gap: 14,
    };
    const rowStyle = { display: "flex", flexDirection: "column", gap: 4 };
    const labelStyle = {
      fontSize: 13,
      lineHeight: "18px",
      fontWeight: 600,
      color: "var(--dsw-alias-label-primary)",
    };
    const hintStyle = {
      fontSize: 12,
      lineHeight: "16px",
      color: "var(--dsw-alias-label-tertiary)",
    };
    const inputStyle = {
      boxSizing: "border-box",
      width: "100%",
      padding: "6px 8px",
      fontSize: 13,
      lineHeight: "18px",
      color: "var(--dsw-alias-label-primary)",
      background: "transparent",
      border: "1px solid var(--dsw-alias-border-l2)",
      borderRadius: 6,
      font: "inherit",
    };
    const selectStyle = { ...inputStyle, appearance: "auto" };
    const controlsRowStyle = {
      display: "flex",
      alignItems: "center",
      gap: 10,
      marginTop: 2,
    };
    const buttonStyle = {
      padding: "6px 14px",
      fontSize: 13,
      lineHeight: "18px",
      borderRadius: 8,
      border: "1px solid var(--dsw-alias-border-l2)",
      background: "transparent",
      color: "var(--dsw-alias-label-primary)",
      cursor: "pointer",
      font: "inherit",
    };
    const disabledStyle = { opacity: 0.5, cursor: "default" };
    const feedbackStyle = {
      fontSize: 12,
      lineHeight: "16px",
      color: "var(--dsw-alias-label-tertiary)",
    };
    const errorStyle = { ...feedbackStyle, color: "#e5484d" };
    const noteStyle = {
      fontSize: 12,
      lineHeight: "16px",
      color: "var(--dsw-alias-label-tertiary)",
    };

    const UNAVAILABLE_SNAPSHOT = Object.freeze({
      status: "unavailable",
      value: undefined,
      revision: 0,
      writable: false,
    });

    function chevron(open) {
      return e("span", {
        "aria-hidden": "true",
        style: { ...chevronStyle, transform: open ? "rotate(180deg)" : "none" },
      }, e("svg", {
        width: "14", height: "14", viewBox: "0 0 14 14", fill: "none",
        xmlns: "http://www.w3.org/2000/svg",
      }, e("path", {
        d: "M11.8486 5.5L11.4238 5.92383L8.69727 8.65137C8.44157 8.90706 8.21562 9.13382 8.01172 9.29785C7.79912 9.46883 7.55595 9.61756 7.25 9.66602C7.08435 9.69222 6.91565 9.69222 6.75 9.66602C6.44405 9.61756 6.20088 9.46883 5.98828 9.29785C5.78438 9.13382 5.55843 8.90706 5.30273 8.65137L2.57617 5.92383L2.15137 5.5L3 4.65137L3.42383 5.07617L6.15137 7.80273C6.42595 8.07732 6.59876 8.24849 6.74023 8.3623C6.87291 8.46904 6.92272 8.47813 6.9375 8.48047C6.97895 8.48703 7.02105 8.48703 7.0625 8.48047C7.07728 8.47813 7.12709 8.46904 7.25977 8.3623C7.40124 8.24849 7.57405 8.07732 7.84863 7.80273L10.5762 5.07617L11 4.65137L11.8486 5.5Z",
        fill: "currentColor",
      })));
    }

    function sameField(field, left, right) {
      if (field === "tailCount" || field === "foldBatchTokens" || field === "thresholdRatio" || field === "retainRatio") {
        const leftNumber = typeof left === "string" && left !== "" ? Number(left) : left;
        const rightNumber = typeof right === "string" && right !== "" ? Number(right) : right;
        return leftNumber === rightNumber;
      }
      return left === right;
    }

    function validateDraft(draft) {
      if (draft === undefined) return "loading";
      const tailCount = Number(draft.tailCount);
      const foldBatchTokens = Number(draft.foldBatchTokens);
      const thresholdRatio = Number(draft.thresholdRatio);
      const retainRatio = Number(draft.retainRatio);
      if (!Number.isInteger(tailCount) || tailCount < 1) return "invalid";
      if (!Number.isInteger(foldBatchTokens) || foldBatchTokens < 1) return "invalid";
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
        setDraft((current) => {
          const base = current === undefined || current === null ? { ...DEFAULTS } : { ...current };
          base[field] = value;
          return base;
        });
        setDirty(true);
        setFeedback("idle");
      };

      const discard = () => {
        const latest = scope && typeof scope.getSnapshot === "function" ? scope.getSnapshot().value : undefined;
        setDraft(latest);
        setDirty(false);
        setFeedback("idle");
      };

      const valueOf = (field) => {
        const current = draft === undefined || draft === null ? {} : draft;
        const value = current[field];
        if (value === undefined || value === null || value === "") return DEFAULTS[field];
        return value;
      };

      const invalid = validateDraft(draft === undefined ? undefined : { ...DEFAULTS, ...draft });
      const loading = snapshot.status === "loading";
      const unavailable = snapshot.status === "unavailable" || snapshot.status === undefined;
      const editable = snapshot.status === "ready" && snapshot.writable && !busy && !invalid;

      const save = async () => {
        if (!scope || !snapshot.writable || draft === undefined || busy || invalid) return;
        const desired = {};
        for (const field of FIELDS) {
          const raw = valueOf(field.key);
          desired[field.key] = field.kind === "select" ? raw : Number(raw);
        }
        setBusy(true);
        setFeedback("idle");
        try {
          for (const field of FIELDS) {
            const accepted = scope.getSnapshot().value ?? {};
            if (sameField(field.key, accepted[field.key], desired[field.key])) continue;
            await scope.set(field.key, desired[field.key]);
            const committed = scope.getSnapshot().value ?? {};
            if (!sameField(field.key, committed[field.key], desired[field.key])) {
              throw new Error("Host refused " + field.key);
            }
          }
          const accepted = scope.getSnapshot().value ?? {};
          setDraft(accepted);
          setDirty(false);
          setFeedback("saved");
        } catch (error) {
          setDraft(scope.getSnapshot().value);
          setDirty(false);
          setFeedback("error");
        } finally {
          setBusy(false);
        }
      };

      if (unavailable) {
        return e("div", { style: noteStyle }, t("unavailable"));
      }
      if (loading && draft === undefined) {
        return e("div", { style: noteStyle }, t("loading"));
      }

      const rows = FIELDS.map((field) => {
        const labelKey = field.key;
        const hintKey = field.key + "Hint";
        if (field.kind === "select") {
          return e("div", { key: field.key, style: rowStyle },
            e("label", { style: labelStyle }, t(labelKey)),
            e("span", { style: hintStyle }, t(hintKey)),
            e("select", {
              style: selectStyle,
              value: String(valueOf(field.key)),
              disabled: !snapshot.writable || busy,
              onChange: (event) => update(field.key, event.target.value),
            }, field.options.map((option) =>
              e("option", { key: option, value: option }, t(field.key + "." + option)))));
        }
        return e("div", { key: field.key, style: rowStyle },
          e("label", { style: labelStyle }, t(labelKey)),
          e("span", { style: hintStyle }, t(hintKey)),
          e("input", {
            type: field.kind === "int" ? "number" : "number",
            inputMode: field.kind === "int" ? "numeric" : "decimal",
            style: inputStyle,
            value: String(valueOf(field.key)),
            min: field.min,
            max: field.max === null ? undefined : field.max,
            step: field.step,
            disabled: !snapshot.writable || busy,
            onChange: (event) => {
              const text = event.target.value;
              if (text === "") {
                update(field.key, "");
                return;
              }
              const parsed = field.kind === "int" ? Number.parseInt(text, 10) : Number.parseFloat(text);
              if (Number.isFinite(parsed)) update(field.key, parsed);
            },
          }));
      });

      return e("section", { "aria-label": t("heading"), style: { display: "flex", flexDirection: "column", gap: 12 } },
        e("div", { style: { ...labelStyle, fontSize: 13 } }, t("heading")),
        rows,
        invalid === "invalid" ? e("div", { style: errorStyle }, t("invalid")) : null,
        snapshot.status === "ready" && !snapshot.writable ? e("div", { style: noteStyle }, t("readonly")) : null,
        e("div", { style: controlsRowStyle },
          e("button", {
            type: "button",
            style: busy || !editable ? { ...buttonStyle, ...disabledStyle } : buttonStyle,
            disabled: !editable,
            onClick: save,
          }, busy ? t("saving") : t("save")),
          dirty && !busy ? e("button", {
            type: "button",
            style: buttonStyle,
            onClick: discard,
          }, t("discard")) : null,
          feedback === "saved" ? e("span", { style: feedbackStyle }, t("saved")) : null,
          feedback === "error" ? e("span", { style: errorStyle }, t("saveError")) : null),
        e("div", { style: noteStyle }, t("modeNote")));
    }

    function LosslessContextPluginCard({ t, configScope }) {
      if (t === undefined) throw new Error("Lossless Context plugin card requires its translation function");
      const [open, setOpen] = React.useState(false);
      const title = t("title");
      return e("li", {
        style: { ...cardStyle, background: "var(--dsw-alias-bg-layer-" + (open ? "2" : "3") + ")" },
      },
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
