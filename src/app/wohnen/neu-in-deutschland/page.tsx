import { getServerT } from "@/lib/i18n/server";
import { GuideLayout, type GuideSection } from "@/components/guides/guide-layout";

/** Verified official source pages (all checked live on 2026-10-11). */
const IG = "https://make-it-in-germany.com/en";
const MIG = { label: "make-it-in-germany.com", url: `${IG}/` };
const MIG_VISA = { label: "make-it-in-germany.com", url: `${IG}/living/visa/visa-national` };
const MIG_ANMELDUNG = { label: "make-it-in-germany.com", url: `${IG}/living/guides/registering-residence` };
const MIG_KV = { label: "make-it-in-germany.com", url: `${IG}/living/guides/health-insurance` };
const MIG_BANK = { label: "make-it-in-germany.com", url: `${IG}/living/guides/bank-account` };
const ELSTER = { label: "ELSTER (Bundeszentralamt für Steuern)", url: "https://www.elster.de/" };

/**
 * "Neu in Deutschland?" — chronological first-weeks guide with an interactive
 * task checklist. All texts come from the guides.neu i18n block; every source
 * link points to an official page (no affiliate/blog sources).
 */
export default async function NeuInDeutschlandPage() {
  const t = await getServerT();
  const sections: GuideSection[] = [
    {
      title: t("guides.neu.sec1"),
      steps: [
        { id: "s1-1", title: t("guides.neu.s1t1"), desc: t("guides.neu.s1d1"), source: MIG_VISA },
        { id: "s1-2", title: t("guides.neu.s1t2"), desc: t("guides.neu.s1d2") },
        { id: "s1-3", title: t("guides.neu.s1t3"), desc: t("guides.neu.s1d3") },
      ],
    },
    {
      title: t("guides.neu.sec2"),
      steps: [
        { id: "s2-1", title: t("guides.neu.s2t1"), desc: t("guides.neu.s2d1"), source: MIG_ANMELDUNG },
        { id: "s2-2", title: t("guides.neu.s2t2"), desc: t("guides.neu.s2d2"), source: MIG_KV },
        { id: "s2-3", title: t("guides.neu.s2t3"), desc: t("guides.neu.s2d3") },
      ],
    },
    {
      title: t("guides.neu.sec3"),
      steps: [
        { id: "s3-1", title: t("guides.neu.s3t1"), desc: t("guides.neu.s3d1") },
        { id: "s3-2", title: t("guides.neu.s3t2"), desc: t("guides.neu.s3d2"), source: ELSTER },
      ],
    },
    {
      title: t("guides.neu.sec4"),
      steps: [
        { id: "s4-1", title: t("guides.neu.s4t1"), desc: t("guides.neu.s4d1"), source: MIG_BANK },
        { id: "s4-2", title: t("guides.neu.s4t2"), desc: t("guides.neu.s4d2") },
      ],
    },
    {
      title: t("guides.neu.sec5"),
      steps: [
        { id: "s5-1", title: t("guides.neu.s5t1"), desc: t("guides.neu.s5d1") },
        { id: "s5-2", title: t("guides.neu.s5t2"), desc: t("guides.neu.s5d2") },
        { id: "s5-3", title: t("guides.neu.s5t3"), desc: t("guides.neu.s5d3") },
      ],
    },
    {
      title: t("guides.neu.sec6"),
      steps: [
        { id: "s6-1", title: t("guides.neu.s6t1"), desc: t("guides.neu.s6d1") },
        { id: "s6-2", title: t("guides.neu.s6t2"), desc: t("guides.neu.s6d2") },
        { id: "s6-3", title: t("guides.neu.s6t3"), desc: t("guides.neu.s6d3"), source: MIG },
      ],
    },
  ];
  return (
    <GuideLayout
      intro={t("guides.neu.intro")}
      sections={sections}
      storageKey="aha-guides-neu"
      checklistTitle={t("guides.neu.checklistTitle")}
      progressTemplate={t("guides.neu.progress")}
      resetLabel={t("guides.neu.reset")}
      doneAllLabel={t("guides.neu.doneAll")}
      sourceLabel={t("guides.neu.officialSource")}
    />
  );
}
