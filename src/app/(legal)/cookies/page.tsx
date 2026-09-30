import { getRequestLang, getServerT } from "@/lib/i18n/server";
import { LegalDocView } from "@/components/legal-doc-view";
import { LEGAL_DOCS } from "@/lib/legal";

export async function generateMetadata() {
  const lang = await getRequestLang();
  const doc = LEGAL_DOCS.cookies;
  return { title: doc.title[lang], description: doc.intro[lang] };
}

export default async function CookiePolicyPage() {
  const [lang, t] = await Promise.all([getRequestLang(), getServerT()]);
  return (
    <LegalDocView
      doc={LEGAL_DOCS.cookies}
      lang={lang}
      tocLabel={t("legal.toc")}
      tocAriaLabel={t("legal.tocAria")}
      emailLabel={t("legal.emailLabel")}
    />
  );
}
