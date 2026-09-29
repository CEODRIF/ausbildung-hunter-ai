import { LoadingState } from "@/components/ui";
import { getServerT } from "@/lib/i18n/server";

export default async function Loading() {
  const t = await getServerT();
  return (
    <div className="flex min-h-[60vh] items-center justify-center">
      <LoadingState label={t("common.loading")} />
    </div>
  );
}
