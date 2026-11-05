import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const owner = process.env.GITHUB_REPOSITORY_OWNER;
const token = process.env.GITHUB_TOKEN;
const timezone = "Asia/Karachi";
const root = process.env.PROFILE_REPO_PATH ?? process.cwd();
const pagesUrl = `https://${owner}.github.io/${owner}/`;

if (!owner || !token) {
  throw new Error("GITHUB_REPOSITORY_OWNER and GITHUB_TOKEN are required.");
}

async function graphql(query, variables) {
  const response = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": "profile-contribution-card",
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!response.ok) {
    throw new Error(`GitHub GraphQL request failed: ${response.status}`);
  }

  const result = await response.json();
  if (result.errors?.length) {
    throw new Error(
      `GitHub GraphQL request failed: ${result.errors.map((error) => error.message).join("; ")}`,
    );
  }

  return result.data;
}

async function publicPushesInRange(user, firstDate, lastDate) {
  const pushes = [];

  for (let page = 1; page <= 3; page += 1) {
    const response = await fetch(
      `https://api.github.com/users/${encodeURIComponent(user)}/events/public?per_page=100&page=${page}`,
      {
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "User-Agent": "profile-contribution-card",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      },
    );

    if (!response.ok) {
      throw new Error(`GitHub public events request failed: ${response.status}`);
    }

    const events = await response.json();
    for (const event of events) {
      const date = dateInTimezone(new Date(event.created_at));
      if (event.type === "PushEvent" && date >= firstDate && date <= lastDate) {
        pushes.push(event);
      }
    }

    if (
      events.length < 100 ||
      dateInTimezone(new Date(events.at(-1).created_at)) < firstDate
    ) {
      break;
    }
  }

  const commitsByDay = new Map();
  const pushesByDay = new Map();
  for (const event of pushes) {
    const date = dateInTimezone(new Date(event.created_at));
    commitsByDay.set(
      date,
      (commitsByDay.get(date) ?? 0) +
        (event.payload.size ?? event.payload.commits?.length ?? 0),
    );
    pushesByDay.set(date, (pushesByDay.get(date) ?? 0) + 1);
  }

  return {
    commits: [...commitsByDay.values()].reduce((total, count) => total + count, 0),
    count: pushes.length,
    commitsByDay,
    pushesByDay,
  };
}

