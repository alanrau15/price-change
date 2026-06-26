const DEFAULT_STATE = {
  cash: 0,
  usdTwdRate: null,
  holdings: [],
  assetHistory: [],
  changeLog: [],
};

let state = structuredClone(DEFAULT_STATE);
let lastRefreshAt = null;
let saveTimer = null;
let autoRefreshTimer = null;
let stateSyncTimer = null;
let isRefreshing = false;

const PASSWORD_HASH = "21039d52a7306ee5b6b7b43512d78cde1da852f5679f401459dd757b42b23a57";
const AUTO_REFRESH_MS = 5 * 60 * 1000;
const STATE_SYNC_MS = 30 * 1000;
const STATIC_STATE_URL = "portfolio-state.json";
const QUOTES_URL = "quotes.json";
const LOCAL_STATE_KEY = "priceChangePortfolioState";

const moneyFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const twdFormatter = new Intl.NumberFormat("zh-TW", {
  style: "currency",
  currency: "TWD",
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});

const numberFormatter = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 4,
});

const dom = {};

document.addEventListener("DOMContentLoaded", init);

async function ensureUnlocked() {
  if (sessionStorage.getItem("priceChangeUnlocked") === "1") return true;

  document.body.innerHTML = `
    <main style="min-height:100vh;display:grid;place-items:center;padding:20px;background:#f4f7fb;color:#14233b;font-family:var(--font-sans);">
      <form id="passwordForm" style="width:min(430px,100%);border:1px solid #dce6f2;border-radius:8px;background:white;padding:28px;box-shadow:0 12px 35px rgba(26,47,80,.08);">
        <h1 style="margin:0 0 8px;font-size:30px;">投資總表</h1>
        <p style="margin:0 0 20px;color:#66758a;line-height:1.6;">請輸入進入密碼。</p>
        <label style="display:grid;gap:8px;color:#66758a;font-weight:700;">
          密碼
          <input id="passwordInput" type="password" autocomplete="current-password" autofocus style="width:100%;min-height:54px;border:1px solid #c6d6e6;border-radius:8px;padding:10px 14px;color:#14233b;font:inherit;font-size:22px;">
        </label>
        <button class="primary-button" type="submit" style="width:100%;margin-top:18px;">進入</button>
        <div id="passwordMessage" style="min-height:24px;margin-top:14px;color:#bd2330;"></div>
      </form>
    </main>
  `;

  const form = document.getElementById("passwordForm");
  const input = document.getElementById("passwordInput");
  const message = document.getElementById("passwordMessage");

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const hash = await sha256(input.value);
    if (hash !== PASSWORD_HASH) {
      message.textContent = "密碼錯誤。";
      input.select();
      return;
    }
    sessionStorage.setItem("priceChangeUnlocked", "1");
    location.reload();
  });

  return false;
}

