/**
 * SuperLcm 浏览器组合包 / SuperLcm browser bundle.
 *
 * 为宿主拥有的 SuperLcm 设置区域提供组合包配置页。
 * Contributes the bundle configuration surface for the host-owned SuperLcm
 * settings section. Plain React keeps the client bundle independent of private
 * DSH UI primitives.
 *
 * 2026-09-02：摘要路由改为由宿主模型目录驱动的单一下拉框。
 * 2026-09-02: the summarizer route is now a single dropdown fed by the Host
 * model catalog (`remote.session.modelCatalog`, the same directory the main
 * model picker uses) and saves on change; the rolling/cache knobs moved under a
 * collapsed "advanced" section with plainer labels.
 */
"use strict";

window.__ModuleLoader__.load({
  id: "SuperLcm",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    const React = require("react");
    const e = React.createElement;

    const SETTINGS_NAMESPACE = "SuperLcm";
    const LOCALE_NAMESPACE = "settings.SuperLcm";
    const FOLLOW_AGENT = "";
    const ROUTE_SEPARATOR = "\t";

    const DEFAULTS = Object.freeze({
      summarizationRoute: Object.freeze({ provider: "", model: "" }),
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

    const POLICY_GROUPS = [
      {
        key: "groupLimits",
        fields: [
          { key: "softActiveTokens", kind: "int", min: 1, step: 1000 },
          { key: "hardActiveTokens", kind: "int", min: 1, step: 1000 },
          { key: "cacheTtlSeconds", kind: "int", min: 0, step: 60 },
        ],
      },
      {
        key: "groupRhythm",
        fields: [
          { key: "foldTiming", kind: "select", options: ["background", "sync"] },
          { key: "tailCount", kind: "int", min: 1, step: 1 },
          { key: "minRetainTokens", kind: "int", min: 0, step: 1000 },
          { key: "pressureFoldTokens", kind: "int", min: 1, step: 1000 },
          { key: "foldBatchTokens", kind: "int", min: 1, step: 1000 },
        ],
      },
      {
        key: "groupFallback",
        fields: [
          { key: "thresholdRatio", kind: "ratio", min: 0, max: 1, step: 0.01 },
          { key: "retainRatio", kind: "ratio", min: 0, max: 1, step: 0.01 },
        ],
      },
    ];
    const POLICY_FIELDS = POLICY_GROUPS.flatMap((group) => group.fields);

    const zh = {
      title: "SuperLcm",
      intro: "SuperLcm 无损召回、压缩模型与上下文压缩参数 / SuperLcm exact recall, summarizer model, and context compaction parameters",
      expand: "展开",
      collapse: "折叠",
      summarizerHeading: "压缩模型",
      summarizerHint: "压缩历史对话时用哪个模型。选择后立即生效。",
      followAgent: "跟随主 Agent",
      followAgentWith: "跟随主 Agent（当前：{model}）",
      customRoute: "自定义：{route}",
      catalogLoading: "正在读取模型列表…",
      catalogError: "模型列表读取失败，可手动填写。",
      catalogRetry: "重试",
      catalogEmpty: "没有可用模型，请先在「模型」页配置提供方。",
      manualToggle: "手动填写",
      manualProvider: "提供方 ID",
      manualModel: "模型 ID",
      manualHint: "两项同时填写，或同时留空表示跟随主 Agent。",
      manualApply: "应用",
      advancedHeading: "高级参数",
      advancedShow: "显示高级参数",
      advancedHide: "收起高级参数",
      groupLimits: "上下文上限",
      groupRhythm: "压缩节奏",
      groupFallback: "兜底压缩",
      foldTiming: "压缩时机",
      foldTimingHint: "后台异步：空闲时压缩，不阻塞回复；同步：每次都在回复前完成。",
      "foldTiming.background": "后台异步",
      "foldTiming.sync": "同步",
      tailCount: "最近保留条数",
      tailCountHint: "最近这么多条消息永远原文保留，不参与压缩。",
      minRetainTokens: "最近保留最少 Token",
      minRetainTokensHint: "与上一项同时生效，防止几十条短消息留下的工作集太小。",
      pressureFoldTokens: "单次压缩最少释放 Token",
      pressureFoldTokensHint: "超过「开始压缩阈值」后，一次压缩至少要腾出这么多。",
      foldBatchTokens: "常规压缩批次 Token",
      foldBatchTokensHint: "缓存冷却后每批压缩多少历史，默认 64k。",
      softActiveTokens: "开始压缩阈值 (Token)",
      softActiveTokensHint: "活动上下文超过这个规模就开始压缩。",
      hardActiveTokens: "强制压缩阈值 (Token)",
      hardActiveTokensHint: "超过这个规模时不再等缓存，立即压缩。必须大于开始压缩阈值。",
      cacheTtlSeconds: "缓存保温时间（秒）",
      cacheTtlSecondsHint: "两次请求间隔小于此值时视为缓存还热，尽量不动前缀；0 表示不考虑缓存。",
      thresholdRatio: "兜底压缩阈值（比例）",
      thresholdRatioHint: "DSH 自带压缩的触发比例，只在本插件没能压下去时起作用。",
      retainRatio: "兜底保留比例",
      retainRatioHint: "兜底压缩后保留多少历史，必须小于兜底压缩阈值。",
      save: "保存",
      saving: "保存中…",
      discard: "放弃更改",
      saved: "已保存，后续压缩立即使用新配置。",
      saveError: "保存失败，已恢复当前生效值。",
      invalid: "参数无效：单次压缩最少释放 ≤ 常规压缩批次；强制压缩阈值 > 开始压缩阈值；兜底保留比例 < 兜底压缩阈值。",
      invalidRoute: "提供方和模型必须同时填写，或同时留空。",
      loading: "配置加载中…",
      unavailable: "设置服务不可用，暂时无法编辑。",
      readonly: "当前为只读模式。",
      modeNote: "rolling / threshold 模式仍由宿主配置文件控制，切换需重载插件；本页其他字段可热更新。",
    };

    const en = {
      title: "SuperLcm",
      intro: "SuperLcm exact recall, summarizer model, and context compaction parameters",
      expand: "Expand",
      collapse: "Collapse",
      summarizerHeading: "Summarizer model",
      summarizerHint: "The model used to compress older conversation. Applies immediately.",
      followAgent: "Follow the main Agent",
      followAgentWith: "Follow the main Agent (currently {model})",
      customRoute: "Custom: {route}",
      catalogLoading: "Loading model list…",
      catalogError: "Could not load the model list; you can enter one manually.",
      catalogRetry: "Retry",
      catalogEmpty: "No models available; configure a provider on the Models page first.",
      manualToggle: "Enter manually",
      manualProvider: "Provider id",
      manualModel: "Model id",
      manualHint: "Set both, or leave both blank to follow the main Agent.",
      manualApply: "Apply",
      advancedHeading: "Advanced",
      advancedShow: "Show advanced parameters",
      advancedHide: "Hide advanced parameters",
      groupLimits: "Context limits",
      groupRhythm: "Compaction rhythm",
      groupFallback: "Fallback compaction",
      foldTiming: "Compaction timing",
      foldTimingHint: "Background: compact when idle without blocking replies. Synchronous: always finish before replying.",
      "foldTiming.background": "Background",
      "foldTiming.sync": "Synchronous",
      tailCount: "Recent messages kept",
      tailCountHint: "This many recent messages are always kept verbatim.",
      minRetainTokens: "Recent minimum tokens",
      minRetainTokensHint: "Applies together with the count so many short messages do not leave a tiny working set.",
      pressureFoldTokens: "Minimum tokens freed per compaction",
      pressureFoldTokensHint: "Once past the start threshold, one compaction must free at least this much.",
      foldBatchTokens: "Routine batch tokens",
      foldBatchTokensHint: "How much history each routine cold-cache batch compacts; default 64k.",
      softActiveTokens: "Start compacting at (tokens)",
      softActiveTokensHint: "Compaction starts once the active context exceeds this size.",
      hardActiveTokens: "Force compacting at (tokens)",
      hardActiveTokensHint: "Above this size compaction no longer waits for the cache. Must exceed the start threshold.",
      cacheTtlSeconds: "Cache warm window (seconds)",
      cacheTtlSecondsHint: "Requests closer together than this count as a warm cache and the prefix is left alone; 0 disables.",
      thresholdRatio: "Fallback threshold (ratio)",
      thresholdRatioHint: "DSH built-in compaction trigger, only used when this plugin could not reduce enough.",
      retainRatio: "Fallback retention (ratio)",
      retainRatioHint: "History kept after fallback compaction; must be below the fallback threshold.",
      save: "Save",
      saving: "Saving…",
      discard: "Discard changes",
      saved: "Saved; subsequent compactions use the new settings.",
      saveError: "Save failed; values restored to the current effective settings.",
      invalid: "Invalid: minimum freed ≤ routine batch; force threshold > start threshold; fallback retention < fallback threshold.",
      invalidRoute: "Provider and model must both be set, or both left blank.",
      loading: "Loading configuration…",
      unavailable: "Settings service unavailable; editing is disabled.",
      readonly: "Read-only mode.",
      modeNote: "rolling / threshold mode stays in the host config file and needs a plugin reload; every other field applies live.",
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
    const groupLabelStyle = { ...labelStyle, marginTop: 4, color: "var(--dsw-alias-label-secondary, var(--dsw-alias-label-primary))" };
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
    const linkButtonStyle = {
      padding: 0, border: 0, background: "transparent", font: "inherit", fontSize: 12,
      lineHeight: "16px", color: "var(--dsw-alias-label-tertiary)", cursor: "pointer", textDecoration: "underline",
    };
    const disabledStyle = { opacity: 0.5, cursor: "default" };
    const noteStyle = { fontSize: 12, lineHeight: "16px", color: "var(--dsw-alias-label-tertiary)" };
    const errorStyle = { ...noteStyle, color: "#e5484d" };

    const UNAVAILABLE_SNAPSHOT = Object.freeze({ status: "unavailable", value: undefined, revision: 0, writable: false });

    function chevron(open) {
      return e("span", { "aria-hidden": "true", style: { color: "var(--dsw-alias-label-tertiary)", transform: open ? "rotate(180deg)" : "none" } }, "⌄");
    }

    function fill(template, params) {
      return String(template).replace(/\{(\w+)\}/g, (_, key) => (params && params[key] !== undefined ? String(params[key]) : ""));
    }

    function normalizeText(value) {
      return value === undefined || value === null ? "" : String(value).trim();
    }

    function normalizeRoute(value) {
      return {
        provider: normalizeText(value && value.provider),
        model: normalizeText(value && value.model),
      };
    }

    function sameRoute(left, right) {
      const a = normalizeRoute(left);
      const b = normalizeRoute(right);
      return a.provider === b.provider && a.model === b.model;
    }

    function routeKey(route) {
      const r = normalizeRoute(route);
      return r.provider.length === 0 && r.model.length === 0 ? FOLLOW_AGENT : r.provider + ROUTE_SEPARATOR + r.model;
    }

    function parseRouteKey(key) {
      if (key === FOLLOW_AGENT) return { provider: "", model: "" };
      const at = key.indexOf(ROUTE_SEPARATOR);
      if (at < 0) return { provider: "", model: "" };
      return { provider: key.slice(0, at), model: key.slice(at + 1) };
    }

    function routeValid(route) {
      const r = normalizeRoute(route);
      return (r.provider.length === 0) === (r.model.length === 0);
    }

    function sameField(field, left, right) {
      if (field.kind === "int" || field.kind === "ratio") return Number(left) === Number(right);
      return left === right;
    }

    function resolvedDraft(draft) {
      return {
        ...DEFAULTS,
        ...(draft ?? {}),
        summarizationRoute: {
          ...DEFAULTS.summarizationRoute,
          ...((draft && draft.summarizationRoute) || {}),
        },
      };
    }

    function validatePolicy(draft) {
      if (draft === undefined) return "loading";
      const resolved = resolvedDraft(draft);
      const integerKeys = ["tailCount", "minRetainTokens", "pressureFoldTokens", "foldBatchTokens", "softActiveTokens", "hardActiveTokens", "cacheTtlSeconds"];
      for (const key of integerKeys) {
        const value = Number(resolved[key]);
        if (!Number.isInteger(value)) return "invalid";
        if (key === "minRetainTokens" || key === "cacheTtlSeconds") {
          if (value < 0) return "invalid";
        } else if (value < 1) return "invalid";
      }
      if (Number(resolved.pressureFoldTokens) > Number(resolved.foldBatchTokens)) return "invalid";
      if (Number(resolved.hardActiveTokens) <= Number(resolved.softActiveTokens)) return "invalid";

      const thresholdRatio = Number(resolved.thresholdRatio);
      const retainRatio = Number(resolved.retainRatio);
      if (!Number.isFinite(thresholdRatio) || thresholdRatio < 0 || thresholdRatio > 1) return "invalid";
      if (!Number.isFinite(retainRatio) || retainRatio < 0 || retainRatio > 1) return "invalid";
      if (retainRatio >= thresholdRatio) return "invalid";
      if (resolved.foldTiming !== "background" && resolved.foldTiming !== "sync") return "invalid";
      return null;
    }

    /** 设置作用域上的快照存储钩子；不可用时返回占位值 / Snapshot-store hook over a settings scope (or an unavailable stand-in). */
    function useScopeSnapshot(scope) {
      const subscribe = React.useCallback(
        (listener) => (scope && typeof scope.subscribe === "function" ? scope.subscribe(listener) : () => undefined),
        [scope],
      );
      const getSnapshot = React.useCallback(
        () => (scope && typeof scope.getSnapshot === "function" ? scope.getSnapshot() : UNAVAILABLE_SNAPSHOT),
        [scope],
      );
      return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
    }

    /** 每次卡片打开时读取一次宿主模型目录，reload 可重试 / Load the Host model catalog once per card open; `reload` retries. */
    function useModelCatalog(loadCatalog) {
      const [state, setState] = React.useState({ status: "idle", catalog: null, error: null });
      const [tick, setTick] = React.useState(0);
      React.useEffect(() => {
        if (typeof loadCatalog !== "function") {
          setState({ status: "error", catalog: null, error: "modelCatalog unavailable" });
          return undefined;
        }
        let cancelled = false;
        setState((current) => ({ ...current, status: "loading", error: null }));
        Promise.resolve()
          .then(() => loadCatalog())
          .then((response) => {
            if (cancelled) return;
            if (!response || response.ok !== true) {
              const message = response && response.error ? response.error.message : "modelCatalog failed";
              setState({ status: "error", catalog: null, error: message });
              return;
            }
            setState({ status: "ready", catalog: response.value, error: null });
          })
          .catch((error) => {
            if (cancelled) return;
            setState({ status: "error", catalog: null, error: error instanceof Error ? error.message : String(error) });
          });
        return () => { cancelled = true; };
      }, [loadCatalog, tick]);
      const reload = React.useCallback(() => setTick((n) => n + 1), []);
      return [state, reload];
    }

    function SummarizerPicker({ t, scope, snapshot, loadCatalog }) {
      const [catalogState, reloadCatalog] = useModelCatalog(loadCatalog);
      const [busy, setBusy] = React.useState(false);
      const [feedback, setFeedback] = React.useState("idle");
      const [manual, setManual] = React.useState(false);
      const [manualDraft, setManualDraft] = React.useState({ provider: "", model: "" });

      const current = normalizeRoute(snapshot.value && snapshot.value.summarizationRoute);
      const currentKey = routeKey(current);
      const catalog = catalogState.catalog;
      const groups = catalog && Array.isArray(catalog.groups) ? catalog.groups : [];
      const known = new Set();
      for (const group of groups) for (const model of group.models || []) known.add(routeKey({ provider: group.id, model: model.id }));
      const currentIsCustom = currentKey !== FOLLOW_AGENT && !known.has(currentKey);

      const agentDefault = catalog && catalog.default ? normalizeRoute(catalog.default) : null;
      let agentDefaultName = agentDefault ? agentDefault.model : "";
      if (agentDefault) {
        for (const group of groups) {
          if (group.id !== agentDefault.provider) continue;
          const hit = (group.models || []).find((model) => model.id === agentDefault.model);
          if (hit) agentDefaultName = hit.name || hit.id;
        }
      }

      const canEdit = snapshot.status === "ready" && snapshot.writable && !busy;

      const commit = async (route) => {
        if (!scope || !canEdit) return;
        if (!routeValid(route)) { setFeedback("invalidRoute"); return; }
        const desired = normalizeRoute(route);
        if (sameRoute(desired, current)) { setFeedback("idle"); return; }
        setBusy(true);
        setFeedback("idle");
        try {
          await scope.set("summarizationRoute", desired);
          const accepted = scope.getSnapshot().value ?? {};
          if (!sameRoute(accepted.summarizationRoute, desired)) throw new Error("Host refused summarizationRoute");
          setFeedback("saved");
          setManual(false);
        } catch (_) {
          setFeedback("error");
        } finally {
          setBusy(false);
        }
      };

      const followLabel = agentDefaultName ? fill(t("followAgentWith"), { model: agentDefaultName }) : t("followAgent");
      const options = [e("option", { key: "__follow", value: FOLLOW_AGENT }, followLabel)];
      if (currentIsCustom) {
        options.push(e("option", { key: "__custom", value: currentKey }, fill(t("customRoute"), { route: current.provider + " / " + current.model })));
      }
      for (const group of groups) {
        const models = group.models || [];
        if (models.length === 0) continue;
        options.push(e("optgroup", { key: group.id, label: group.name || group.id },
          models.map((model) => e("option", { key: model.id, value: routeKey({ provider: group.id, model: model.id }) }, model.name || model.id))));
      }

      const catalogNote = (() => {
        if (catalogState.status === "loading") return e("span", { style: noteStyle }, t("catalogLoading"));
        if (catalogState.status === "error") return e("span", { style: errorStyle },
          t("catalogError"), " ",
          e("button", { type: "button", style: linkButtonStyle, onClick: reloadCatalog }, t("catalogRetry")));
        if (catalogState.status === "ready" && groups.length === 0) return e("span", { style: errorStyle }, t("catalogEmpty"));
        return null;
      })();

      const manualForm = manual ? e("div", { style: { ...sectionStyle, gap: 8 } },
        e("span", { style: hintStyle }, t("manualHint")),
        e("div", { style: { display: "flex", gap: 8, flexWrap: "wrap" } },
          e("input", {
            type: "text", spellCheck: false, autoCapitalize: "none", autoCorrect: "off",
            placeholder: t("manualProvider"), style: { ...inputStyle, flex: "1 1 160px" },
            value: manualDraft.provider, disabled: !canEdit,
            onChange: (event) => setManualDraft({ ...manualDraft, provider: event.target.value }),
          }),
          e("input", {
            type: "text", spellCheck: false, autoCapitalize: "none", autoCorrect: "off",
            placeholder: t("manualModel"), style: { ...inputStyle, flex: "1 1 200px" },
            value: manualDraft.model, disabled: !canEdit,
            onChange: (event) => setManualDraft({ ...manualDraft, model: event.target.value }),
          }),
          e("button", {
            type: "button", disabled: !canEdit,
            style: !canEdit ? { ...buttonStyle, ...disabledStyle } : buttonStyle,
            onClick: () => commit(manualDraft),
          }, t("manualApply")))) : null;

      return e("div", { style: sectionStyle },
        e("div", { style: labelStyle }, t("summarizerHeading")),
        e("span", { style: hintStyle }, t("summarizerHint")),
        e("select", {
          style: inputStyle,
          value: currentKey,
          disabled: !canEdit || catalogState.status === "loading",
          onChange: (event) => commit(parseRouteKey(event.target.value)),
        }, options),
        e("div", { style: controlsRowStyle },
          catalogNote,
          e("button", {
            type: "button", style: linkButtonStyle,
            onClick: () => { setManualDraft({ ...current }); setManual(!manual); },
          }, t("manualToggle")),
          busy ? e("span", { style: noteStyle }, t("saving")) : null,
          feedback === "saved" ? e("span", { style: noteStyle }, t("saved")) : null,
          feedback === "error" ? e("span", { style: errorStyle }, t("saveError")) : null,
          feedback === "invalidRoute" ? e("span", { style: errorStyle }, t("invalidRoute")) : null),
        manualForm);
    }

    function AdvancedForm({ t, scope, snapshot }) {
      const [draft, setDraft] = React.useState(snapshot.value);
      const [dirty, setDirty] = React.useState(false);
      const [busy, setBusy] = React.useState(false);
      const [feedback, setFeedback] = React.useState("idle");

      React.useEffect(() => {
        if (!dirty && !busy) setDraft(snapshot.value);
      }, [busy, dirty, snapshot.revision, snapshot.value]);

      const updatePolicy = (field, value) => {
        setDraft((current) => ({ ...resolvedDraft(current), [field]: value }));
        setDirty(true);
        setFeedback("idle");
      };

      const discard = () => {
        setDraft(scope && typeof scope.getSnapshot === "function" ? scope.getSnapshot().value : undefined);
        setDirty(false);
        setFeedback("idle");
      };

      const resolved = resolvedDraft(draft);
      const invalid = validatePolicy(draft);
      const editable = snapshot.status === "ready" && snapshot.writable && !busy && !invalid && dirty;

      const save = async () => {
        if (!scope || !snapshot.writable || draft === undefined || busy || invalid) return;
        setBusy(true);
        setFeedback("idle");
        try {
          for (const field of POLICY_FIELDS) {
            const raw = resolved[field.key];
            const desired = field.kind === "select" ? raw : Number(raw);
            let accepted = scope.getSnapshot().value ?? {};
            if (sameField(field, accepted[field.key], desired)) continue;
            await scope.set(field.key, desired);
            accepted = scope.getSnapshot().value ?? {};
            if (!sameField(field, accepted[field.key], desired)) throw new Error("Host refused " + field.key);
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
              onChange: (event) => updatePolicy(field.key, event.target.value),
            }, field.options.map((option) => e("option", { key: option, value: option }, t(field.key + "." + option)))));
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
              if (text === "") return updatePolicy(field.key, "");
              const parsed = field.kind === "int" ? Number.parseInt(text, 10) : Number.parseFloat(text);
              if (Number.isFinite(parsed)) updatePolicy(field.key, parsed);
            },
          }));
      };

      return e("div", { style: sectionStyle },
        POLICY_GROUPS.map((group) => e("div", { key: group.key, style: sectionStyle },
          e("div", { style: groupLabelStyle }, t(group.key)),
          group.fields.map(renderField))),
        invalid === "invalid" ? e("div", { style: errorStyle }, t("invalid")) : null,
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

    function SettingsForm({ t, configScope, loadCatalog }) {
      const snapshot = useScopeSnapshot(configScope);
      const [advanced, setAdvanced] = React.useState(false);

      const loading = snapshot.status === "loading";
      const unavailable = snapshot.status === "unavailable" || snapshot.status === undefined;
      if (unavailable) return e("div", { style: noteStyle }, t("unavailable"));
      if (loading && snapshot.value === undefined) return e("div", { style: noteStyle }, t("loading"));

      return e("section", { style: { display: "flex", flexDirection: "column", gap: 16 } },
        e(SummarizerPicker, { t, scope: configScope, snapshot, loadCatalog }),
        snapshot.status === "ready" && !snapshot.writable ? e("div", { style: noteStyle }, t("readonly")) : null,
        e("div", { style: sectionStyle },
          e("button", {
            type: "button", style: { ...buttonStyle, alignSelf: "flex-start" },
            "aria-expanded": advanced,
            onClick: () => setAdvanced(!advanced),
          }, advanced ? t("advancedHide") : t("advancedShow")),
          advanced ? e(AdvancedForm, { t, scope: configScope, snapshot }) : null));
    }

    function SuperLcmPluginConfig({ t, configScope, loadCatalog, view }) {
      if (t === undefined) throw new Error("SuperLcm configuration requires its translation function");
      if (view === "summary") return e("span", { style: descriptionStyle }, t("intro"));
      return e("section", { style: cardBodyStyle },
        e("h3", { style: nameStyle }, t("title")),
        e(SettingsForm, { t, configScope, loadCatalog }));
    }

    const name = "SuperLcm-client";
    const inject = ["slots", "locale", "settingsScope", "remote", "remote.session"];

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(LOCALE_NAMESPACE, { zh, en }), "SuperLcm：设置文案 / SuperLcm: settings copy");
      const t = ctx.locale.bind(LOCALE_NAMESPACE);
      const configScope = ctx.settingsScope.bind({ namespace: SETTINGS_NAMESPACE });
      const loadCatalog = () => ctx.remote.session.modelCatalog();
      ctx.slots.inject("plugins.bundle.config", () => ctx.slots.register({
        name: "plugins.bundle.config",
        key: "SuperLcm",
        inject: () => ({ t, configScope, loadCatalog }),
      }, SuperLcmPluginConfig));
    }

    exports.apply = apply;
    exports.inject = inject;
    exports.name = name;
    return module.exports;
  },
});
