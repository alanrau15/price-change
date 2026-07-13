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
let githubSyncTimer = null;
let githubSyncInFlight = false;
let githubSyncPending = false;

const PASSWORD_HASH = "4b97f9dbb25b9b8c0847d2c06dda29699dfb25fcd40137a72c216f312dc5cc34";
const AUTO_REFRESH_MS = 5 * 60 * 1000;
const STATE_SYNC_MS = 30 * 1000;
const STATIC_STATE_URL = "https://raw.githubusercontent.com/alanrau15/price-change/gh-pages/portfolio-state.json";
const QUOTES_URL = "https://raw.githubusercontent.com/alanrau15/price-change/gh-pages/quotes.json";
const JINA_READER_PREFIX = "https://r.jina.ai/http://";
const YAHOO_CHART_URL = "https://query1.finance.yahoo.com/v8/finance/chart";
const LOCAL_STATE_KEY = "priceChangePortfolioState";
const GITHUB_TOKEN_KEY = "priceChangeGithubToken";
const GITHUB_OWNER = "alanrau15";
const GITHUB_REPO = "price-change";
const GITHUB_BRANCH = "gh-pages";
const GITHUB_STATE_PATH = "portfolio-state.json";

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
  updateGithubSyncStatus();
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
    "githubTokenInput",
    "githubTokenSaveBtn",
    "githubTokenClearBtn",
    "githubSyncStatus",
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
    "historyDrawdown",
    "historyChange7d",
    "historyChange30d",
    "historyChange90d",
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
  dom.githubTokenSaveBtn.addEventListener("click", () => saveGithubToken());
  dom.githubTokenClearBtn.addEventListener("click", () => clearGithubToken());

  dom.cashInput.addEventListener("change", async () => {
    await syncLatestState({ renderAfter: false, force: true });
    const previous = state.cash;
    const next = parseNumber(dom.cashInput.value, previous);
    if (!numbersEqual(previous, next)) {
      state.cash = next;
      logChange("cash_change", "", "", previous, next);
      await saveState({ syncToGithub: true, reason: "更新現金" });
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

async function saveState({ syncToGithub = false, reason = "更新投資總表" } = {}) {
  state.savedAt = new Date().toISOString();
  localStorage.setItem(LOCAL_STATE_KEY, JSON.stringify(state));
  if (syncToGithub) scheduleGithubSync(reason);
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
    if (document.hidden || isRefreshing || isUserEditing() || hasPendingGithubSync()) return;
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
  dom.lanHint.textContent = "GitHub Pages 網頁版；可用 token 啟用股數與現金寫回，股價每 5 分鐘更新。";
}

async function logout() {
  sessionStorage.removeItem("priceChangeUnlocked");
  location.reload();
}

async function saveGithubToken() {
  const token = dom.githubTokenInput.value.trim();
  if (!token) {
    showToast("請先貼上 GitHub token");
    return;
  }

  localStorage.setItem(GITHUB_TOKEN_KEY, token);
  dom.githubTokenInput.value = "";
  updateGithubSyncStatus("已儲存 token，正在測試寫回...");
  showToast("GitHub 寫回已啟用");
  scheduleGithubSync("啟用 GitHub 寫回", { immediate: true });
}

function clearGithubToken() {
  localStorage.removeItem(GITHUB_TOKEN_KEY);
  sessionStorage.removeItem(GITHUB_TOKEN_KEY);
  dom.githubTokenInput.value = "";
  updateGithubSyncStatus();
  showToast("GitHub token 已清除");
}

function getGithubToken() {
  return localStorage.getItem(GITHUB_TOKEN_KEY) || sessionStorage.getItem(GITHUB_TOKEN_KEY) || "";
}

function updateGithubSyncStatus(message = "") {
  if (!dom.githubSyncStatus) return;
  const token = getGithubToken();
  dom.githubSyncStatus.textContent = message || (token
    ? "已啟用；股數、現金、持股與手動資產紀錄會寫回 GitHub。"
    : "未啟用；修改只會存在這台瀏覽器。");
  dom.githubSyncStatus.classList.toggle("sync-enabled", Boolean(token));
}

function scheduleGithubSync(reason, { immediate = false } = {}) {
  if (!getGithubToken()) {
    updateGithubSyncStatus("未啟用 GitHub 寫回；這次修改只存在此瀏覽器。");
    return;
  }

  clearTimeout(githubSyncTimer);
  githubSyncTimer = setTimeout(() => {
    githubSyncTimer = null;
    pushGithubState(reason);
  }, immediate ? 0 : 1200);
  updateGithubSyncStatus("等待寫回 GitHub...");
}

function hasPendingGithubSync() {
  return Boolean(githubSyncTimer || githubSyncInFlight);
}

async function pushGithubState(reason) {
  if (githubSyncInFlight) {
    githubSyncPending = true;
    return;
  }

  const token = getGithubToken();
  if (!token) return;

  githubSyncInFlight = true;
  githubSyncPending = false;
  updateGithubSyncStatus("正在寫回 GitHub...");

  try {
    const metadata = await fetchGithubStateMetadata(token);
    try {
      await putGithubState(token, metadata.sha, reason);
    } catch (error) {
      if (!String(error.message).includes("409")) throw error;
      const latestMetadata = await fetchGithubStateMetadata(token);
      await putGithubState(token, latestMetadata.sha, reason);
    }
    updateGithubSyncStatus(`GitHub 已同步：${formatTime(new Date())}`);
  } catch (error) {
    updateGithubSyncStatus(`GitHub 寫回失敗：${error.message}`);
    showToast(`GitHub 寫回失敗：${error.message}`);
  } finally {
    githubSyncInFlight = false;
    if (githubSyncPending) scheduleGithubSync("更新投資總表", { immediate: true });
  }
}

async function fetchGithubStateMetadata(token) {
  const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${GITHUB_STATE_PATH}?ref=${encodeURIComponent(GITHUB_BRANCH)}&t=${Date.now()}`;
  const response = await fetch(url, {
    headers: githubHeaders(token),
    cache: "no-store",
  });
  if (!response.ok) throw new Error(await githubErrorMessage(response));
  return response.json();
}

async function putGithubState(token, sha, reason) {
  const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${GITHUB_STATE_PATH}`;
  const payload = {
    message: `Update portfolio state - ${reason}`,
    branch: GITHUB_BRANCH,
    sha,
    content: base64EncodeUtf8(JSON.stringify(state, null, 2) + "\n"),
  };
  const response = await fetch(url, {
    method: "PUT",
    headers: githubHeaders(token),
    body: JSON.stringify(payload),
  });
  if (!response.ok) throw new Error(await githubErrorMessage(response));
  return response.json();
}

function githubHeaders(token) {
  return {
    "Accept": "application/vnd.github+json",
    "Authorization": `Bearer ${token}`,
    "Content-Type": "application/json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

async function githubErrorMessage(response) {
  try {
    const data = await response.json();
    return `${data?.message || "GitHub API error"} (HTTP ${response.status})`;
  } catch {
    return `HTTP ${response.status}`;
  }
}

function base64EncodeUtf8(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary);
}

async function refreshQuotes({ quiet, automatic = false, skipStateSync = false }) {
  if (isRefreshing) {
    if (!quiet) showToast("股價正在更新中");
    return;
  }
  if (!skipStateSync && !hasPendingGithubSync()) await syncLatestState({ renderAfter: false, force: true });
  const symbols = state.holdings.map((holding) => holding.symbol).filter(Boolean);
  if (!symbols.length) {
    if (!quiet) showToast("請先新增持股");
    return;
  }

  isRefreshing = true;
  dom.refreshBtn.disabled = true;
  dom.refreshBtn.textContent = automatic ? "自動更新中" : "更新中";
  try {
    const quoteData = await fetchQuoteData(symbols);

    state.holdings = state.holdings.map((holding) => {
      const quote = quoteData.quotes?.[holding.symbol];
      return quote && shouldUseQuote(quote, holding.quote, quoteData.updatedAt)
        ? { ...holding, quote }
        : holding;
    });

    if (quoteData.fx?.rate && shouldUseTimestamp(quoteData.fx.updatedAt || quoteData.updatedAt, state.fxUpdatedAt)) {
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

async function fetchQuoteData(symbols) {
  const fallback = await fetchJson(`${QUOTES_URL}?t=${Date.now()}`).catch((error) => ({
    quotes: {},
    fx: null,
    errors: { quotesJson: error.message },
  }));

  try {
    const live = await fetchLiveQuoteData(symbols);
    if (Object.keys(live.quotes).length) {
      return {
        ...fallback,
        ...live,
        quotes: { ...(fallback.quotes || {}), ...live.quotes },
        errors: { ...(fallback.errors || {}), ...(live.errors || {}) },
      };
    }
  } catch (error) {
    fallback.errors = { ...(fallback.errors || {}), liveRefresh: error.message };
  }

  if (Object.keys(fallback.quotes || {}).length) return fallback;
  throw new Error(fallback.errors?.liveRefresh || fallback.errors?.quotesJson || "quote unavailable");
}

async function fetchLiveQuoteData(symbols) {
  const settled = await Promise.allSettled(symbols.map((symbol) => fetchYahooQuoteViaJina(symbol)));
  const quotes = {};
  const errors = {};

  settled.forEach((result, index) => {
    const symbol = symbols[index];
    if (result.status === "fulfilled") quotes[symbol] = result.value;
    else errors[symbol] = result.reason?.message || "live quote unavailable";
  });

  const fx = await fetchFxViaJina().catch((error) => {
    errors["USD/TWD"] = error.message;
    return null;
  });

  return {
    updatedAt: new Date().toISOString(),
    source: "Yahoo via r.jina.ai live",
    quotes,
    fx,
    errors,
  };
}

async function fetchYahooQuoteViaJina(symbol) {
  try {
    const encoded = encodeURIComponent(symbol);
    const data = await fetchJinaJson(`${YAHOO_CHART_URL}/${encoded}?range=1d&interval=1m&_=${Date.now()}`);
    return normalizeYahooChartQuote(symbol, data);
  } catch (yahooError) {
    try {
      return await fetchNasdaqQuoteViaJina(symbol);
    } catch (nasdaqError) {
      throw new Error(`${symbol}: Yahoo ${yahooError.message}; Nasdaq ${nasdaqError.message}`);
    }
  }
}

async function fetchNasdaqQuoteViaJina(symbol) {
  const errors = [];
  for (const assetClass of ["stocks", "etf"]) {
    try {
      const encoded = encodeURIComponent(symbol);
      const data = await fetchJinaJson(`https://api.nasdaq.com/api/quote/${encoded}/info?assetclass=${assetClass}&_=${Date.now()}`);
      return normalizeNasdaqQuote(symbol, data);
    } catch (error) {
      errors.push(`${assetClass}: ${error.message}`);
    }
  }
  throw new Error(errors.join("; "));
}

async function fetchFxViaJina() {
  for (const symbol of ["TWD=X", "USDTWD=X"]) {
    try {
      const quote = await fetchYahooQuoteViaJina(symbol);
      if (quote.price) {
        return {
          rate: quote.price,
          source: quote.source,
          symbol,
          updatedAt: quote.marketTime || new Date().toISOString(),
        };
      }
    } catch {}
  }
  throw new Error("FX unavailable");
}

async function fetchJinaJson(url) {
  const response = await fetch(`${JINA_READER_PREFIX}${url}`, { cache: "no-store" });
  if (!response.ok) throw new Error(`live HTTP ${response.status}`);
  const text = await response.text();
  return JSON.parse(extractJsonFromJina(text));
}

function extractJsonFromJina(text) {
  const marker = "Markdown Content:";
  const markerIndex = text.indexOf(marker);
  const source = markerIndex >= 0 ? text.slice(markerIndex + marker.length) : text;
  const firstBrace = source.indexOf("{");
  const lastBrace = source.lastIndexOf("}");
  if (firstBrace < 0 || lastBrace <= firstBrace) throw new Error("live quote response missing JSON");
  return source.slice(firstBrace, lastBrace + 1);
}

function normalizeYahooChartQuote(symbol, data) {
  const result = data?.chart?.result?.[0];
  const meta = result?.meta;
  if (!meta) throw new Error(`${symbol} live quote missing metadata`);

  const price = parseNumber(meta.regularMarketPrice ?? meta.postMarketPrice ?? meta.previousClose, null);
  const previousClose = parseNumber(meta.previousClose ?? meta.chartPreviousClose, null);
  if (price == null || previousClose == null) throw new Error(`${symbol} live quote missing price`);

  const change = price - previousClose;
  const changePercent = previousClose ? (change / previousClose) * 100 : 0;
  return {
    symbol: meta.symbol || symbol,
    price,
    previousClose,
    change,
    changePercent,
    currency: meta.currency || "USD",
    exchange: meta.exchangeName || meta.fullExchangeName || "",
    marketTime: meta.regularMarketTime ? new Date(meta.regularMarketTime * 1000).toISOString() : new Date().toISOString(),
    source: "Yahoo via r.jina.ai",
  };
}

function normalizeNasdaqQuote(symbol, data) {
  const item = data?.data;
  const primary = item?.primaryData;
  if (!primary) throw new Error(`${symbol} Nasdaq quote missing data`);

  const price = parseMarketNumber(primary.lastSalePrice, null);
  const change = parseMarketNumber(primary.netChange, 0);
  const changePercent = parseMarketNumber(primary.percentageChange, 0);
  if (price == null) throw new Error(`${symbol} Nasdaq quote missing price`);

  return {
    symbol: item.symbol || symbol,
    price,
    previousClose: price - change,
    change,
    changePercent,
    currency: "USD",
    exchange: item.exchange || "",
    marketTime: new Date().toISOString(),
    source: "Nasdaq via r.jina.ai",
  };
}

function parseMarketNumber(value, fallback = null) {
  if (value == null || value === "") return fallback;
  const number = Number(String(value).replace(/[,$%+\s]/g, ""));
  return Number.isFinite(number) ? number : fallback;
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
  await saveState({ syncToGithub: true, reason: `更新持股 ${symbol}` });
  render();
  refreshQuotes({ quiet: true, skipStateSync: true });
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
    await saveState({ syncToGithub: true, reason: `更新 ${holding.symbol} 股數` });
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
  await saveState({ syncToGithub: true, reason: `移除 ${holding.symbol}` });
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
  await saveState({ syncToGithub: true, reason: "記錄目前總資產" });
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
  const rowsWithChanges = rows.map((row, index) => ({
    ...row,
    displayDayChange: index === 0 ? null : Number(row.total) - Number(rows[index - 1].total),
  }));
  dom.historyCount.textContent = `${rows.length} 筆`;
  const latest = rows.at(-1);
  const first = rows[0];
  dom.latestHistoryTotal.textContent = latest ? formatMoney(latest.total) : "-";
  const change = latest && first ? latest.total - first.total : 0;
  dom.historyChange.textContent = rows.length > 1 ? `${formatSignedMoney(change)} / ${formatSignedPercent(first.total ? (change / first.total) * 100 : 0)}` : "-";
  setTrendClass(dom.historyChange, change);
  renderHistoryTrendStats(rows);

  dom.historyChart.innerHTML = renderHistoryChart(rows);
  dom.historyBody.innerHTML = rowsWithChanges.slice().reverse().map((row) => `
    <tr>
      <td>${escapeHtml(row.date)}</td>
      <td>${formatMoney(row.total)}</td>
      <td class="${trendClass(row.displayDayChange)}">${row.displayDayChange == null ? "-" : formatSignedMoney(row.displayDayChange)}</td>
      <td>${formatMoney(row.securities)}</td>
      <td>${formatMoney(row.cash)}</td>
      <td>${row.recordedAt ? formatDateTime(row.recordedAt) : "-"}</td>
    </tr>
  `).join("") || `<tr><td colspan="6" class="empty-row">尚未有紀錄</td></tr>`;
}

function renderHistoryTrendStats(rows) {
  const latest = rows.at(-1);
  if (!latest) {
    [
      dom.historyDrawdown,
      dom.historyChange7d,
      dom.historyChange30d,
      dom.historyChange90d,
    ].forEach((element) => {
      element.textContent = "-";
      setTrendClass(element, 0);
    });
    return;
  }

  const peak = rows.reduce((best, row) => (Number(row.total) > Number(best.total) ? row : best), rows[0]);
  const drawdown = Number(latest.total) - Number(peak.total);
  dom.historyDrawdown.textContent = drawdown < 0
    ? `${formatSignedMoney(drawdown)} / ${formatSignedPercent((drawdown / peak.total) * 100)}`
    : "$0.00 / 0.00%";
  setTrendClass(dom.historyDrawdown, drawdown);

  renderPeriodChange(dom.historyChange7d, getPeriodChange(rows, 7));
  renderPeriodChange(dom.historyChange30d, getPeriodChange(rows, 30));
  renderPeriodChange(dom.historyChange90d, getPeriodChange(rows, 90));
}

function renderPeriodChange(element, period) {
  if (!period) {
    element.textContent = "-";
    setTrendClass(element, 0);
    return;
  }
  element.textContent = `${formatSignedMoney(period.change)} / ${formatSignedPercent(period.changePercent)}`;
  setTrendClass(element, period.change);
}

function getPeriodChange(rows, days) {
  const latest = rows.at(-1);
  if (!latest) return null;

  const targetDate = addDays(parseIsoDate(latest.date), -days);
  const base = rows
    .filter((row) => parseIsoDate(row.date) <= targetDate)
    .at(-1);
  if (!base) return null;

  const change = Number(latest.total) - Number(base.total);
  return {
    baseDate: base.date,
    change,
    changePercent: base.total ? (change / Number(base.total)) * 100 : 0,
  };
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

function shouldUseQuote(nextQuote, currentQuote = {}, fallbackUpdatedAt = "") {
  const nextTime = parseTimestamp(nextQuote?.marketTime || fallbackUpdatedAt);
  const currentTime = parseTimestamp(currentQuote?.marketTime);
  return shouldUseTimestamp(nextTime, currentTime);
}

function shouldUseTimestamp(nextValue, currentValue) {
  const nextTime = typeof nextValue === "number" ? nextValue : parseTimestamp(nextValue);
  const currentTime = typeof currentValue === "number" ? currentValue : parseTimestamp(currentValue);
  if (!currentTime) return true;
  if (!nextTime) return true;
  return nextTime >= currentTime;
}

function parseTimestamp(value) {
  const timestamp = Date.parse(value || "");
  return Number.isFinite(timestamp) ? timestamp : 0;
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

function parseIsoDate(value) {
  const [year, month, day] = String(value).split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

function addDays(date, days) {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
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
