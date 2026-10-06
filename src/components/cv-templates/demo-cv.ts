/**
 * Demo CV for the TEMPLATE GALLERY ONLY.
 *
 * The template-selection screen renders each template with this neutral
 * sample document (realistic content, ~reference density, fits one A4 page
 * in every template) so the user can judge the complete visual identity of
 * each design before selecting.
 *
 * HARD RULE: this data is only ever passed to the gallery thumbnails. It is
 * NEVER written to the user's CvDocument, never persisted, and never used
 * after a template is selected — the editor/preview/PDF always render the
 * user's real data.
 */
import {
  cvEmpty,
  emptyCertificate,
  emptyEducation,
  emptyExperience,
  emptyLanguage,
  type CvDocument,
} from "@/lib/templates/cv";

export function buildDemoCv(): CvDocument {
  const cv = cvEmpty();

  cv.personal.fullName = "Alex Morgan";
  cv.personal.professionalTitle = "Project Coordinator";
  cv.personal.email = "alex.morgan@email.com";
  cv.personal.phone = "+1 312 555 0187";
  cv.personal.location = "Chicago, IL";
  cv.personal.linkedin = "linkedin.com/in/alex-morgan";

  cv.summary =
    "Organized project professional with 8+ years of experience coordinating cross-functional teams, budgets, and delivery timelines in B2B technology environments. Skilled in stakeholder communication, risk planning, and process improvement. Brings a practical, results-focused approach to project execution and client success.";

  const e1 = emptyExperience();
  e1.jobTitle = "Project Coordinator";
  e1.company = "BrightPath Solutions";
  e1.location = "Chicago, Illinois";
  e1.start = "2022";
  e1.isCurrent = true;
  e1.responsibilities = [
    "Coordinate end-to-end delivery of cross-functional projects for enterprise clients",
    "Plan budgets, milestones, and resource allocation across three product teams",
    "Maintain stakeholder reporting, risk registers, and client communication",
  ];
  const e2 = emptyExperience();
  e2.jobTitle = "Team Lead";
  e2.company = "Nexora Consulting";
  e2.location = "Chicago, Illinois";
  e2.start = "2019";
  e2.end = "2022";
  e2.responsibilities = [
    "Led a team of six analysts supporting operations and client success programs",
    "Improved project reporting and forecasting accuracy across key accounts",
    "Coordinated vendor onboarding and contract renewal processes",
  ];
  const e3 = emptyExperience();
  e3.jobTitle = "Program Specialist";
  e3.company = "Horizon Logic";
  e3.location = "Milwaukee, Wisconsin";
  e3.start = "2016";
  e3.end = "2019";
  e3.responsibilities = [
    "Supported program planning, documentation, and status reporting",
    "Assisted with proposal preparation and delivery coordination",
  ];
  cv.experience = [e1, e2, e3];

  const d1 = emptyEducation();
  d1.degree = "Professional Certificate in Project Management";
  d1.institution = "DePaul University";
  d1.location = "Chicago, Illinois";
  d1.end = "2021";
  const d2 = emptyEducation();
  d2.degree = "Bachelor of Science in Business Administration";
  d2.institution = "University of Wisconsin";
  d2.location = "Madison, Wisconsin";
  d2.start = "2012";
  d2.end = "2016";
  cv.education = [d1, d2];

  cv.skills = [
    "Project Planning",
    "Stakeholder Management",
    "Budget Control",
    "Team Leadership",
    "Risk Assessment",
    "Process Improvement",
    "Vendor Coordination",
    "Client Reporting",
  ];

  const l1 = emptyLanguage();
  l1.language = "English";
  l1.level = "Native";
  const l2 = emptyLanguage();
  l2.language = "Spanish";
  l2.level = "Proficient";
  const l3 = emptyLanguage();
  l3.language = "French";
  l3.level = "Conversational";
  cv.languages = [l1, l2, l3];

  const c1 = emptyCertificate();
  c1.name = "Certified Project Management Professional (PMP)";
  const c2 = emptyCertificate();
  c2.name = "Agile Project Management Certification";
  const c3 = emptyCertificate();
  c3.name = "Lean Six Sigma Green Belt";
  cv.certificates = [c1, c2, c3];

  return cv;
}
