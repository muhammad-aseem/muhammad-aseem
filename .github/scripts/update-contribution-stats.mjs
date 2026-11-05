import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const owner = process.env.GITHUB_REPOSITORY_OWNER;
const token = process.env.GITHUB_TOKEN;
const timezone = "Asia/Karachi";

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
];

const columns = stats
  .map(
    ({ value, label, detail }, index) => `
      <g text-anchor="middle">
        <text x="${120 + index * 240}" y="77" class="value">${escapeXml(value)}</text>
        <text x="${120 + index * 240}" y="111" class="label">${label}</text>
        <text x="${120 + index * 240}" y="139" class="detail">${detail}</text>
      </g>`,
  )
  .join("");

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="720" height="180" viewBox="0 0 720 180" role="img" aria-labelledby="title description">
  <title id="title">GitHub contribution activity for ${escapeXml(owner)}</title>
  <desc id="description">${escapeXml(stats[0].value)} contributions in the past year, a current streak of ${escapeXml(currentStreak)} days, and a longest streak of ${escapeXml(longestStreak)} days.</desc>
  <style>
    .card{fill:#0d1117;stroke:#30363d}
    .divider{stroke:#30363d}
    .value{fill:#e6edf3;font:700 34px system-ui,-apple-system,Segoe UI,sans-serif}
    .label{fill:#f2bfa7;font:600 14px system-ui,-apple-system,Segoe UI,sans-serif}
    .detail{fill:#8b949e;font:13px system-ui,-apple-system,Segoe UI,sans-serif}
  </style>
  <rect class="card" x=".5" y=".5" width="719" height="179" rx="14"/>
  <path class="divider" d="M240 30v120M480 30v120"/>
  ${columns}
</svg>
`;

const root = process.env.PROFILE_REPO_PATH ?? process.cwd();
const readmePath = join(root, "README.md");
const svgPath = join(root, "assets", "contribution-stats.svg");
const readme = await readFile(readmePath, "utf8");
const version = createHash("sha256").update(svg).digest("hex").slice(0, 12);
const section = `## Live GitHub Contribution Activity

<p align="center">
  <a href="https://github.com/users/${owner}/contributions">
    <img src="./assets/contribution-stats.svg?v=${version}" alt="GitHub contribution totals and streaks for ${owner}" width="720" />
  </a>
</p>

<p align="center"><sub>Refreshes automatically every six hours from GitHub contribution history · Asia/Karachi</sub></p>
`;
const pattern = /## Live GitHub Contribution (?:Streak|Activity)\r?\n[\s\S]*?(?=\r?\n## Connect With Me)/;

if (!pattern.test(readme)) {
  throw new Error("Could not find the contribution section in README.md.");
}

await mkdir(dirname(svgPath), { recursive: true });
await writeFile(svgPath, svg);
await writeFile(readmePath, readme.replace(pattern, section));
console.log(
  `Updated contribution card: ${stats.map(({ value, label }) => `${label} ${value}`).join(", ")}`,
);
