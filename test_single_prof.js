import fs from "fs";
import fetch from "node-fetch";
import { parse } from "csv-parse/sync";
import dotenv from "dotenv";

dotenv.config();

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
if (!GEMINI_API_KEY) {
  console.error("❌ Missing GEMINI_API_KEY in environment variables");
  process.exit(1);
}

const RATINGS_URL =
  "https://raw.githubusercontent.com/sreshtalluri/polyratings-data-collection/refs/heads/main/data/main/professors_data.csv";
const COMMENTS_URL =
  "https://raw.githubusercontent.com/sreshtalluri/polyratings-data-collection/refs/heads/main/data/main/professor_detailed_reviews.csv";

async function fetchCSV(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`);
  const text = await res.text();
  const records = parse(text, { columns: true, skip_empty_lines: true });
  return records;
}

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

async function testProfessor(profName) {
  console.log(`🔍 Testing professor: ${profName}\n`);

  const [ratings, comments] = await Promise.all([
    fetchCSV(RATINGS_URL),
    fetchCSV(COMMENTS_URL),
  ]);

  const professors = convertCSVToProfessorData(ratings, comments);
  const prof = professors.find((p) => p.name === profName);

  if (!prof) {
    console.error(`❌ Professor "${profName}" not found in data`);
    return;
  }

  console.log("📊 Professor Data:");
  console.log(`   Name: ${prof.name}`);
  console.log(`   Rating: ${prof.rating}/4.0`);
  console.log(`   Num Evals: ${prof.numEvals}`);
  console.log(`   Clarity: ${prof.clarity}/4.0`);
  console.log(`   Helpfulness: ${prof.helpfulness}/4.0`);
  console.log(`   Department: ${prof.department}`);
  console.log(`   Courses: ${prof.courses}`);
  console.log(`   Comments length: ${prof.comments.length} chars`);
  console.log(`   Comments preview: ${prof.comments.substring(0, 200)}...\n`);

  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/gemini-robotics-er-1.5-preview:generateContent?key=${GEMINI_API_KEY}`;

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

  console.log("🚀 Calling Gemini API...\n");

  const body = { contents: [{ parts: [{ text: prompt }] }] };

  const resp = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  console.log(`📡 Response Status: ${resp.status}\n`);

  const data = await resp.json();
  
  console.log("📦 Full Response:");
  console.log(JSON.stringify(data, null, 2));
  
  if (data?.candidates?.[0]?.content?.parts?.[0]?.text) {
    console.log("\n✅ Generated Summary:");
    console.log(data.candidates[0].content.parts[0].text);
  } else {
    console.log("\n❌ No summary generated");
  }
}

// Test with a professor that failed
const testName = process.argv[2] || "Michael Cirovic";
testProfessor(testName).catch(console.error);
