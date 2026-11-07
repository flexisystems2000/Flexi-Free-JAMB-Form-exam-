"use strict";

const { randomInt, createHash } = require("node:crypto");

const SOURCE_BASE =
  "https://raw.githubusercontent.com/flexisystems2000/Flexi-JAMB-CBT-App-/main/question_bank";

const QUESTION_COUNT = 40;
const CACHE_TTL_MS = 5 * 60 * 1000;

// Exact subject names from the Verify registration repository.
// Do not change these labels without updating the Verify mapping.
const SUBJECT_BANKS = Object.freeze({
  "Use of English": {
    type: "split",
    sources: [
      { file: "use_of_english.json", count: 35 },
      { file: "the_lekki_headmaster.json", count: 5 }
    ]
  },

  Mathematics: { file: "mathematics.json" },
  Biology: { file: "biology.json" },
  Chemistry: { file: "chemistry.json" },
  Physics: { file: "physics.json" },
  Economics: { file: "economics.json" },
  Government: { file: "government.json" },
  Commerce: { file: "commerce.json" },
  Accounting: { file: "accounting.json" },

  "Literature in English": {
    file: "literature_in_english.json"
  },

  "Christian Religious Studies (CRS)": {
    file: "christian_religious_studies__crs_.json"
  },

  Arabic: { file: "arabic.json" },

  Art: { file: "fine_art.json" }
});

// Subjects in Verify without an approved matching dataset.
const UNSUPPORTED_SUBJECTS = Object.freeze([
  "Agricultural Science",
  "Geography",
  "History",
  "Islamic Religious Studies (IRS)",
  "French",
  "Hausa",
  "Igbo",
  "Home Economics",
  "Music",
  "Physical and Health Education (PHE)"
]);

const bankCache = new Map();

function createError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function normalizeQuestion(value) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function normalizeAnswer(value) {
  const match = String(value || "")
    .trim()
    .toUpperCase()
    .match(/^([A-D])(?:[.)])?$/);

  return match ? match[1] : null;
}

function shuffle(items) {
  const result = [...items];

  for (let i = result.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [result[i], result[j]] = [result[j], result[i]];
  }

  return result;
}

// Same question text receives the same ID even if it
// appears in two different source files.
function generateQuestionId(subject, question) {
  return createHash("sha256")
    .update(subject + "|" + normalizeQuestion(question))
    .digest("hex")
    .slice(0, 24);
}

function validateBank(data, subject, sourceFile) {
  if (!Array.isArray(data)) {
    throw createError(
      "QUESTION_BANK_INVALID",
      "Question bank is not a valid JSON array: " + sourceFile
    );
  }

  const validQuestions = [];

  for (const item of data) {
    if (!item || typeof item.question !== "string") {
      continue;
    }

    if (
      !Array.isArray(item.options) ||
      item.options.length !== 4
    ) {
      continue;
    }

    const options = item.options.map(option =>
      String(option || "").trim()
    );

    if (options.some(option => !option)) {
      continue;
    }

    const answer = normalizeAnswer(item.answer);

    if (!answer) {
      continue;
    }

    validQuestions.push({
      id: generateQuestionId(subject, item.question),
      subject,
      question: item.question.trim(),
      options,
      answer,
      year: item.year ? String(item.year) : null,
      sourceFile
    });
  }

  if (validQuestions.length < QUESTION_COUNT) {
    throw createError(
      "QUESTION_BANK_INSUFFICIENT",
      "Not enough valid questions in " + sourceFile
    );
  }

  return validQuestions;
}

// Fetches and temporarily caches a source dataset.
async function loadBank(file, subject) {
  const cached = bankCache.get(file);

  if (cached && cached.expiresAt > Date.now()) {
    return cached.questions;
  }

  const response = await fetch(
    SOURCE_BASE + "/" + encodeURIComponent(file),
    {
      headers: {
        Accept: "application/json"
      },
      signal: AbortSignal.timeout(15000)
    }
  );

  if (!response.ok) {
    throw createError(
      "QUESTION_BANK_UNAVAILABLE",
      "Unable to retrieve question bank: " + file
    );
  }

  let data;

  try {
    data = await response.json();
  } catch {
    throw createError(
      "QUESTION_BANK_INVALID",
      "Invalid JSON received from " + file
    );
  }

  const questions = validateBank(data, subject, file);

  bankCache.set(file, {
    questions,
    expiresAt: Date.now() + CACHE_TTL_MS
  });

  return questions;
}

// Selects questions without repeating question IDs.
function chooseUniqueQuestions(bank, count, usedIds) {
  const available = shuffle(
    bank.filter(question => !usedIds.has(question.id))
  );

  if (available.length < count) {
    throw createError(
      "QUESTION_BANK_DUPLICATES",
      "Not enough unique questions available."
    );
  }

  const selected = available.slice(0, count);

  for (const question of selected) {
    usedIds.add(question.id);
  }

  return selected;
}

// Main function: generates exactly 40 questions for one subject.
async function getQuestionsForSubject(subject) {
  const exactSubject = String(subject || "").trim();
  const mapping = SUBJECT_BANKS[exactSubject];

  if (!mapping) {
    const unsupported =
      UNSUPPORTED_SUBJECTS.includes(exactSubject);

    throw createError(
      unsupported
        ? "SUBJECT_BANK_NOT_CONFIGURED"
        : "UNKNOWN_SUBJECT",
      unsupported
        ? "No approved question bank exists for " + exactSubject
        : "Subject is not in the approved Verify mapping."
    );
  }

  const usedIds = new Set();
  let selected = [];

  if (mapping.type === "split") {
    // Use of English: 35 general English + 5 novel questions.
    for (const source of mapping.sources) {
      const bank = await loadBank(
        source.file,
        exactSubject
      );

      selected.push(
        ...chooseUniqueQuestions(
          bank,
          source.count,
          usedIds
        )
      );
    }
  } else {
    const bank = await loadBank(
      mapping.file,
      exactSubject
    );

    selected = chooseUniqueQuestions(
      bank,
      QUESTION_COUNT,
      usedIds
    );
  }

  if (selected.length !== QUESTION_COUNT) {
    throw createError(
      "QUESTION_COUNT_MISMATCH",
      "Exactly 40 questions are required for " + exactSubject
    );
  }

  return shuffle(selected).map((question, index) => ({
    ...question,
    position: index + 1
  }));
}

// IMPORTANT:
// This is the only question representation that should
// be returned to a candidate's browser.
function toCandidateQuestion(question) {
  return {
    id: question.id,
    subject: question.subject,
    position: question.position,
    question: question.question,
    options: question.options,
    year: question.year
  };
}

// Checks all four registered subjects before an exam begins.
function getSubjectBankStatus(subjects) {
  const list = Array.isArray(subjects) ? subjects : [];

  const normalized = list.map(value =>
    String(value || "").trim()
  );

  const supported = normalized.filter(
    subject => Boolean(SUBJECT_BANKS[subject])
  );

  const unsupported = normalized.filter(
    subject => !SUBJECT_BANKS[subject]
  );

  const unique = new Set(normalized).size === normalized.length;

  return {
    supported,
    unsupported,
    ready:
      normalized.length === 4 &&
      supported.length === 4 &&
      unique
  };
}

module.exports = {
  QUESTION_COUNT,
  SUBJECT_BANKS,
  UNSUPPORTED_SUBJECTS,
  getQuestionsForSubject,
  getSubjectBankStatus,
  toCandidateQuestion
};
