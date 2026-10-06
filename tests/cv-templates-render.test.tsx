import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { CvDocument } from "@/components/cv-document";
import {
  cvEmpty,
  type CvDocument as CvDocModel,
} from "@/lib/templates/cv";
import type { CvLabels } from "@/components/cv-document";

const LABELS: CvLabels = {
  summary: "Profile",
  experience: "Professional Experience",
  education: "Education",
  skills: "Skills",
  languages: "Languages",
  certificates: "Certificates",
  projects: "Projects",
  interests: "Interests",
  present: "Present",
  documentTitle: "Your CV",
};

function sampleCv(templateId: CvDocModel["templateId"]): CvDocModel {
  const cv = cvEmpty();
  cv.templateId = templateId;
  cv.personal.fullName = "Daniel Mercer";
  cv.personal.professionalTitle = "Vice President of Sales";
  cv.personal.email = "daniel.mercer@email.com";
  cv.personal.phone = "+1 312 555 0187";
  cv.personal.location = "Chicago, IL";
  cv.personal.linkedin = "linkedin.com/in/daniel-mercer";
  cv.summary =
    "Sales professional with 8+ years of experience supporting revenue growth in B2B technology environments.";
  cv.experience = [
    {
      id: "x1",
      jobTitle: "Sales Manager",
      company: "Nexora Solutions",
      location: "Chicago, Illinois",
      start: "2022",
      end: "",
      isCurrent: true,
      responsibilities: [
        "Manage a team of account executives across mid-market accounts",
        "Improve pipeline tracking and weekly forecast reporting accuracy",
      ],
      achievements: ["Lead client negotiations and support renewal growth opportunities"],
    },
    {
      id: "x2",
      jobTitle: "Senior Sales Specialist",
      company: "BrightPath Systems",
      location: "Chicago, Illinois",
      start: "2019",
      end: "2022",
      isCurrent: false,
      responsibilities: ["Delivered quarterly targets through consultative selling"],
      achievements: [],
    },
  ];
  cv.education = [
    {
      id: "e1",
      degree: "Professional Certificate in Sales Management",
      institution: "DePaul University",
      location: "Chicago, Illinois",
      start: "",
      end: "2018",
      description: "",
    },
    {
      id: "e2",
      degree: "Bachelor of Science in Marketing",
      institution: "Indiana University Bloomington",
      location: "Bloomington, Indiana",
      start: "2012",
      end: "2016",
      description: "",
    },
  ];
  cv.skills = [
    "Sales Strategy",
    "Enterprise Account Management",
    "Pipeline Management",
    "Negotiation",
    "Revenue Growth",
    "Team Leadership",
  ];
  cv.languages = [
    { id: "l1", language: "English", level: "Native" },
    { id: "l2", language: "Spanish", level: "Proficient" },
    { id: "l3", language: "French", level: "Conversational" },
  ];
  cv.certificates = [
    { id: "c1", name: "Certified Sales Leadership Professional", issuer: "CSLP", date: "2021", description: "" },
    { id: "c2", name: "Salesforce Certified Sales Representative", issuer: "Salesforce", date: "2020", description: "" },
  ];
  cv.projects = [
    { id: "p1", name: "Pricing Engine", role: "Lead", date: "2023", description: "Rebuilt pricing workflows.", technologies: "React, Node" },
  ];
  cv.interests = ["Chess", "Marathon running"];
  return cv;
}

const render = (id: CvDocModel["templateId"]) =>
  renderToStaticMarkup(<CvDocument cv={sampleCv(id)} labels={LABELS} />);

describe("template renderers (SSR smoke + design signatures)", () => {
  it("classic: original serif layout, dot bullets, uppercase headings", () => {
    const html = render("classic");
    expect(html).toContain("cv-sheet");
    expect(html).toContain("Times New Roman");
    expect(html).toContain("Profile");
    expect(html).toContain("Professional Experience");
    expect(html).toMatch(/text-transform:uppercase/);
    // dot bullet (4px round span)
    expect(html).toContain("border-radius:50%");
  });

  it("executive: centered header, 4-column skills, pipe meta on education", () => {
    const html = render("executive");
    // centered header
    expect(html).toMatch(/<header[^>]*style="[^"]*text-align:center/);
    // italic slate title
    expect(html).toContain("Vice President of Sales");
    expect(html).toMatch(/font-style:italic/);
    // 4-column skills grid (6 items → 4 cols)
    expect(html).toContain("repeat(4, minmax(0, 1fr))");
    // education single-line meta "2012 – 2016  |  Bloomington, Indiana"
    // (full date range + the sheet's double-spaced pipe separator)
    expect(html).toContain("2012 – 2016  |  Bloomington, Indiana");
    // round bullet
    expect(html).toContain("•");
  });

  it("modern: steel-blue identity + contact icons + 2-column skills", () => {
    const html = render("modern");
    expect(html).toContain("#2f5c99");
    // contact icons: mail/phone/pin/linkedin/globe inline SVGs
    expect(html).toMatch(/<svg[^>]*aria-hidden="true"/);
    expect(html).toContain("linkedin.com/in/daniel-mercer");
    // 2-column skills (6 items)
    expect(html).toContain("repeat(2, minmax(0, 1fr))");
    // 3-column languages
    expect(html).toContain("repeat(3, 1fr)");
    // dates + location stacked top-right on experience
    expect(html).toContain("2022 – Present");
    expect(html).toContain("Chicago, Illinois");
  });

  it("professional: inline pipe lists, dash bullets, bold name + italic title", () => {
    const html = render("professional");
    expect(html).toContain("font-weight:800");
    // inline skill list with pipe separators
    expect(html).toContain("Sales Strategy");
    expect(html).toContain("|");
    // languages "English: Native" (bold lead span + plain level)
    expect(html).toMatch(/English<\/span>: Native/);
    // dash bullets
    expect(html).toContain("–");
    // uppercase headings
    expect(html).toMatch(/text-transform:uppercase/);
  });

  it("template font identity: classic stays serif, the three new templates are sans by default", () => {
    // Classic keeps the classic serif default (behavior unchanged).
    expect(render("classic")).toContain("Times New Roman");
    // The reference designs of the new templates are sans-serif — the classic
    // serif default must not leak into them (per-template identity).
    for (const id of ["executive", "modern", "professional"] as const) {
      const html = render(id);
      expect(html).not.toContain("Times New Roman");
      expect(html).toContain("system-ui"); // sans-modern identity stack
    }
  });

  it("end-only dates render without a leading dash (new templates)", () => {
    const html = render("modern");
    expect(html).not.toContain("– 2018");
    expect(html).toContain("2018");
  });

  it("executive language names are bold (reference)", () => {
    expect(render("executive")).toContain("font-weight:600");
  });

  it("every template renders the same A4 sheet root", () => {
    for (const id of ["classic", "executive", "modern", "professional"] as const) {
      const html = render(id);
      expect(html).toContain('class="cv-sheet"');
      expect(html).toContain("width:794px");
      expect(html).toContain("min-height:1123px");
    }
  });
});
