import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = path.join(ROOT, 'data');
const QUESTIONS_DIR = path.join(DATA_DIR, 'questions');

function subjectSlug(subject) {
  return subject.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

const files = (await fs.readdir(QUESTIONS_DIR)).filter(name => name.endsWith('.json')).sort();
if (!files.length) throw new Error(`No subject JSON files found in ${QUESTIONS_DIR}`);

const ids = new Set();
const subjects = [];
let pendingCount = 0;
const normalizeTopic = topic => String(topic || 'Uncategorized').replaceAll('_', ' ').replace(/\s+/g, ' ').trim() || 'Uncategorized';
for (const file of files) {
  const questions = JSON.parse(await fs.readFile(path.join(QUESTIONS_DIR, file), 'utf8'));
  if (!Array.isArray(questions) || !questions.length) throw new Error(`${file} must contain a non-empty question array.`);
  const subject = questions[0].subject;
  if (!subject || questions.some(question => question.subject !== subject)) throw new Error(`${file} must contain questions from exactly one subject.`);
  for (const question of questions) {
    if (!question.id || ids.has(question.id)) throw new Error(`Missing or duplicate question id: ${question.id || '(empty)'}`);
    ids.add(question.id);
    if (question.answerStatus === 'pending') pendingCount++;
  }
  const expectedFile = `${subjectSlug(subject)}.json`;
  if (file !== expectedFile) throw new Error(`${file} should be named ${expectedFile} for subject “${subject}”.`);
  const source = await fs.readFile(path.join(QUESTIONS_DIR, file));
  await fs.writeFile(path.join(QUESTIONS_DIR, `${file}.gz`), gzipSync(source, { level: 9 }));
  const topicGroups = new Map();
  const yearCounts = new Map();
  for (const question of questions) {
    const label = normalizeTopic(question.topic), key = label.toLocaleLowerCase();
    if (!topicGroups.has(key)) topicGroups.set(key, new Map());
    const labels = topicGroups.get(key);
    const stat = labels.get(label) || { count: 0, years: new Set() };
    stat.count++;
    stat.years.add(question.year);
    labels.set(label, stat);
    yearCounts.set(question.year, (yearCounts.get(question.year) || 0) + 1);
  }
  const topics = [...topicGroups.values()].map(labels => {
    const [name] = [...labels.entries()].sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]))[0];
    const variants = [...labels.values()];
    return { name, count: variants.reduce((sum, stat) => sum + stat.count, 0), years: [...new Set(variants.flatMap(stat => [...stat.years]))].sort((a, b) => b - a) };
  }).sort((a, b) => a.name.localeCompare(b.name));
  const years = [...yearCounts].map(([year, count]) => ({ year, count })).sort((a, b) => b.year - a.year);
  subjects.push({ subject, file, count: questions.length, topics, years });
}

subjects.sort((a, b) => a.subject.localeCompare(b.subject));
await fs.writeFile(path.join(DATA_DIR, 'questions-manifest.json'), `${JSON.stringify({ version: 1, subjects, questionCount: ids.size, pendingCount }, null, 2)}\n`);
console.log(`Built ${subjects.length} subject files with ${ids.size} questions.`);