async function sha256(text) {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function init() {
  if (!(await ensureUnlocked())) return;
  cacheDom();
  bindEvents();
  await loadState();
  render();
  refreshQuotes({ quiet: true });
  startAutoRefresh();
  startStateSync();
  loadNetworkInfo();
}

function cacheDom() {
  [
    "updatedAt",
    "lanHint",
    "refreshBtn",
    "logoutBtn",
    "copyBtn",
    "addBtn",
    "recordBtn",
    "symbolInput",
    "sharesInput",
    "cashInput",
    "totalUsd",
    "totalTwd",
    "fxRate",
    "securitiesValue",
    "cashValue",
    "dayChangeValue",
    "largestHolding",
    "holdingsBody",
    "historyCount",
    "latestHistoryTotal",
    "historyChange",
    "historyChart",
    "historyBody",
    "changeLog",
    "toast",
  ].forEach((id) => {
    dom[id] = document.getElementById(id);
  });
}

function bindEvents() {
  dom.refreshBtn.addEventListener("click", () => refreshQuotes({ quiet: false }));
  dom.logoutBtn.addEventListener("click", logout);
  dom.copyBtn.addEventListener("click", copyHoldings);
  dom.addBtn.addEventListener("click", () => addHolding());
  dom.recordBtn.addEventListener("click", () => recordCurrentSnapshot());

  dom.cashInput.addEventListener("change", async () => {
    await syncLatestState({ renderAfter: false, force: true });
    const previous = state.cash;
    const next = parseNumber(dom.cashInput.value, previous);
    if (!numbersEqual(previous, next)) {
      state.cash = next;
      logChange("cash_change", "", "", previous, next);
      await saveState();
      render();
      showToast("現金已儲存");
    } else {
      dom.cashInput.value = formatPlainNumber(state.cash);
    }
  });

  dom.cashInput.addEventListener("keydown", blurOnEnter);
  dom.sharesInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") addHolding();
  });
  dom.symbolInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") addHolding();
  });

  dom.holdingsBody.addEventListener("change", async (event) => {
    const input = event.target.closest(".shares-text");
    if (!input) return;
    await updateHoldingShares(input.dataset.id, input.value);
  });

  dom.holdingsBody.addEventListener("keydown", (event) => {
    if (event.target.matches(".shares-text")) blurOnEnter(event);
  });

  dom.holdingsBody.addEventListener("click", (event) => {
    const button = event.target.closest("[data-remove-id]");
    if (!button) return;
    removeHolding(button.dataset.removeId);
  });
}

async function loadState({ silent = false } = {}) {
  try {
    const response = await fetch(`${STATIC_STATE_URL}?t=${Date.now()}`, { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    state = normalizeState(await response.json());
    localStorage.setItem(LOCAL_STATE_KEY, JSON.stringify(state));
    return true;
  } catch (error) {
    if (silent) return false;
    const cached = localStorage.getItem(LOCAL_STATE_KEY);
    if (cached) {
      state = normalizeState(JSON.parse(cached));
      showToast("目前先使用瀏覽器暫存資料");
    } else {
      state = structuredClone(DEFAULT_STATE);
      showToast("讀取資料失敗，已建立空白表格");
    }
    return false;
  }
}

function normalizeState(input = {}) {
  const output = {
    ...DEFAULT_STATE,
    ...input,
    holdings: Array.isArray(input.holdings) ? input.holdings : [],
    assetHistory: Array.isArray(input.assetHistory) ? input.assetHistory : [],
    changeLog: Array.isArray(input.changeLog) ? input.changeLog : [],
  };

  output.cash = parseNumber(output.cash, 0);
  output.usdTwdRate = output.usdTwdRate == null ? null : parseNumber(output.usdTwdRate, null);
  output.holdings = output.holdings
    .map((holding) => ({
      id: holding.id || crypto.randomUUID(),
      symbol: String(holding.symbol || "").trim().toUpperCase(),
      shares: parseNumber(holding.shares, 0),
      quote: holding.quote || {},
    }))
    .filter((holding) => holding.symbol);

  output.assetHistory = output.assetHistory
    .filter((row) => row?.date)
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));

  return output;
}

function saveSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveState, 300);
}

async function saveState() {
  state.savedAt = new Date().toISOString();
  localStorage.setItem(LOCAL_STATE_KEY, JSON.stringify(state));
  return true;
}

function startAutoRefresh() {
  if (autoRefreshTimer) clearInterval(autoRefreshTimer);
  autoRefreshTimer = setInterval(() => {
    if (document.hidden || isRefreshing) return;
    refreshQuotes({ quiet: true, automatic: true });
  }, AUTO_REFRESH_MS);
}

function startStateSync() {
  if (stateSyncTimer) clearInterval(stateSyncTimer);
  stateSyncTimer = setInterval(() => {
    if (document.hidden || isRefreshing || isUserEditing()) return;
    syncLatestState({ renderAfter: true });
  }, STATE_SYNC_MS);
}

