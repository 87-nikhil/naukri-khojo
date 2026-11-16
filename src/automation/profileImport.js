const mammoth = require('mammoth');

const SKILLS = [
  'JavaScript', 'TypeScript', 'Node.js', 'Express.js', 'React', 'Next.js', 'Angular', 'AngularJS',
  'HTML', 'CSS', 'SCSS', 'Redux', 'Redux Toolkit', 'RxJS', 'NgRx', 'GraphQL', 'REST APIs',
  'WebSockets', 'Microfrontends', 'Module Federation', 'AWS', 'Docker', 'Kubernetes', 'MongoDB',
  'PostgreSQL', 'MySQL', 'Java', 'Python', 'Spring Boot', 'Playwright', 'Jest', 'Git', 'CI/CD',
  'Webpack', 'Vite', 'Nx', 'Storybook', 'Figma', 'Electron', 'Tailwind CSS', 'Material UI', 'Bootstrap',
];
const CITIES = ['Pune', 'Bengaluru', 'Bangalore', 'Mumbai', 'Hyderabad', 'Chennai', 'Delhi', 'Gurugram', 'Gurgaon', 'Noida', 'Indore', 'Jaipur', 'Kolkata', 'Ahmedabad', 'Kochi'];

function cleanText(text) {
  return String(text || '').replace(/\u0000/g, '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim().slice(0, 500000);
}

function extractEmployment(lines) {
  const start = lines.findIndex(line => /professional experience|work experience|employment history/i.test(line));
  if (start < 0) return [];
  const end = lines.findIndex((line, index) => index > start && /^(projects?|education|technical skills|skills|certifications?)\b/i.test(line));
  const section = lines.slice(start + 1, end < 0 ? start + 50 : end);
  const records = [];
  for (let i = 0; i < section.length && records.length < 20; i++) {
    const line = section[i];
    const legalSuffix = line.match(/^(.+?\b(?:Pvt\.?\s*Ltd\.?|Private Limited|Limited|Ltd\.?|Inc\.?|Corp\.?))\s*(.*)$/i);
    const commonSuffix = legalSuffix || line.match(/^(.+?\b(?:Technologies|Technology|Infotech|Systems))\s*(.*)$/i);
    if (!commonSuffix) continue;
    const company = commonSuffix[1].trim();
    const inline = commonSuffix[2].trim();
    const dateLine = /\b\d{4}\b/.test(inline) ? inline : section[i + 1] || '';
    const range = dateLine.match(/([A-Z][a-z]{2,9}\s+\d{4}|\d{4})\s*(?:–|—|-|to)\s*([A-Z][a-z]{2,9}\s+\d{4}|\d{4}|Present|Current)/i);
    const titleLine = section[i + (dateLine === inline ? 1 : 2)] || '';
    const title = titleLine.replace(/\s*(?:Pune|Bengaluru|Bangalore|Mumbai|Hyderabad|Chennai|Indore|Jaipur|Delhi),?\s*(?:India|Madhya Pradesh|Maharashtra).*$/i, '').trim();
    records.push({ company, title, start: range?.[1] || '', end: range?.[2] || '' });
  }
  return records;
}

async function parseDocument(buffer, originalName) {
  const ext = String(originalName || '').toLowerCase().match(/\.(pdf|docx)$/)?.[1];
  if (!ext) throw new Error('Upload a PDF or DOCX resume');
  let text;
  if (ext === 'pdf') {
    const pdf = require('pdf-parse');
    const parsed = await pdf(buffer);
    text = parsed.text;
  } else {
    const parsed = await mammoth.extractRawText({ buffer });
    text = parsed.value;
  }
  text = cleanText(text);
  if (text.length < 80) throw new Error('Could not extract enough text. Use a text-based PDF or DOCX file.');
  return text;
}

function extractProfile(text, originalName = '') {
  const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const email = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0] || '';
  const phoneMatch = text.match(/(?:\+?91[\s-]?)?([6-9]\d{9})\b/);
  const phone = phoneMatch ? `+91${phoneMatch[1]}` : '';
  const name = lines.find(line => line.length <= 70 && /^[A-Z][A-Z .'-]+$/i.test(line) && !/^(PROFILE|RESUME|CURRICULUM VITAE|SUMMARY|CONTACT|EXPERIENCE|EDUCATION|SKILLS)$/i.test(line)) || '';
  const title = lines.slice(0, 12).find(line => /\b(engineer|developer|architect|designer|manager|analyst|consultant|lead|administrator|scientist)\b/i.test(line) && line.length <= 100) || '';
  const experience = text.match(/\b(\d{1,2}(?:\.\d+)?)\s*\+?\s*years?\s+(?:of\s+)?experience\b/i);
  const genderLine = lines.find(line => /^gender(?: identity)?\s*[:=-]\s*/i.test(line));
  const rawGender = genderLine?.replace(/^gender(?: identity)?\s*[:=-]\s*/i, '').trim().toLowerCase();
  const genderValues = { female: 'Female', woman: 'Female', male: 'Male', man: 'Male', 'non-binary': 'Non-binary', nonbinary: 'Non-binary', other: 'Other / self-describe', 'prefer not to say': 'Prefer not to say' };
  const gender = rawGender ? (genderValues[rawGender] || '') : '';
  const authLine = lines.find(line => /^(?:work authorization|work eligibility|right to work)\s*[:=-]\s*/i.test(line));
  const rawAuth = authLine?.replace(/^(?:work authorization|work eligibility|right to work)\s*[:=-]\s*/i, '').trim().toLowerCase() || '';
  let workAuthorization = '';
  if (/not authorized|not eligible|no right to work/.test(rawAuth)) workAuthorization = 'not_authorized';
  else if (/require|need|needs.*sponsor|sponsorship required/.test(rawAuth)) workAuthorization = 'needs_sponsorship';
  else if (/authorized to work in india|eligible to work in india|without (?:visa )?sponsorship/.test(rawAuth)) workAuthorization = 'authorized_india';
  const skills = SKILLS.filter(skill => new RegExp(`(^|[^a-z0-9])${skill.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`, 'i').test(text));
  const city = CITIES.find(value => new RegExp(`\\b${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(lines.slice(0, 8).join(' '))) || '';

  const experienceIndex = lines.findIndex(line => /professional experience|work experience|employment history/i.test(line));
  const experienceLines = experienceIndex >= 0 ? lines.slice(experienceIndex + 1, experienceIndex + 16) : [];
  const company = experienceLines.find(line => /\b(?:pvt\.?|private|ltd\.?|limited|inc\.?|corp\.?|technologies|technology|infotech|solutions|systems)\b/i.test(line) && line.length <= 120) || '';
  const educationIndex = lines.findIndex(line => /^education(?:al)?(?: details)?$/i.test(line));
  const educationLines = educationIndex >= 0 ? lines.slice(educationIndex + 1, educationIndex + 12) : [];
  const degree = text.match(/\b(Master of Computer Applications|MCA|Master of Business Administration|MBA|Bachelor of Technology|B\.Tech|Bachelor of Engineering|B\.E\.?|Bachelor of Computer Applications|BCA|Bachelor of Science|B\.Sc\.?|Bachelor of Arts|B\.A\.?)\b/i)?.[0] || '';
  const institution = educationLines.find(line => /university|college|institute|school|\bDAVV\b/i.test(line) && line.length <= 160) || '';
  const currentYear = new Date().getFullYear();
  const keywords = [...new Set([title, ...skills.filter(s => /angular|react|node|javascript|typescript|frontend|full.stack/i.test(s))])].filter(Boolean).slice(0, 8);

  return {
    name,
    email,
    phone,
    gender,
    workAuthorization,
    currentTitle: title,
    currentCompany: company,
    currentCity: city,
    experienceYears: experience ? Math.min(50, Number(experience[1])) : undefined,
    skills,
    searchKeywords: keywords,
    education: {
      degree,
      institution,
      startYear: undefined,
      endYear: undefined,
      percentage: undefined,
    },
    employment: extractEmployment(lines),
    resumeOriginalName: String(originalName).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 180),
    extractedText: text,
    extractionNotes: [
      'Review every suggested field before saving.',
      'Salary, notice period, skill-specific years, and consent choices are not inferred. Work authorization is suggested only when the resume states it explicitly.',
      `Resume text extracted (${text.length} characters).`,
      `Parsed on ${currentYear}.`,
    ],
  };
}

module.exports = { parseDocument, extractProfile, extractEmployment };
