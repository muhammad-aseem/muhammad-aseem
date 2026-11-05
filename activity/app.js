const formatNumber = new Intl.NumberFormat("en-US");
const timezone = "Asia/Karachi";
const root = document.querySelector("#dashboard");
const loader = document.querySelector("#loader");
const chart = document.querySelector("#activity-chart");
const buttons = [...document.querySelectorAll("[data-range], [data-metric]")];
let data;
let selectedRange = 90;
let selectedMetric = "contributions";

function showError(error) {
  console.error(error);
  loader.innerHTML = `
    <div class="error-card">
      <p class="eyebrow">ACTIVITY DATA UNAVAILABLE</p>
      <h1>Couldn’t load the latest snapshot.</h1>
      <p class="panel-copy">The profile will keep showing the last generated contribution card. Try reloading this dashboard in a moment.</p>
      <button type="button" onclick="location.reload()">Try again</button>
    </div>`;
}

function countUp(element, value) {
  const end = Number(value) || 0;
  const start = performance.now();
  const duration = 800;
  function frame(now) {
    const progress = Math.min(1, (now - start) / duration);
    const eased = 1 - (1 - progress) ** 3;
    element.textContent = formatNumber.format(Math.round(end * eased));
    if (progress < 1) requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

function addSummaryCard(container, label, value, note, index) {
  const card = document.createElement("article");
  card.className = "summary-card";
  card.style.animationDelay = `${index * 45}ms`;
  card.innerHTML = `
    <div class="summary-label">${label}</div>
    <div class="summary-value" data-count="${Number(value) || 0}">0</div>
    <div class="summary-note">${note}</div>`;
  container.append(card);
  countUp(card.querySelector("[data-count]"), value);
}

function renderSummary() {
  const summary = data.summary;
  const target = document.querySelector("#summary");
  const cards = [
    ["GITHUB CONTRIBUTIONS", summary.contributionsPastYear, "PAST YEAR"],
    ["GITHUB CONTRIBUTIONS", summary.contributionsToday, `TODAY · ${timezone.replace("_", " ")}`],
    ["CURRENT STREAK", summary.currentStreak, "CONSECUTIVE DAYS"],
    ["LONGEST STREAK", summary.longestStreak, "PAST YEAR"],
    ["PUBLIC COMMITS", summary.publicCommitsRecentEvents, "RECENT PUBLIC EVENTS"],
    ["PUBLIC PUSHES", summary.publicPushesRecentEvents, "RECENT PUBLIC EVENTS"],
  ];
  cards.forEach((card, index) => addSummaryCard(target, ...card, index));

  document.querySelector("#streak-summary").innerHTML = `
    <div><div class="streak-value">${formatNumber.format(summary.currentStreak)}</div><div class="streak-label">Current streak</div></div>
    <div><div class="streak-value">${formatNumber.format(summary.longestStreak)}</div><div class="streak-label">Longest this year</div></div>`;
}

function contributionLevel(value, max) {
  if (!value) return 0;
  const fraction = value / Math.max(max, 1);
  if (fraction < .25) return 1;
  if (fraction < .5) return 2;
  if (fraction < .75) return 3;
  return 4;
}

function renderHeatmap() {
  const heatmap = document.querySelector("#heatmap");
  const days = data.days;
  const max = Math.max(1, ...days.map((day) => day.contributions));
  const firstDay = new Date(`${days[0].date}T12:00:00Z`).getUTCDay();
  const weekCount = Math.ceil((firstDay + days.length) / 7);
  heatmap.style.gridTemplateColumns = `repeat(${weekCount}, 12px)`;

  for (let index = 0; index < firstDay; index += 1) {
    const blank = document.createElement("span");
    blank.setAttribute("aria-hidden", "true");
    heatmap.append(blank);
  }

  for (const day of days) {
    const cell = document.createElement("button");
    cell.type = "button";
    cell.className = `heat-cell level-${contributionLevel(day.contributions, max)}`;
    cell.setAttribute(
      "aria-label",
      `${day.date}: ${day.contributions} GitHub contributions, ${day.publicCommits} public commits pushed`,
    );
    cell.title = cell.getAttribute("aria-label");
    cell.addEventListener("focus", () => {
      document.querySelector("#heatmap-detail").textContent = cell.title;
    });
    cell.addEventListener("blur", () => {
      document.querySelector("#heatmap-detail").textContent =
        "Select a day to inspect its activity.";
    });
    heatmap.append(cell);
  }
}

function svgElement(name, attributes = {}) {
  const element = document.createElementNS("http://www.w3.org/2000/svg", name);
  for (const [key, value] of Object.entries(attributes)) {
    element.setAttribute(key, value);
  }
  return element;
}

function dateLabel(date, options) {
  return new Intl.DateTimeFormat("en", { timeZone: timezone, ...options }).format(
    new Date(`${date}T12:00:00Z`),
  );
}

function renderChart() {
  const days = data.days.slice(-selectedRange);
  const key =
    selectedMetric === "contributions"
      ? "contributions"
      : selectedMetric === "commits"
        ? "publicCommits"
        : "publicPushes";
  const color =
    selectedMetric === "contributions"
      ? "#f2bfa7"
      : selectedMetric === "commits"
        ? "#79c0ff"
        : "#84d9b1";
  const values = days.map((day) => day[key]);
  const max = Math.max(1, ...values);
  const plot = { left: 44, right: 985, top: 24, bottom: 220 };
  const plotHeight = plot.bottom - plot.top;
  chart.replaceChildren();
  const metricLabel =
    selectedMetric === "contributions"
      ? "GitHub contributions, which may include anonymous private activity"
      : `public ${selectedMetric}`;
  chart.setAttribute("aria-label", `${selectedRange} day chart of ${metricLabel}`);

  for (let line = 0; line <= 4; line += 1) {
    const y = plot.top + (plotHeight / 4) * line;
    chart.append(
      svgElement("line", {
        x1: plot.left,
        x2: plot.right,
        y1: y,
        y2: y,
        class: "chart-grid",
      }),
    );
  }

  const step = (plot.right - plot.left) / days.length;
  const barWidth = Math.max(1.4, Math.min(16, step * .64));
  days.forEach((day, index) => {
    const value = day[key];
    const height = value ? Math.max(3, (value / max) * plotHeight) : 2;
    const x = plot.left + step * index + (step - barWidth) / 2;
    const y = plot.bottom - height;
    const rect = svgElement("rect", {
      x,
      y,
      width: barWidth,
      height,
      rx: Math.min(4, barWidth / 3),
      fill: value ? color : "#253044",
      class: "chart-bar",
      tabindex: "0",
    });
    const title = svgElement("title");
    title.textContent = `${day.date}: ${formatNumber.format(value)} ${
      selectedMetric === "contributions"
        ? "public contributions"
        : selectedMetric === "commits"
          ? "public commits"
          : "public pushes"
    }`;
    rect.append(title);
    chart.append(rect);
  });

  const tickIndexes = [...new Set([0, Math.floor(days.length / 3), Math.floor((days.length * 2) / 3), days.length - 1])];
  for (const index of tickIndexes) {
    const label = svgElement("text", {
      x: plot.left + step * index,
      y: 252,
      class: "chart-label",
      "text-anchor": index === 0 ? "start" : index === days.length - 1 ? "end" : "middle",
    });
    label.textContent = dateLabel(days[index].date, { month: "short", day: "numeric" });
    chart.append(label);
  }

  document.querySelector("#activity-description").textContent =
    selectedMetric === "contributions"
      ? "GitHub contribution totals. These may include anonymous private activity; no repository names are shown."
      : `Public ${selectedMetric} from GitHub’s recent event feed; private project activity is excluded.`;
  document.querySelector("#chart-note").textContent =
    selectedMetric === "contributions"
      ? "Each bar is one day. Hover or focus a bar to see its exact GitHub contribution count."
      : "GitHub’s public event feed is limited to recent activity (up to 300 events); older bars may not have push data.";
}

function renderRecentPushes() {
  const target = document.querySelector("#recent-pushes");
  const active = data.days.filter((day) => day.publicPushes > 0).slice(-5).reverse();
  if (!active.length) {
    target.innerHTML = '<p class="panel-copy">No public push events in the recent activity feed yet.</p>';
    return;
  }
  for (const day of active) {
    const row = document.createElement("div");
    row.className = "recent-row";
    const label = document.createElement("span");
    label.textContent = dateLabel(day.date, { month: "short", day: "numeric", year: "numeric" });
    const value = document.createElement("strong");
    value.textContent = `${formatNumber.format(day.publicCommits)} commits · ${formatNumber.format(day.publicPushes)} pushes`;
    row.append(label, value);
    target.append(row);
  }
}

function renderTimestamp() {
  const date = new Date(data.updatedAt);
  document.querySelector("#updated-at").textContent = `UPDATED ${new Intl.DateTimeFormat("en", {
    timeZone: timezone,
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date)}`;
}

function setPressed(selector, attribute, value) {
  document.querySelectorAll(selector).forEach((button) => {
    button.setAttribute("aria-pressed", String(button.dataset[attribute] === String(value)));
  });
}

for (const button of buttons) {
  button.addEventListener("click", () => {
    if (button.dataset.range) {
      selectedRange = Number(button.dataset.range);
      setPressed("[data-range]", "range", selectedRange);
    } else {
      selectedMetric = button.dataset.metric;
      setPressed("[data-metric]", "metric", selectedMetric);
    }
    renderChart();
  });
}

try {
  const response = await fetch("./data.json", { cache: "no-store" });
  if (!response.ok) throw new Error(`Activity data request failed: ${response.status}`);
  data = await response.json();
  if (!Array.isArray(data.days) || !data.summary) {
    throw new Error("The activity snapshot is incomplete.");
  }
  renderTimestamp();
  renderSummary();
  renderHeatmap();
  renderChart();
  renderRecentPushes();
  loader.hidden = true;
  root.hidden = false;
} catch (error) {
  showError(error);
}