async function syncLatestState({ renderAfter = true, force = false } = {}) {
  if (!force && isUserEditing()) return false;
  const previousSnapshot = JSON.stringify({
    savedAt: state.savedAt || "",
    cash: state.cash,
    holdings: state.holdings.map((holding) => ({
      symbol: holding.symbol,
      shares: holding.shares,
    })),
  });
  const ok = await loadState({ silent: true });
  const nextSnapshot = JSON.stringify({
    savedAt: state.savedAt || "",
    cash: state.cash,
    holdings: state.holdings.map((holding) => ({
      symbol: holding.symbol,
      shares: holding.shares,
    })),
  });
  if (ok && renderAfter && nextSnapshot !== previousSnapshot) {
    render();
    showToast("已同步本機最新持股");
  }
  return ok;
}

async function loadNetworkInfo() {
  dom.lanHint.textContent = "GitHub Pages 網頁版；會同步本機最新持股，股價每 5 分鐘更新。";
}

async function logout() {
  sessionStorage.removeItem("priceChangeUnlocked");
  location.reload();
}

async function refreshQuotes({ quiet, automatic = false }) {
  if (isRefreshing) {
    if (!quiet) showToast("股價正在更新中");
    return;
  }

    await syncLatestState({ renderAfter: false, force: true });
  const symbols = state.holdings.map((holding) => holding.symbol).filter(Boolean);
  if (!symbols.length) {
    if (!quiet) showToast("請先新增持股");
    return;
  }

  isRefreshing = true;
  dom.refreshBtn.disabled = true;
  dom.refreshBtn.textContent = automatic ? "自動更新中" : "更新中";
  try {
    const quoteData = await fetchJson(`${QUOTES_URL}?t=${Date.now()}`);

    state.holdings = state.holdings.map((holding) => {
      const quote = quoteData.quotes?.[holding.symbol];
      return quote ? { ...holding, quote } : holding;
    });

    if (quoteData.fx?.rate) {
      state.usdTwdRate = quoteData.fx.rate;
      state.fxUpdatedAt = quoteData.fx.updatedAt || quoteData.updatedAt;
      state.fxSource = quoteData.fx.source || quoteData.source;
    }

    lastRefreshAt = new Date(quoteData.updatedAt || Date.now());
    await saveState();
    await backfillHistory();
    render();

    const failedSymbols = Object.keys(quoteData.errors || {});
    if (failedSymbols.length) {
      showToast(`部分股價未更新：${failedSymbols.join(", ")}`);
    } else if (!quiet) {
      showToast("股價已更新");
    }
  } catch (error) {
    if (!quiet) showToast(`刷新失敗：${error.message}`);
  } finally {
    isRefreshing = false;
    dom.refreshBtn.disabled = false;
    dom.refreshBtn.textContent = "刷新股價";
  }
}

async function backfillHistory() {
  return;
}

