import fs from "fs";
import fetch from "node-fetch";
import { parse } from "csv-parse/sync";
import dotenv from "dotenv";

dotenv.config();

// ---------------------- Config ----------------------

const GROQ_API_KEY = process.env.GROQ_API_KEY;
if (!GROQ_API_KEY) {
  console.error("❌ Missing GROQ_API_KEY in environment variables");
  process.exit(1);
}

const OUTPUT_DIR = "summaries";
const OUTPUT_FILE = `${OUTPUT_DIR}/ai_summaries.json`;
const STATE_FILE = `${OUTPUT_DIR}/state.json`;

// Weekly mode is controlled by summaries/config.json → { "weekly": 1 }
// Set to 1 for weekly (regenerate all), 0 for daily (batched).
function getWeeklyMode() {
  const configPath = `${OUTPUT_DIR}/config.json`;
  try {
    if (fs.existsSync(configPath)) {
      const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
      return config.weekly === 1;
    }
  } catch {
    // ignore parse errors
  }
  return false;
}

const GROQ_MODEL = "meta-llama/llama-4-maverick-17b-128e-instruct";
const GROQ_ENDPOINT = "https://api.groq.com/openai/v1/chat/completions";

const RATINGS_URL =
  "https://raw.githubusercontent.com/sreshtalluri/polyratings-data-collection/refs/heads/main/data/main/professors_data.csv";
const COMMENTS_URL =
  "https://raw.githubusercontent.com/sreshtalluri/polyratings-data-collection/refs/heads/main/data/main/professor_detailed_reviews.csv";

// Daily mode: process 200 per run. Weekly mode: process all at once.
const DAILY_BATCH_SIZE = 200;
const REQUEST_DELAY_MS = 5000; // 2.5s between requests — Groq free tier is very generous

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
    const joined = prof.allComments.join(" | ");
    const cutoff = 1200;
    if (joined.length > cutoff) {
      const lastPipe = joined.lastIndexOf(" | ", cutoff);
      prof.comments = lastPipe > 0 ? joined.substring(0, lastPipe) : joined.substring(0, cutoff);
    } else {
      prof.comments = joined;
    }
    delete prof.allComments;
    return prof;
  });
}

