(function () {
  "use strict";

  const state = {
    publicInfo: null,
    me: null,
    nodes: [],
    statuses: {},
    route: normalizeRoute(window.location.pathname),
    collapsedGroups: new Set(),
    activeCountryFilter: null,
    statusTimer: null,
    statusRefreshing: false,
    rpcSocket: null,
    rpcConnecting: false,
    rpcRetryAt: 0,
    rpcRequestId: 0,
    rpcPending: new Map(),
    exchangeRates: null,
    exchangeRatesLoaded: false,
    visitorInfo: null,
    detail: {
      chart: "load",
      loadRange: "real-time",
      pingRange: "real-time",
      pingTask: "all",
      recent: {},
      recentLoading: {},
      recentLoaded: {},
      loadRecords: {},
      loadLoading: {},
      pingRecords: {},
      pingLoading: {},
      errors: {}
    },
    booted: false,
    accessDenied: false,
    bootError: ""
  };

  const defaults = {
    refreshInterval: 3,
    offlineServerPosition: "Last",
    customFooterBrand: ""
  };

  const els = {
    home: document.getElementById("homeView"),
    notice: document.getElementById("notice"),
    auth: document.getElementById("authArea"),
    footerBrand: document.getElementById("footerBrand")
  };

  document.addEventListener("click", function (event) {
    const target = event.target && event.target.closest ? event.target : null;
    if (!target) return;

    const detailAction = target.closest("[data-detail-action]");
    if (detailAction) {
      event.preventDefault();
      updateDetailControl(detailAction.getAttribute("data-detail-action"), detailAction.getAttribute("data-value"));
      return;
    }

    const countryBtn = target.closest("[data-filter-country]");
    if (countryBtn) {
      event.preventDefault();
      const code = countryBtn.getAttribute("data-filter-country");
      toggleCountryFilter(code);
      return;
    }

    const clearFilter = target.closest("[data-clear-country-filter]");
    if (clearFilter) {
      event.preventDefault();
      state.activeCountryFilter = null;
      if (els.home) els.home.innerHTML = '';
      render();
      return;
    }

    const link = target.closest("[data-route]");
    if (!link) return;
    const route = normalizeRoute(link.getAttribute("data-route"));
    event.preventDefault();
    navigate(route);
  });

  document.addEventListener("keydown", function (event) {
    if (event.key !== "Enter" && event.key !== " ") return;
  });

  window.addEventListener("popstate", function () {
    state.route = normalizeRoute(window.location.pathname);
    render();
  });

  if (/^\/instance\/[^/]+\/?$/.test(window.location.pathname)) {
    window.history.replaceState({}, "", state.route + window.location.search + window.location.hash);
  }

  boot();

  async function boot() {
    setNotice("正在加载监控数据...", "success");
    try {
      await Promise.all([loadPublicInfo(), loadMe()]);
      await loadNodes();
      await loadStatuses();
      state.booted = true;
      state.accessDenied = false;
      state.bootError = "";
      setNotice("", "");
      render();
      loadExchangeRates();
      loadVisitorInfo();
      startStatusPolling();
    } catch (error) {
      console.error(error);
      state.booted = true;
      state.accessDenied = isAuthError(error);
      state.bootError = state.accessDenied ? "站点已设为私有，请登录后查看监控数据。" : (error.message || "监控数据加载失败。");
      setNotice("", "");
      render();
    }
  }

  function settings() {
    const merged = Object.assign({}, defaults, state.publicInfo && state.publicInfo.theme_settings || {});
    merged.refreshInterval = Math.max(2, Number(merged.refreshInterval) || defaults.refreshInterval);
    return merged;
  }

  async function loadPublicInfo() {
    const info = await rpc("common:getPublicInfo");
    state.publicInfo = info || {};
    const brand = settings().customFooterBrand || state.publicInfo.sitename || "Komari";
    els.footerBrand.textContent = brand;
    document.documentElement.lang = detectLang();
  }

  async function loadMe() {
    try {
      state.me = await rpc("common:getMe");
    } catch (_) {
      state.me = { logged_in: false };
    }
    renderAuth();
  }

  async function loadNodes() {
    const data = await rpc("common:getNodes");
    const nodes = Array.isArray(data) ? data : Object.values(data || {});
    state.nodes = nodes.map(normalizeNode).sort(compareNodeWeight);
  }

  async function loadStatuses() {
    try {
      const data = await rpc("common:getNodesLatestStatus");
      state.statuses = normalizeRpcStatuses(data || {});
    } catch (error) {
      console.warn("RPC2 status request failed:", error);
      state.statuses = {};
    }
  }

  async function loadExchangeRates() {
    // 采用“先显示加载态，后更新真实数据”的策略：
    // - renderCostSummary() 在 exchangeRatesLoaded=false 时显示“成本计算中...”，避免显示 fallback 价格导致视觉跳变。
    // - 仅在 finally 里把 exchangeRatesLoaded 设为 true 并 setSummaryBars()，实现平滑更新。
    try {
      const resp = await fetch("https://open.er-api.com/v6/latest/CNY", { 
        cache: "no-store" 
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      
      const data = await resp.json();
      const rates = data?.rates || {};
      
      const next = { CNY: 1, RMB: 1, CNH: 1 };
      Object.entries(rates).forEach(function ([code, rate]) {
        const n = Number(rate);
        if (n > 0) next[String(code).toUpperCase().trim()] = 1 / n;
      });
      
      state.exchangeRates = Object.assign(fallbackCnyRates(), next);
      console.log("✅ 汇率加载成功", state.exchangeRates);
    } catch (error) {
      console.warn("汇率获取失败，使用备用汇率:", error);
      state.exchangeRates = fallbackCnyRates();
    } finally {
      state.exchangeRatesLoaded = true;
      setSummaryBars();
    }
  }

  async function loadVisitorInfo() {
    state.visitorInfo = { loading: true };
    setSummaryBars();
    try {
      const resp = await fetch("https://ipwho.is/", { cache: "no-store" });
      if (!resp.ok) throw new Error(`visitor info failed: ${resp.status}`);
      const data = await resp.json();
      if (data && data.success === false) throw new Error(data.message || "visitor info failed");
      const connection = data && data.connection || {};
      state.visitorInfo = {
        ip: data && data.ip || "-",
        location: compact([data && data.city, data && data.region, data && (data.country_code || data.country)], " / ") || "-",
        asn: compact([connection.asn ? `AS${connection.asn}` : "", connection.org || connection.isp], " ") || "-"
      };
    } catch (error) {
      console.warn("Visitor info request failed:", error);
      state.visitorInfo = { ip: "-", location: "-", asn: "-" };
    } finally {
      setSummaryBars();
    }
  }

  function startStatusPolling() {
    if (state.statusTimer) window.clearTimeout(state.statusTimer);
    const loop = async function () {
      try {
        if (!state.statusRefreshing) {
          state.statusRefreshing = true;
          await loadStatuses();
          updateHomeMetrics();
          updateDetailRealtime();
        }
      } catch (error) {
        console.warn("Status refresh failed:", error);
      } finally {
        state.statusRefreshing = false;
        state.statusTimer = window.setTimeout(loop, settings().refreshInterval * 1000);
      }
    };
    state.statusTimer = window.setTimeout(loop, settings().refreshInterval * 1000);
  }

  function normalizeNode(node) {
    return {
      uuid: String(node.uuid || ""),
      name: String(node.name || "未命名"),
      cpu_name: node.cpu_name || "",
      virtualization: node.virtualization || "",
      arch: node.arch || "",
      cpu_cores: Number(node.cpu_cores || 0),
      os: node.os || "",
      kernel_version: node.kernel_version || "",
      gpu_name: node.gpu_name || "",
      region: node.region || "",
      mem_total: Number(node.mem_total || 0),
      swap_total: Number(node.swap_total || 0),
      disk_total: Number(node.disk_total || 0),
      version: node.version || node.client_version || node.agent_version || node.clientVersion || "",
      weight: Number(node.weight || 0),
      price: Number(node.price || 0),
      billing_cycle: Number(node.billing_cycle || 0),
      auto_renewal: Boolean(node.auto_renewal),
      currency: node.currency == null ? "" : String(node.currency),
      expired_at: node.expired_at || "",
      group: node.group || "默认",
      tags: node.tags || "",
      public_remark: node.public_remark || "",
      hidden: Boolean(node.hidden),
      traffic_limit: Number(node.traffic_limit || 0),
      traffic_limit_type: node.traffic_limit_type || "sum",
      created_at: node.created_at || "",
      updated_at: node.updated_at || ""
    };
  }

  function normalizeRpcStatuses(map) {
    const next = {};
    Object.entries(map).forEach(function ([uuid, rec]) {
      next[uuid] = {
        online: Boolean(rec && rec.online),
        cpu: Number(rec && rec.cpu) || 0,
        gpu: Number(rec && rec.gpu) || 0,
        ram: Number(rec && rec.ram) || 0,
        ram_total: Number(rec && rec.ram_total) || 0,
        swap: Number(rec && rec.swap) || 0,
        swap_total: Number(rec && rec.swap_total) || 0,
        load: Number(rec && rec.load) || 0,
        load5: Number(rec && rec.load5) || 0,
        load15: Number(rec && rec.load15) || 0,
        temp: Number(rec && rec.temp) || 0,
        disk: Number(rec && rec.disk) || 0,
        disk_total: Number(rec && rec.disk_total) || 0,
        net_in: Number(rec && rec.net_in) || 0,
        net_out: Number(rec && rec.net_out) || 0,
        net_total_up: Number(rec && (rec.net_total_up || rec.net_total_out)) || 0,
        net_total_down: Number(rec && (rec.net_total_down || rec.net_total_in)) || 0,
        process: Number(rec && rec.process) || 0,
        connections: Number(rec && rec.connections) || 0,
        connections_udp: Number(rec && rec.connections_udp) || 0,
        uptime: Number(rec && rec.uptime) || 0,
        version: rec && (rec.version || rec.client_version || rec.agent_version) ? String(rec.version || rec.client_version || rec.agent_version) : "",
        message: rec && rec.message ? String(rec.message) : "",
        updated_at: rec && (rec.time || rec.updated_at) ? rec.time || rec.updated_at : ""
      };
    });
    return next;
  }

  function normalizeWsStatuses(resp) {
    const online = new Set((resp && resp.online) || []);
    const data = (resp && resp.data) || {};
    const next = {};
    Object.entries(data).forEach(function ([uuid, rec]) {
      next[uuid] = {
        online: online.has(uuid),
        cpu: Number(rec.cpu && rec.cpu.usage) || 0,
        gpu: Number(rec.gpu && rec.gpu.average_usage) || 0,
        ram: Number(rec.ram && rec.ram.used) || 0,
        ram_total: Number(rec.ram && rec.ram.total) || 0,
        swap: Number(rec.swap && rec.swap.used) || 0,
        swap_total: Number(rec.swap && rec.swap.total) || 0,
        load: Number(rec.load && rec.load.load1) || 0,
        load5: Number(rec.load && rec.load.load5) || 0,
        load15: Number(rec.load && rec.load.load15) || 0,
        disk: Number(rec.disk && rec.disk.used) || 0,
        disk_total: Number(rec.disk && rec.disk.total) || 0,
        net_in: Number(rec.network && rec.network.down) || 0,
        net_out: Number(rec.network && rec.network.up) || 0,
        net_total_up: Number(rec.network && rec.network.totalUp) || 0,
        net_total_down: Number(rec.network && rec.network.totalDown) || 0,
        process: Number(rec.process) || 0,
        connections: Number(rec.connections && rec.connections.tcp) || 0,
        connections_udp: Number(rec.connections && rec.connections.udp) || 0,
        uptime: Number(rec.uptime) || 0,
        version: rec.version || rec.client_version || rec.agent_version || "",
        message: rec.message || "",
        updated_at: rec.updated_at || ""
      };
    });
    return next;
  }

  function render() {
    document.querySelectorAll("[data-route]").forEach(function (link) {
      const routeLink = !link.classList.contains("ak-logo");
      const linkRoute = normalizeRoute(link.getAttribute("data-route"));
      const keepHomeActive = link.classList.contains("nav-home") && detailUuidFromRoute(state.route);
      link.classList.toggle("active", routeLink && (linkRoute === state.route || keepHomeActive));
    });
    els.home.hidden = false;
    if (state.accessDenied) {
      renderAccessRequired();
      return;
    }
    if (state.bootError) {
      renderBootError();
      return;
    }
    const detailUuid = detailUuidFromRoute(state.route);
    if (detailUuid) {
      renderDetail(detailUuid);
    } else {
      renderHome();
    }
  }

  function renderAuth() {
    if (!els.auth) return;
    if (state.me && state.me.logged_in) {
      const name = escapeHtml(state.me.username || "Admin");
      els.auth.innerHTML = `<a class="ui large positive nezha-primary-btn button" href="/admin"><i class="terminal icon" aria-hidden="true"></i>${name}</a>`;
      return;
    }
    els.auth.innerHTML = `<a class="ui large positive nezha-primary-btn button" href="/admin"><i class="sign-in icon" aria-hidden="true"></i>登录</a>`;
  }

  function renderHome() {
    if (!els.home || state.route !== "/") return;
    if (state.accessDenied) {
      renderAccessRequired();
      return;
    }
    if (state.bootError) {
      renderBootError();
      return;
    }
    if (!state.booted && state.nodes.length === 0) {
      els.home.innerHTML = `<div class="ak-empty">正在加载节点...</div>`;
      return;
    }
    if (state.nodes.length === 0) {
      els.home.innerHTML = `<div class="ak-empty">暂无可见节点。</div>`;
      return;
    }

    // 国家/地区筛选
    let displayNodes = state.nodes;
    if (state.activeCountryFilter) {
      displayNodes = state.nodes.filter(function (node) {
        return countryCodeFromRegion(node.region) === state.activeCountryFilter;
      });
    }

    if (displayNodes.length === 0 && state.activeCountryFilter) {
      els.home.innerHTML = `<div class="ak-empty">
        暂无 ${escapeHtml(state.activeCountryFilter)} 地区的节点。
        <button type="button" class="ui button" data-clear-country-filter style="margin-left: 0.5rem;">显示全部</button>
      </div>`;
      return;
    }

    if (els.home.querySelector(".ak-card")) {
      updateHomeMetrics();
      return;
    }
    const groups = groupNodes(displayNodes);
    els.home.innerHTML = groups.map(function (group) {
      const cards = group.nodes.map(renderNodeCard).join("");
      return `<div class="ak-accordion active">
        <div class="ak-accordion-title">${renderSummaryBars()}</div>
        <div class="ak-card-grid">${cards}</div>
      </div>`;
    }).join("");
    // 注意：这里不再调用 updateHomeMetrics()，因为刚刚用 renderNodeCard + renderSummaryBars 完整渲染了初始值。
    // updateHomeMetrics 只在“已有卡片”的快速刷新路径中使用，避免重复 setSummaryBars 导致价格条多余更新。
  }

  function renderNodeCard(node) {
    const status = statusFor(node);
    const online = status.online;
    const os = osIcon(node.os);
    const cpu = pct(status.cpu, 100, online);
    const mem = pct(status.ram, node.mem_total || status.ram_total, online);
    const swap = swapPct(status.swap, node.swap_total || status.swap_total, online);
    const disk = pct(status.disk, node.disk_total || status.disk_total, online);
    const trafficUsage = trafficUsagePct(node, status);
    return `<article id="${escapeAttr(node.uuid)}" class="ak-card ${online ? "" : "offline"}">
      <div class="ak-card-header">
        <div class="ak-title-line">
          ${renderRegion(node.region)}
          ${os}
          <a class="ak-node-name ak-node-link" data-route="/node/${escapeAttr(node.uuid)}" href="/node/${escapeAttr(node.uuid)}" data-ak="node-name">${escapeHtml(node.name)}${online ? "" : "[离线]"}</a>
        </div>
        <button class="ak-info" aria-label="节点详情" title="节点详情"></button>
        <div class="ak-popup" data-ak="popup">${renderNodePopup(node, status, online)}</div>
        <div class="ak-divider"></div>
      </div>
      <div class="ak-metrics">
        <div class="ak-label">CPU</div><div class="ak-value">${progress(cpu, "cpu")}</div>
        <div class="ak-label">内存</div><div class="ak-value">${progress(mem, "mem")}</div>
        <div class="ak-label">交换</div><div class="ak-value">${progress(swap, "swap")}</div>
        <div class="ak-label">网速</div><div class="ak-value"><span class="ak-inline-metric" data-ak="net-speed">${renderNetSpeed(status)}</span></div>
        <div class="ak-label">流量</div><div class="ak-value"><span class="ak-inline-metric" data-ak="traffic">${renderTraffic(status)}</span></div>
        <div class="ak-label">用量</div><div class="ak-value">${progress(trafficUsage, "traffic-usage")}</div>
        <div class="ak-label">硬盘</div><div class="ak-value">${progress(disk, "disk")}</div>
        <div class="ak-label">信息</div><div class="ak-value"><span class="ak-info-line" data-ak="server-info">${renderServerInfo(node, status)}</span></div>
        <div class="ak-label">在线</div><div class="ak-value ak-online-value"><span class="ak-inline-metric" data-ak="uptime">${renderUptime(status, online)}</span>${renderNodeTags(node, "inline")}</div>
      </div>
    </article>`;
  }

  function updateHomeMetrics() {
    if (!els.home || state.route !== "/") return;
    setSummaryBars();
    state.nodes.forEach(function (node) {
      const card = document.getElementById(node.uuid);
      if (!card) return;
      const status = statusFor(node);
      const online = status.online;
      card.classList.toggle("offline", !online);
      setText(card, "node-name", `${node.name}${online ? "" : "[离线]"}`);
      setHtml(card, "net-speed", renderNetSpeed(status));
      setHtml(card, "traffic", renderTraffic(status));
      setHtml(card, "server-info", renderServerInfo(node, status));
      setHtml(card, "uptime", renderUptime(status, online));
      setHtml(card, "popup", renderNodePopup(node, status, online));
      updateProgress(card, "cpu", pct(status.cpu, 100, online));
      updateProgress(card, "mem", pct(status.ram, node.mem_total || status.ram_total, online));
      updateProgress(card, "swap", swapPct(status.swap, node.swap_total || status.swap_total, online));
      updateProgress(card, "traffic-usage", trafficUsagePct(node, status));
      updateProgress(card, "disk", pct(status.disk, node.disk_total || status.disk_total, online));
    });
  }

  function setText(root, key, value) {
    const el = root.querySelector(`[data-ak="${key}"]`);
    if (el && el.textContent !== value) el.textContent = value;
  }

  function setHtml(root, key, value) {
    const el = root.querySelector(`[data-ak="${key}"]`);
    if (el && el.innerHTML !== value) el.innerHTML = value;
  }

  function setSummaryBars() {
    if (!els.home) return;
    const html = renderSummaryBars();
    els.home.querySelectorAll('[data-ak="summary-bars"]').forEach(function (el) {
      if (el.outerHTML !== html) el.outerHTML = html;
    });
  }

  function renderNodePopup(node, status, online) {
    return nodeInfoRows(node, status, online).map(function (row) {
      return `<div><strong>${escapeHtml(row[0])}:</strong> ${escapeHtml(String(row[1]))}</div>`;
    }).join("");
  }

  function nodeInfoRows(node, status, online) {
    return [
      ["平台", compact([node.os, node.kernel_version], " / ")],
      ["虚拟化", compact([node.virtualization, node.arch], " / ")],
      ["CPU", node.cpu_name || `${node.cpu_cores || 0} 核`],
      ["GPU", node.gpu_name && node.gpu_name !== "None" ? node.gpu_name : ""],
      ["硬盘", `${formatBytes(status.disk)} / ${formatBytes(node.disk_total || status.disk_total)}`],
      ["内存", `${formatBytes(status.ram)} / ${formatBytes(node.mem_total || status.ram_total)}`],
      ["交换", `${formatBytes(status.swap)} / ${formatBytes(node.swap_total || status.swap_total)}`],
      ["流量", `↓ ${formatBytes(status.net_total_down)} ↑ ${formatBytes(status.net_total_up)}`],
      ["流量额度", formatTrafficUsageLine(node, status)],
      ["负载", `${fixed(status.load)} / ${fixed(status.load5)} / ${fixed(status.load15)}`],
      ["进程数", status.process || 0],
      ["连接数", `TCP ${status.connections || 0} / UDP ${status.connections_udp || 0}`],
      ["在线时间", online ? formatUptime(status.uptime) : "-"],
      ["最后活跃", formatDate(status.updated_at)]
    ].filter(function (row) { return row[1] !== ""; });
  }

  function renderNetSpeed(status) {
    return `<i class="arrow alternate circle down outline icon"></i><span>${formatBytes(status.net_in)}/s</span><i class="arrow alternate circle up outline icon"></i><span>${formatBytes(status.net_out)}/s</span>`;
  }

  function renderTraffic(status) {
    return `<i class="arrow circle down icon"></i><span>${formatBytes(status.net_total_down)}</span><i class="arrow circle up icon"></i><span>${formatBytes(status.net_total_up)}</span>`;
  }

  function renderServerInfo(node, status) {
    return `<span class="ak-hardware"><i class="bi bi-cpu-fill ak-icon-cpu"></i><span>${node.cpu_cores || guessCores(node.cpu_name)} 核</span></span><span class="ak-hardware"><i class="bi bi-memory ak-icon-memory"></i><span>${formatGB(node.mem_total || status.ram_total)}</span></span><span class="ak-hardware"><i class="bi bi-hdd-rack-fill ak-icon-disk"></i><span>${formatGB(node.disk_total || status.disk_total)}</span></span>`;
  }

  function renderUptime(status, online) {
    return `<i class="clock icon"></i><span>${online ? formatUptime(status.uptime) : "-"}</span>`;
  }

  function renderNodeTags(node, mode) {
    const tags = nodeTagItems(node);
    if (!tags.length) return "";
    const className = mode === "inline" ? "ak-node-tags ak-node-tags-inline" : "ak-node-tags";
    return `<span class="${className}">${tags.map(function (tag, index) {
      const colorClass = tag.kind ? ` ${tag.kind}` : ` c${index % 6}`;
      const title = tag.title || tag.text;
      return `<span class="ak-node-tag${colorClass}" title="${escapeAttr(title)}">${escapeHtml(tag.text)}</span>`;
    }).join("")}</span>`;
  }

  function nodeTagItems(node) {
    const items = [];
    const remaining = formatNodeRemaining(node.expired_at);
    if (remaining) items.push({ text: remaining, kind: remaining === "已到期" ? "expired" : "time" });
    const priceTag = formatNodePrice(node);
    if (priceTag) items.push({ text: priceTag, kind: "bill" });
    if (node.auto_renewal) items.push({ text: "自动续费", kind: "bill" });
    if (node.public_remark) items.push({ text: String(node.public_remark).trim(), kind: "remark" });
    splitNodeTags(node.tags).forEach(function (tag) { items.push({ text: tag, kind: "custom" }); });
    return limitNodeTags(items.filter(function (item) { return item.text; }));
  }

  function limitNodeTags(items) {
    const maxVisible = 4;
    if (items.length <= maxVisible) return items;
    const visible = items.slice(0, maxVisible - 1);
    const hidden = items.slice(maxVisible - 1);
    visible.push({ text: `+${hidden.length}`, kind: "more", title: hidden.map(function (item) { return item.text; }).join(" / ") });
    return visible;
  }

  function splitNodeTags(tags) {
    return String(tags || "").split(";").map(function (tag) {
      return tag.replace(/<\w+>$/, "").trim();
    }).filter(Boolean);
  }

  function formatNodePrice(node) {
    if (node.price === -1) return "免费";
    if (!node.price) return "";
    return `${node.currency || ""}${formatPriceNumber(node.price)}/${formatBillingCycle(node.billing_cycle)}`;
  }

  function formatPriceNumber(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return "0";
    return Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
  }

  function formatBillingCycle(days) {
    const cycle = Number(days) || 0;
    if (cycle >= 27 && cycle <= 32) return "月";
    if (cycle >= 87 && cycle <= 95) return "季";
    if (cycle >= 175 && cycle <= 185) return "半年";
    if (cycle >= 360 && cycle <= 370) return "年";
    if (cycle >= 720 && cycle <= 750) return "两年";
    if (cycle >= 1080 && cycle <= 1150) return "三年";
    if (cycle >= 1800 && cycle <= 1850) return "五年";
    if (cycle === -1) return "一次";
    return `${cycle}天`;
  }

  function formatNodeRemaining(expiredAt) {
    if (!expiredAt) return "";
    const date = new Date(expiredAt);
    if (Number.isNaN(date.getTime())) return "";
    const days = Math.ceil((date.getTime() - Date.now()) / 86400000);
    if (days <= 0) return "已到期";
    if (days > 36500) return "长期";
    return `余${days}天`;
  }

  function detailUuidFromRoute(route) {
    const match = String(route || "").match(/^\/(?:node|instance)\/(.+)$/);
    return match ? decodeURIComponent(match[1]) : "";
  }

  function renderAccessRequired() {
    if (!els.home) return;
    els.home.innerHTML = `<section class="ak-system-state ak-private-state">
      <div class="ak-system-icon"><i class="lock icon" aria-hidden="true"></i></div>
      <h1>站点已设为私有</h1>
      <p>当前监控数据需要登录后才能获取，请登录管理后台后再查看节点列表和详情数据。</p>
      <a class="ui large positive nezha-primary-btn button" href="/admin"><i class="sign-in icon" aria-hidden="true"></i>登录</a>
    </section>`;
  }

  function renderBootError() {
    if (!els.home) return;
    els.home.innerHTML = `<section class="ak-system-state ak-error-state">
      <div class="ak-system-icon"><i class="exclamation triangle icon" aria-hidden="true"></i></div>
      <h1>监控数据加载失败</h1>
      <p>${escapeHtml(state.bootError)}</p>
      <button class="ui large positive nezha-primary-btn button" type="button" onclick="window.location.reload()"><i class="sync alternate icon" aria-hidden="true"></i>重新加载</button>
    </section>`;
  }

  function findNodeByUuid(uuid) {
    return state.nodes.find(function (node) { return node.uuid === uuid; });
  }

  function updateDetailControl(action, value) {
    if (!action || !value) return;
    if (action === "chart") state.detail.chart = value === "ping" ? "ping" : "load";
    if (action === "load-range") state.detail.loadRange = value;
    if (action === "ping-range") {
      state.detail.pingRange = value;
      state.detail.pingTask = "all";
    }
    if (action === "ping-task") state.detail.pingTask = state.detail.pingTask === value ? "all" : value;
    const uuid = detailUuidFromRoute(state.route);
    if (uuid) renderDetail(uuid);
  }

  function renderDetail(uuid) {
    if (!els.home) return;
    const node = findNodeByUuid(uuid);
    if (!node) {
      els.home.innerHTML = `<div class="ak-detail-page"><a class="ak-back" href="/" data-route="/"><i class="arrow left icon"></i>返回首页</a><div class="ak-empty">未找到该节点。</div></div>`;
      return;
    }
    ensureDetailData(uuid);
    const status = statusFor(node);
    const title = `${escapeHtml(node.name)}${status.online ? "" : "[离线]"}`;
    els.home.innerHTML = `<section class="ak-detail-page" data-detail-uuid="${escapeAttr(uuid)}">
      <a class="ak-back" href="/" data-route="/"><i class="arrow left icon" aria-hidden="true"></i>返回首页</a>
      <article class="ak-detail-info-card">
        <div class="ak-detail-hero">
          <div class="ak-detail-title">
            ${renderRegion(node.region)}
            ${osIcon(node.os)}
            <h1 data-ak-detail="title">${title}</h1>
          </div>
          <div class="ak-detail-uuid">${escapeHtml(node.uuid)}</div>
        </div>
        ${renderDetailsGrid(node, status)}
      </article>
      ${renderChartsSection(node, status)}
    </section>`;
  }

  function ensureDetailData(uuid) {
    if (!state.detail.recentLoaded[uuid] && !state.detail.recentLoading[uuid]) loadRecentData(uuid);
    const loadRange = state.detail.loadRange;
    if (loadRange !== "real-time") {
      const key = `${uuid}:${loadRange}`;
      if (!state.detail.loadRecords[key] && !state.detail.loadLoading[key]) loadLoadRecords(uuid, loadRange);
    }
    if (state.detail.chart === "ping") {
      const key = `${uuid}:${state.detail.pingRange}`;
      if (!state.detail.pingRecords[key] && !state.detail.pingLoading[key]) loadPingRecords(uuid, state.detail.pingRange);
    }
  }

  async function loadRecentData(uuid) {
    state.detail.recentLoading[uuid] = true;
    try {
      const data = await rpc("common:getNodeRecentStatus", { uuid });
      state.detail.recent[uuid] = normalizeLoadRecordsResponse(data).slice(-150);
      state.detail.recentLoaded[uuid] = true;
      delete state.detail.errors[`recent:${uuid}`];
    } catch (error) {
      state.detail.errors[`recent:${uuid}`] = error.message || "加载实时记录失败";
    } finally {
      delete state.detail.recentLoading[uuid];
      if (detailUuidFromRoute(state.route) === uuid) renderDetail(uuid);
    }
  }

  async function loadLoadRecords(uuid, range) {
    const hours = hoursFromRange(range, "load");
    const key = `${uuid}:${range}`;
    state.detail.loadLoading[key] = true;
    try {
      const data = await rpc("common:getRecords", { uuid, type: "load", hours, load_type: "all", maxCount: loadHistoryMaxCount(hours) });
      state.detail.loadRecords[key] = normalizeLoadRecordsResponse(data);
      delete state.detail.errors[`load:${key}`];
    } catch (error) {
      state.detail.errors[`load:${key}`] = error.message || "加载负载记录失败";
    } finally {
      delete state.detail.loadLoading[key];
      if (detailUuidFromRoute(state.route) === uuid) renderDetail(uuid);
    }
  }

  async function loadPingRecords(uuid, range) {
    const hours = hoursFromRange(range, "ping");
    const key = `${uuid}:${range}`;
    state.detail.pingLoading[key] = true;
    try {
      const data = await rpc("common:getRecords", { uuid, type: "ping", hours });
      state.detail.pingRecords[key] = normalizePingRecords(data);
      delete state.detail.errors[`ping:${key}`];
    } catch (error) {
      state.detail.errors[`ping:${key}`] = error.message || "加载延迟记录失败";
    } finally {
      delete state.detail.pingLoading[key];
      if (detailUuidFromRoute(state.route) === uuid) renderDetail(uuid);
    }
  }

  function updateDetailRealtime() {
    const uuid = detailUuidFromRoute(state.route);
    if (!uuid) return;
    const node = findNodeByUuid(uuid);
    if (!node) return;
    const status = statusFor(node);
    const record = convertStatusToRecord(uuid, status);
    if (record) state.detail.recent[uuid] = mergeRecords(state.detail.recent[uuid] || [], record, 150);
    updateDetailRealtimeDom(node, status);
  }

  function updateDetailRealtimeDom(node, status) {
    const page = els.home && els.home.querySelector(".ak-detail-page");
    if (!page || page.getAttribute("data-detail-uuid") !== node.uuid) return;
    setDetailHtml(page, "title", `${escapeHtml(node.name)}${status.online ? "" : "[离线]"}`);
    setDetailHtml(page, "net-speed", `<span class="ak-net-down">↓ ${formatBytes(status.net_in)}/s</span><span class="ak-net-up">↑ ${formatBytes(status.net_out)}/s</span>`);
    setDetailHtml(page, "traffic", `<span>↓ ${formatBytes(status.net_total_down)}</span><span>↑ ${formatBytes(status.net_total_up)}</span>`);
    setDetailText(page, "traffic-usage", formatTrafficUsagePercent(node, status));
    setDetailSubText(page, "traffic-usage", formatTrafficLimit(node));
    setDetailText(page, "load", `${fixed(status.load)} / ${fixed(status.load5)} / ${fixed(status.load15)}`);
    setDetailText(page, "uptime", status.online ? formatUptime(status.uptime) : "-");
    setDetailText(page, "process", status.process || 0);
    setDetailText(page, "connections", `TCP ${status.connections || 0}`);
    setDetailSubText(page, "connections", `UDP ${status.connections_udp || 0}`);
    setDetailText(page, "updated", formatDate(status.updated_at || node.updated_at));
    setDetailSubText(page, "mem", `${formatBytes(status.ram)} 已用`);
    setDetailSubText(page, "swap", `${formatBytes(status.swap)} 已用`);
    setDetailSubText(page, "disk", `${formatBytes(status.disk)} 已用`);
  }

  function setDetailText(root, key, value) {
    const el = root.querySelector(`[data-ak-detail="${key}"]`);
    if (el && el.textContent !== String(value)) el.textContent = String(value);
  }

  function setDetailHtml(root, key, value) {
    const el = root.querySelector(`[data-ak-detail="${key}"]`);
    if (el && el.innerHTML !== value) el.innerHTML = value;
  }

  function setDetailSubText(root, key, value) {
    const el = root.querySelector(`[data-ak-detail-sub="${key}"]`);
    if (el && el.textContent !== String(value)) el.textContent = String(value);
  }

  function renderDetailsGrid(node, status) {
    const online = status.online;
    return `<div class="ak-detail-grid">
      ${renderStatCard("CPU", node.cpu_name || "Unknown", `${node.cpu_cores || guessCores(node.cpu_name) || 0} Cores`, "wide", "", "bi bi-cpu-fill ak-icon-cpu")}
      ${renderStatCard("架构", node.arch || "Unknown", "", "", "", "bi bi-diagram-3-fill")}
      ${renderStatCard("虚拟化", node.virtualization || "Unknown", "", "", "", "bi bi-grid-3x3-gap-fill")}
      ${renderStatCard("GPU", node.gpu_name && node.gpu_name !== "None" ? node.gpu_name : "Unknown", "", "wide", "", "bi bi-gpu-card")}
      ${renderStatCard("系统", node.os || "Unknown", `Kernel: ${node.kernel_version || "Unknown"}`, "", "", "bi bi-window-stack")}
      ${renderStatCard("网络速度", `<span class="ak-net-down">↓ ${formatBytes(status.net_in)}/s</span><span class="ak-net-up">↑ ${formatBytes(status.net_out)}/s</span>`, "", "", "net-speed", "bi bi-speedometer2", true)}
      ${renderStatCard("总流量", `<span>↓ ${formatBytes(status.net_total_down)}</span><span>↑ ${formatBytes(status.net_total_up)}</span>`, "", "", "traffic", "bi bi-arrow-left-right", true)}
      ${renderStatCard("流量使用", formatTrafficUsagePercent(node, status), formatTrafficLimit(node), "", "traffic-usage", "bi bi-pie-chart-fill")}
      ${renderStatCard("内存", formatBytes(node.mem_total || status.ram_total || 0), `${formatBytes(status.ram)} 已用`, "", "mem", "bi bi-memory ak-icon-memory")}
      ${renderStatCard("交换", formatBytes(node.swap_total || status.swap_total || 0), `${formatBytes(status.swap)} 已用`, "", "swap", "bi bi-layers-fill")}
      ${renderStatCard("硬盘", formatBytes(node.disk_total || status.disk_total || 0), `${formatBytes(status.disk)} 已用`, "", "disk", "bi bi-hdd-rack-fill ak-icon-disk")}
      ${renderStatCard("负载", `${fixed(status.load)} / ${fixed(status.load5)} / ${fixed(status.load15)}`, "", "", "load", "bi bi-activity")}
      ${renderStatCard("在线时间", online ? formatUptime(status.uptime) : "-", "", "", "uptime", "clock icon")}
      ${renderStatCard("进程", status.process || 0, "", "", "process", "bi bi-list-task")}
      ${renderStatCard("连接", `TCP ${status.connections || 0}`, `UDP ${status.connections_udp || 0}`, "", "connections", "bi bi-hdd-network-fill")}
      ${renderStatCard("最后更新", formatDate(status.updated_at || node.updated_at), "", "", "updated", "sync alternate icon")}
    </div>`;
  }

  function renderStatCard(title, value, subValue, extraClass, key, iconClass, allowHtml) {
    const valueHtml = allowHtml ? String(value == null ? "" : value) : escapeHtml(value);
    const icon = iconClass ? `<i class="${escapeAttr(iconClass)}" aria-hidden="true"></i>` : "";
    return `<article class="ak-stat-card ${extraClass ? escapeAttr(extraClass) : ""}">
      <div class="ak-stat-title">${icon}<span>${escapeHtml(title)}</span></div>
      <div class="ak-stat-value"${key ? ` data-ak-detail="${escapeAttr(key)}"` : ""}>${valueHtml}</div>
      ${subValue ? `<div class="ak-stat-sub"${key ? ` data-ak-detail-sub="${escapeAttr(key)}"` : ""}>${escapeHtml(subValue)}</div>` : ""}
    </article>`;
  }

  function renderChartsSection(node, status) {
    const chartTabs = [
      { label: "负载", value: "load", icon: "bi bi-bar-chart-line-fill" },
      { label: "延迟", value: "ping", icon: "bi bi-broadcast-pin" }
    ];
    const chart = state.detail.chart === "ping" ? "ping" : "load";
    return `<section class="ak-chart-section">
      ${renderSegmented(chartTabs, chart, "chart")}
      ${chart === "ping" ? renderPingCharts(node) : renderLoadCharts(node, status)}
    </section>`;
  }

  function renderLoadCharts(node, status) {
    const ranges = loadRanges();
    const active = normalizeRange(state.detail.loadRange, ranges);
    state.detail.loadRange = active;
    const key = `${node.uuid}:${active}`;
    const loading = Boolean(state.detail.loadLoading[key] || state.detail.recentLoading[node.uuid]);
    const error = state.detail.errors[`load:${key}`] || state.detail.errors[`recent:${node.uuid}`];
    const data = active === "real-time" ? getRealtimeRecords(node.uuid, status) : fillTimeRange(state.detail.loadRecords[key] || [], hoursFromRange(active, "load"));
    const empty = !loading && data.length === 0 ? `<div class="ak-chart-empty">暂无记录</div>` : "";
    return `<div class="ak-chart-block">
      ${renderSegmented(ranges, active, "load-range")}
      ${loading ? `<div class="ak-chart-loading">正在加载图表...</div>` : ""}
      ${error ? `<div class="ak-chart-error">${escapeHtml(error)}</div>` : ""}
      ${empty || `<div class="ak-chart-grid">
        ${renderChartCard("CPU", latestPercent(status.cpu), renderSvgChart(data, [{ key: "cpu", name: "CPU", color: "#F38181", scale: "percent" }], { min: 0, max: 100, format: formatPercent }))}
        ${renderChartCard("内存 / 交换", `${formatBytes(status.ram)} / ${formatBytes(node.mem_total || status.ram_total || 0)}`, renderSvgChart(data, [
          { key: "ram", name: "RAM", color: "#F38181", scale: "memory", total: node.mem_total || status.ram_total },
          { key: "swap", name: "Swap", color: "#FCE38A", scale: "memory", total: node.swap_total || status.swap_total }
        ], { min: 0, max: 100, format: formatPercent }))}
        ${renderChartCard("硬盘", `${formatBytes(status.disk)} / ${formatBytes(node.disk_total || status.disk_total || 0)}`, renderSvgChart(data, [{ key: "disk", name: "Disk", color: "#F38181", scale: "disk", total: node.disk_total || status.disk_total }], { min: 0, max: 100, format: formatPercent }))}
        ${renderChartCard("网络速度", `↓ ${formatBytes(status.net_in)}/s ↑ ${formatBytes(status.net_out)}/s`, renderSvgChart(data, [
          { key: "net_in", name: "Down", color: "#F38181", scale: "raw" },
          { key: "net_out", name: "Up", color: "#95E1D3", scale: "raw" }
        ], { min: 0, format: formatBytes }))}
        ${renderChartCard("负载", `${fixed(status.load)} / ${fixed(status.load5)} / ${fixed(status.load15)}`, renderSvgChart(data, [{ key: "load", name: "Load", color: "#F38181", scale: "raw" }], { min: 0, format: fixed }))}
        ${renderChartCard("连接", `TCP ${status.connections || 0} / UDP ${status.connections_udp || 0}`, renderSvgChart(data, [
          { key: "connections", name: "TCP", color: "#F38181", scale: "raw" },
          { key: "connections_udp", name: "UDP", color: "#95E1D3", scale: "raw" }
        ], { min: 0, format: formatNumber }))}
        ${renderChartCard("进程", status.process || 0, renderSvgChart(data, [{ key: "process", name: "Process", color: "#F38181", scale: "raw" }], { min: 0, format: formatNumber }))}
      </div>`}
    </div>`;
  }

  function renderPingCharts(node) {
    const ranges = pingRanges();
    const active = normalizeRange(state.detail.pingRange, ranges);
    state.detail.pingRange = active;
    const key = `${node.uuid}:${active}`;
    const loading = Boolean(state.detail.pingLoading[key]);
    const error = state.detail.errors[`ping:${key}`];
    const ping = state.detail.pingRecords[key] || { records: [], tasks: [] };
    const latest = latestPingValues(ping);
    const series = ping.tasks.map(function (task, idx) {
      return { key: String(task.id), name: task.name || `Task ${task.id}`, color: pingColors()[idx % pingColors().length], scale: "raw" };
    });
    if (state.detail.pingTask !== "all" && !series.some(function (item) { return item.key === state.detail.pingTask; })) state.detail.pingTask = "all";
    const activeTask = state.detail.pingTask || "all";
    const chartSeries = activeTask === "all" ? series : series.filter(function (item) { return item.key === activeTask; });
    const summary = latest.length ? `<article class="ak-ping-summary" aria-label="延迟监测任务">${latest.map(function (task) { return renderPingSummaryItem(task, activeTask); }).join("")}</article>` : "";
    const chart = chartSeries.length ? renderSvgChart(ping.records, chartSeries, { min: 0, lineWidth: 0.9, format: function (value) { return `${Math.round(value)}ms`; } }) : "";
    return `<div class="ak-chart-block">
      ${renderSegmented(ranges, active, "ping-range")}
      ${loading ? `<div class="ak-chart-loading">正在加载延迟...</div>` : ""}
      ${error ? `<div class="ak-chart-error">${escapeHtml(error)}</div>` : ""}
      ${summary || chart ? renderPingChartCard("延迟", "ms", summary, chart) : (!loading ? `<div class="ak-chart-empty">暂无延迟记录</div>` : "")}
    </div>`;
  }

  function renderPingSummaryItem(task, activeTask) {
    const taskId = String(task.id);
    const selected = activeTask === taskId;
    return `<button type="button" class="ak-ping-item ${selected ? "active" : ""}" data-detail-action="ping-task" data-value="${escapeAttr(taskId)}" aria-pressed="${String(selected)}">
      <span class="ak-ping-mark" style="background:${escapeAttr(task.color)}" aria-hidden="true"></span>
      <span class="ak-ping-text"><strong>${escapeHtml(task.name || `Task ${task.id}`)}</strong><span>${task.value == null ? "-" : `${Math.round(task.value)} ms`} · 丢包 ${fixed(task.loss || 0)}%</span></span>
    </button>`;
  }

  function renderChartCard(title, value, chart, extraClass) {
    return `<article class="ak-chart-card ${extraClass ? escapeAttr(extraClass) : ""}">
      <div class="ak-chart-head"><h2>${escapeHtml(title)}</h2><span>${escapeHtml(value)}</span></div>
      ${chart}
    </article>`;
  }

  function renderPingChartCard(title, value, summary, chart) {
    return `<article class="ak-chart-card ak-ping-card full">
      <div class="ak-chart-head"><h2>${escapeHtml(title)}</h2><span>${escapeHtml(value)}</span></div>
      ${summary}
      ${chart}
    </article>`;
  }

  function renderSegmented(items, active, action) {
    return `<div class="ak-segmented ak-segmented-${escapeAttr(action)}" role="tablist">${items.map(function (item) {
      const selected = item.value === active;
      const icon = item.icon ? `<i class="${escapeAttr(item.icon)}" aria-hidden="true"></i>` : "";
      return `<button type="button" class="${selected ? "active" : ""}" data-detail-action="${escapeAttr(action)}" data-value="${escapeAttr(item.value)}" aria-selected="${String(selected)}">${icon}<span>${escapeHtml(item.label)}</span></button>`;
    }).join("")}</div>`;
  }

  function loadRanges() {
    const max = Number(state.publicInfo && state.publicInfo.record_preserve_time) || 0;
    return rangeOptions(max, [
      { label: "实时", value: "real-time" },
      { label: "4 小时", value: "hours-4", hours: 4 },
      { label: "1 天", value: "hours-24", hours: 24 },
      { label: "7 天", value: "hours-168", hours: 168 },
      { label: "30 天", value: "hours-720", hours: 720 }
    ]);
  }

  function pingRanges() {
    const max = Number(state.publicInfo && state.publicInfo.ping_record_preserve_time) || 0;
    return rangeOptions(max, [
      { label: "实时", value: "real-time", hours: 1 },
      { label: "4 小时", value: "hours-4", hours: 4 },
      { label: "1 天", value: "hours-24", hours: 24 },
      { label: "7 天", value: "hours-168", hours: 168 },
      { label: "30 天", value: "hours-720", hours: 720 }
    ]);
  }

  function rangeOptions(maxHours, presets) {
    return presets.filter(function (item) {
      return !item.hours || !maxHours || maxHours >= item.hours;
    });
  }

  function normalizeRange(value, items) {
    return items.some(function (item) { return item.value === value; }) ? value : (items[0] && items[0].value || "real-time");
  }

  function hoursFromRange(range, type) {
    if (range === "real-time") return type === "ping" ? 1 : 0;
    const match = String(range || "").match(/^hours-(\d+)$/);
    return match ? Number(match[1]) : 1;
  }

  function loadHistoryMaxCount(hours) {
    if (hours <= 4) return 480;
    if (hours <= 24) return 960;
    return 2000;
  }

  function fillTimeRange(records, hours) {
    const clean = (records || []).filter(function (row) { return row && row.time; }).sort(sortByTime);
    if (!hours || clean.length === 0) return clean;
    const pointCount = 240;
    const end = new Date(clean[clean.length - 1].time).getTime() || Date.now();
    const start = end - hours * 3600 * 1000;
    const step = (end - start) / (pointCount - 1);
    let index = 0;
    const filled = [];
    for (let i = 0; i < pointCount; i++) {
      const ts = start + step * i;
      while (index < clean.length - 1 && new Date(clean[index + 1].time).getTime() <= ts) index++;
      const current = clean[index];
      const next = clean[index + 1];
      const currentDiff = current ? Math.abs(new Date(current.time).getTime() - ts) : Infinity;
      const nextDiff = next ? Math.abs(new Date(next.time).getTime() - ts) : Infinity;
      const chosen = nextDiff < currentDiff ? next : current;
      const chosenDiff = Math.min(currentDiff, nextDiff);
      if (chosen && chosenDiff <= step * 0.75) {
        filled.push(Object.assign({}, chosen, { time: new Date(ts).toISOString() }));
      } else {
        filled.push({ time: new Date(ts).toISOString() });
      }
    }
    return filled;
  }

  function getRealtimeRecords(uuid, status) {
    const base = (state.detail.recent[uuid] || []).slice(-150);
    const live = convertStatusToRecord(uuid, status);
    return live ? mergeRecords(base, live, 150) : base;
  }

  function convertNestedRecord(rec) {
    if (!rec) return null;
    return {
      client: rec.client || "",
      time: rec.updated_at || rec.time || "",
      cpu: numberOrNull(rec.cpu && rec.cpu.usage),
      gpu: numberOrNull(rec.gpu && rec.gpu.average_usage),
      ram: numberOrNull(rec.ram && rec.ram.used),
      ram_total: numberOrNull(rec.ram && rec.ram.total),
      swap: numberOrNull(rec.swap && rec.swap.used),
      swap_total: numberOrNull(rec.swap && rec.swap.total),
      load: numberOrNull(rec.load && rec.load.load1),
      disk: numberOrNull(rec.disk && rec.disk.used),
      disk_total: numberOrNull(rec.disk && rec.disk.total),
      net_in: numberOrNull(rec.network && rec.network.down),
      net_out: numberOrNull(rec.network && rec.network.up),
      net_total_up: numberOrNull(rec.network && rec.network.totalUp),
      net_total_down: numberOrNull(rec.network && rec.network.totalDown),
      process: numberOrNull(rec.process),
      connections: numberOrNull(rec.connections && rec.connections.tcp),
      connections_udp: numberOrNull(rec.connections && rec.connections.udp)
    };
  }

  function convertStatusToRecord(uuid, status) {
    if (!status || !status.updated_at) return null;
    return normalizeLoadRecord(Object.assign({ client: uuid, time: status.updated_at }, status));
  }

  function normalizeLoadRecord(rec) {
    if (!rec) return null;
    return {
      client: rec.client || "",
      time: rec.time || rec.updated_at || "",
      cpu: numberOrNull(rec.cpu),
      gpu: numberOrNull(rec.gpu),
      ram: numberOrNull(rec.ram),
      ram_total: numberOrNull(rec.ram_total),
      swap: numberOrNull(rec.swap),
      swap_total: numberOrNull(rec.swap_total),
      load: numberOrNull(rec.load),
      temp: numberOrNull(rec.temp),
      disk: numberOrNull(rec.disk),
      disk_total: numberOrNull(rec.disk_total),
      net_in: numberOrNull(rec.net_in),
      net_out: numberOrNull(rec.net_out),
      net_total_up: numberOrNull(rec.net_total_up),
      net_total_down: numberOrNull(rec.net_total_down),
      process: numberOrNull(rec.process),
      connections: numberOrNull(rec.connections),
      connections_udp: numberOrNull(rec.connections_udp)
    };
  }

  function normalizePingRecords(data) {
    // Komari 1.2.6 ping records compatibility
    // Old: {records:[{task_id,time,value}],tasks:[]}
    // New: {data:{records:...}}, {records:{task_id:[...]}} or grouped records
    const source = data && data.data ? data.data : (data || {});
    let records = [];
    if (Array.isArray(source.records)) {
      records = source.records;
    } else if (source.records && typeof source.records === "object") {
      Object.keys(source.records).forEach(function (k) {
        const arr = Array.isArray(source.records[k]) ? source.records[k] : [];
        arr.forEach(function (r) {
          const item = Object.assign({}, r);
          if (item.task_id == null) item.task_id = k;
          records.push(item);
        });
      });
    }
    const taskMap = new Map();
    const tasks = Array.isArray(source.tasks) ? source.tasks : [];
    tasks.forEach(function (task) { taskMap.set(Number(task.id), task); });
    const grouped = new Map();
    records.forEach(function (rec) {
      const id = Number(rec.task_id ?? rec.taskId ?? rec.id);
      if (!Number.isFinite(id)) return;
      if (!taskMap.has(id)) taskMap.set(id, { id, name: `Task ${id}`, loss: 0 });
      const time = rec.time || rec.created_at || rec.updated_at || rec.timestamp || "";
      if (!time) return;
      if (!grouped.has(time)) grouped.set(time, { time });
      const value = Number(rec.value ?? rec.latency ?? rec.delay ?? rec.ping);
      // 严格过滤：小于 1ms 的值视为无效（高丢包场景下 0/极低值通常是测量失败/超时）
      // 这样即使是历史数据里的 0 尖峰也会被过滤成缺口，曲线更干净
      grouped.get(time)[String(id)] = Number.isFinite(value) && value >= 1 ? value : null;
    });
    const rows = Array.from(grouped.values()).sort(sortByTime);
    return { records: rows, tasks: Array.from(taskMap.values()) };
  }

  function normalizeLoadRecordsResponse(data) {
    const records = data && data.records;
    const list = Array.isArray(records) ? records : (records && Array.isArray(records[Object.keys(records)[0]]) ? records[Object.keys(records)[0]] : []);
    return list.map(normalizeLoadRecord).filter(Boolean).sort(sortByTime);
  }

  function latestPingValues(ping) {
    const colors = pingColors();
    return (ping.tasks || []).map(function (task, idx) {
      let value = null;
      for (let i = ping.records.length - 1; i >= 0; i--) {
        const v = ping.records[i][String(task.id)];
        if (typeof v === "number" && Number.isFinite(v)) {
          value = v;
          break;
        }
      }
      return Object.assign({}, task, { value, color: colors[idx % colors.length] });
    });
  }

  function renderSvgChart(data, series, options) {
    const rows = (Array.isArray(data) ? data : []).filter(function (row) { return row && row.time; });
    if (rows.length === 0) return `<div class="ak-chart-empty">暂无记录</div>`;
    const width = 720;
    const height = 210;
    const pad = { left: 58, right: 16, top: 18, bottom: 38 };
    const plotW = width - pad.left - pad.right;
    const plotH = height - pad.top - pad.bottom;
    const prepared = series.map(function (s) {
      return Object.assign({}, s, { values: rows.map(function (row) { return scaledValue(row, s); }) });
    });
    const all = prepared.flatMap(function (s) { return s.values; }).filter(isFiniteNumber);
    if (all.length === 0) return `<div class="ak-chart-empty">暂无记录</div>`;
    const min = isFiniteNumber(options && options.min) ? options.min : Math.min.apply(null, all);
    let max = isFiniteNumber(options && options.max) ? options.max : Math.max.apply(null, all);
    if (!isFiniteNumber(max) || max <= min) max = min + 1;
    const yTicks = [0, 0.25, 0.5, 0.75, 1];
    const grid = yTicks.map(function (ratio) {
      const y = pad.top + plotH * ratio;
      return `<line x1="${pad.left}" y1="${y}" x2="${width - pad.right}" y2="${y}" class="ak-chart-gridline"></line>`;
    }).join("");
    const axes = `<line x1="${pad.left}" y1="${pad.top}" x2="${pad.left}" y2="${pad.top + plotH}" class="ak-chart-axis"></line>
        <line x1="${pad.left}" y1="${pad.top + plotH}" x2="${width - pad.right}" y2="${pad.top + plotH}" class="ak-chart-axis"></line>`;
    const yAxis = yTicks.map(function (ratio) {
      const y = pad.top + plotH * ratio;
      const value = max - (max - min) * ratio;
      const label = options && options.format ? options.format(value) : fixed(value);
      return `<g class="ak-chart-tick"><line x1="${pad.left - 5}" y1="${y}" x2="${pad.left}" y2="${y}" class="ak-chart-axis"></line><text x="${pad.left - 8}" y="${y + 4}" text-anchor="end" class="ak-chart-axis-label">${escapeHtml(label)}</text></g>`;
    }).join("");
    const xTickItems = [
      { ratio: 0, label: formatShortTime(rows[0] && rows[0].time), anchor: "start" },
      { ratio: 0.5, label: formatShortTime(rows[Math.floor((rows.length - 1) / 2)] && rows[Math.floor((rows.length - 1) / 2)].time), anchor: "middle" },
      { ratio: 1, label: formatShortTime(rows[rows.length - 1] && rows[rows.length - 1].time), anchor: "end" }
    ];
    const xAxis = xTickItems.map(function (tick) {
      const x = pad.left + plotW * tick.ratio;
      const textX = tick.ratio === 0 ? x + 2 : (tick.ratio === 1 ? x - 2 : x);
      return `<g class="ak-chart-tick"><line x1="${x}" y1="${pad.top + plotH}" x2="${x}" y2="${pad.top + plotH + 5}" class="ak-chart-axis"></line><text x="${textX}" y="${pad.top + plotH + 23}" text-anchor="${tick.anchor}" class="ak-chart-axis-label">${escapeHtml(tick.label)}</text></g>`;
    }).join("");
    const lines = prepared.map(function (s) {
      return pathForSeries(s.values, min, max, pad, plotW, plotH, s.color, options && options.lineWidth);
    }).join("");
    const hitAreas = rows.map(function (row, index) {
      const x = pad.left + (rows.length <= 1 ? plotW : index / (rows.length - 1) * plotW);
      const nextX = pad.left + (rows.length <= 1 ? plotW : Math.min(index + 1, rows.length - 1) / (rows.length - 1) * plotW);
      const prevX = pad.left + (rows.length <= 1 ? 0 : Math.max(index - 1, 0) / (rows.length - 1) * plotW);
      const w = Math.max(8, ((nextX - prevX) || 16) / 2);
      return `<rect class="ak-chart-hit" x="${(x - w / 2).toFixed(2)}" y="${pad.top}" width="${w.toFixed(2)}" height="${plotH}"><title>${escapeHtml(chartTooltip(row, prepared, options))}</title></rect>`;
    }).join("");
    const legend = prepared.map(function (s) {
      return `<span><i style="background:${escapeAttr(s.color)}"></i>${escapeHtml(s.name)}</span>`;
    }).join("");
    return `<div class="ak-chart-wrap">
      <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="chart">
        ${grid}
        ${axes}
        ${yAxis}
        ${xAxis}
        ${lines}
        ${hitAreas}
      </svg>
      <div class="ak-chart-legend">${legend}</div>
    </div>`;
  }

  function chartTooltip(row, prepared, options) {
    const lines = [formatDate(row.time)];
    prepared.forEach(function (series) {
      const value = scaledValue(row, series);
      if (!isFiniteNumber(value)) return;
      const formatted = options && options.format ? options.format(value) : fixed(value);
      lines.push(`${series.name}: ${formatted}`);
    });
    return lines.join("\n");
  }

  function pathForSeries(values, min, max, pad, plotW, plotH, color, lineWidth) {
    const count = values.length;
    let path = "";
    values.forEach(function (value, index) {
      if (!isFiniteNumber(value)) return;
      const x = pad.left + (count <= 1 ? plotW : index / (count - 1) * plotW);
      const y = pad.top + plotH - ((value - min) / (max - min)) * plotH;
      path += `${path ? "L" : "M"}${x.toFixed(2)} ${y.toFixed(2)} `;
    });
    return path ? `<path d="${path.trim()}" fill="none" stroke="${escapeAttr(color)}" stroke-width="${escapeAttr(lineWidth || 3)}" stroke-linecap="round" stroke-linejoin="round"></path>` : "";
  }

  function scaledValue(row, series) {
    const value = numberOrNull(row[series.key]);
    if (value == null) return null;

    // 针对 Ping 任务（key 是纯数字，如 "1", "3"），额外把 0 也视为无效
    // 防止历史数据或某些聚合场景下 0 尖峰漏网
    if (/^\d+$/.test(String(series.key)) && value === 0) {
      return null;
    }

    if ((series.scale === "memory" || series.scale === "disk") && Number(series.total) > 0) {
      return value <= 100 && value >= 0 && numberOrNull(row[`${series.key}_total`]) == null ? value : value / Number(series.total) * 100;
    }
    if (series.scale === "percent") return Math.max(0, Math.min(100, value));
    return value;
  }

  function mergeRecords(records, record, limit) {
    const next = records.slice();
    const time = record.time || "";
    if (time && next.some(function (item) { return item.time === time; })) return next.slice(-limit);
    next.push(record);
    return next.sort(sortByTime).slice(-limit);
  }

  function sortByTime(a, b) {
    return new Date(a.time || 0).getTime() - new Date(b.time || 0).getTime();
  }

  function numberOrNull(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }

  function isFiniteNumber(value) {
    return typeof value === "number" && Number.isFinite(value);
  }

  function formatPercent(value) {
    return `${Math.round(Number(value) || 0)}%`;
  }

  function latestPercent(value) {
    return formatPercent(value);
  }

  function formatNumber(value) {
    const n = Number(value) || 0;
    return n >= 100 ? String(Math.round(n)) : fixed(n);
  }

  function formatShortTime(value) {
    if (!value) return "";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    return date.toLocaleString([], { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
  }

  function pingColors() {
    return ["#F38181", "#347433", "#898AC4", "#03A6A1", "#7AD6F0", "#B388FF", "#FF8A65", "#FFD600"];
  }

  function navigate(route) {
    const normalized = normalizeRoute(route);
    // 点击“首页”时，如果有国家筛选，则清除筛选并强制刷新卡片
    if (normalized === "/" && state.activeCountryFilter) {
      state.activeCountryFilter = null;
      if (els.home) els.home.innerHTML = '';
    }
    state.route = normalized;
    window.history.pushState({}, "", state.route);
    render();
  }

  function toggleCountryFilter(code) {
    if (!code) return;
    if (state.activeCountryFilter === code) {
      state.activeCountryFilter = null;
    } else {
      state.activeCountryFilter = code;
    }
    if (els.home) els.home.innerHTML = ''; // 强制重新渲染卡片列表（绕过增量更新路径）
    render();
  }

  function toggleGroup(groupName) {
    if (!groupName) return;
    const title = els.home && els.home.querySelector(`.ak-accordion-title[data-group="${cssEscape(groupName)}"]`);
    const accordion = title ? title.closest(".ak-accordion") : null;
    const content = accordion ? accordion.querySelector(".ak-card-grid") : null;
    if (state.collapsedGroups.has(groupName)) {
      state.collapsedGroups.delete(groupName);
      if (accordion) accordion.classList.remove("collapsed");
      if (accordion) accordion.classList.add("active");
      if (title) {
        title.classList.add("active");
        title.setAttribute("aria-expanded", "true");
      }
      if (content) content.hidden = false;
    } else {
      state.collapsedGroups.add(groupName);
      if (accordion) accordion.classList.add("collapsed");
      if (accordion) accordion.classList.remove("active");
      if (title) {
        title.classList.remove("active");
        title.setAttribute("aria-expanded", "false");
      }
      if (content) content.hidden = true;
    }
  }

  function normalizeRoute(path) {
    const clean = String(path || "/").split("?")[0].replace(/\/+$/, "") || "/";
    const detail = clean.match(/^\/node\/([^/]+)$/);
    if (detail) return `/node/${decodeURIComponent(detail[1])}`;
    const legacyDetail = clean.match(/^\/instance\/([^/]+)$/);
    if (legacyDetail) return `/node/${decodeURIComponent(legacyDetail[1])}`;
    return "/";
  }

  function groupNodes(nodes) {
    const map = new Map();
    nodes.forEach(function (node) {
      const key = node.group || "默认";
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(node);
    });
    return Array.from(map.entries()).map(function ([name, list]) {
      return { name, nodes: sortNodes(list) };
    });
  }

  function sortNodes(nodes) {
    const mode = settings().offlineServerPosition;
    return nodes.slice().sort(function (a, b) {
      const ao = statusFor(a).online;
      const bo = statusFor(b).online;
      if (mode === "First" && ao !== bo) return ao ? 1 : -1;
      if (mode !== "Keep" && ao !== bo) return ao ? -1 : 1;
      return compareNodeWeight(a, b);
    });
  }

  function compareNodeWeight(a, b) {
    const diff = (Number(a && a.weight) || 0) - (Number(b && b.weight) || 0);
    if (diff !== 0) return diff;
    return String(a && a.name || "").localeCompare(String(b && b.name || ""), "zh-Hans-CN");
  }

  function statusFor(node) {
    const rec = state.statuses[node.uuid] || {};
    return {
      online: Boolean(rec.online),
      cpu: Number(rec.cpu) || 0,
      gpu: Number(rec.gpu) || 0,
      ram: Number(rec.ram) || 0,
      ram_total: Number(rec.ram_total) || node.mem_total || 0,
      swap: Number(rec.swap) || 0,
      swap_total: Number(rec.swap_total) || node.swap_total || 0,
      load: Number(rec.load) || 0,
      load5: Number(rec.load5) || 0,
      load15: Number(rec.load15) || 0,
      disk: Number(rec.disk) || 0,
      disk_total: Number(rec.disk_total) || node.disk_total || 0,
      net_in: Number(rec.net_in) || 0,
      net_out: Number(rec.net_out) || 0,
      net_total_up: Number(rec.net_total_up) || 0,
      net_total_down: Number(rec.net_total_down) || 0,
      process: Number(rec.process) || 0,
      connections: Number(rec.connections) || 0,
      connections_udp: Number(rec.connections_udp) || 0,
      uptime: Number(rec.uptime) || 0,
      version: rec.version || "",
      updated_at: rec.updated_at || "",
      message: rec.message || ""
    };
  }

  function pct(used, total, online) {
    const percent = online ? Math.max(0, Math.min(100, total ? Math.round(used / total * 100) : 0)) : -1;
    return { percent, className: percent < 0 ? "offline" : classForPercent(percent) };
  }

  function swapPct(used, total, online) {
    if (online && !total) {
      return { percent: 0, label: "-", className: `${classForPercent(0)} swap-disabled` };
    }
    return pct(used, total, online);
  }

  function progress(data, key) {
    const percent = Number(data.percent);
    const width = progressWidth(percent);
    const label = data.label || (percent < 0 ? "0%" : `${Math.round(percent)}%`);
    const attr = key ? ` data-ak-progress="${escapeAttr(key)}"` : "";
    return `<div class="ak-progress ${escapeAttr(data.className)}"${attr}><div class="ak-bar" style="width:${width}"><small>${label}</small></div></div>`;
  }

  function updateProgress(root, key, data) {
    const progressEl = root.querySelector(`[data-ak-progress="${key}"]`);
    if (!progressEl) return;
    const percent = Number(data.percent);
    const width = progressWidth(percent);
    const label = data.label || (percent < 0 ? "0%" : `${Math.round(percent)}%`);
    progressEl.className = `ak-progress ${data.className}`;
    const bar = progressEl.querySelector(".ak-bar");
    if (bar) bar.style.width = width;
    const small = progressEl.querySelector("small");
    if (small && small.textContent !== label) small.textContent = label;
  }

  function progressWidth(percent) {
    if (percent < 0) return "100%";
    const visible = Math.max(0, Math.min(100, percent));
    const base = 1.8 * (1 - visible / 100);
    return `calc(${visible}% + ${base.toFixed(3)}em)`;
  }

  function classForPercent(percent) {
    if (percent < 0) return "offline";
    if (percent < 51) return "fine";
    if (percent < 81) return "warning";
    return "error";
  }

  function formatTrafficUsagePercent(node, status) {
    const limit = Number(node.traffic_limit) || 0;
    if (limit <= 0) return "-";
    const used = trafficUsedForQuota(status);
    return `${Math.round(Math.max(0, used) / limit * 100)}%`;
  }

  function trafficUsagePct(node, status) {
    const limit = Number(node.traffic_limit) || 0;
    if (limit <= 0) return { percent: 0, label: "-", className: `${classForPercent(0)} swap-disabled` };
    const used = trafficUsedForQuota(status);
    const percent = Math.max(0, used) / limit * 100;
    return { percent, label: `${Math.round(percent)}%`, className: classForPercent(percent) };
  }

  function formatTrafficUsageLine(node, status) {
    const limit = Number(node.traffic_limit) || 0;
    if (limit <= 0) return "-";
    const used = Math.max(0, trafficUsedForQuota(status));
    return `${formatBytes(used)} / ${formatBytes(limit)} (${Math.round(used / limit * 100)}%)`;
  }

  function trafficUsedForQuota(status) {
    return (Number(status.net_total_up) || 0) + (Number(status.net_total_down) || 0);
  }

  function trafficSummaryData() {
    return state.nodes.reduce(function (summary, node) {
      const status = statusFor(node);
      summary.up += Number(status.net_total_up) || 0;
      summary.down += Number(status.net_total_down) || 0;
      summary.speedUp += Number(status.net_out) || 0;
      summary.speedDown += Number(status.net_in) || 0;
      return summary;
    }, { up: 0, down: 0, speedUp: 0, speedDown: 0 });
  }

  function renderTrafficSummary() {
    const data = trafficSummaryData();
    const total = data.up + data.down;
    const speedTotal = data.speedUp + data.speedDown;
    return `<span class="ak-summary-bar ak-traffic-summary" title="全网流量汇总">
      <span>总 ${formatBytes(total)}</span>
      <span>↑ ${formatBytes(data.up)}</span>
      <span>↓ ${formatBytes(data.down)}</span>
      <span>实时 ${formatBytes(speedTotal)}/s</span>
    </span>`;
  }

  function renderSummaryBars() {
    return `<span class="ak-summary-bars" data-ak="summary-bars">
      ${renderTrafficSummary()}
      ${renderCostSummary()}
      ${renderCountrySummary()}
      ${renderVisitorSummary()}
    </span>`;
  }

  function renderCostSummary() {
    // 汇率未加载完成前显示加载态，避免显示 fallback 价格导致“跳变”
    if (!state.exchangeRatesLoaded) {
      return `<span class="ak-summary-bar ak-cost-summary" title="节点成本汇总（已换算为人民币）\n正在根据实时汇率计算成本...">
        <span>成本计算中...</span>
      </span>`;
    }
    const cost = costSummaryData();
    return `<span class="ak-summary-bar ak-cost-summary" title="节点成本汇总（已换算为人民币）\n总：所有VPS年化金额总和\n月均：总金额除以12（总月均费用）\n剩：所有VPS剩余预付价值总和">
      <span>总 ${formatCny(cost.yearly)}</span>
      <span>月均 ${formatCny(cost.average)}</span>
      <span>剩 ${formatCny(cost.remaining)}</span>
    </span>`;
  }
  
  function costSummaryData() {
    const totalMonthly = state.nodes.reduce(function (sum, node) {
      return sum + nodeMonthlyCostCny(node);
    }, 0);
    const remainingTotal = state.nodes.reduce(function (sum, node) {
      return sum + nodeRemainingValueCny(node);
    }, 0);
    return {
      monthly: totalMonthly,
      yearly: totalMonthly * 12,
      average: totalMonthly,
      remaining: remainingTotal
    };
  }

  function nodeMonthlyCostCny(node) {
    const price = Number(node.price) || 0;
    const cycle = Number(node.billing_cycle) || 0;
    if (node.price === -1 || price <= 0 || cycle <= 0) return 0;
    return price * currencyToCnyRate(node.currency) * 365 / cycle / 12;
  }

  function nodeRemainingValueCny(node) {
    const price = Number(node.price) || 0;
    const cycle = Number(node.billing_cycle) || 0;
    if (node.price === -1 || price <= 0 || cycle <= 0 || !node.expired_at) return 0;

    const expired = new Date(node.expired_at);
    if (isNaN(expired.getTime())) return 0;

    const remainingDays = Math.max(0, Math.ceil((expired.getTime() - Date.now()) / 86400000));
    if (remainingDays <= 0) return 0;

    const rate = currencyToCnyRate(node.currency);
    const dailyCost = (price * rate) / cycle;   // 每天成本
    return remainingDays * dailyCost;
  }

  function currencyToCnyRate(currency) {
    // Komari 未填写货币时默认按 USD 处理，而不是 CNY
    if (!currency || !String(currency).trim()) {
      currency = "USD";
    }
    let code = String(currency).trim().toUpperCase();
    
    const symbolMap = {
      "€": "EUR", "EURO": "EUR", "EUR": "EUR", "EUROS": "EUR",
      "$": "USD", "USD": "USD", "US$": "USD",
      "¥": "CNY", "￥": "CNY", "CNY": "CNY", "JPY": "JPY",
      "£": "GBP", "GBP": "GBP",
      "₩": "KRW", "KRW": "KRW",
      "RMB": "CNY", "CN¥": "CNY"
    };
    if (symbolMap[code]) code = symbolMap[code];
    
    if (["CNY", "RMB", "CNH"].includes(code)) return 1;
    
    const rates = state.exchangeRates || fallbackCnyRates();
    return Number(rates[code]) || 1;
  }

  function fallbackCnyRates() {
    return {
      CNY: 1, RMB: 1, CNH: 1,
      USD: 7.2, EUR: 7.8, GBP: 9.2, JPY: 0.05,
      HKD: 0.92, TWD: 0.23, SGD: 5.35, KRW: 0.0052,
      AUD: 4.75, CAD: 5.25, CHF: 8.1
    };
  }

  function formatCny(value) {
    const n = Number(value) || 0;
    if (n >= 1000) return `¥${Math.round(n).toLocaleString()}`;
    return `¥${n.toFixed(2).replace(/\.00$/, "")}`;
  }

  function renderCountrySummary() {
    const items = countrySummaryItems();
    const active = state.activeCountryFilter;
    const maxVisible = 5;

    // 紧凑显示内容：≤5个完整显示，>5个显示前5个 +N
    let compactHTML = '';
    const visibleCount = Math.min(items.length, maxVisible);
    for (let i = 0; i < visibleCount; i++) {
      const item = items[i];
      const isActive = active === item.code;
      compactHTML += `<button type="button" class="ak-country-item${isActive ? " active" : ""}" data-filter-country="${escapeAttr(item.code)}" title="点击筛选 ${item.code} 地区节点">
        <img class="ak-summary-flag" src="https://cdnjs.cloudflare.com/ajax/libs/flag-icon-css/4.1.5/flags/1x1/${escapeAttr(item.code.toLowerCase())}.svg" alt="${escapeAttr(item.code)}">
        <span>${escapeHtml(item.code)} ${item.count}</span>
      </button>`;
    }
    if (items.length > maxVisible) {
      compactHTML += `<span class="ak-country-more" title="还有 ${items.length - maxVisible} 个地区，悬停展开查看全部">+${items.length - maxVisible}</span>`;
    }
    const content = items.length ? compactHTML : "<span>-</span>";

    // 展开列表（hover时显示全部）
    const expandedContent = items.length ? items.map(function (item) {
      const isActive = active === item.code;
      return `<button type="button" class="ak-country-item expanded${isActive ? " active" : ""}" data-filter-country="${escapeAttr(item.code)}">
        <img class="ak-summary-flag" src="https://cdnjs.cloudflare.com/ajax/libs/flag-icon-css/4.1.5/flags/1x1/${escapeAttr(item.code.toLowerCase())}.svg" alt="${escapeAttr(item.code)}">
        <span>${escapeHtml(item.code)} ${item.count}</span>
      </button>`;
    }).join("") : "<span>-</span>";

    return `<span class="ak-summary-bar ak-country-summary" title="节点国家统计（点击图标可筛选对应地区VPS）">
      <div class="ak-country-content">
        <div class="ak-country-compact">${content}</div>
        <div class="ak-country-full">${expandedContent}</div>
      </div>
    </span>`;
  }

  function countrySummaryItems() {
    const map = new Map();
    state.nodes.forEach(function (node) {
      const code = countryCodeFromRegion(node.region);
      if (!code) return;
      map.set(code, (map.get(code) || 0) + 1);
    });
    return Array.from(map.entries()).sort(function (a, b) {
      return a[0].localeCompare(b[0]);
    }).map(function ([code, count]) {
      return { code, count };
    });
  }

  function renderVisitorSummary() {
    const info = state.visitorInfo || { loading: true };
    if (info.loading) {
      return `<span class="ak-summary-bar ak-visitor-summary" title="来访者信息"><span>访客 获取中...</span></span>`;
    }
    return `<span class="ak-summary-bar ak-visitor-summary" title="来访者信息">
      <span>IP ${escapeHtml(info.ip || "-")}</span>
      <span>${escapeHtml(info.location || "-")}</span>
      <span>${escapeHtml(info.asn || "-")}</span>
    </span>`;
  }

  function formatTrafficLimit(node) {
    const limit = Number(node.traffic_limit) || 0;
    return `流量阈值 ${limit > 0 ? formatBytes(limit) : "-"}`;
  }

  function trafficUsedByType(type, up, down) {
    const sent = Number(up) || 0;
    const received = Number(down) || 0;
    switch (String(type || "max").toLowerCase()) {
      case "up":
        return sent;
      case "down":
        return received;
      case "sum":
        return sent + received;
      case "min":
        return Math.min(sent, received);
      case "max":
      default:
        return Math.max(sent, received);
    }
  }

  function renderRegion(region) {
    const code = countryCodeFromRegion(region);
    if (code) {
      return `<img class="ak-region" src="https://cdnjs.cloudflare.com/ajax/libs/flag-icon-css/4.1.5/flags/1x1/${escapeAttr(code.toLowerCase())}.svg" alt="${escapeAttr(code)}">`;
    }
    return region ? `<span class="ak-region ak-region-text">${escapeHtml(region)}</span>` : "";
  }

  function countryCodeFromRegion(region) {
    const value = String(region || "").trim();
    if (/^[a-z]{2}$/i.test(value)) return value.toUpperCase();
    const chars = Array.from(value);
    if (chars.length !== 2) return "";
    const start = 0x1F1E6;
    const first = chars[0].codePointAt(0);
    const second = chars[1].codePointAt(0);
    if (first >= start && first <= 0x1F1FF && second >= start && second <= 0x1F1FF) {
      return String.fromCharCode(first - start + 65) + String.fromCharCode(second - start + 65);
    }
    return "";
  }

  function osIcon(os) {
    const name = String(os || "").toLowerCase();
    if (name.includes("windows")) return `<i class="windows icon" aria-hidden="true"></i>`;
    if (name.includes("darwin") || name.includes("mac")) return `<i class="apple icon" aria-hidden="true"></i>`;
    const map = [
      ["almalinux", "almalinux"], ["alpine", "alpine"], ["arch", "archlinux"],
      ["centos", "centos"], ["debian", "debian"], ["fedora", "fedora"],
      ["freebsd", "freebsd"], ["gentoo", "gentoo"], ["kali", "kali-linux"],
      ["mint", "linuxmint"], ["openbsd", "openbsd"], ["opensuse", "opensuse"],
      ["pop", "pop-os"], ["red hat", "redhat"], ["redhat", "redhat"],
      ["rocky", "rocky-linux"], ["ubuntu", "ubuntu"], ["void", "void"],
      ["openwrt", "tux"], ["linux", "tux"]
    ];
    const found = map.find(function (item) { return name.includes(item[0]); });
    return found ? `<i class="fl-${found[1]}" aria-hidden="true"></i>` : `<i class="server icon" aria-hidden="true"></i>`;
  }

  async function rpc(method, params) {
    ensureRpcWebSocket();
    if (state.rpcSocket && state.rpcSocket.readyState === WebSocket.OPEN) {
      try {
        return await callRpcViaWebSocket(method, params);
      } catch (error) {
        console.warn(`RPC2 WebSocket ${method} failed, falling back to HTTP:`, error);
      }
    }

    return callRpcViaHttp(method, params);
  }

  function ensureRpcWebSocket() {
    if (typeof WebSocket === "undefined") return;
    if (state.rpcSocket && (state.rpcSocket.readyState === WebSocket.OPEN || state.rpcSocket.readyState === WebSocket.CONNECTING)) return;
    if (state.rpcConnecting) return;
    if (Date.now() < state.rpcRetryAt) return;

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(`${protocol}//${window.location.host}/api/rpc2`);
    state.rpcSocket = socket;
    state.rpcConnecting = true;

    socket.addEventListener("open", function () {
      state.rpcConnecting = false;
      state.rpcRetryAt = 0;
    });

    socket.addEventListener("message", function (event) {
      let data;
      try {
        data = JSON.parse(event.data);
      } catch (error) {
        console.warn("RPC2 WebSocket message parse failed:", error);
        return;
      }
      const pending = state.rpcPending.get(data && data.id);
      if (!pending) return;
      window.clearTimeout(pending.timeout);
      state.rpcPending.delete(data.id);
      if (data.error) {
        pending.reject(new Error(data.error.message || "RPC2 WebSocket request failed"));
      } else {
        pending.resolve(data.result);
      }
    });

    socket.addEventListener("close", function () {
      state.rpcConnecting = false;
      state.rpcRetryAt = Date.now() + 15000;
      if (state.rpcSocket === socket) state.rpcSocket = null;
      rejectSocketPending(socket, new Error("RPC2 WebSocket closed"));
    });

    socket.addEventListener("error", function () {
      state.rpcConnecting = false;
      state.rpcRetryAt = Date.now() + 15000;
      rejectSocketPending(socket, new Error("RPC2 WebSocket error"));
      socket.close();
    });
  }

  function callRpcViaWebSocket(method, params) {
    const socket = state.rpcSocket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("RPC2 WebSocket is not connected"));
    }

    const id = ++state.rpcRequestId;
    const payload = { jsonrpc: "2.0", id, method, params };
    return new Promise(function (resolve, reject) {
      const timeout = window.setTimeout(function () {
        state.rpcPending.delete(id);
        reject(new Error(`RPC2 ${method} timed out`));
      }, 8000);
      state.rpcPending.set(id, { resolve, reject, timeout, socket });
      socket.send(JSON.stringify(payload));
    });
  }

  function rejectSocketPending(socket, error) {
    Array.from(state.rpcPending.entries()).forEach(function ([id, pending]) {
      if (pending.socket !== socket) return;
      window.clearTimeout(pending.timeout);
      state.rpcPending.delete(id);
      pending.reject(error);
    });
  }

  async function callRpcViaHttp(method, params) {
    const payload = { jsonrpc: "2.0", id: Date.now() + Math.random(), method, params };
    const resp = await fetch("/api/rpc2", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify(payload)
    });
    if (!resp.ok) throw httpError(`RPC ${method}`, resp.status);
    const data = await resp.json();
    if (data.error) throw new Error(data.error.message || `RPC ${method} failed`);
    return data.result;
  }

  function httpError(source, status) {
    const error = new Error(status === 401 ? "需要登录后才能获取监控数据" : `${source} failed: ${status}`);
    error.status = status;
    error.source = source;
    return error;
  }

  function isAuthError(error) {
    return Boolean(error && (error.status === 401 || /(?:^|\D)401(?:\D|$)/.test(String(error.message || ""))));
  }

  function setNotice(message, type) {
    if (!els.notice) return;
    els.notice.innerHTML = message ? `<div class="ak-alert ${escapeAttr(type)}">${escapeHtml(message)}</div>` : "";
  }

  function detectLang() {
    const stored = localStorage.getItem("i18nextLng");
    if (stored) return stored;
    return navigator.language || "zh-CN";
  }

  function compact(values, sep) {
    return values.filter(Boolean).join(sep);
  }

  function fixed(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n.toFixed(2) : "0.00";
  }

  function formatGB(bytes) {
    const n = Number(bytes) || 0;
    return `${(n / 1024 / 1024 / 1024).toFixed(2)}GB`;
  }

  function formatBytes(bytes) {
    const n = Number(bytes) || 0;
    if (n <= 0) return "0B";
    const units = ["B", "KB", "MB", "GB", "TB", "PB"];
    const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), units.length - 1);
    return `${parseFloat((n / Math.pow(1024, i)).toFixed(2))}${units[i]}`;
  }

  function formatUptime(seconds) {
    let s = Math.max(0, Number(seconds) || 0);
    const d = Math.floor(s / 86400);
    s -= d * 86400;
    const h = Math.floor(s / 3600);
    s -= h * 3600;
    const m = Math.floor(s / 60);
    s = Math.floor(s - m * 60);
    if (d > 0) return `${d} 天`;
    return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }

  function formatDate(value) {
    if (!value) return "-";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "-";
    return date.toLocaleString();
  }

  function guessCores(cpuName) {
    const match = String(cpuName || "").match(/(\d+)\s*(core|cores|cpu|vcpu)/i);
    return match ? Number(match[1]) : 0;
  }

  function escapeHtml(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function escapeAttr(value) {
    return escapeHtml(value).replace(/`/g, "&#096;");
  }

  function cssEscape(value) {
    if (window.CSS && typeof window.CSS.escape === "function") return window.CSS.escape(value);
    return String(value).replace(/["\\]/g, "\\$&");
  }
})();