async function fetchJson(url) {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

async function addHolding() {
  await syncLatestState({ renderAfter: false, force: true });
  const symbol = dom.symbolInput.value.trim().toUpperCase();
  const shares = parseNumber(dom.sharesInput.value, null);
  if (!symbol || shares == null || shares <= 0) {
    showToast("請輸入股票代號和有效股數");
    return;
  }

  const existing = state.holdings.find((holding) => holding.symbol === symbol);
  if (existing) {
    const previous = existing.shares;
    existing.shares = roundNumber(previous + shares, 4);
    logChange("shares_change", "", symbol, previous, existing.shares);
  } else {
    state.holdings.push({
      id: crypto.randomUUID(),
      symbol,
      shares,
      quote: {},
    });
    logChange("holding_add", "", symbol, null, shares);
  }

  dom.symbolInput.value = "";
  dom.sharesInput.value = "";
  await saveState();
  render();
  refreshQuotes({ quiet: true });
}

async function updateHoldingShares(id, rawValue) {
  await syncLatestState({ renderAfter: false, force: true });
  const holding = state.holdings.find((item) => item.id === id);
  if (!holding) return;
  const previous = holding.shares;
  const next = parseNumber(rawValue, previous);
  if (next < 0) {
    showToast("股數不能小於 0");
    render();
    return;
  }
  if (!numbersEqual(previous, next)) {
    holding.shares = next;
    logChange("shares_change", "", holding.symbol, previous, next);
    await saveState();
    render();
    showToast(`${holding.symbol} 股數已儲存`);
  } else {
    render();
  }
}

async function removeHolding(id) {
  await syncLatestState({ renderAfter: false, force: true });
  const holding = state.holdings.find((item) => item.id === id);
  if (!holding) return;
  state.holdings = state.holdings.filter((item) => item.id !== id);
  logChange("holding_remove", "", holding.symbol, holding.shares, null);
  await saveState();
  render();
  showToast(`${holding.symbol} 已移除`);
}

async function recordCurrentSnapshot() {
  await syncLatestState({ renderAfter: false, force: true });
  const snapshot = buildCurrentSnapshot("manual");
  const existingIndex = state.assetHistory.findIndex((row) => row.date === snapshot.date);
  if (existingIndex >= 0) {
    state.assetHistory[existingIndex] = snapshot;
  } else {
    state.assetHistory.push(snapshot);
  }
  state.assetHistory.sort((a, b) => a.date.localeCompare(b.date));
  recomputeHistoryChanges();
  logChange("close_snapshot", "", "", null, snapshot.total);
  await saveState();
  render();
  showToast("已記錄目前總資產");
}

function buildCurrentSnapshot(source) {
  const summary = getPortfolioSummary();
  const total = summary.total;
  return {
    date: taipeiDate(new Date()),
    total: roundMoney(total),
    securities: roundMoney(summary.securities),
    cash: roundMoney(state.cash),
    dayChange: roundMoney(summary.dayChange),
    recordedAt: new Date().toISOString(),
    source,
    holdings: summary.rows.map((row) => ({
      symbol: row.symbol,
      shares: row.shares,
      price: roundMoney(row.price),
      marketValue: roundMoney(row.marketValue),
      weightPercent: roundPercent(row.weight),
    })),
  };
}

function recomputeHistoryChanges() {
  state.assetHistory.forEach((row, index) => {
    row.dayChange = index === 0 ? null : roundMoney(row.total - state.assetHistory[index - 1].total);
  });
}

function render() {
  const summary = getPortfolioSummary();
  renderSummary(summary);
  renderHoldings(summary);
  renderHistory();
  renderChangeLog();

  if (document.activeElement !== dom.cashInput) {
    dom.cashInput.value = formatPlainNumber(state.cash);
  }
}

function getPortfolioSummary() {
  const rows = state.holdings.map((holding) => {
    const price = parseNumber(holding.quote?.price, 0);
    const previousClose = parseNumber(holding.quote?.previousClose, null);
    const change = parseNumber(holding.quote?.change, previousClose == null ? 0 : price - previousClose);
    const changePercent = parseNumber(holding.quote?.changePercent, previousClose ? (change / previousClose) * 100 : 0);
    const marketValue = holding.shares * price;
    const marketValueChange = holding.shares * change;
    return {
      ...holding,
      price,
      change,
      changePercent,
      marketValue,
      marketValueChange,
      weight: 0,
    };
  });

  const securities = rows.reduce((sum, row) => sum + row.marketValue, 0);
  const total = securities + state.cash;
  const dayChange = rows.reduce((sum, row) => sum + row.marketValueChange, 0);
  rows.forEach((row) => {
    row.weight = total ? (row.marketValue / total) * 100 : 0;
  });

  const largest = [...rows].sort((a, b) => b.weight - a.weight)[0] || null;
  return { rows, securities, total, dayChange, largest };
}

function renderSummary(summary) {
  dom.totalUsd.textContent = formatMoney(summary.total);
  dom.totalTwd.textContent = state.usdTwdRate ? twdFormatter.format(summary.total * state.usdTwdRate) : "-";
  dom.fxRate.textContent = state.usdTwdRate
    ? `USD/TWD ${formatPlainNumber(state.usdTwdRate, 4)}，隨刷新更新`
    : "匯率尚未更新";
  dom.securitiesValue.textContent = formatMoney(summary.securities);
  dom.cashValue.textContent = formatMoney(state.cash);
  dom.dayChangeValue.textContent = formatSignedMoney(summary.dayChange);
  setTrendClass(dom.dayChangeValue, summary.dayChange);
  dom.largestHolding.textContent = summary.largest
    ? `${summary.largest.symbol} ${formatPercent(summary.largest.weight)}`
    : "-";
  dom.updatedAt.textContent = lastRefreshAt
    ? `已更新 ${formatTime(lastRefreshAt)}，每 5 分鐘自動刷新`
    : "讀取完成，每 5 分鐘自動刷新";
}

function renderHoldings(summary) {
  if (!summary.rows.length) {
    dom.holdingsBody.innerHTML = `<tr><td colspan="8" class="empty-row">尚未新增持股</td></tr>`;
    return;
  }

  dom.holdingsBody.innerHTML = summary.rows.map((row) => `
    <tr>
      <td class="symbol">${escapeHtml(row.symbol)}</td>
      <td>
        <input class="shares-text" type="text" inputmode="decimal" data-id="${row.id}" value="${escapeHtml(formatPlainNumber(row.shares))}">
      </td>
      <td>${formatMoney(row.price)}</td>
      <td class="${trendClass(row.change)}">${formatSignedMoney(row.change)} / ${formatSignedPercent(row.changePercent)}</td>
      <td class="${trendClass(row.marketValueChange)}">${formatSignedMoney(row.marketValueChange)}</td>
      <td>${formatMoney(row.marketValue)}</td>
      <td>${formatPercent(row.weight)}</td>
      <td><button class="delete-button" type="button" data-remove-id="${row.id}" aria-label="移除 ${escapeHtml(row.symbol)}">×</button></td>
    </tr>
  `).join("");
}

function renderHistory() {
  const rows = [...state.assetHistory].sort((a, b) => a.date.localeCompare(b.date));
  dom.historyCount.textContent = `${rows.length} 筆`;
  const latest = rows.at(-1);
  const first = rows[0];
  dom.latestHistoryTotal.textContent = latest ? formatMoney(latest.total) : "-";
  const change = latest && first ? latest.total - first.total : 0;
  dom.historyChange.textContent = rows.length > 1 ? `${formatSignedMoney(change)} / ${formatSignedPercent(first.total ? (change / first.total) * 100 : 0)}` : "-";
  setTrendClass(dom.historyChange, change);

  dom.historyChart.innerHTML = renderHistoryChart(rows);
  dom.historyBody.innerHTML = rows.slice().reverse().map((row) => `
    <tr>
      <td>${escapeHtml(row.date)}</td>
      <td>${formatMoney(row.total)}</td>
      <td>${formatMoney(row.securities)}</td>
      <td>${formatMoney(row.cash)}</td>
      <td>${row.recordedAt ? formatDateTime(row.recordedAt) : "-"}</td>
    </tr>
  `).join("") || `<tr><td colspan="5" class="empty-row">尚未有紀錄</td></tr>`;
}

function renderHistoryChart(rows) {
  if (!rows.length) {
    return `<div class="chart-empty">刷新股價或手動記錄後，這裡會開始累積總資產紀錄。</div>`;
  }

  const width = 980;
  const height = 300;
  const pad = { top: 24, right: 34, bottom: 44, left: 116 };
  const totals = rows.map((row) => Number(row.total));
  let min = Math.min(...totals);
  let max = Math.max(...totals);
  if (min === max) {
    min -= 1;
    max += 1;
  }
  const padding = (max - min) * 0.08;
  min -= padding;
  max += padding;

  const x = (index) => {
    if (rows.length === 1) return (pad.left + width - pad.right) / 2;
    return pad.left + ((width - pad.left - pad.right) * index) / (rows.length - 1);
  };
  const y = (value) => pad.top + ((max - value) / (max - min)) * (height - pad.top - pad.bottom);
  const points = rows.map((row, index) => `${x(index)},${y(row.total)}`).join(" ");
  const area = `${pad.left},${height - pad.bottom} ${points} ${width - pad.right},${height - pad.bottom}`;
  const ticks = Array.from({ length: 4 }, (_, index) => min + ((max - min) * index) / 3).reverse();

  return `
    <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="總資產歷史圖表">
      <polygon points="${area}" fill="#dcecf7"></polygon>
      ${ticks.map((tick) => `
        <line x1="${pad.left}" y1="${y(tick)}" x2="${width - pad.right}" y2="${y(tick)}" stroke="#dce6f2"></line>
        <text x="${pad.left - 12}" y="${y(tick) + 5}" text-anchor="end" fill="#66758a" font-size="16">${formatCompactMoney(tick)}</text>
      `).join("")}
      <polyline points="${points}" fill="none" stroke="#126fb0" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"></polyline>
      ${rows.map((row, index) => `
        <circle cx="${x(index)}" cy="${y(row.total)}" r="6" fill="white" stroke="#126fb0" stroke-width="3"></circle>
      `).join("")}
      ${rows.map((row, index) => shouldShowDateLabel(index, rows.length) ? `
        <text x="${x(index)}" y="${height - 12}" text-anchor="middle" fill="#66758a" font-size="16">${row.date.slice(5)}</text>
      ` : "").join("")}
    </svg>
  `;
}

function shouldShowDateLabel(index, length) {
  if (length <= 6) return true;
  return index === 0 || index === length - 1 || index % Math.ceil(length / 5) === 0;
}

function renderChangeLog() {
  const logs = state.changeLog.slice(-8).reverse();
  dom.changeLog.innerHTML = logs.map((item) => `
    <div class="change-item">
      ${escapeHtml(describeLog(item))}
      <time>${formatDateTime(item.createdAt)}</time>
    </div>
  `).join("") || `<div class="hint">還沒有手動變動紀錄。</div>`;
}

async function copyHoldings() {
  await syncLatestState({ renderAfter: true, force: true });
  const summary = getPortfolioSummary();
  const lines = [
    `持股明細 ${new Date().toLocaleString("zh-TW")}`,
    `總資產 USD: ${formatMoney(summary.total)}`,
    state.usdTwdRate ? `約當台幣: ${twdFormatter.format(summary.total * state.usdTwdRate)} (USD/TWD ${formatPlainNumber(state.usdTwdRate, 4)})` : "約當台幣: -",
    `現金: ${formatMoney(state.cash)}`,
    "",
    "代號\t股數\t最新價格\t日變動\t市值變化\t市值\t佔比",
    ...summary.rows.map((row) => [
      row.symbol,
      formatPlainNumber(row.shares),
      formatMoney(row.price),
      `${formatSignedMoney(row.change)} / ${formatSignedPercent(row.changePercent)}`,
      formatSignedMoney(row.marketValueChange),
      formatMoney(row.marketValue),
      formatPercent(row.weight),
    ].join("\t")),
  ];

  try {
    await navigator.clipboard.writeText(lines.join("\n"));
    showToast("持股明細已複製");
  } catch {
    fallbackCopy(lines.join("\n"));
  }
}

function fallbackCopy(text) {
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand("copy");
  textarea.remove();
  showToast("持股明細已複製");
}

function logChange(type, label, symbol, previousValue, nextValue) {
  state.changeLog.push({
    id: crypto.randomUUID(),
    type,
    label,
    symbol,
    previousValue,
    nextValue,
    createdAt: new Date().toISOString(),
  });
  state.changeLog = state.changeLog.slice(-120);
}

function describeLog(item) {
  if (item.label && !looksMojibake(item.label)) return item.label;
  const symbol = item.symbol ? `${item.symbol} ` : "";
  if (item.type === "shares_change") return `${symbol}股數：${formatPlainNumber(item.previousValue)} → ${formatPlainNumber(item.nextValue)}`;
  if (item.type === "cash_change") return `現金：${formatMoney(item.previousValue)} → ${formatMoney(item.nextValue)}`;
  if (item.type === "holding_add") return `新增 ${symbol.trim()}，股數 ${formatPlainNumber(item.nextValue)}`;
  if (item.type === "holding_remove") return `移除 ${symbol.trim()}，原股數 ${formatPlainNumber(item.previousValue)}`;
  if (item.type === "close_snapshot") return `記錄總資產 ${formatMoney(item.nextValue)}`;
  if (item.type === "historical_backfill") return `補回收盤後總資產紀錄，最新 ${formatMoney(item.nextValue)}`;
  return "資料已更新";
}

function looksMojibake(text) {
  return /[�]/.test(text) || /\?{2,}/.test(text);
}

function blurOnEnter(event) {
  if (event.key === "Enter") event.target.blur();
}

function isUserEditing() {
  const element = document.activeElement;
  return Boolean(element && (element.matches?.("input, textarea") || element.isContentEditable));
}

function parseNumber(value, fallback) {
  if (value === "" || value == null) return fallback;
  const normalized = String(value).replace(/,/g, "").trim();
  const number = Number(normalized);
  return Number.isFinite(number) ? number : fallback;
}

function numbersEqual(a, b) {
  return Math.abs(Number(a) - Number(b)) < 0.000001;
}

function roundNumber(value, digits = 2) {
  const scale = 10 ** digits;
  return Math.round((Number(value) + Number.EPSILON) * scale) / scale;
}

function roundMoney(value) {
  return roundNumber(value, 2);
}

function roundPercent(value) {
  return roundNumber(value, 2);
}

function formatMoney(value) {
  const number = parseNumber(value, null);
  return number == null ? "-" : moneyFormatter.format(number);
}

function formatSignedMoney(value) {
  const number = parseNumber(value, 0);
  const sign = number > 0 ? "+" : "";
  return `${sign}${moneyFormatter.format(number)}`;
}

function formatPercent(value) {
  const number = parseNumber(value, null);
  return number == null ? "-" : `${number.toFixed(2)}%`;
}

function formatSignedPercent(value) {
  const number = parseNumber(value, 0);
  const sign = number > 0 ? "+" : "";
  return `${sign}${number.toFixed(2)}%`;
}

function formatPlainNumber(value, digits = 4) {
  const number = parseNumber(value, 0);
  return numberFormatter.format(roundNumber(number, digits));
}

function formatCompactMoney(value) {
  return moneyFormatter.format(value).replace(".00", "");
}

function formatTime(date) {
  return new Intl.DateTimeFormat("zh-TW", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date);
}

function formatDateTime(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return new Intl.DateTimeFormat("zh-TW", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date);
}

function taipeiDate(date) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function trendClass(value) {
  const number = parseNumber(value, 0);
  if (number > 0) return "positive";
  if (number < 0) return "negative";
  return "";
}

function setTrendClass(element, value) {
  element.classList.remove("positive", "negative");
  const className = trendClass(value);
  if (className) element.classList.add(className);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function showToast(message) {
  dom.toast.textContent = message;
  dom.toast.classList.add("show");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => dom.toast.classList.remove("show"), 2600);
}
