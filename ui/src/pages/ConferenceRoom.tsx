import { useEffect } from "react";
import { MessagesSquare } from "lucide-react";
import { EmptyState } from "../components/EmptyState";
import { useBreadcrumbs } from "../context/BreadcrumbContext";

export function ConferenceRoom() {
  const { setBreadcrumbs } = useBreadcrumbs();

  useEffect(() => {
    setBreadcrumbs([{ label: "Conference room" }]);
  }, [setBreadcrumbs]);

  return (
    <EmptyState
      icon={MessagesSquare}
      message="The conference room is coming soon."
    />
  );
}
