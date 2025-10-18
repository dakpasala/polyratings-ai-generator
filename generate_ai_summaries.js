import fs from "fs";
import fetch from "node-fetch";
import { parse } from "csv-parse/sync";

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;;
if (!GEMINI_API_KEY) {
  console.error("❌ Missing GEMINI_API_KEY in environment variables");
  process.exit(1);
}

const RATINGS_URL =
  "https://raw.githubusercontent.com/sreshtalluri/polyratings-data-collection/refs/heads/main/data/main/professors_data.csv";
const COMMENTS_URL =
  "https://raw.githubusercontent.com/sreshtalluri/polyratings-data-collection/refs/heads/main/data/main/professor_detailed_reviews.csv";

const OUTPUT_DIR = "summaries";
const OUTPUT_FILE = `${OUTPUT_DIR}/ai_summaries.json`;
const STATE_FILE = `${OUTPUT_DIR}/state.json`;

const BATCH_SIZE = 2; // for testing — later set to 400/day

// ---------------------- Helpers ----------------------

function convertCSVToProfessorData(ratingsData, commentsData) {
  const professorMap = new Map();

  ratingsData.forEach((row) => {
    const profName = row.fullName?.trim();
    if (!profName) return;

    professorMap.set(profName, {
      name: profName,
      rating: parseFloat(row.overallRating) || 0,
      numEvals: parseInt(row.numEvals) || 0,
      link: `https://polyratings.dev/professor/${row.id}`,
      clarity: parseFloat(row.materialClear) || 0,
      helpfulness: parseFloat(row.studentDifficulties) || 0,
      comments: "",
      department: row.department || "",
      courses: row.courses || "",
      allComments: [],
      gradeLevels: [],
      grades: [],
    });
  });

  commentsData.forEach((row) => {
    const profName = row.professor_name?.trim();
    if (!profName) return;

    if (!professorMap.has(profName)) {
      professorMap.set(profName, {
        name: profName,
        rating: 0,
        numEvals: 0,
        link: `https://polyratings.dev/professor/${
          row.professor_id || profName.toLowerCase().replace(/\s+/g, "-")
        }`,
        clarity: 0,
        helpfulness: 0,
        comments: "",
        department: row.professor_department || "",
        courses: row.course_code || "",
        allComments: [],
        gradeLevels: [],
        grades: [],
      });
    }

    const prof = professorMap.get(profName);
    const comment = row.rating_text || "";
    if (comment.trim()) prof.allComments.push(comment.trim());
    if (row.grade_level && row.grade_level !== "N/A")
      prof.gradeLevels.push(row.grade_level);
    if (row.grade && row.grade !== "N/A") prof.grades.push(row.grade);
  });

  return Array.from(professorMap.values()).map((prof) => {
    prof.comments = prof.allComments.join(" | ").substring(0, 2000);
    delete prof.allComments;
    return prof;
  });
}

async function fetchCSV(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`);
  const text = await res.text();
  const records = parse(text, { columns: true, skip_empty_lines: true });
  return records;
}

// ---------------------- Gemini API ----------------------

async function callGeminiAnalysis(prof) {
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`;

  const prompt = `You are a helpful Cal Poly student assistant. Analyze this professor's data and provide a short summary.

Professor: "${prof.name}"
Overall Rating: ${prof.rating}/4.0 (${prof.numEvals} evaluations)
Material Clear: ${prof.clarity}/4.0
Student Difficulties: ${prof.helpfulness}/4.0
Department: ${prof.department}
Courses: ${prof.courses}
Student Comments: "${prof.comments.substring(0, 1000)}"

Provide 5 descriptive sentences describing what this professor is known for and what students can expect. Also talk about like which years succeed
and don't succeed. End your response with: "${prof.link}"`;

  const body = { contents: [{ parts: [{ text: prompt }] }] };

  const resp = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    console.log(`⚠️ Gemini API error ${resp.status} for ${prof.name}`);
    return "AI summary unavailable.";
  }

  const data = await resp.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
  return text || "AI summary unavailable.";
}

// ---------------------- State Handling ----------------------

function loadState() {
  if (!fs.existsSync(STATE_FILE)) {
    return { lastIndex: 0 };
  }
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"));
  } catch {
    return { lastIndex: 0 };
  }
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function loadExistingSummaries() {
  if (!fs.existsSync(OUTPUT_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(OUTPUT_FILE, "utf-8"));
  } catch {
    return {};
  }
}

// ---------------------- Main ----------------------

async function main() {
  console.log("🚀 Fetching professor data...");
  const [ratings, comments] = await Promise.all([
    fetchCSV(RATINGS_URL),
    fetchCSV(COMMENTS_URL),
  ]);

  const professors = convertCSVToProfessorData(ratings, comments);
  console.log(`✅ Loaded ${professors.length} total professors`);

  // Load state and existing summaries
  const state = loadState();
  const existingSummaries = loadExistingSummaries();

  const startIndex = state.lastIndex || 0;
  const endIndex = Math.min(startIndex + BATCH_SIZE, professors.length);

  console.log(
    `📦 Processing professors ${startIndex + 1}-${endIndex} of ${professors.length}`
  );

  const batch = professors.slice(startIndex, endIndex);
  const results = { ...existingSummaries };

  for (const prof of batch) {
    if (results[prof.name]) {
      console.log(`⏩ Skipping ${prof.name} (already processed)`);
      continue;
    }
    console.log(`🧠 Generating AI summary for ${prof.name}...`);
    const summary = await callGeminiAnalysis(prof);
    results[prof.name] = summary;
  }

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(results, null, 2));
  console.log(`✅ Saved ${Object.keys(results).length} total summaries`);

  // Update state for next run
  saveState({ lastIndex: endIndex });

  if (endIndex >= professors.length) {
    console.log("🎉 All professors processed!");
  } else {
    console.log(`📍 Progress saved. Next start index: ${endIndex}`);
  }

  console.log("\n📜 Latest batch:");
  console.log(batch.map((p) => `${p.name}: ${results[p.name]}`).join("\n\n"));
}

main().catch((err) => {
  console.error("❌ Error running script:", err);
  process.exit(1);
});