function dateInTimezone(date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function offsetDate(date, offset) {
  const result = new Date(`${date}T12:00:00Z`);
  result.setUTCDate(result.getUTCDate() + offset);
  return result.toISOString().slice(0, 10);
}

function escapeXml(value) {
  return String(value).replace(/[<>&'"]/g, (char) => {
    const entities = {
      "<": "&lt;",
      ">": "&gt;",
      "&": "&amp;",
      "'": "&apos;",
      '"': "&quot;",
    };
    return entities[char];
  });
}

const now = new Date();
const today = dateInTimezone(now);
const from = `${offsetDate(today, -364)}T00:00:00Z`;
const query = `
  query($login: String!, $from: DateTime!, $to: DateTime!) {
    user(login: $login) {
      contributionsCollection(from: $from, to: $to) {
        contributionCalendar {
          totalContributions
          weeks {
            contributionDays {
              date
              contributionCount
            }
          }
        }
      }
    }
  }
`;
const data = await graphql(query, {
  login: owner,
  from,
  to: now.toISOString(),
});
const calendar = data.user?.contributionsCollection?.contributionCalendar;

if (!calendar) {
  throw new Error(`No contribution calendar returned for ${owner}.`);
}

const days = calendar.weeks
  .flatMap((week) => week.contributionDays)
  .sort((left, right) => left.date.localeCompare(right.date));
const counts = new Map(days.map(({ date, contributionCount }) => [date, contributionCount]));
const yearActivity = Array.from({ length: 365 }, (_, index) => {
  const date = offsetDate(today, index - 364);
  return { date, count: counts.get(date) ?? 0 };
});
const recentActivity = yearActivity.slice(-90);
const publicPushes = await publicPushesInRange(
  owner,
  recentActivity[0].date,
  today,
);

let currentStreak = 0;
let cursor = counts.get(today) > 0 ? today : offsetDate(today, -1);
while ((counts.get(cursor) ?? 0) > 0) {
  currentStreak += 1;
  cursor = offsetDate(cursor, -1);
}

let longestStreak = 0;
let runningStreak = 0;
let previousDate;
for (const { date, contributionCount } of days) {
  runningStreak =
    contributionCount > 0 && previousDate === offsetDate(date, -1)
      ? runningStreak + 1
      : contributionCount > 0
        ? 1
        : 0;
  longestStreak = Math.max(longestStreak, runningStreak);
  previousDate = date;
}

const stats = [
  {
    value: calendar.totalContributions.toLocaleString("en-US"),
    label: "CONTRIBUTIONS",
    detail: "PAST YEAR",
  },
  {
    value: currentStreak.toLocaleString("en-US"),
    label: "CURRENT STREAK",
    detail: "DAYS",
  },
  {
    value: longestStreak.toLocaleString("en-US"),
    label: "LONGEST STREAK",
    detail: "DAYS · PAST YEAR",
  },
  {
    value: (counts.get(today) ?? 0).toLocaleString("en-US"),
    label: "CONTRIBUTIONS",
    detail: "TODAY",
  },
  {
    value: publicPushes.commits.toLocaleString("en-US"),
    label: "PUBLIC COMMITS",
    detail: "PAST 90 DAYS",
  },
  {
    value: publicPushes.count.toLocaleString("en-US"),
    label: "PUBLIC PUSHES",
    detail: "PAST 90 DAYS",
  },
];

const columns = stats
  .map(
    ({ value, label, detail }, index) => `
      <g text-anchor="middle">
        <text x="${70 + index * 140}" y="54" class="value">${escapeXml(value)}</text>
        <text x="${70 + index * 140}" y="78" class="label">${label}</text>
        <text x="${70 + index * 140}" y="97" class="detail">${detail}</text>
      </g>`,
  )
  .join("");

const chartActivity = yearActivity.slice(-14);
const maxDailyActivity = Math.max(1, ...chartActivity.map(({ count }) => count));
const bars = chartActivity
  .map(({ date, count }, index) => {
    const x = 47 + index * 53;
    const commitCount = publicPushes.commitsByDay.get(date) ?? 0;
    const max = Math.max(maxDailyActivity, commitCount);
    const contributionHeight = count === 0 ? 2 : 5 + (count / max) * 35;
    const commitHeight =
      commitCount === 0 ? 2 : 5 + (commitCount / max) * 35;
    const dateLabel = date.slice(5).replace("-", "/");
    return `
      <g text-anchor="middle">
        <title>${date}: ${count} GitHub contributions, ${commitCount} public commits pushed</title>
        <rect x="${x + 4}" y="${235 - contributionHeight}" width="16" height="${contributionHeight}" rx="3" fill="${count === 0 ? "#30363d" : "#f2bfa7"}"/>
        <rect x="${x + 24}" y="${235 - commitHeight}" width="16" height="${commitHeight}" rx="3" fill="${commitCount === 0 ? "#30363d" : "#79c0ff"}"/>
        ${count > 0 ? `<text x="${x + 12}" y="${230 - contributionHeight}" class="bar-value">${count}</text>` : ""}
        ${commitCount > 0 ? `<text x="${x + 32}" y="${230 - commitHeight}" class="bar-value">${commitCount}</text>` : ""}
        <text x="${x + 22}" y="256" class="date">${dateLabel}</text>
      </g>`;
  })
  .join("");

const dividers = Array.from({ length: 5 }, (_, index) => {
  const x = 140 + index * 140;
  return `<path class="divider" d="M${x} 19v88"/>`;
}).join("");
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="840" height="275" viewBox="0 0 840 275" role="img" aria-labelledby="title description">
  <title id="title">GitHub contribution activity for ${escapeXml(owner)}</title>
  <desc id="description">${escapeXml(stats[0].value)} GitHub contributions in the past year, ${escapeXml(stats[3].value)} contributions today, and ${escapeXml(stats[4].value)} public commits across ${escapeXml(stats[5].value)} public pushes in recent events. Contribution totals may include anonymous private activity; no repository names are displayed.</desc>
  <style>
    .card{fill:#0d1117;stroke:#30363d}
    .divider{stroke:#30363d}
    .value{fill:#e6edf3;font:700 25px system-ui,-apple-system,Segoe UI,sans-serif}
    .label{fill:#f2bfa7;font:600 10px system-ui,-apple-system,Segoe UI,sans-serif}
    .detail{fill:#8b949e;font:10px system-ui,-apple-system,Segoe UI,sans-serif}
    .chart-title{fill:#e6edf3;font:600 12px system-ui,-apple-system,Segoe UI,sans-serif}
    .bar-value{fill:#e6edf3;font:8px system-ui,-apple-system,Segoe UI,sans-serif}
    .date{fill:#8b949e;font:9px system-ui,-apple-system,Segoe UI,sans-serif}
  </style>
  <rect class="card" x=".5" y=".5" width="839" height="274" rx="14"/>
  ${dividers}
  ${columns}
  <text x="35" y="139" class="chart-title">DAILY ACTIVITY · PAST 14 DAYS</text>
  <rect x="580" y="130" width="9" height="9" rx="2" fill="#f2bfa7"/>
  <text x="594" y="139" class="date">CONTRIBUTIONS</text>
  <rect x="700" y="130" width="9" height="9" rx="2" fill="#79c0ff"/>
  <text x="714" y="139" class="date">PUBLIC COMMITS</text>
  <path class="divider" d="M35 148h770M35 239h770"/>
  ${bars}
</svg>
`;

const readmePath = join(root, "README.md");
const svgPath = join(root, "assets", "contribution-stats.svg");
const readme = await readFile(readmePath, "utf8");
const version = createHash("sha256").update(svg).digest("hex").slice(0, 12);
const section = `## Live GitHub Contribution Activity

<p align="center">
  <a href="${pagesUrl}" title="Open the interactive GitHub activity dashboard">
    <img src="./assets/contribution-stats.svg?v=${version}" alt="GitHub contribution totals, public pushes, and daily activity for ${owner}" width="840" />
  </a>
</p>

<p align="center"><sub>Refreshes every six hours · Asia/Karachi. GitHub contribution totals may include anonymous private activity, but no private repository names are retrieved or shown. Push and commit counts come only from public events. <a href="${pagesUrl}">Open the interactive activity dashboard.</a></sub></p>
`;
const pattern = /## Live GitHub Contribution (?:Streak|Activity)\r?\n[\s\S]*?(?=\r?\n## Connect With Me)/;

if (!pattern.test(readme)) {
  throw new Error("Could not find the contribution section in README.md.");
}

const activityPath = join(root, "activity", "data.json");
const progress = {
  summary: {
    contributionsPastYear: calendar.totalContributions,
    contributionsToday: counts.get(today) ?? 0,
    activeDaysPastYear: days.filter(({ contributionCount }) => contributionCount > 0).length,
    currentStreak,
    longestStreak,
    publicCommitsRecentEvents: publicPushes.commits,
    publicPushesRecentEvents: publicPushes.count,
  },
  days: yearActivity.map(({ date, count }) => ({
    date,
    contributions: counts.get(date) ?? 0,
    publicCommits: publicPushes.commitsByDay.get(date) ?? 0,
    publicPushes: publicPushes.pushesByDay.get(date) ?? 0,
  })),
};
let updatedAt = now.toISOString();
try {
  const previous = JSON.parse(await readFile(activityPath, "utf8"));
  if (
    JSON.stringify(previous.summary) === JSON.stringify(progress.summary) &&
    JSON.stringify(previous.days) === JSON.stringify(progress.days)
  ) {
    updatedAt = previous.updatedAt;
  }
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}

await mkdir(dirname(svgPath), { recursive: true });
await mkdir(dirname(activityPath), { recursive: true });
await writeFile(svgPath, svg);
await writeFile(activityPath, `${JSON.stringify({ ...progress, updatedAt, timezone }, null, 2)}\n`);
await writeFile(readmePath, readme.replace(pattern, section));
console.log(
  `Updated contribution card: ${stats.map(({ value, label }) => `${label} ${value}`).join(", ")}`,
);
