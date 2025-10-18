import fs from "fs";
import fetch from "node-fetch";
import { parse } from "csv-parse/sync";

const GEMINI_API_KEY = "AIzaSyCmwRwQpxuZFifAH9tOTUOGcx7hasCspK8";
if (!GEMINI_API_KEY) {
  console.error("❌ Missing GEMINI_API_KEY in environment variables");
  process.exit(1);
}

const RATINGS_URL =
  "https://raw.githubusercontent.com/sreshtalluri/polyratings-data-collection/refs/heads/main/data/main/professors_data.csv";
const COMMENTS_URL =
  "https://raw.githubusercontent.com/sreshtalluri/polyratings-data-collection/refs/heads/main/data/main/professor_detailed_reviews.csv";

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

Provide 5 concise sentences describing what this professor is known for and what students can expect. End your response with: "${prof.link}"`;

  const body = {
    contents: [{ parts: [{ text: prompt }] }],
  };

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

// ---------------------- Main ----------------------

async function main() {
  console.log("🚀 Fetching professor data...");
  const [ratings, comments] = await Promise.all([
    fetchCSV(RATINGS_URL),
    fetchCSV(COMMENTS_URL),
  ]);

  console.log(`✅ Loaded ${ratings.length} ratings & ${comments.length} comments`);
  const professors = convertCSVToProfessorData(ratings, comments);

  // Limit for testing
  const testBatch = professors.slice(0, 2); // only 2 professors

  const results = {};
  for (const prof of testBatch) {
    console.log(`🧠 Generating AI summary for ${prof.name}...`);
    const summary = await callGeminiAnalysis(prof);
    results[prof.name] = summary;
  }

  // Ensure directory exists
  fs.mkdirSync("summaries", { recursive: true });

  // Save output
  const outputPath = "summaries/test_batch.json";
  fs.writeFileSync(outputPath, JSON.stringify(results, null, 2));
  console.log(`✅ Saved ${Object.keys(results).length} summaries to ${outputPath}`);
  console.log("\n📜 Output JSON:");
  console.log(JSON.stringify(results, null, 2));
}

main().catch((err) => {
  console.error("❌ Error running script:", err);
  process.exit(1);
});