async function fetchCSV(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`);
  const text = await res.text();
  return parse(text, { columns: true, skip_empty_lines: true });
}

// ---------------------- Groq API ----------------------

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function callAISummary(prof, retries = 3) {
  // Skip professors with no useful data
  if (prof.numEvals === 0 || !prof.comments || prof.comments.trim().length === 0) {
    console.log(`⚠️ Insufficient data for ${prof.name} (${prof.numEvals} evals)`);
    return `Professor ${prof.name} has limited reviews available. More student feedback is needed to generate a comprehensive summary.\n\n${prof.link}`;
  }

  const prompt = `You are a helpful Cal Poly student assistant. Analyze this professor's data and provide a short summary.

Professor: "${prof.name}"
Overall Rating: ${prof.rating}/4.0 (${prof.numEvals} evaluations)
Material Clear: ${prof.clarity}/4.0
Student Difficulties: ${prof.helpfulness}/4.0
Department: ${prof.department}
Courses: ${prof.courses}
Student Comments: "${prof.comments}"

Provide 5 descriptive sentences describing what this professor is known for and what students can expect. Also talk about which years succeed and don't succeed. End your response with: "${prof.link}"`;

  const body = {
    model: GROQ_MODEL,
    messages: [{ role: "user", content: prompt }],
    temperature: 0.7,
    max_tokens: 500,
  };

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const resp = await fetch(GROQ_ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${GROQ_API_KEY}`,
        },
        body: JSON.stringify(body),
      });

      if (!resp.ok) {
        const errorText = await resp.text();
        console.log(`⚠️ Groq API error ${resp.status} for ${prof.name} (attempt ${attempt}/${retries})`);
        console.log(`   Error: ${errorText.substring(0, 200)}`);

        if (resp.status === 429) {
          const waitTime = Math.pow(2, attempt) * 3000;
          console.log(`   ⏳ Rate limited. Waiting ${waitTime / 1000}s...`);
          await sleep(waitTime);
          continue;
        }

        if (attempt < retries) {
          await sleep(2000 * attempt);
          continue;
        }
        return "AI summary unavailable.";
      }

      const data = await resp.json();
      const text = data?.choices?.[0]?.message?.content?.trim();

      if (!text) {
        console.log(`⚠️ Empty response for ${prof.name}: ${JSON.stringify(data).substring(0, 200)}`);
        return "AI summary unavailable.";
      }

      return text;
    } catch (error) {
      console.log(`⚠️ Network error for ${prof.name} (attempt ${attempt}/${retries}): ${error.message}`);
      if (attempt < retries) {
        await sleep(2000 * attempt);
        continue;
      }
      return "AI summary unavailable.";
    }
  }

  return "AI summary unavailable.";
}

// ---------------------- State ----------------------

function loadState() {
  if (!fs.existsSync(STATE_FILE)) return { lastIndex: 0 };
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
  const WEEKLY_MODE = getWeeklyMode();
  console.log(`🚀 Mode: ${WEEKLY_MODE ? "WEEKLY (full regeneration)" : "DAILY (batched)"}`);
  console.log(`🤖 Using Groq (${GROQ_MODEL})`);
  console.log("📡 Fetching professor data...");

  const [ratings, comments] = await Promise.all([
    fetchCSV(RATINGS_URL),
    fetchCSV(COMMENTS_URL),
  ]);

  const professors = convertCSVToProfessorData(ratings, comments);
  console.log(`✅ Loaded ${professors.length} professors`);

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  let batch;
  let results;
  let startIndex;
  let endIndex;

  if (WEEKLY_MODE) {
    // Weekly: regenerate ALL summaries, but keep existing ones as fallback
    console.log("🔄 Weekly run — regenerating all summaries (keeping old ones as fallback)");
    batch = professors;
    results = loadExistingSummaries();
    startIndex = 0;
    endIndex = professors.length;
    saveState({ lastIndex: 0 });
  } else {
    // Daily: process next batch, skip already-done professors
    const state = loadState();
    startIndex = state.lastIndex || 0;
    endIndex = Math.min(startIndex + DAILY_BATCH_SIZE, professors.length);
    batch = professors.slice(startIndex, endIndex);
    results = loadExistingSummaries();
    console.log(`📦 Processing professors ${startIndex + 1}–${endIndex} of ${professors.length}`);
  }

  let processed = 0;
  let skipped = 0;

  for (let i = 0; i < batch.length; i++) {
    const prof = batch[i];

    // In daily mode, skip if already have a valid summary
    if (!WEEKLY_MODE && results[prof.name] && results[prof.name] !== "AI summary unavailable.") {
      skipped++;
      continue;
    }

    console.log(`🧠 [${i + 1}/${batch.length}] ${prof.name}...`);
    const summary = await callAISummary(prof);

    // In weekly mode, only overwrite if the new summary actually succeeded
    if (WEEKLY_MODE && summary === "AI summary unavailable." && results[prof.name] && results[prof.name] !== "AI summary unavailable.") {
      console.log(`   ↩️ Keeping existing summary for ${prof.name} (new call failed)`);
      skipped++;
    } else {
      results[prof.name] = summary;
      processed++;
    }

    // Delay between requests (skip for last item)
    if (i < batch.length - 1) {
      await sleep(REQUEST_DELAY_MS);
    }
  }

  // Save results
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(results, null, 2));
  console.log(`\n✅ Done! Processed: ${processed}, Skipped: ${skipped}, Total saved: ${Object.keys(results).length}`);

  // Update state for next daily run
  if (WEEKLY_MODE) {
    saveState({ lastIndex: 0 });
    console.log("🎉 Weekly regeneration complete. State reset to 0.");
  } else {
    const nextIndex = endIndex >= professors.length ? 0 : endIndex;
    saveState({ lastIndex: nextIndex });
    if (endIndex >= professors.length) {
      console.log("🎉 Reached end of list — next run starts from 0.");
    } else {
      console.log(`📍 Next run starts at index: ${nextIndex}`);
    }
  }
}

main().catch((err) => {
  console.error("❌ Fatal error:", err);
  process.exit(1);
});