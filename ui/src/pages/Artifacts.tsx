import { useEffect } from "react";
import { Package } from "lucide-react";
import { EmptyState } from "../components/EmptyState";
import { useBreadcrumbs } from "../context/BreadcrumbContext";

export function Artifacts() {
  const { setBreadcrumbs } = useBreadcrumbs();

  useEffect(() => {
    setBreadcrumbs([{ label: "Artifacts" }]);
  }, [setBreadcrumbs]);

  return (
    <EmptyState
      icon={Package}
      message="Artifacts are coming soon."
    />
  );
}
