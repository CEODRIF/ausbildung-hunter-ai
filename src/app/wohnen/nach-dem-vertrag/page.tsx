import { getServerT } from "@/lib/i18n/server";
import { GuideLayout, type GuideSection } from "@/components/guides/guide-layout";

/** Verified official source pages (all checked live on 2026-10-11). */
const IG = "https://make-it-in-germany.com/en";
const MIG = { label: "make-it-in-germany.com", url: `${IG}/` };
const MIG_VISA = { label: "make-it-in-germany.com", url: `${IG}/living/visa/visa-national` };
const MIG_ANMELDUNG = { label: "make-it-in-germany.com", url: `${IG}/living/guides/registering-residence` };
const MIG_AZUBI = {
  label: "make-it-in-germany.com",
  url: `${IG}/study-and-education/vocational-training`,
};
const AUSLANDSPORTAL = { label: "Auslandsportal (Auswärtiges Amt)", url: "https://auslandsportal.auswaertiges-amt.de/" };

/**
 * "Nach dem Arbeits- oder Ausbildungsvertrag" — what to check, the visa
 * requirements by situation (EU vs. non-EU), documents, travel prep and
 * post-arrival steps. Carries the prominent "contract ≠ visa" warning.
 */
export default async function NachDemVertragPage() {
  const t = await getServerT();
  const sections: GuideSection[] = [
    {
      title: t("guides.vertrag.sec1"),
      steps: [
        { id: "s1-1", title: t("guides.vertrag.s1t1"), desc: t("guides.vertrag.s1d1") },
        { id: "s1-2", title: t("guides.vertrag.s1t2"), desc: t("guides.vertrag.s1d2") },
        { id: "s1-3", title: t("guides.vertrag.s1t3"), desc: t("guides.vertrag.s1d3") },
        { id: "s1-4", title: t("guides.vertrag.s1t4"), desc: t("guides.vertrag.s1d4"), source: MIG_AZUBI },
      ],
    },
    {
      title: t("guides.vertrag.sec2"),
      steps: [
        { id: "s2-1", title: t("guides.vertrag.s2t1"), desc: t("guides.vertrag.s2d1"), source: MIG_VISA },
        { id: "s2-2", title: t("guides.vertrag.s2t2"), desc: t("guides.vertrag.s2d2") },
        { id: "s2-3", title: t("guides.vertrag.s2t3"), desc: t("guides.vertrag.s2d3") },
        { id: "s2-4", title: t("guides.vertrag.s2t4"), desc: t("guides.vertrag.s2d4"), source: AUSLANDSPORTAL },
      ],
    },
    {
      title: t("guides.vertrag.sec3"),
      steps: [
        { id: "s3-1", title: t("guides.vertrag.s3t1"), desc: t("guides.vertrag.s3d1") },
        { id: "s3-2", title: t("guides.vertrag.s3t2"), desc: t("guides.vertrag.s3d2") },
        { id: "s3-3", title: t("guides.vertrag.s3t3"), desc: t("guides.vertrag.s3d3") },
        { id: "s3-4", title: t("guides.vertrag.s3t4"), desc: t("guides.vertrag.s3d4") },
        { id: "s3-5", title: t("guides.vertrag.s3t5"), desc: t("guides.vertrag.s3d5") },
      ],
    },
    {
      title: t("guides.vertrag.sec4"),
      steps: [
        { id: "s4-1", title: t("guides.vertrag.s4t1"), desc: t("guides.vertrag.s4d1") },
        { id: "s4-2", title: t("guides.vertrag.s4t2"), desc: t("guides.vertrag.s4d2") },
        { id: "s4-3", title: t("guides.vertrag.s4t3"), desc: t("guides.vertrag.s4d3"), source: MIG },
      ],
    },
    {
      title: t("guides.vertrag.sec5"),
      steps: [
        { id: "s5-1", title: t("guides.vertrag.s5t1"), desc: t("guides.vertrag.s5d1"), source: MIG_ANMELDUNG },
        { id: "s5-2", title: t("guides.vertrag.s5t2"), desc: t("guides.vertrag.s5d2") },
        { id: "s5-3", title: t("guides.vertrag.s5t3"), desc: t("guides.vertrag.s5d3") },
        { id: "s5-4", title: t("guides.vertrag.s5t4"), desc: t("guides.vertrag.s5d4") },
      ],
    },
  ];
  return (
    <GuideLayout
      intro={t("guides.vertrag.intro")}
      warning={t("guides.vertrag.visaWarning")}
      sections={sections}
      storageKey="aha-guides-vertrag"
      checklistTitle={t("guides.vertrag.checklistTitle")}
      progressTemplate={t("guides.vertrag.progress")}
      resetLabel={t("guides.vertrag.reset")}
      doneAllLabel={t("guides.vertrag.doneAll")}
      sourceLabel={t("guides.vertrag.officialSource")}
    />
  );
}
